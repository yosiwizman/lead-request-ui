/**
 * Cleanup logic for expired exports.
 * Handles both database row deletion and storage file cleanup.
 * NO PII in logs - only counts and IDs.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';

/**
 * Configuration for cleanup operations.
 */
export interface CleanupConfig {
  /** Number of days to retain exports. Default: 30 */
  retentionDays: number;
  /** Maximum rows to process per run. Default: 500 */
  maxRowsPerRun: number;
  /** Whether to run in dry-run mode (no actual deletions). Default: false */
  dryRun: boolean;
}

/**
 * Result of a cleanup operation.
 */
export interface CleanupResult {
  ok: boolean;
  runId: string;
  dryRun: boolean;
  scanned: number;
  deletedRows: number;
  deletedFiles: number;
  errorsCount: number;
  retentionDays: number;
  cutoffDate: string;
  errors?: string[];
}

/**
 * Export record shape for cleanup operations.
 */
interface ExportRow {
  id: string;
  created_at: string;
  bucket: string | null;
  path: string | null;
}

/**
 * Get cleanup configuration from environment or defaults.
 */
export function getCleanupConfig(overrides?: Partial<CleanupConfig>): CleanupConfig {
  const envRetention = process.env.EXPORT_RETENTION_DAYS;
  const envMaxRows = process.env.CLEANUP_MAX_ROWS_PER_RUN;

  return {
    retentionDays: overrides?.retentionDays ?? (envRetention ? parseInt(envRetention, 10) : 30),
    maxRowsPerRun: overrides?.maxRowsPerRun ?? (envMaxRows ? parseInt(envMaxRows, 10) : 500),
    dryRun: overrides?.dryRun ?? false,
  };
}

/**
 * Calculate the cutoff date for retention.
 */
export function getCutoffDate(retentionDays: number): Date {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - retentionDays);
  return cutoff;
}

/**
 * Generate a unique run ID for logging.
 */
export function generateRunId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 8);
  return `cleanup_${ts}_${rand}`;
}

/**
 * Get Supabase client for cleanup operations.
 * Throws if not configured.
 */
function getSupabaseClient(): SupabaseClient {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    throw new Error('Supabase not configured (missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY)');
  }

  return createClient(supabaseUrl, serviceKey);
}

/**
 * Find exports eligible for cleanup:
 * - Older than retention window, OR
 * - Missing bucket/path (orphaned records)
 */
export async function findExpiredExports(
  supabase: SupabaseClient,
  cutoffDate: Date,
  limit: number
): Promise<ExportRow[]> {
  // Query for old exports OR orphaned records (missing path/bucket)
  const { data, error } = await supabase
    .from('lead_exports')
    .select('id, created_at, bucket, path')
    .or(`created_at.lt.${cutoffDate.toISOString()},bucket.is.null,path.is.null`)
    .order('created_at', { ascending: true })
    .limit(limit);

  if (error) {
    console.error('[cleanup] Failed to query expired exports:', error.message);
    throw error;
  }

  return (data || []) as ExportRow[];
}

/**
 * Delete a file from Supabase Storage.
 * Returns true if successful or file didn't exist.
 */
export async function deleteStorageFile(
  supabase: SupabaseClient,
  bucket: string,
  path: string
): Promise<boolean> {
  try {
    const { error } = await supabase.storage.from(bucket).remove([path]);
    
    if (error) {
      // Log error but don't fail - file might already be deleted
      console.warn(`[cleanup] Storage delete warning for ${bucket}/${path}:`, error.message);
      return false;
    }
    
    return true;
  } catch (err) {
    console.error(`[cleanup] Storage delete error for ${bucket}/${path}:`, err);
    return false;
  }
}

/**
 * Delete export rows from database.
 */
export async function deleteExportRows(
  supabase: SupabaseClient,
  ids: string[]
): Promise<{ deleted: number; errors: number }> {
  if (ids.length === 0) {
    return { deleted: 0, errors: 0 };
  }

  const { error, count } = await supabase
    .from('lead_exports')
    .delete()
    .in('id', ids);

  if (error) {
    console.error('[cleanup] Failed to delete export rows:', error.message);
    return { deleted: 0, errors: ids.length };
  }

  return { deleted: count ?? ids.length, errors: 0 };
}

/**
 * Run the cleanup process.
 */
export async function runCleanup(configOverrides?: Partial<CleanupConfig>): Promise<CleanupResult> {
  const runId = generateRunId();
  const config = getCleanupConfig(configOverrides);
  const cutoffDate = getCutoffDate(config.retentionDays);
  
  const result: CleanupResult = {
    ok: true,
    runId,
    dryRun: config.dryRun,
    scanned: 0,
    deletedRows: 0,
    deletedFiles: 0,
    errorsCount: 0,
    retentionDays: config.retentionDays,
    cutoffDate: cutoffDate.toISOString(),
    errors: [],
  };

  console.log(JSON.stringify({
    event: 'cleanup_start',
    ts: new Date().toISOString(),
    runId,
    dryRun: config.dryRun,
    retentionDays: config.retentionDays,
    cutoffDate: cutoffDate.toISOString(),
    maxRows: config.maxRowsPerRun,
  }));

  try {
    const supabase = getSupabaseClient();

    // Find expired exports
    const expiredExports = await findExpiredExports(supabase, cutoffDate, config.maxRowsPerRun);
    result.scanned = expiredExports.length;

    if (expiredExports.length === 0) {
      console.log(JSON.stringify({
        event: 'cleanup_complete',
        ts: new Date().toISOString(),
        runId,
        scanned: 0,
        deletedRows: 0,
        deletedFiles: 0,
        errorsCount: 0,
      }));
      return result;
    }

    // Dry run - just return what would be deleted
    if (config.dryRun) {
      console.log(JSON.stringify({
        event: 'cleanup_dry_run',
        ts: new Date().toISOString(),
        runId,
        wouldDelete: expiredExports.length,
        sampleIds: expiredExports.slice(0, 5).map(e => e.id),
      }));
      return result;
    }

    // Delete storage files (best-effort)
    const idsToDelete: string[] = [];
    for (const exp of expiredExports) {
      if (exp.bucket && exp.path) {
        const deleted = await deleteStorageFile(supabase, exp.bucket, exp.path);
        if (deleted) {
          result.deletedFiles++;
        } else {
          result.errorsCount++;
          result.errors?.push(`storage:${exp.id}`);
        }
      }
      idsToDelete.push(exp.id);
    }

    // Delete database rows
    const dbResult = await deleteExportRows(supabase, idsToDelete);
    result.deletedRows = dbResult.deleted;
    result.errorsCount += dbResult.errors;
    if (dbResult.errors > 0) {
      result.errors?.push(`db:${dbResult.errors} rows`);
    }

    // Mark as failed if too many errors
    if (result.errorsCount > result.scanned / 2) {
      result.ok = false;
    }

    console.log(JSON.stringify({
      event: 'cleanup_complete',
      ts: new Date().toISOString(),
      runId,
      scanned: result.scanned,
      deletedRows: result.deletedRows,
      deletedFiles: result.deletedFiles,
      errorsCount: result.errorsCount,
    }));

    return result;
  } catch (err) {
    result.ok = false;
    result.errorsCount++;
    result.errors?.push(err instanceof Error ? err.message : 'Unknown error');
    
    console.error(JSON.stringify({
      event: 'cleanup_error',
      ts: new Date().toISOString(),
      runId,
      error: err instanceof Error ? err.message : 'Unknown error',
    }));

    return result;
  }
}

/**
 * Clean up old rate limit windows (call this during cleanup).
 */
export async function cleanupRateLimits(retentionHours: number = 24): Promise<number> {
  try {
    const supabase = getSupabaseClient();
    
    // Call the cleanup function we defined in the migration
    const { data, error } = await supabase.rpc('cleanup_old_rate_limits', {
      retention_hours: retentionHours,
    });

    if (error) {
      // Function might not exist yet, try direct delete
      if (error.code === '42883') {
        const cutoff = new Date();
        cutoff.setHours(cutoff.getHours() - retentionHours);
        
        const { count, error: deleteError } = await supabase
          .from('rate_limits')
          .delete()
          .lt('window_start', cutoff.toISOString());
        
        if (deleteError) {
          console.error('[cleanup] Rate limits cleanup failed:', deleteError.message);
          return 0;
        }
        
        return count ?? 0;
      }
      
      console.error('[cleanup] Rate limits RPC failed:', error.message);
      return 0;
    }

    return typeof data === 'number' ? data : 0;
  } catch (err) {
    console.error('[cleanup] Rate limits cleanup error:', err);
    return 0;
  }
}

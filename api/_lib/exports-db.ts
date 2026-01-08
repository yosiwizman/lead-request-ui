/**
 * Database operations for lead_exports table.
 * Stores METADATA ONLY - no PII.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { LeadQualityDiagnostics, FieldCoverage } from './types.js';

/**
 * Export record as stored in the database.
 */
/**
 * Valid export status values.
 * - 'building': Initial build in progress (interactive polling)
 * - 'building_long': Build taking longer than expected (background processing)
 * - 'success': Export completed successfully
 * - 'no_results': Provider returned no matching leads
 * - 'error': Terminal failure (auth error, provider error, etc.)
 */
export type ExportStatus = 'building' | 'building_long' | 'success' | 'no_results' | 'error';

export interface LeadExport {
  id: string;
  created_at: string;
  updated_at: string;
  provider: string;
  lead_request: string;
  zip_codes: string[];
  target: string;
  use_case: string;
  audience_id: string | null;
  request_id: string | null;
  status: ExportStatus;
  error_code: string | null;
  error_message: string | null;
  total_fetched: number | null;
  kept: number | null;
  diagnostics: LeadQualityDiagnostics | null;
  field_coverage: FieldCoverage | null;
  bucket: string | null;
  path: string | null;
  last_signed_url_at: string | null;
  /** AudienceLab request payload (sanitized, no PII) for debugging */
  request_payload: Record<string, unknown> | null;
  /** Number of leads originally requested */
  requested_count: number | null;
  /** Number of poll attempts for building status */
  poll_attempts: number;
  /** Last poll timestamp */
  last_polled_at: string | null;
  /** Number of leads suppressed by compliance filtering */
  suppressed_count: number;
  /** States that were suppressed */
  suppressed_states: string[] | null;
  /** When background processor should next check this export */
  next_poll_at: string | null;
  /** Quality tier used for filtering (hot, balanced, scale) */
  quality_tier: string | null;
  /** Intent pack ID applied */
  intent_pack: string | null;
  // Quality Gate fields
  /** Number of leads delivered after quality gate filtering */
  delivered_count: number | null;
  /** Number of leads rejected by quality gate */
  rejected_by_quality_count: number | null;
  /** Minimum quality score threshold used */
  min_quality_score_used: number | null;
  // Extended quality report fields
  /** Average quality score across delivered leads */
  avg_quality_score: number | null;
  /** Maximum quality score in export */
  max_quality_score: number | null;
  /** 90th percentile quality score */
  p90_quality_score: number | null;
  /** Percentage of delivered leads with wireless phone */
  pct_wireless: number | null;
  /** Percentage of delivered leads with full address */
  pct_with_address: number | null;
  /** Distribution of match scores as JSON */
  match_score_distribution: Record<string, number> | null;
  /** Warning message if fewer leads delivered than requested */
  quality_gate_warning: string | null;
  /** Count of leads with quality_score >= 70 */
  high_quality_count: number | null;
  /** Count of leads with quality_score >= 50 and < 70 */
  medium_quality_count: number | null;
  /** Count of leads with quality_score < 50 */
  low_quality_count: number | null;
}

/**
 * Input for creating a new export record.
 */
export interface CreateExportInput {
  provider: string;
  leadRequest: string;
  zipCodes: string[];
  target: string;
  useCase: string;
  audienceId?: string;
  requestId?: string;
  status: 'building' | 'success' | 'no_results' | 'error';
  /** AudienceLab request payload for debugging (sanitized, no PII) */
  requestPayload?: Record<string, unknown>;
  /** Number of leads requested */
  requestedCount?: number;
  /** Quality tier used for intent targeting */
  qualityTier?: string;
  /** Intent pack ID applied */
  intentPack?: string;
}

/**
 * Input for updating an export on success.
 */
export interface UpdateExportSuccessInput {
  status: 'success';
  totalFetched: number;
  kept: number;
  diagnostics: LeadQualityDiagnostics | null;
  fieldCoverage: FieldCoverage | null;
  bucket: string;
  path: string;
  /** Number of leads suppressed by compliance filtering */
  suppressedCount?: number;
  /** States that were suppressed */
  suppressedStates?: string[];
  // Quality Gate fields
  /** Number of leads delivered after quality gate filtering */
  deliveredCount?: number;
  /** Number of leads rejected by quality gate */
  rejectedByQualityCount?: number;
  /** Minimum quality score threshold used */
  minQualityScoreUsed?: number;
  // Extended quality report fields
  /** Average quality score across delivered leads */
  avgQualityScore?: number;
  /** Maximum quality score in export */
  maxQualityScore?: number;
  /** 90th percentile quality score */
  p90QualityScore?: number;
  /** Percentage of delivered leads with wireless phone */
  pctWireless?: number;
  /** Percentage of delivered leads with full address */
  pctWithAddress?: number;
  /** Distribution of match scores as JSON */
  matchScoreDistribution?: Record<string, number>;
  /** Warning message if fewer leads delivered than requested */
  qualityGateWarning?: string;
  /** Count of leads with quality_score >= 70 */
  highQualityCount?: number;
  /** Count of leads with quality_score >= 50 and < 70 */
  mediumQualityCount?: number;
  /** Count of leads with quality_score < 50 */
  lowQualityCount?: number;
}

/**
 * Input for updating an export on error or no results.
 */
export interface UpdateExportErrorInput {
  status: 'no_results' | 'error';
  errorCode?: string;
  errorMessage?: string;
  totalFetched?: number;
}

/**
 * Get Supabase client for database operations.
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
 * Create a new export record when a request starts.
 * Returns the created record ID for later updates.
 */
export async function createExport(input: CreateExportInput): Promise<string | null> {
  try {
    const supabase = getSupabaseClient();
    
    const { data, error } = await supabase
      .from('lead_exports')
      .insert({
        provider: input.provider,
        lead_request: input.leadRequest,
        zip_codes: input.zipCodes,
        target: input.target,
        use_case: input.useCase,
        audience_id: input.audienceId || null,
        request_id: input.requestId || null,
        status: input.status,
        request_payload: input.requestPayload || null,
        requested_count: input.requestedCount || null,
        quality_tier: input.qualityTier || null,
        intent_pack: input.intentPack || null,
      })
      .select('id')
      .single();

    if (error) {
      console.error('Failed to create export record:', error.message);
      return null;
    }

    return data?.id || null;
  } catch (err) {
    console.error('Export DB error (create):', err);
    return null;
  }
}

/**
 * Update an export record on success.
 */
export async function updateExportSuccess(
  exportId: string,
  input: UpdateExportSuccessInput
): Promise<boolean> {
  try {
    const supabase = getSupabaseClient();

    const { error } = await supabase
      .from('lead_exports')
      .update({
        status: input.status,
        total_fetched: input.totalFetched,
        kept: input.kept,
        diagnostics: input.diagnostics,
        field_coverage: input.fieldCoverage,
        bucket: input.bucket,
        path: input.path,
        suppressed_count: input.suppressedCount ?? 0,
        suppressed_states: input.suppressedStates ?? null,
        // Quality Gate fields
        delivered_count: input.deliveredCount ?? null,
        rejected_by_quality_count: input.rejectedByQualityCount ?? null,
        min_quality_score_used: input.minQualityScoreUsed ?? null,
        // Extended quality report fields
        avg_quality_score: input.avgQualityScore ?? null,
        max_quality_score: input.maxQualityScore ?? null,
        p90_quality_score: input.p90QualityScore ?? null,
        pct_wireless: input.pctWireless ?? null,
        pct_with_address: input.pctWithAddress ?? null,
        match_score_distribution: input.matchScoreDistribution ?? null,
        quality_gate_warning: input.qualityGateWarning ?? null,
        high_quality_count: input.highQualityCount ?? null,
        medium_quality_count: input.mediumQualityCount ?? null,
        low_quality_count: input.lowQualityCount ?? null,
      })
      .eq('id', exportId);

    if (error) {
      console.error('Failed to update export record:', error.message);
      return false;
    }

    return true;
  } catch (err) {
    console.error('Export DB error (updateSuccess):', err);
    return false;
  }
}

/**
 * Update an export record on error or no results.
 */
export async function updateExportError(
  exportId: string,
  input: UpdateExportErrorInput
): Promise<boolean> {
  try {
    const supabase = getSupabaseClient();

    const { error } = await supabase
      .from('lead_exports')
      .update({
        status: input.status,
        error_code: input.errorCode || null,
        error_message: input.errorMessage || null,
        total_fetched: input.totalFetched || null,
      })
      .eq('id', exportId);

    if (error) {
      console.error('Failed to update export error:', error.message);
      return false;
    }

    return true;
  } catch (err) {
    console.error('Export DB error (updateError):', err);
    return false;
  }
}

/**
 * Update export with audience_id after it becomes available.
 */
export async function updateExportAudienceId(
  exportId: string,
  audienceId: string
): Promise<boolean> {
  try {
    const supabase = getSupabaseClient();

    const { error } = await supabase
      .from('lead_exports')
      .update({ audience_id: audienceId })
      .eq('id', exportId);

    if (error) {
      console.error('Failed to update audience_id:', error.message);
      return false;
    }

    return true;
  } catch (err) {
    console.error('Export DB error (updateAudienceId):', err);
    return false;
  }
}

/**
 * Find export by audience_id (for status polling updates).
 */
export async function findExportByAudienceId(audienceId: string): Promise<LeadExport | null> {
  try {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from('lead_exports')
      .select('*')
      .eq('audience_id', audienceId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error) {
      if (error.code !== 'PGRST116') { // Not found is OK
        console.error('Failed to find export by audience_id:', error.message);
      }
      return null;
    }

    return data as LeadExport;
  } catch (err) {
    console.error('Export DB error (findByAudienceId):', err);
    return null;
  }
}

/**
 * List recent exports (most recent first).
 */
export async function listExports(limit: number = 25): Promise<LeadExport[]> {
  try {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from('lead_exports')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('Failed to list exports:', error.message);
      return [];
    }

    return (data || []) as LeadExport[];
  } catch (err) {
    console.error('Export DB error (list):', err);
    return [];
  }
}

/**
 * Get a single export by ID.
 */
export async function getExport(id: string): Promise<LeadExport | null> {
  try {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from('lead_exports')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      console.error('Failed to get export:', error.message);
      return null;
    }

    return data as LeadExport;
  } catch (err) {
    console.error('Export DB error (get):', err);
    return null;
  }
}

/**
 * Update last_signed_url_at timestamp.
 */
export async function updateLastSignedUrlAt(exportId: string): Promise<boolean> {
  try {
    const supabase = getSupabaseClient();

    const { error } = await supabase
      .from('lead_exports')
      .update({ last_signed_url_at: new Date().toISOString() })
      .eq('id', exportId);

    if (error) {
      console.error('Failed to update last_signed_url_at:', error.message);
      return false;
    }

    return true;
  } catch (err) {
    console.error('Export DB error (updateLastSignedUrlAt):', err);
    return false;
  }
}

/**
 * Create a signed URL for an existing export.
 * Returns null if export not found or has no path.
 */
export async function createSignedUrlForExport(
  exportId: string,
  expiresInSeconds: number = 86400
): Promise<{ signedUrl: string; expiresInSeconds: number } | null> {
  try {
    const exp = await getExport(exportId);
    if (!exp || !exp.bucket || !exp.path) {
      return null;
    }

    const supabase = getSupabaseClient();
    const { data, error } = await supabase.storage
      .from(exp.bucket)
      .createSignedUrl(exp.path, expiresInSeconds);

    if (error || !data?.signedUrl) {
      console.error('Failed to create signed URL:', error?.message);
      return null;
    }

    // Update last_signed_url_at
    await updateLastSignedUrlAt(exportId);

    return {
      signedUrl: data.signedUrl,
      expiresInSeconds,
    };
  } catch (err) {
    console.error('Export DB error (createSignedUrl):', err);
    return null;
  }
}

/**
 * Increment poll_attempts and update last_polled_at.
 * Returns the new poll_attempts count, or null on error.
 */
export async function incrementPollAttempts(exportId: string): Promise<number | null> {
  try {
    const supabase = getSupabaseClient();
    
    // First get current value
    const { data: current, error: fetchError } = await supabase
      .from('lead_exports')
      .select('poll_attempts')
      .eq('id', exportId)
      .single();
    
    if (fetchError) {
      console.error('Failed to fetch poll_attempts:', fetchError.message);
      return null;
    }
    
    const newAttempts = (current?.poll_attempts ?? 0) + 1;
    
    const { error: updateError } = await supabase
      .from('lead_exports')
      .update({
        poll_attempts: newAttempts,
        last_polled_at: new Date().toISOString(),
      })
      .eq('id', exportId);
    
    if (updateError) {
      console.error('Failed to increment poll_attempts:', updateError.message);
      return null;
    }
    
    return newAttempts;
  } catch (err) {
    console.error('Export DB error (incrementPollAttempts):', err);
    return null;
  }
}

/**
 * Get current poll attempts for an export.
 */
export async function getPollAttempts(exportId: string): Promise<number> {
  try {
    const supabase = getSupabaseClient();
    
    const { data, error } = await supabase
      .from('lead_exports')
      .select('poll_attempts')
      .eq('id', exportId)
      .single();
    
    if (error) {
      return 0;
    }
    
    return data?.poll_attempts ?? 0;
  } catch {
    return 0;
  }
}

/**
 * Update suppression stats on an export.
 */
export async function updateExportSuppression(
  exportId: string,
  suppressedCount: number,
  suppressedStates: string[]
): Promise<boolean> {
  try {
    const supabase = getSupabaseClient();
    
    const { error } = await supabase
      .from('lead_exports')
      .update({
        suppressed_count: suppressedCount,
        suppressed_states: suppressedStates,
      })
      .eq('id', exportId);
    
    if (error) {
      console.error('Failed to update suppression:', error.message);
      return false;
    }
    
    return true;
  } catch (err) {
    console.error('Export DB error (updateSuppression):', err);
    return false;
  }
}

/**
 * Transition an export to building_long status for background processing.
 * Called when interactive polling exceeds max attempts but provider is still building.
 */
export async function updateExportBuildingLong(
  exportId: string,
  nextPollMinutes: number = 5
): Promise<boolean> {
  try {
    const supabase = getSupabaseClient();
    const nextPollAt = new Date(Date.now() + nextPollMinutes * 60 * 1000).toISOString();
    
    const { error } = await supabase
      .from('lead_exports')
      .update({
        status: 'building_long',
        next_poll_at: nextPollAt,
      })
      .eq('id', exportId);
    
    if (error) {
      console.error('Failed to update export to building_long:', error.message);
      return false;
    }
    
    return true;
  } catch (err) {
    console.error('Export DB error (updateBuildingLong):', err);
    return false;
  }
}

/**
 * Find exports that need background processing.
 * Returns exports with status 'building' or 'building_long' where next_poll_at is null or past.
 */
export async function findPendingBackgroundExports(limit: number = 10): Promise<LeadExport[]> {
  try {
    const supabase = getSupabaseClient();
    const now = new Date().toISOString();
    
    const { data, error } = await supabase
      .from('lead_exports')
      .select('*')
      .in('status', ['building', 'building_long'])
      .or(`next_poll_at.is.null,next_poll_at.lte.${now}`)
      .order('created_at', { ascending: true })
      .limit(limit);
    
    if (error) {
      console.error('Failed to find pending background exports:', error.message);
      return [];
    }
    
    return (data || []) as LeadExport[];
  } catch (err) {
    console.error('Export DB error (findPendingBackgroundExports):', err);
    return [];
  }
}

/**
 * Update next_poll_at for scheduling the next background check.
 */
export async function updateNextPollAt(
  exportId: string,
  nextPollMinutes: number = 5
): Promise<boolean> {
  try {
    const supabase = getSupabaseClient();
    const nextPollAt = new Date(Date.now() + nextPollMinutes * 60 * 1000).toISOString();
    
    const { error } = await supabase
      .from('lead_exports')
      .update({
        next_poll_at: nextPollAt,
        last_polled_at: new Date().toISOString(),
      })
      .eq('id', exportId);
    
    if (error) {
      console.error('Failed to update next_poll_at:', error.message);
      return false;
    }
    
    return true;
  } catch (err) {
    console.error('Export DB error (updateNextPollAt):', err);
    return false;
  }
}

/**
 * Get full export details including all fields needed for background processing.
 */
export async function getExportForProcessing(id: string): Promise<LeadExport | null> {
  return getExport(id);
}

/**
 * GET /api/cron/process-exports
 * 
 * Background processor for long-running export builds.
 * Picks up exports with status 'building' or 'building_long' and processes them.
 * 
 * Authentication:
 * - Vercel Cron: Authorization header with Bearer token
 * - Manual trigger: x-cron-secret header or ?secret= query param
 * 
 * Query params:
 * - dryRun=1: Preview what would be processed without actual processing
 * - batchSize=N: Override default batch size (10)
 * 
 * Response:
 * { ok, runId, processed, completed, stillBuilding, failed, errors }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { fetchAudienceMembers } from '../_lib/providers/audiencelab.js';
import { validateProviderConfig, getProviderName } from '../_lib/providers/index.js';
import { leadsToCsv } from '../_lib/csv.js';
import {
  findPendingBackgroundExports,
  updateExportSuccess,
  updateExportError,
  updateNextPollAt,
  type LeadExport,
} from '../_lib/exports-db.js';
import { filterLeadsByStateCompliance } from '../_lib/compliance.js';
import { verifyCronSecret, CRON_AUTH_ERROR_RESPONSE } from '../_lib/cron-auth.js';
import type { LeadScope, UseCase } from '../_lib/types.js';

/** Background poll interval (minutes) */
const BACKGROUND_POLL_MINUTES = 5;

/** Max items to process per cron run (avoid Vercel function timeout) */
const DEFAULT_BATCH_SIZE = 10;

/** Generate unique run ID */
function generateRunId(): string {
  const ts = Date.now().toString(36);
  const rand = Math.random().toString(36).slice(2, 6);
  return `cron_${ts}_${rand}`;
}

/**
 * Structured log entry (safe for Vercel logs - no PII).
 */
function logEvent(event: string, data: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...data }));
}


/**
 * Get Supabase client for storage operations.
 */
function getSupabaseClient() {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    throw new Error('Supabase not configured');
  }

  return createClient(supabaseUrl, serviceKey);
}

/**
 * Process a single export - check provider, complete if ready.
 */
async function processExport(exp: LeadExport, runId: string): Promise<{
  status: 'completed' | 'still_building' | 'failed' | 'no_results';
  error?: string;
}> {
  const exportId = exp.id;
  
  // Skip if no audience_id (shouldn't happen, but be safe)
  if (!exp.audience_id) {
    logEvent('cron_skip_no_audience', { runId, exportId });
    return { status: 'failed', error: 'No audience_id' };
  }
  
  // Parse zip codes from array
  const zips = exp.zip_codes || [];
  if (zips.length === 0) {
    logEvent('cron_skip_no_zips', { runId, exportId });
    return { status: 'failed', error: 'No zip codes' };
  }
  
  // Build input for provider
  const input = {
    leadRequest: exp.lead_request,
    zips,
    scope: (exp.target === 'Commercial' ? 'commercial' : 'residential') as LeadScope,
    useCase: (exp.use_case || 'both') as UseCase,
  };
  
  try {
    // Check provider status
    const result = await fetchAudienceMembers(exp.audience_id, input, exp.request_id || undefined);
    
    if (result.ok) {
      // Provider ready! Complete the export
      const useCase = (exp.use_case || 'both') as UseCase;
      const complianceResult = filterLeadsByStateCompliance(result.leads, useCase);
      const leads = complianceResult.filteredLeads;
      const csv = leadsToCsv(leads);
      
      // Upload to storage
      const supabase = getSupabaseClient();
      const now = new Date();
      const dateDir = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
      const ts = Date.now();
      const rand = Math.random().toString(36).slice(2, 8);
      const path = `${dateDir}/${ts}-${rand}.csv`;
      const bucket = 'exports';
      
      const bytes = new TextEncoder().encode(csv);
      const uploadRes = await supabase.storage.from(bucket).upload(path, bytes, {
        contentType: 'text/csv',
        upsert: false,
      });
      
      if (uploadRes.error) {
        logEvent('cron_upload_error', { runId, exportId, error: uploadRes.error.message });
        return { status: 'failed', error: `Upload failed: ${uploadRes.error.message}` };
      }
      
      // Update export record with success
      await updateExportSuccess(exportId, {
        status: 'success',
        totalFetched: result.diagnostics?.totalFetched ?? (leads.length + complianceResult.suppressedCount),
        kept: leads.length,
        diagnostics: result.diagnostics ?? null,
        fieldCoverage: result.fieldCoverage ?? null,
        bucket,
        path,
        suppressedCount: complianceResult.suppressedCount,
        suppressedStates: complianceResult.suppressedStates,
      });
      
      logEvent('cron_export_completed', {
        runId,
        exportId,
        audienceId: exp.audience_id,
        count: leads.length,
        suppressedCount: complianceResult.suppressedCount,
      });
      
      return { status: 'completed' };
    }
    
    // Not ready yet
    const err = result.error;
    
    if (err.code === 'provider_building') {
      // Still building - schedule next check
      await updateNextPollAt(exportId, BACKGROUND_POLL_MINUTES);
      
      logEvent('cron_still_building', {
        runId,
        exportId,
        audienceId: exp.audience_id,
        pollAttempts: exp.poll_attempts,
      });
      
      return { status: 'still_building' };
    }
    
    if (err.code === 'provider_no_results') {
      // No results - mark accordingly
      await updateExportError(exportId, {
        status: 'no_results',
        errorCode: err.code,
        errorMessage: err.message,
      });
      
      logEvent('cron_no_results', { runId, exportId, audienceId: exp.audience_id });
      return { status: 'no_results' };
    }
    
    // Other error
    await updateExportError(exportId, {
      status: 'error',
      errorCode: err.code,
      errorMessage: err.message,
    });
    
    logEvent('cron_provider_error', {
      runId,
      exportId,
      audienceId: exp.audience_id,
      errorCode: err.code,
    });
    
    return { status: 'failed', error: err.message };
    
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    
    // Don't mark as failed for transient errors - just reschedule
    await updateNextPollAt(exportId, BACKGROUND_POLL_MINUTES);
    
    logEvent('cron_process_error', { runId, exportId, error: message });
    return { status: 'still_building', error: message };
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  const runId = generateRunId();
  const startTime = Date.now();
  
  // Only allow GET (Vercel Cron uses GET)
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({
      ok: false,
      error: { code: 'method_not_allowed', message: 'Use GET' },
    });
  }

  // Verify cron secret
  if (!verifyCronSecret(req)) {
    logEvent('cron_auth_failed', {
      runId,
      ip: req.headers['x-forwarded-for'] || req.headers['x-real-ip'],
      userAgent: req.headers['user-agent'],
    });
    
    return res.status(401).json(CRON_AUTH_ERROR_RESPONSE);
  }

  // Parse query params
  const dryRun = req.query?.dryRun === '1' || req.query?.dryRun === 'true';
  const batchSize = req.query?.batchSize 
    ? Math.min(parseInt(req.query.batchSize as string, 10) || DEFAULT_BATCH_SIZE, 20)
    : DEFAULT_BATCH_SIZE;

  logEvent('cron_process_exports_start', { runId, dryRun, batchSize });

  try {
    // Validate provider configuration
    try {
      validateProviderConfig();
    } catch {
      logEvent('cron_provider_config_error', { runId });
      return res.status(500).json({
        ok: false,
        error: { code: 'provider_not_configured', message: 'Provider not properly configured' },
      });
    }

    // Only works with audiencelab provider
    if (getProviderName() !== 'audiencelab') {
      return res.status(400).json({
        ok: false,
        error: { code: 'invalid_provider', message: 'Background processing only works with AudienceLab provider' },
      });
    }

    // Find pending exports
    const pendingExports = await findPendingBackgroundExports(batchSize);
    
    if (pendingExports.length === 0) {
      logEvent('cron_no_pending_exports', { runId });
      return res.status(200).json({
        ok: true,
        runId,
        dryRun,
        processed: 0,
        completed: 0,
        stillBuilding: 0,
        failed: 0,
        noResults: 0,
        message: 'No pending exports to process',
      });
    }

    // Dry run - just report what would be processed
    if (dryRun) {
      return res.status(200).json({
        ok: true,
        runId,
        dryRun: true,
        wouldProcess: pendingExports.length,
        exports: pendingExports.map(e => ({
          id: e.id,
          status: e.status,
          audienceId: e.audience_id,
          pollAttempts: e.poll_attempts,
          createdAt: e.created_at,
        })),
      });
    }

    // Process each export
    const results = {
      completed: 0,
      stillBuilding: 0,
      failed: 0,
      noResults: 0,
      errors: [] as string[],
    };

    for (const exp of pendingExports) {
      const result = await processExport(exp, runId);
      
      switch (result.status) {
        case 'completed':
          results.completed++;
          break;
        case 'still_building':
          results.stillBuilding++;
          break;
        case 'no_results':
          results.noResults++;
          break;
        case 'failed':
          results.failed++;
          if (result.error) {
            results.errors.push(`${exp.id}: ${result.error}`);
          }
          break;
      }
    }

    const durationMs = Date.now() - startTime;
    logEvent('cron_process_exports_complete', {
      runId,
      processed: pendingExports.length,
      ...results,
      durationMs,
    });

    // Build response
    const response: Record<string, unknown> = {
      ok: true,
      runId,
      dryRun: false,
      processed: pendingExports.length,
      completed: results.completed,
      stillBuilding: results.stillBuilding,
      noResults: results.noResults,
      failed: results.failed,
      durationMs,
    };

    if (results.errors.length > 0) {
      response.errors = results.errors;
    }

    return res.status(200).json(response);

  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    logEvent('cron_process_exports_error', { runId, error: message });
    
    return res.status(500).json({
      ok: false,
      runId,
      error: { code: 'internal_error', message },
    });
  }
}

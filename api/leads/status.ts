import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { fetchAudienceMembers } from '../_lib/providers/audiencelab.js';
import { validateProviderConfig, getProviderName } from '../_lib/providers/index.js';
import { leadsToCsv } from '../_lib/csv.js';
import { jsonError } from '../_lib/json.js';
import {
  AudienceLabAuthError,
  AudienceLabUpstreamError,
  AudienceLabContractError,
  AudienceLabAsyncError,
  ProviderConfigError,
  type LeadScope,
  type UseCase,
} from '../_lib/types.js';
import { ConfigError } from '../_lib/bytestring.js';
import { generateRequestId } from '../_lib/audiencelab-response.js';
import { requireSession } from '../_lib/auth.js';
import { checkRateLimit } from '../_lib/rate-limit.js';
import {
  findExportByAudienceId,
  updateExportSuccess,
  updateExportError,
  incrementPollAttempts,
  getExport,
} from '../_lib/exports-db.js';
import {
  filterLeadsByStateCompliance,
  calculateBackoffSeconds,
  hasExceededMaxAttempts,
  MAX_POLL_ATTEMPTS,
} from '../_lib/compliance.js';

/**
 * Structured log entry (safe for Vercel logs - no PII).
 */
function logEvent(event: string, data: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...data }));
}

/**
 * POST /api/leads/status
 * 
 * Poll for audience members after initial generate returned 202 building.
 * Implements exponential backoff polling with compliance filtering.
 * 
 * Request body:
 *   { audienceId: string, leadRequest: string, zipCodes: string, leadScope: string, useCase: string, requestId?: string, exportId?: string }
 * 
 * Responses:
 *   200: Success with signedUrl, count, suppressedCount
 *   202: Still building, poll again (includes nextPollSeconds with exponential backoff)
 *   404: Definitively no results after max attempts
 *   410: Max poll attempts exceeded (hard cap: 30)
 *   4xx/5xx: Various errors
 * 
 * Polling uses Fibonacci-based backoff: 3, 5, 8, 13, 21, 34, 55, 60s (capped)
 * After 30 attempts, returns 410 Gone with actionable error.
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Require authentication (returns non-null if 401 sent)
  if (requireSession(req, res)) return;
  
  // Rate limiting (120/hour)
  const rateLimited = await checkRateLimit(req, res, 'status');
  if (rateLimited) return;
  
  const requestId = generateRequestId();
  const startTime = Date.now();

  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return jsonError(res, 405, 'invalid_method', 'Method not allowed. Use POST.');
  }

  if (!req.body || typeof req.body !== 'object') {
    return jsonError(res, 400, 'invalid_body', 'Request body is required JSON.');
  }

  const body = req.body as Record<string, unknown>;
  const audienceId = typeof body.audienceId === 'string' ? body.audienceId.trim() : '';
  const leadRequest = typeof body.leadRequest === 'string' ? body.leadRequest.trim() : '';
  const zipCodesRaw = typeof body.zipCodes === 'string' ? body.zipCodes : '';
  const leadScope = typeof body.leadScope === 'string' ? body.leadScope.toLowerCase().trim() : '';
  const useCase = typeof body.useCase === 'string' ? body.useCase.toLowerCase().trim() as UseCase : 'both';
  const originalRequestId = typeof body.requestId === 'string' ? body.requestId : undefined;
  // exportId may be passed from generate.ts 202 response
  const exportIdFromBody = typeof body.exportId === 'string' ? body.exportId.trim() : undefined;

  // Validate required fields
  if (!audienceId) {
    return jsonError(res, 400, 'invalid_audience_id', 'audienceId is required.');
  }
  if (!leadRequest) {
    return jsonError(res, 400, 'invalid_lead_request', 'leadRequest is required.');
  }
  if (!['residential', 'commercial', 'both'].includes(leadScope)) {
    return jsonError(res, 400, 'invalid_scope', 'leadScope must be residential|commercial|both.');
  }

  // Parse ZIP codes
  const zips = zipCodesRaw.split(/[\s,]+/).map(z => z.trim()).filter(z => /^[0-9]{5}$/.test(z));
  if (zips.length === 0) {
    return jsonError(res, 400, 'invalid_zip_codes', 'At least one valid 5-digit ZIP code required.');
  }

  logEvent('status_start', { requestId, audienceId, originalRequestId });

  // ─────────────────────────────────────────────────────────────────────────
  // Resolve export record (by exportId or audienceId)
  // ─────────────────────────────────────────────────────────────────────────
  let exportId: string | null = exportIdFromBody ?? null;
  let currentPollAttempts = 0;
  
  if (!exportId) {
    try {
      const found = await findExportByAudienceId(audienceId);
      exportId = found?.id ?? null;
      currentPollAttempts = found?.poll_attempts ?? 0;
    } catch (err) {
      console.error('[status] Failed to find export by audienceId:', err);
    }
  } else {
    // Get current poll attempts from export record
    try {
      const exp = await getExport(exportId);
      currentPollAttempts = exp?.poll_attempts ?? 0;
    } catch {
      // Ignore - will default to 0
    }
  }
  
  if (exportId) {
    logEvent('status_export_found', { requestId, exportId, currentPollAttempts });
  }
  
  // ─────────────────────────────────────────────────────────────────────────
  // Check if max poll attempts exceeded (hard cap)
  // ─────────────────────────────────────────────────────────────────────────
  if (hasExceededMaxAttempts(currentPollAttempts)) {
    logEvent('status_max_attempts_exceeded', { requestId, exportId, attempts: currentPollAttempts });
    
    // Mark export as failed
    if (exportId) {
      updateExportError(exportId, {
        status: 'error',
        errorCode: 'max_poll_attempts',
        errorMessage: `Audience build timed out after ${currentPollAttempts} poll attempts`,
      }).catch(console.error);
    }
    
    return res.status(410).json({
      ok: false,
      error: {
        code: 'max_poll_attempts',
        message: `Audience build timed out after ${MAX_POLL_ATTEMPTS} poll attempts. The audience may still be processing in AudienceLab. Try again later or create a new request.`,
        details: {
          audienceId,
          exportId,
          attempts: currentPollAttempts,
          maxAttempts: MAX_POLL_ATTEMPTS,
        },
      },
    });
  }

  // Validate provider configuration
  try {
    validateProviderConfig();
  } catch (err) {
    if (err instanceof ProviderConfigError) {
      logEvent('status_config_error', { requestId, provider: err.provider });
      return jsonError(res, 500, err.code, err.message, { ...err.toSafeContext(), hint: err.hint });
    }
    throw err;
  }

  // Only works with audiencelab provider
  if (getProviderName() !== 'audiencelab') {
    return jsonError(res, 400, 'invalid_provider', 'Status polling only works with AudienceLab provider.');
  }

  const input = {
    leadRequest,
    zips,
    scope: leadScope as LeadScope,
    useCase,
  };

  // Single poll attempt per request (client handles retry with backoff)
  // This avoids Vercel function timeout issues
  let lastResult;

  // Increment poll attempts
  if (exportId) {
    const newAttempts = await incrementPollAttempts(exportId);
    if (newAttempts !== null) {
      currentPollAttempts = newAttempts;
    }
  }
  
  try {
    lastResult = await fetchAudienceMembers(audienceId, input, originalRequestId || requestId);

    if (lastResult.ok) {
      // Success! Apply compliance filtering, then generate CSV and upload
      const complianceResult = filterLeadsByStateCompliance(lastResult.leads, useCase);
      const leads = complianceResult.filteredLeads;
      const csv = leadsToCsv(leads);

        const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
        const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

        if (!supabaseUrl || !serviceKey) {
          return jsonError(res, 500, 'server_config_error', 'Missing Supabase configuration.', {
            missing: {
              SUPABASE_URL_or_VITE_SUPABASE_URL: !supabaseUrl,
              SUPABASE_SERVICE_ROLE_KEY: !serviceKey,
            },
          });
        }

        const supabase = createClient(supabaseUrl, serviceKey);

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
          logEvent('status_upload_error', { requestId, error: uploadRes.error.message });
          return jsonError(res, 500, 'upload_error', 'Failed to upload CSV.', { message: uploadRes.error.message });
        }

        const expiresInSeconds = 24 * 60 * 60;
        const signedRes = await supabase.storage.from(bucket).createSignedUrl(path, expiresInSeconds);

        if (signedRes.error || !signedRes.data) {
          logEvent('status_signed_url_error', { requestId, error: signedRes.error?.message });
          return jsonError(res, 500, 'signed_url_error', 'Failed to generate signed URL.', { message: signedRes.error?.message });
        }

        const durationMs = Date.now() - startTime;
        logEvent('status_success', {
          requestId,
          audienceId,
          pollAttempts: currentPollAttempts,
          count: leads.length,
          suppressedCount: complianceResult.suppressedCount,
          durationMs,
          diagnostics: lastResult.diagnostics,
          fieldCoverage: lastResult.fieldCoverage,
        });

        // ─────────────────────────────────────────────────────────────────────
        // Update export record with success
        // ─────────────────────────────────────────────────────────────────────
        if (exportId) {
          try {
            await updateExportSuccess(exportId, {
              status: 'success',
              totalFetched: lastResult.diagnostics?.totalFetched ?? (leads.length + complianceResult.suppressedCount),
              kept: leads.length,
              diagnostics: lastResult.diagnostics ?? null,
              fieldCoverage: lastResult.fieldCoverage ?? null,
              bucket,
              path,
              suppressedCount: complianceResult.suppressedCount,
              suppressedStates: complianceResult.suppressedStates,
            });
            logEvent('export_updated', { requestId, exportId, status: 'success' });
          } catch (dbErr) {
            console.error('[status] Failed to update export record:', dbErr);
          }
        }

        return res.status(200).json({
          ok: true,
          count: leads.length,
          bucket,
          path,
          signedUrl: signedRes.data.signedUrl,
          expiresInSeconds,
          audienceId,
          requestId,
          exportId,
          quality: lastResult.diagnostics,
          fieldCoverage: lastResult.fieldCoverage,
          // Compliance info
          suppressedCount: complianceResult.suppressedCount,
          suppressedStates: complianceResult.suppressedStates.length > 0 ? complianceResult.suppressedStates : undefined,
          pollAttempts: currentPollAttempts,
        });
    }

  } catch (err) {
    // Handle typed errors
    if (err instanceof ProviderConfigError) {
      logEvent('status_config_error', { requestId, provider: err.provider });
      return jsonError(res, 500, err.code, err.message, { ...err.toSafeContext(), hint: err.hint });
    }
    if (err instanceof AudienceLabAuthError) {
      logEvent('status_auth_error', { requestId, status: err.status });
      return jsonError(res, 502, err.code, 'Unauthorized.', { ...err.toSafeContext(), hint: err.hint });
    }
    if (err instanceof AudienceLabUpstreamError) {
      logEvent('status_upstream_error', { requestId, status: err.status });
      return jsonError(res, 502, err.code, 'AudienceLab upstream error.', err.toSafeContext());
    }
    if (err instanceof AudienceLabContractError) {
      logEvent('status_contract_error', { requestId, code: err.code });
      return jsonError(res, 502, err.code, err.message, { ...err.toSafeContext(), hint: err.hint });
    }
    if (err instanceof AudienceLabAsyncError) {
      logEvent('status_async_error', { requestId });
      return jsonError(res, 502, err.code, 'AudienceLab async response.', { ...err.toSafeContext(), hint: err.hint });
    }
    if (err instanceof ConfigError) {
      logEvent('status_config_error', { requestId, code: err.code });
      return jsonError(res, 500, err.code, err.message, { ...err.toSafeContext(), hint: err.hint });
    }

    const message = err instanceof Error ? err.message : 'Unknown error';
    logEvent('status_unknown_error', { requestId, message });
    return jsonError(res, 500, 'internal_error', message);
  }

  // Return final state
  if (lastResult && !lastResult.ok) {
    const err = lastResult.error;

    // Still building - return 202 with backoff recommendation
    if (err.code === 'provider_building') {
      const nextPollSeconds = calculateBackoffSeconds(currentPollAttempts + 1);
      logEvent('status_still_building', { requestId, audienceId, pollAttempts: currentPollAttempts, nextPollSeconds });
      
      return res.status(202).json({
        ok: false,
        error: {
          code: 'provider_building',
          message: 'Audience is still building. Continue polling.',
          details: {
            audienceId,
            requestId,
            exportId,
            pollAttempts: currentPollAttempts,
            maxAttempts: MAX_POLL_ATTEMPTS,
            nextPollSeconds,
          },
        },
      });
    }

    // provider_no_results after building is complete - definitively no results
    logEvent('status_no_results', { requestId, audienceId, code: err.code });
    
    // Update export with no_results error
    if (exportId) {
      updateExportError(exportId, { status: 'no_results', errorCode: err.code, errorMessage: err.message }).catch(console.error);
    }
    
    return jsonError(res, 404, err.code, err.message, err.details);
  }

  // Shouldn't reach here, but handle gracefully
  logEvent('status_unexpected', { requestId, audienceId });
  return jsonError(res, 500, 'internal_error', 'Unexpected state in status handler.');
}

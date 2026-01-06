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

/**
 * Structured log entry (safe for Vercel logs - no PII).
 */
function logEvent(event: string, data: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...data }));
}

/**
 * Sleep helper for polling backoff.
 */
function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * POST /api/leads/status
 * 
 * Poll for audience members after initial generate returned 202 building.
 * Implements short polling with backoff (2-3 attempts over ~3-6s max).
 * 
 * Request body:
 *   { audienceId: string, leadRequest: string, zipCodes: string, leadScope: string, requestId?: string }
 * 
 * Responses:
 *   200: Success with signedUrl
 *   202: Still building, poll again
 *   404: Definitively no results after max attempts
 *   4xx/5xx: Various errors
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
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

  // Poll with backoff: up to 3 attempts, 2s apart (max ~6s total within Vercel limits)
  const maxAttempts = 3;
  const pollIntervalMs = 2000;
  let lastResult;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      lastResult = await fetchAudienceMembers(audienceId, input, originalRequestId || requestId);

      if (lastResult.ok) {
        // Success! Generate CSV and upload
        const leads = lastResult.leads;
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
          attempt,
          count: leads.length,
          durationMs,
          diagnostics: lastResult.diagnostics,
          fieldCoverage: lastResult.fieldCoverage,
        });

        return res.status(200).json({
          ok: true,
          count: leads.length,
          bucket,
          path,
          signedUrl: signedRes.data.signedUrl,
          expiresInSeconds,
          audienceId,
          requestId,
          quality: lastResult.diagnostics,
          fieldCoverage: lastResult.fieldCoverage,
        });
      }

      // Still building - check if we should retry
      if (lastResult.error.code === 'provider_building' && attempt < maxAttempts) {
        logEvent('status_building', { requestId, audienceId, attempt });
        await sleep(pollIntervalMs);
        continue;
      }

      // Last attempt or non-building error - return current state
      break;

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
  }

  // Return final state after all attempts
  if (lastResult && !lastResult.ok) {
    const err = lastResult.error;

    // Still building after max attempts - return 202 to let client continue polling
    if (err.code === 'provider_building') {
      logEvent('status_still_building', { requestId, audienceId, maxAttempts });
      return res.status(202).json({
        ok: false,
        error: {
          code: 'provider_building',
          message: 'Audience is still building. Continue polling.',
          details: {
            audienceId,
            requestId,
            retryAfterSeconds: 2,
          },
        },
      });
    }

    // provider_no_results after building is complete - definitively no results
    logEvent('status_no_results', { requestId, audienceId, code: err.code });
    return jsonError(res, 404, err.code, err.message, err.details);
  }

  // Shouldn't reach here, but handle gracefully
  logEvent('status_unexpected', { requestId, audienceId });
  return jsonError(res, 500, 'internal_error', 'Unexpected state in status handler.');
}

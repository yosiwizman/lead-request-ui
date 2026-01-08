import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { generateLeads, getProviderName } from '../_lib/providers/index.js';
import { leadsToCsv } from '../_lib/csv.js';
import { validatePayload } from '../_lib/validation.js';
import { jsonError } from '../_lib/json.js';
import {
  AudienceLabAuthError,
  AudienceLabUpstreamError,
  AudienceLabContractError,
  AudienceLabAsyncError,
  ProviderConfigError,
} from '../_lib/types.js';
import { ConfigError } from '../_lib/bytestring.js';
import { generateRequestId } from '../_lib/audiencelab-response.js';
import { requireSession } from '../_lib/auth.js';
import { checkRateLimit } from '../_lib/rate-limit.js';
import {
  createExport,
  updateExportSuccess,
  updateExportError,
  updateExportAudienceId,
} from '../_lib/exports-db.js';

/**
 * Structured log entry (safe for Vercel logs - no PII).
 */
function logEvent(event: string, data: Record<string, unknown>): void {
  console.log(JSON.stringify({ event, ts: new Date().toISOString(), ...data }));
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Require authentication (returns non-null if 401 sent)
  if (requireSession(req, res)) return;
  
  // Rate limiting (20/hour)
  const rateLimited = await checkRateLimit(req, res, 'generate');
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

  const validation = validatePayload(req.body as Record<string, unknown>);
  if (!validation.ok) {
    const err = validation.error;
    return jsonError(res, 400, err.code, err.message, err.details);
  }

  const { leadRequest, zips, scope, useCase } = validation.data;
  
  logEvent('generate_start', { requestId, zipCount: zips.length, scope, useCase });

  // ─────────────────────────────────────────────────────────────────────────
  // Create export record in database (status=building)
  // ─────────────────────────────────────────────────────────────────────────
  let exportId: string | null = null;
  try {
    exportId = await createExport({
      provider: getProviderName(),
      leadRequest,
      zipCodes: zips,
      target: String(zips.length), // Target count as string
      useCase,
      requestId,
      status: 'building',
    });
    logEvent('export_created', { requestId, exportId });
  } catch (dbErr) {
    // Log but don't fail - export tracking is non-critical
    console.error('[generate] Failed to create export record:', dbErr);
  }

  // Generate leads using configured provider
  let result;
  try {
    result = await generateLeads({ leadRequest, zips, scope, useCase });
  } catch (err) {
    // Handle provider configuration errors (missing API key when audiencelab expected)
    if (err instanceof ProviderConfigError) {
      logEvent('generate_config_error', { requestId, provider: err.provider });
      // Update export record with error
      if (exportId) {
        updateExportError(exportId, { status: 'error', errorCode: err.code, errorMessage: err.message }).catch(console.error);
      }
      return jsonError(
        res,
        500,
        err.code,
        err.message,
        { ...err.toSafeContext(), hint: err.hint }
      );
    }
    // Handle typed AudienceLab errors with standardized response
    if (err instanceof AudienceLabAuthError) {
      logEvent('generate_auth_error', { requestId, status: err.status });
      if (exportId) {
        updateExportError(exportId, { status: 'error', errorCode: err.code, errorMessage: 'AudienceLab auth error' }).catch(console.error);
      }
      return jsonError(
        res,
        502,
        err.code,
        'Unauthorized: invalid key, wrong workspace, revoked key, or missing permissions.',
        { ...err.toSafeContext(), hint: err.hint }
      );
    }
    if (err instanceof AudienceLabUpstreamError) {
      logEvent('generate_upstream_error', { requestId, status: err.status });
      if (exportId) {
        updateExportError(exportId, { status: 'error', errorCode: err.code, errorMessage: 'AudienceLab upstream error' }).catch(console.error);
      }
      return jsonError(
        res,
        502,
        err.code,
        'AudienceLab upstream service error.',
        err.toSafeContext()
      );
    }
    // Handle contract errors (response shape mismatch)
    if (err instanceof AudienceLabContractError) {
      logEvent('generate_contract_error', { requestId, code: err.code });
      if (exportId) {
        updateExportError(exportId, { status: 'error', errorCode: err.code, errorMessage: err.message }).catch(console.error);
      }
      return jsonError(
        res,
        502,
        err.code,
        err.message,
        { ...err.toSafeContext(), hint: err.hint }
      );
    }
    // Handle async/job responses
    if (err instanceof AudienceLabAsyncError) {
      logEvent('generate_async_error', { requestId });
      if (exportId) {
        updateExportError(exportId, { status: 'error', errorCode: err.code, errorMessage: 'AudienceLab async error' }).catch(console.error);
      }
      return jsonError(
        res,
        502,
        err.code,
        'AudienceLab returned an async job response.',
        { ...err.toSafeContext(), hint: err.hint }
      );
    }
    // Handle configuration errors (e.g. BOM in API key)
    if (err instanceof ConfigError) {
      logEvent('generate_config_error', { requestId, code: err.code });
      if (exportId) {
        updateExportError(exportId, { status: 'error', errorCode: err.code, errorMessage: err.message }).catch(console.error);
      }
      return jsonError(
        res,
        500,
        err.code,
        err.message,
        { ...err.toSafeContext(), hint: err.hint }
      );
    }
    // Unknown errors
    const message = err instanceof Error ? err.message : 'Unknown error';
    logEvent('generate_unknown_error', { requestId, message });
    if (exportId) {
      updateExportError(exportId, { status: 'error', errorCode: 'internal_error', errorMessage: message }).catch(console.error);
    }
    return jsonError(res, 500, 'internal_error', message);
  }

  if (!result.ok) {
    const err = result.error;
    
    // Handle provider_building: return HTTP 202 Accepted (audience building async)
    if (err.code === 'provider_building') {
      const audienceId = (err.details as Record<string, unknown>)?.audienceId as string;
      logEvent('generate_building', { requestId, audienceId });
      
      // Update export with audienceId so status.ts can find it later
      if (exportId && audienceId) {
        updateExportAudienceId(exportId, audienceId).catch(console.error);
      }
      
      return res.status(202).json({
        ok: false,
        error: {
          code: 'provider_building',
          message: 'Audience is building. Poll /api/leads/status for results.',
          details: {
            audienceId,
            leadRequest,
            zipCodes: zips.join(','),
            leadScope: scope,
            useCase,
            requestId,
            retryAfterSeconds: 2,
            exportId, // Include exportId for status.ts to update
          },
        },
      });
    }
    
    // Map provider errors: 404 for no results, 502 for other upstream failures
    const status = err.code === 'provider_no_results' ? 404 : 502;
    logEvent('generate_error', { requestId, code: err.code, status });
    
    // Update export with error
    if (exportId) {
      const errStatus = err.code === 'provider_no_results' ? 'no_results' : 'error';
      updateExportError(exportId, { status: errStatus, errorCode: err.code, errorMessage: err.message }).catch(console.error);
    }
    
    return jsonError(res, status, err.code, err.message, err.details);
  }

  const leads = result.leads;
  const csv = leadsToCsv(leads);

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return jsonError(res, 500, 'server_config_error', 'Missing Supabase configuration on server.', {
      missing: {
        SUPABASE_URL_or_VITE_SUPABASE_URL: !supabaseUrl,
        SUPABASE_SERVICE_ROLE_KEY: !serviceKey,
      },
    });
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const dateDir = `${yyyy}-${mm}-${dd}`;
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
    logEvent('generate_upload_error', { requestId, error: uploadRes.error.message });
    return jsonError(res, 500, 'upload_error', 'Failed to upload CSV to storage.', { message: uploadRes.error.message });
  }

  const expiresInSeconds = 24 * 60 * 60;
  const signedRes = await supabase.storage.from(bucket).createSignedUrl(path, expiresInSeconds);

  if (signedRes.error || !signedRes.data) {
    logEvent('generate_signed_url_error', { requestId, error: signedRes.error?.message });
    return jsonError(res, 500, 'signed_url_error', 'Failed to generate signed URL.', { message: signedRes.error?.message });
  }

  const durationMs = Date.now() - startTime;
  logEvent('generate_success', { 
    requestId, 
    audienceId: result.audienceId,
    count: leads.length, 
    durationMs,
    diagnostics: result.diagnostics,
    fieldCoverage: result.fieldCoverage,
  });

  // ─────────────────────────────────────────────────────────────────────────
  // Update export record with success
  // ─────────────────────────────────────────────────────────────────────────
  if (exportId) {
    try {
      await updateExportSuccess(exportId, {
        status: 'success',
        totalFetched: result.diagnostics?.totalFetched ?? leads.length,
        kept: leads.length,
        diagnostics: result.diagnostics ?? null,
        fieldCoverage: result.fieldCoverage ?? null,
        bucket,
        path,
      });
      logEvent('export_updated', { requestId, exportId, status: 'success' });
    } catch (dbErr) {
      console.error('[generate] Failed to update export record:', dbErr);
    }
  }

  return res.status(200).json({
    ok: true,
    count: leads.length,
    bucket,
    path,
    signedUrl: signedRes.data.signedUrl,
    expiresInSeconds,
    audienceId: result.audienceId,
    requestId,
    exportId,
    quality: result.diagnostics,
    fieldCoverage: result.fieldCoverage,
  });
}

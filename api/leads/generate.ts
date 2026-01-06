import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';
import { generateLeads } from '../_lib/providers/index.js';
import { leadsToCsv } from '../_lib/csv.js';
import { validatePayload } from '../_lib/validation.js';
import { jsonError } from '../_lib/json.js';
import {
  AudienceLabAuthError,
  AudienceLabUpstreamError,
  AudienceLabContractError,
  AudienceLabAsyncError,
} from '../_lib/types.js';
import { ConfigError } from '../_lib/bytestring.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
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

  const { leadRequest, zips, scope } = validation.data;

  // Generate leads using configured provider
  let result;
  try {
    result = await generateLeads({ leadRequest, zips, scope });
  } catch (err) {
    // Handle typed AudienceLab errors with standardized response
    if (err instanceof AudienceLabAuthError) {
      return jsonError(
        res,
        502,
        err.code,
        'Unauthorized: invalid key, wrong workspace, revoked key, or missing permissions.',
        { ...err.toSafeContext(), hint: err.hint }
      );
    }
    if (err instanceof AudienceLabUpstreamError) {
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
    return jsonError(res, 500, 'internal_error', message);
  }

  if (!result.ok) {
    const err = result.error;
    // Map provider errors to HTTP 502 (Bad Gateway) for upstream failures
    // or 404 for no results - client should not retry no_results
    const status = err.code === 'provider_no_results' ? 404 : 502;
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
    return jsonError(res, 500, 'upload_error', 'Failed to upload CSV to storage.', { message: uploadRes.error.message });
  }

  const expiresInSeconds = 24 * 60 * 60;
  const signedRes = await supabase.storage.from(bucket).createSignedUrl(path, expiresInSeconds);

  if (signedRes.error || !signedRes.data) {
    return jsonError(res, 500, 'signed_url_error', 'Failed to generate signed URL.', { message: signedRes.error?.message });
  }

  return res.status(200).json({
    ok: true,
    count: leads.length,
    bucket,
    path,
    signedUrl: signedRes.data.signedUrl,
    expiresInSeconds,
  });
}

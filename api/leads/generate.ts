import type { Lead } from '../../src/types';
import { generateLeads } from '../../src/server/providers/mock';
import { leadsToCsv } from '../../src/server/csv';
import { validatePayload } from '../../src/server/validation';
import { createClient } from '@supabase/supabase-js';

type Json = Record<string, unknown>;

const jsonError = (res: any, status: number, code: string, message: string, details?: Json) => {
  res.status(status).json({
    ok: false,
    error: { code, message, ...(details ? { details } : {}) },
  });
};

export default async function handler(req: any, res: any) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return jsonError(res, 405, 'invalid_method', 'Method not allowed. Use POST.');
  }

  if (!req.body) {
    return jsonError(res, 400, 'invalid_body', 'Request body is required JSON.');
  }

  const validation = validatePayload(req.body);
  if (!validation.ok) {
    const err = validation.error!;
    return jsonError(res, 400, err.code, err.message, err.details);
  }

  const { leadRequest, zips, scope } = validation.data!;

  // Generate leads using provider abstraction (mock by default)
  const leads: Lead[] = generateLeads({ leadRequest, zips, scope });

  // Build CSV
  const csv = leadsToCsv(leads);

  // Prepare Supabase client (server-side: service role key)
  const supabaseUrl = process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return jsonError(
      res,
      500,
      'server_config_error',
      'Missing Supabase configuration on server.',
      {
        missing: {
          VITE_SUPABASE_URL: !supabaseUrl,
          SUPABASE_SERVICE_ROLE_KEY: !serviceKey,
        },
      }
    );
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  // Filename: exports/<yyyy-mm-dd>/<timestamp>-<random>.csv (bucket is 'exports')
  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const dateDir = `${yyyy}-${mm}-${dd}`;
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const path = `${dateDir}/${ts}-${rand}.csv`;
  const filePath = `exports/${path}`;

  // Upload CSV
  const uploadRes = await supabase.storage
    .from('exports')
    .upload(path, Buffer.from(csv, 'utf-8'), {
      contentType: 'text/csv',
      upsert: false,
    });

  if (uploadRes.error) {
    return jsonError(
      res,
      500,
      'upload_error',
      'Failed to upload CSV to storage.',
      { message: uploadRes.error.message }
    );
  }

  // Create signed URL (24 hours)
  const expiresInSeconds = 24 * 60 * 60;
  const signedRes = await supabase.storage
    .from('exports')
    .createSignedUrl(path, expiresInSeconds);

  if (signedRes.error || !signedRes.data) {
    return jsonError(
      res,
      500,
      'signed_url_error',
      'Failed to generate signed URL.',
      { message: signedRes.error?.message }
    );
  }

  return res.status(200).json({
    ok: true,
    count: leads.length,
    filePath,
    signedUrl: signedRes.data.signedUrl,
    expiresInSeconds,
  });
}
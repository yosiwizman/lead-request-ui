import type { VercelRequest, VercelResponse } from '@vercel/node';
import { jsonError } from '../_lib/json.js';
import { requireSession } from '../_lib/auth.js';
import { getExport } from '../_lib/exports-db.js';

/**
 * GET /api/debug/generation?id={exportId}
 * 
 * Returns the stored AudienceLab request payload for a generation request.
 * Useful for debugging why certain filters produced specific results.
 * 
 * Requires authentication (same as generate endpoint).
 */
export default async function handler(req: VercelRequest, res: VercelResponse) {
  // Require authentication
  if (requireSession(req, res)) return;
  
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return jsonError(res, 405, 'invalid_method', 'Method not allowed. Use GET.');
  }

  const { id } = req.query;
  
  if (!id || typeof id !== 'string') {
    return jsonError(res, 400, 'missing_id', 'Export ID is required. Use ?id={exportId}');
  }

  // UUID validation
  const uuidRegex = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
  if (!uuidRegex.test(id)) {
    return jsonError(res, 400, 'invalid_id', 'Export ID must be a valid UUID.');
  }

  try {
    const exportRecord = await getExport(id);
    
    if (!exportRecord) {
      return jsonError(res, 404, 'not_found', 'Export not found.');
    }

    // Return debug info including the request payload
    return res.status(200).json({
      ok: true,
      export: {
        id: exportRecord.id,
        created_at: exportRecord.created_at,
        updated_at: exportRecord.updated_at,
        provider: exportRecord.provider,
        lead_request: exportRecord.lead_request,
        zip_codes: exportRecord.zip_codes,
        target: exportRecord.target,
        use_case: exportRecord.use_case,
        audience_id: exportRecord.audience_id,
        request_id: exportRecord.request_id,
        status: exportRecord.status,
        error_code: exportRecord.error_code,
        error_message: exportRecord.error_message,
        total_fetched: exportRecord.total_fetched,
        kept: exportRecord.kept,
        requested_count: exportRecord.requested_count,
        // The main purpose of this endpoint - inspect the actual AL payload
        request_payload: exportRecord.request_payload,
        // Quality diagnostics
        diagnostics: exportRecord.diagnostics,
        field_coverage: exportRecord.field_coverage,
        // Storage location (no signed URL - use /api/exports/signed-url for that)
        bucket: exportRecord.bucket,
        path: exportRecord.path,
      },
    });
  } catch (err) {
    console.error('[debug/generation] Error:', err);
    return jsonError(res, 500, 'internal_error', 'Failed to fetch export details.');
  }
}

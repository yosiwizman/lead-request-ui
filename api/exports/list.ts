/**
 * @file api/exports/list.ts
 * @description GET endpoint to list recent exports for the authenticated user.
 *              Returns export metadata (no PII) with status, counts, and timestamps.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireSession } from '../_lib/auth.js';
import { listExports, type LeadExport } from '../_lib/exports-db.js';

/* -------------------------------------------------------------------------- */
/*                                  TYPES                                     */
/* -------------------------------------------------------------------------- */

interface ExportListItem {
  id: string;
  createdAt: string;
  provider: string;
  leadRequest: string;
  zipCodes: string[];
  target: number;
  useCase: string | null;
  status: string;
  errorCode: string | null;
  errorMessage: string | null;
  totalFetched: number | null;
  kept: number | null;
  hasFile: boolean;
  lastSignedUrlAt: string | null;
}

interface ListExportsResponse {
  ok: true;
  exports: ExportListItem[];
  total: number;
}

interface ErrorResponse {
  ok: false;
  error: string;
}

/* -------------------------------------------------------------------------- */
/*                                 HELPERS                                    */
/* -------------------------------------------------------------------------- */

/**
 * Transform database row to API response format
 */
function toListItem(row: LeadExport): ExportListItem {
  return {
    id: row.id,
    createdAt: row.created_at,
    provider: row.provider,
    leadRequest: row.lead_request,
    zipCodes: row.zip_codes,
    target: parseInt(row.target, 10) || 0,
    useCase: row.use_case,
    status: row.status,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    totalFetched: row.total_fetched,
    kept: row.kept,
    hasFile: !!(row.bucket && row.path),
    lastSignedUrlAt: row.last_signed_url_at,
  };
}

/* -------------------------------------------------------------------------- */
/*                                 HANDLER                                    */
/* -------------------------------------------------------------------------- */

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // ─────────────────────────────────────────────────────────────────────────
  // Session guard
  // ─────────────────────────────────────────────────────────────────────────
  const sessionOk = await requireSession(req, res);
  if (!sessionOk) return;

  // ─────────────────────────────────────────────────────────────────────────
  // Method check
  // ─────────────────────────────────────────────────────────────────────────
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    const errorResp: ErrorResponse = { ok: false, error: 'Method not allowed' };
    res.status(405).json(errorResp);
    return;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Parse query params
  // ─────────────────────────────────────────────────────────────────────────
  const limitParam = req.query.limit;
  let limit = 25;
  if (typeof limitParam === 'string') {
    const parsed = parseInt(limitParam, 10);
    if (!isNaN(parsed) && parsed > 0 && parsed <= 100) {
      limit = parsed;
    }
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Fetch exports
  // ─────────────────────────────────────────────────────────────────────────
  try {
    const exports = await listExports(limit);
    
    const response: ListExportsResponse = {
      ok: true,
      exports: exports.map(toListItem),
      total: exports.length,
    };

    res.status(200).json(response);
  } catch (err) {
    console.error('[exports/list] Database error:', err);
    const errorResp: ErrorResponse = {
      ok: false,
      error: 'Failed to fetch exports',
    };
    res.status(500).json(errorResp);
  }
}

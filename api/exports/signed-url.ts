/**
 * @file api/exports/signed-url.ts
 * @description POST endpoint to generate a fresh signed URL for an existing export.
 *              Allows users to re-download exports after the original signed URL expires.
 */
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { requireSession } from '../_lib/auth.js';
import { createSignedUrlForExport } from '../_lib/exports-db.js';

/* -------------------------------------------------------------------------- */
/*                                  TYPES                                     */
/* -------------------------------------------------------------------------- */

interface SignedUrlRequest {
  exportId: string;
}

interface SignedUrlResponse {
  ok: true;
  signedUrl: string;
  expiresIn: number; // seconds
}

interface ErrorResponse {
  ok: false;
  error: string;
  code?: string;
}

/* -------------------------------------------------------------------------- */
/*                                CONSTANTS                                   */
/* -------------------------------------------------------------------------- */

/** Signed URL expiration in seconds (1 hour) */
const SIGNED_URL_EXPIRES_IN = 3600;

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
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    const errorResp: ErrorResponse = { ok: false, error: 'Method not allowed' };
    res.status(405).json(errorResp);
    return;
  }

  // ─────────────────────────────────────────────────────────────────────────
  // Parse request body
  // ─────────────────────────────────────────────────────────────────────────
  const body = req.body as Partial<SignedUrlRequest> | undefined;
  
  if (!body || typeof body.exportId !== 'string' || !body.exportId.trim()) {
    const errorResp: ErrorResponse = {
      ok: false,
      error: 'Missing or invalid exportId',
      code: 'INVALID_REQUEST',
    };
    res.status(400).json(errorResp);
    return;
  }

  const exportId = body.exportId.trim();

  // ─────────────────────────────────────────────────────────────────────────
  // Generate signed URL (function handles all validation internally)
  // ─────────────────────────────────────────────────────────────────────────
  try {
    const result = await createSignedUrlForExport(exportId, SIGNED_URL_EXPIRES_IN);

    if (!result) {
      const errorResp: ErrorResponse = {
        ok: false,
        error: 'Export not found or has no downloadable file',
        code: 'NOT_FOUND_OR_NO_FILE',
      };
      res.status(404).json(errorResp);
      return;
    }

    // ─────────────────────────────────────────────────────────────────────────
    // Return success
    // ─────────────────────────────────────────────────────────────────────────
    const response: SignedUrlResponse = {
      ok: true,
      signedUrl: result.signedUrl,
      expiresIn: result.expiresInSeconds,
    };

    res.status(200).json(response);
  } catch (err) {
    console.error('[exports/signed-url] Error:', err);
    const errorResp: ErrorResponse = {
      ok: false,
      error: 'Internal server error',
      code: 'INTERNAL_ERROR',
    };
    res.status(500).json(errorResp);
  }
}

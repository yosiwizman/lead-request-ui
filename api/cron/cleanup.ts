/**
 * GET /api/cron/cleanup
 * 
 * Cron-triggered endpoint for cleaning up expired exports.
 * 
 * Authentication:
 * - Vercel Cron: Authorization header with Bearer token
 * - Manual trigger: x-cron-secret header or ?secret= query param
 * 
 * Query params:
 * - dryRun=1: Preview what would be deleted without actual deletion
 * - retentionDays=N: Override default retention (30 days)
 * - maxRows=N: Override max rows per run (500)
 * 
 * Response:
 * { ok, runId, dryRun, scanned, deletedRows, deletedFiles, errorsCount, retentionDays, cutoffDate }
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { runCleanup, cleanupRateLimits } from '../_lib/cleanup.js';
import { verifyCronSecret, CRON_AUTH_ERROR_RESPONSE } from '../_lib/cron-auth.js';

export default async function handler(req: VercelRequest, res: VercelResponse) {
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
    console.log(JSON.stringify({
      event: 'cron_auth_failed',
      ts: new Date().toISOString(),
      ip: req.headers['x-forwarded-for'] || req.headers['x-real-ip'],
      userAgent: req.headers['user-agent'],
    }));
    
    return res.status(401).json(CRON_AUTH_ERROR_RESPONSE);
  }

  // Parse query params
  const dryRun = req.query?.dryRun === '1' || req.query?.dryRun === 'true';
  const retentionDays = req.query?.retentionDays 
    ? parseInt(req.query.retentionDays as string, 10) 
    : undefined;
  const maxRowsPerRun = req.query?.maxRows
    ? parseInt(req.query.maxRows as string, 10)
    : undefined;

  // Validate params
  if (retentionDays !== undefined && (isNaN(retentionDays) || retentionDays < 1)) {
    return res.status(400).json({
      ok: false,
      error: { code: 'invalid_param', message: 'retentionDays must be >= 1' },
    });
  }
  if (maxRowsPerRun !== undefined && (isNaN(maxRowsPerRun) || maxRowsPerRun < 1)) {
    return res.status(400).json({
      ok: false,
      error: { code: 'invalid_param', message: 'maxRows must be >= 1' },
    });
  }

  try {
    // Run cleanup
    const result = await runCleanup({
      dryRun,
      retentionDays,
      maxRowsPerRun,
    });

    // Also cleanup rate limits (non-blocking, best-effort)
    let rateLimitsDeleted = 0;
    if (!dryRun) {
      rateLimitsDeleted = await cleanupRateLimits(24).catch(() => 0);
    }

    // Return result
    const response = {
      ...result,
      rateLimitsDeleted,
    };

    // Remove errors array if empty
    if (response.errors?.length === 0) {
      delete response.errors;
    }

    return res.status(result.ok ? 200 : 500).json(response);
  } catch (err) {
    console.error('[cron/cleanup] Unexpected error:', err);
    return res.status(500).json({
      ok: false,
      error: {
        code: 'internal_error',
        message: err instanceof Error ? err.message : 'Unknown error',
      },
    });
  }
}

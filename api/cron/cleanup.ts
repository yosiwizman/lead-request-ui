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
import { timingSafeEqual } from 'crypto';

/**
 * Verify cron secret from various sources.
 * Vercel Cron sends Authorization: Bearer <CRON_SECRET>
 * Manual trigger can use x-cron-secret header or ?secret query param
 */
function verifyCronSecret(req: VercelRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;
  
  // If no secret configured, deny all requests
  if (!cronSecret) {
    console.warn('[cron/cleanup] CRON_SECRET not configured');
    return false;
  }

  // Check Authorization header (Vercel Cron format)
  const authHeader = req.headers.authorization;
  if (authHeader?.startsWith('Bearer ')) {
    const token = authHeader.slice(7);
    return safeCompare(token, cronSecret);
  }

  // Check x-cron-secret header (manual trigger)
  const secretHeader = req.headers['x-cron-secret'];
  if (typeof secretHeader === 'string') {
    return safeCompare(secretHeader, cronSecret);
  }

  // Check query param (manual trigger via curl)
  const secretQuery = req.query?.secret;
  if (typeof secretQuery === 'string') {
    return safeCompare(secretQuery, cronSecret);
  }

  return false;
}

/**
 * Timing-safe string comparison.
 */
function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

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
    
    return res.status(401).json({
      ok: false,
      error: { code: 'unauthorized', message: 'Invalid or missing cron secret' },
    });
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

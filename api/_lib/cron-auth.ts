/**
 * Shared cron authentication utilities.
 *
 * Supports multiple authentication methods for cron endpoints:
 * 1. Authorization: Bearer <CRON_SECRET> (Vercel Cron automatic behavior)
 * 2. x-cron-secret: <CRON_SECRET> (legacy/manual curl)
 * 3. ?secret=<CRON_SECRET> (manual curl query param)
 *
 * When CRON_SECRET is set as a Vercel environment variable, Vercel Cron Jobs
 * automatically include it as a Bearer token in the Authorization header.
 *
 * @see https://vercel.com/docs/cron-jobs/manage-cron-jobs#securing-cron-jobs
 */

import type { VercelRequest } from '@vercel/node';
import { timingSafeEqual } from 'crypto';

/**
 * Verify cron secret from various sources.
 *
 * Checks in order:
 * 1. Authorization: Bearer <token> (Vercel Cron format)
 * 2. x-cron-secret header (manual trigger)
 * 3. ?secret= query param (manual curl)
 *
 * @returns true if valid secret provided, false otherwise
 */
export function verifyCronSecret(req: VercelRequest): boolean {
  const cronSecret = process.env.CRON_SECRET;

  // If no secret configured, deny all requests
  if (!cronSecret) {
    console.warn('[cron-auth] CRON_SECRET not configured - denying request');
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
 * Timing-safe string comparison to prevent timing attacks.
 */
export function safeCompare(a: string, b: string): boolean {
  if (a.length !== b.length) {
    return false;
  }
  try {
    return timingSafeEqual(Buffer.from(a), Buffer.from(b));
  } catch {
    return false;
  }
}

/**
 * Standard 401 response for failed cron auth.
 */
export const CRON_AUTH_ERROR_RESPONSE = {
  ok: false,
  error: { code: 'unauthorized', message: 'Invalid or missing cron secret' },
} as const;

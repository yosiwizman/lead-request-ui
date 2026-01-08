/**
 * GET /api/health/app
 * 
 * Basic app health check. Returns OK if the serverless function is running.
 * Does NOT require authentication - this is a public health check.
 * Does NOT expose any secrets.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';

export default function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  // Get version from environment (Vercel sets VERCEL_GIT_COMMIT_SHA)
  const version = process.env.VERCEL_GIT_COMMIT_SHA?.slice(0, 7) || 
                  process.env.GIT_COMMIT_SHA?.slice(0, 7) ||
                  'unknown';

  // Get environment name
  const env = process.env.VERCEL_ENV || process.env.NODE_ENV || 'development';

  return res.status(200).json({
    ok: true,
    time: new Date().toISOString(),
    version,
    env,
  });
}

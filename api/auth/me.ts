/**
 * GET /api/auth/me
 * Check if current session is valid.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { hasValidSession } from '../_lib/auth.js';

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Only allow GET
  if (req.method !== 'GET') {
    res.status(405).json({
      ok: false,
      error: { code: 'method_not_allowed', message: 'Only GET allowed' },
    });
    return;
  }

  try {
    const isValid = hasValidSession(req);

    if (isValid) {
      res.status(200).json({ ok: true });
    } else {
      res.status(401).json({
        ok: false,
        error: { code: 'unauthorized', message: 'Not authenticated' },
      });
    }
  } catch (error) {
    console.error('Session check error:', error);
    
    // If SESSION_SECRET is not configured, treat as unauthorized
    // (don't expose config errors to unauthenticated users)
    res.status(401).json({
      ok: false,
      error: { code: 'unauthorized', message: 'Not authenticated' },
    });
  }
}

/**
 * POST /api/auth/login
 * Authenticate with passcode and set session cookie.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { verifyPasscode, setSessionCookie } from '../_lib/auth.js';

export default async function handler(
  req: VercelRequest,
  res: VercelResponse
): Promise<void> {
  // Only allow POST
  if (req.method !== 'POST') {
    res.status(405).json({
      ok: false,
      error: { code: 'method_not_allowed', message: 'Only POST allowed' },
    });
    return;
  }

  try {
    const { passcode } = req.body || {};

    if (!passcode || typeof passcode !== 'string') {
      res.status(400).json({
        ok: false,
        error: { code: 'invalid_request', message: 'Passcode is required' },
      });
      return;
    }

    // Verify passcode
    const isValid = verifyPasscode(passcode);

    if (!isValid) {
      res.status(401).json({
        ok: false,
        error: { code: 'invalid_passcode', message: 'Invalid passcode' },
      });
      return;
    }

    // Set session cookie
    setSessionCookie(res);

    res.status(200).json({ ok: true });
  } catch (error) {
    console.error('Login error:', error);
    
    // Check for config errors
    if (error instanceof Error && error.message.includes('environment variable')) {
      res.status(500).json({
        ok: false,
        error: { 
          code: 'server_config_error', 
          message: 'Authentication not configured',
        },
      });
      return;
    }

    res.status(500).json({
      ok: false,
      error: { code: 'internal_error', message: 'Login failed' },
    });
  }
}

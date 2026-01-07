/**
 * Session-based authentication using httpOnly cookies.
 * NO client-side secrets - all validation happens server-side.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createHmac, timingSafeEqual } from 'crypto';

const COOKIE_NAME = 'lr_session';
const DEFAULT_TTL_SECONDS = 604800; // 7 days

interface SessionPayload {
  iat: number; // Issued at (Unix timestamp)
  exp: number; // Expiration (Unix timestamp)
}

/**
 * Get the session secret from environment.
 * Throws if not configured.
 */
function getSessionSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('SESSION_SECRET must be at least 32 characters');
  }
  return secret;
}

/**
 * Get session TTL from environment or default.
 */
function getSessionTtl(): number {
  const ttl = process.env.SESSION_TTL_SECONDS;
  if (ttl) {
    const parsed = parseInt(ttl, 10);
    if (!isNaN(parsed) && parsed > 0) {
      return parsed;
    }
  }
  return DEFAULT_TTL_SECONDS;
}

/**
 * Sign a session payload using HMAC-SHA256.
 * Returns base64url encoded: payload.signature
 */
export function signSession(): string {
  const secret = getSessionSecret();
  const now = Math.floor(Date.now() / 1000);
  const ttl = getSessionTtl();
  
  const payload: SessionPayload = {
    iat: now,
    exp: now + ttl,
  };
  
  const payloadB64 = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const signature = createHmac('sha256', secret)
    .update(payloadB64)
    .digest('base64url');
  
  return `${payloadB64}.${signature}`;
}

/**
 * Verify a session token.
 * Returns true if valid and not expired.
 */
export function verifySession(token: string): boolean {
  try {
    const secret = getSessionSecret();
    const [payloadB64, signature] = token.split('.');
    
    if (!payloadB64 || !signature) {
      return false;
    }
    
    // Verify signature using timing-safe comparison
    const expectedSig = createHmac('sha256', secret)
      .update(payloadB64)
      .digest('base64url');
    
    const sigBuffer = Buffer.from(signature, 'base64url');
    const expectedBuffer = Buffer.from(expectedSig, 'base64url');
    
    if (sigBuffer.length !== expectedBuffer.length) {
      return false;
    }
    
    if (!timingSafeEqual(sigBuffer, expectedBuffer)) {
      return false;
    }
    
    // Parse and check expiration
    const payload: SessionPayload = JSON.parse(
      Buffer.from(payloadB64, 'base64url').toString('utf8')
    );
    
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp < now) {
      return false;
    }
    
    return true;
  } catch {
    return false;
  }
}

/**
 * Parse cookies from request header.
 */
function parseCookies(cookieHeader: string | undefined): Record<string, string> {
  const cookies: Record<string, string> = {};
  if (!cookieHeader) return cookies;
  
  for (const cookie of cookieHeader.split(';')) {
    const [name, ...rest] = cookie.trim().split('=');
    if (name && rest.length > 0) {
      cookies[name] = rest.join('=');
    }
  }
  
  return cookies;
}

/**
 * Get session cookie from request.
 */
export function getSessionFromRequest(req: VercelRequest): string | null {
  const cookieHeader = req.headers?.cookie;
  const cookies = parseCookies(cookieHeader);
  return cookies[COOKIE_NAME] || null;
}

/**
 * Check if the current request has a valid session.
 * Returns true if:
 * - AUTH_DISABLED_FOR_TESTS is set (test mode)
 * - Valid session cookie is present
 */
export function hasValidSession(req: VercelRequest): boolean {
  // Test bypass
  if (process.env.AUTH_DISABLED_FOR_TESTS === 'true') {
    return true;
  }
  
  const token = getSessionFromRequest(req);
  if (!token) {
    return false;
  }
  
  return verifySession(token);
}

/**
 * Session guard for API routes.
 * Returns 401 response if session is invalid.
 * Returns null if session is valid (route should continue).
 */
export function requireSession(
  req: VercelRequest,
  res: VercelResponse
): VercelResponse | null {
  if (hasValidSession(req)) {
    return null; // Session valid, continue
  }
  
  res.status(401).json({
    ok: false,
    error: {
      code: 'unauthorized',
      message: 'Authentication required',
    },
  });
  
  return res;
}

/**
 * Set session cookie on response.
 */
export function setSessionCookie(res: VercelResponse): void {
  const token = signSession();
  const ttl = getSessionTtl();
  const isProduction = process.env.NODE_ENV === 'production' || 
                       process.env.VERCEL_ENV === 'production';
  
  // Build cookie attributes
  const attrs = [
    `${COOKIE_NAME}=${token}`,
    `Max-Age=${ttl}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
  ];
  
  // Only set Secure in production (localhost doesn't support it)
  if (isProduction) {
    attrs.push('Secure');
  }
  
  res.setHeader('Set-Cookie', attrs.join('; '));
}

/**
 * Clear session cookie on response.
 */
export function clearSessionCookie(res: VercelResponse): void {
  const attrs = [
    `${COOKIE_NAME}=`,
    'Max-Age=0',
    'Path=/',
    'HttpOnly',
    'SameSite=Strict',
  ];
  
  res.setHeader('Set-Cookie', attrs.join('; '));
}

/**
 * Verify passcode against APP_PASSCODE env var.
 */
export function verifyPasscode(passcode: string): boolean {
  const appPasscode = process.env.APP_PASSCODE;
  if (!appPasscode) {
    throw new Error('APP_PASSCODE environment variable is not set');
  }
  
  // Use timing-safe comparison
  const passcodeBuffer = Buffer.from(passcode);
  const expectedBuffer = Buffer.from(appPasscode);
  
  if (passcodeBuffer.length !== expectedBuffer.length) {
    return false;
  }
  
  return timingSafeEqual(passcodeBuffer, expectedBuffer);
}

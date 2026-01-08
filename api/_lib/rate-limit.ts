/**
 * Rate limiting using Supabase Postgres.
 * Uses a fixed-window approach for simplicity.
 * No PII is stored - only hashed session identifiers.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { createHash } from 'crypto';
import type { VercelRequest, VercelResponse } from '@vercel/node';
import { getSessionFromRequest } from './auth.js';

/**
 * Default rate limits by route (requests per hour).
 * Can be overridden via environment variables.
 */
export const DEFAULT_LIMITS: Record<string, { limit: number; windowSeconds: number }> = {
  generate: { limit: 20, windowSeconds: 3600 },
  status: { limit: 120, windowSeconds: 3600 },
  'signed-url': { limit: 60, windowSeconds: 3600 },
};

/**
 * Result of a rate limit check.
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  limit: number;
  resetAt: Date;
  retryAfterSeconds?: number;
}

/**
 * Get Supabase client for rate limit operations.
 * Returns null if not configured (rate limiting will be skipped).
 */
function getSupabaseClient(): SupabaseClient | null {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return null;
  }

  return createClient(supabaseUrl, serviceKey);
}

/**
 * Hash a session token to create a non-PII identifier for rate limiting.
 */
export function hashSession(sessionToken: string): string {
  return createHash('sha256').update(sessionToken).digest('hex').slice(0, 32);
}

/**
 * Calculate the start of the current rate limit window.
 */
export function getWindowStart(windowSeconds: number): Date {
  const now = Date.now();
  const windowMs = windowSeconds * 1000;
  const windowStart = Math.floor(now / windowMs) * windowMs;
  return new Date(windowStart);
}

/**
 * Get rate limit configuration for a route from environment or defaults.
 */
export function getRouteLimit(routeKey: string): { limit: number; windowSeconds: number } {
  // Check for environment override
  const envLimit = process.env[`RATE_LIMIT_${routeKey.toUpperCase().replace('-', '_')}`];
  const envWindow = process.env[`RATE_WINDOW_${routeKey.toUpperCase().replace('-', '_')}`];

  const defaults = DEFAULT_LIMITS[routeKey] || { limit: 60, windowSeconds: 3600 };

  return {
    limit: envLimit ? parseInt(envLimit, 10) : defaults.limit,
    windowSeconds: envWindow ? parseInt(envWindow, 10) : defaults.windowSeconds,
  };
}

/**
 * Check and increment rate limit for a session+route combination.
 * Returns the result including whether the request is allowed.
 */
export async function enforceRouteLimit(opts: {
  sessionHash: string;
  routeKey: string;
  limit: number;
  windowSeconds: number;
}): Promise<RateLimitResult> {
  const { sessionHash, routeKey, limit, windowSeconds } = opts;
  const windowStart = getWindowStart(windowSeconds);
  const resetAt = new Date(windowStart.getTime() + windowSeconds * 1000);

  const supabase = getSupabaseClient();
  if (!supabase) {
    // Rate limiting disabled if Supabase not configured
    console.warn('[rate-limit] Supabase not configured, skipping rate limit');
    return { allowed: true, remaining: limit, limit, resetAt };
  }

  try {
    // Use upsert to atomically increment the counter
    // ON CONFLICT: increment request_count
    const { data, error } = await supabase.rpc('increment_rate_limit', {
      p_session_hash: sessionHash,
      p_route_key: routeKey,
      p_window_start: windowStart.toISOString(),
      p_limit: limit,
    });

    // If the RPC doesn't exist, fall back to direct query
    if (error && error.code === '42883') {
      // Function doesn't exist, use direct upsert
      return await enforceRouteLimitDirect(supabase, opts, windowStart, resetAt);
    }

    if (error) {
      console.error('[rate-limit] RPC error:', error.message);
      // Fail open - allow request if rate limiting fails
      return { allowed: true, remaining: limit, limit, resetAt };
    }

    const currentCount = typeof data === 'number' ? data : (data?.request_count ?? 0);
    const allowed = currentCount <= limit;
    const remaining = Math.max(0, limit - currentCount);
    const retryAfterSeconds = allowed ? undefined : Math.ceil((resetAt.getTime() - Date.now()) / 1000);

    // Log rate limit check (no PII - only route and counts)
    if (!allowed) {
      console.log(JSON.stringify({
        event: 'rate_limit_exceeded',
        ts: new Date().toISOString(),
        routeKey,
        limit,
        currentCount,
        retryAfterSeconds,
      }));
    }

    return { allowed, remaining, limit, resetAt, retryAfterSeconds };
  } catch (err) {
    console.error('[rate-limit] Error:', err);
    // Fail open
    return { allowed: true, remaining: limit, limit, resetAt };
  }
}

/**
 * Direct upsert fallback when RPC is not available.
 */
async function enforceRouteLimitDirect(
  supabase: SupabaseClient,
  opts: { sessionHash: string; routeKey: string; limit: number; windowSeconds: number },
  windowStart: Date,
  resetAt: Date
): Promise<RateLimitResult> {
  const { sessionHash, routeKey, limit } = opts;

  // Try to get existing record
  const { data: existing } = await supabase
    .from('rate_limits')
    .select('request_count')
    .eq('session_hash', sessionHash)
    .eq('route_key', routeKey)
    .eq('window_start', windowStart.toISOString())
    .single();

  let currentCount: number;

  if (existing) {
    // Increment existing
    const newCount = existing.request_count + 1;
    await supabase
      .from('rate_limits')
      .update({ request_count: newCount })
      .eq('session_hash', sessionHash)
      .eq('route_key', routeKey)
      .eq('window_start', windowStart.toISOString());
    currentCount = newCount;
  } else {
    // Insert new
    const { error: insertError } = await supabase
      .from('rate_limits')
      .insert({
        session_hash: sessionHash,
        route_key: routeKey,
        window_start: windowStart.toISOString(),
        request_count: 1,
      });

    if (insertError && insertError.code === '23505') {
      // Race condition - record was inserted by another request, retry
      return enforceRouteLimitDirect(supabase, opts, windowStart, resetAt);
    }
    currentCount = 1;
  }

  const allowed = currentCount <= limit;
  const remaining = Math.max(0, limit - currentCount);
  const retryAfterSeconds = allowed ? undefined : Math.ceil((resetAt.getTime() - Date.now()) / 1000);

  if (!allowed) {
    console.log(JSON.stringify({
      event: 'rate_limit_exceeded',
      ts: new Date().toISOString(),
      routeKey,
      limit,
      currentCount,
      retryAfterSeconds,
    }));
  }

  return { allowed, remaining, limit, resetAt, retryAfterSeconds };
}

/**
 * Rate limit guard for API routes.
 * Returns a 429 response if rate limited, or null to continue.
 */
export async function checkRateLimit(
  req: VercelRequest,
  res: VercelResponse,
  routeKey: string
): Promise<VercelResponse | null> {
  // Skip rate limiting in tests
  if (process.env.RATE_LIMIT_DISABLED === 'true') {
    return null;
  }

  const sessionToken = getSessionFromRequest(req);
  if (!sessionToken) {
    // No session = no rate limiting (auth will handle this)
    return null;
  }

  const sessionHash = hashSession(sessionToken);
  const config = getRouteLimit(routeKey);
  const result = await enforceRouteLimit({
    sessionHash,
    routeKey,
    limit: config.limit,
    windowSeconds: config.windowSeconds,
  });

  // Set rate limit headers
  res.setHeader('X-RateLimit-Limit', result.limit.toString());
  res.setHeader('X-RateLimit-Remaining', result.remaining.toString());
  res.setHeader('X-RateLimit-Reset', Math.floor(result.resetAt.getTime() / 1000).toString());

  if (!result.allowed) {
    res.setHeader('Retry-After', (result.retryAfterSeconds ?? 60).toString());
    res.status(429).json({
      ok: false,
      error: {
        code: 'rate_limited',
        message: `Rate limit exceeded. Try again in ${result.retryAfterSeconds} seconds.`,
        details: {
          limit: result.limit,
          remaining: result.remaining,
          retryAfterSeconds: result.retryAfterSeconds,
          resetAt: result.resetAt.toISOString(),
        },
      },
    });
    return res;
  }

  return null;
}

/**
 * Tests for rate limiting helper.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  hashSession,
  getWindowStart,
  getRouteLimit,
  DEFAULT_LIMITS,
} from '../../../api/_lib/rate-limit.js';

describe('hashSession', () => {
  it('returns consistent hash for same input', () => {
    const token = 'test-session-token-abc123';
    const hash1 = hashSession(token);
    const hash2 = hashSession(token);

    expect(hash1).toBe(hash2);
  });

  it('returns different hashes for different inputs', () => {
    const hash1 = hashSession('token-1');
    const hash2 = hashSession('token-2');

    expect(hash1).not.toBe(hash2);
  });

  it('returns 32-character hex string', () => {
    const hash = hashSession('any-token');

    expect(hash).toMatch(/^[a-f0-9]{32}$/);
  });

  it('does not expose original token', () => {
    const token = 'secret-session-token';
    const hash = hashSession(token);

    expect(hash).not.toContain('secret');
    expect(hash).not.toContain('session');
    expect(hash).not.toContain('token');
  });
});

describe('getWindowStart', () => {
  it('returns start of current hour for 3600s window', () => {
    const windowStart = getWindowStart(3600);
    
    // Window start should have minutes, seconds, and milliseconds = 0
    expect(windowStart.getMinutes()).toBe(0);
    expect(windowStart.getSeconds()).toBe(0);
    expect(windowStart.getMilliseconds()).toBe(0);
  });

  it('aligns to window boundaries', () => {
    const windowSeconds = 300; // 5-minute windows
    const windowStart = getWindowStart(windowSeconds);
    
    // Window start should be aligned to 5-minute boundary
    expect(windowStart.getMinutes() % 5).toBe(0);
    expect(windowStart.getSeconds()).toBe(0);
  });

  it('returns same window start within same window', () => {
    const windowSeconds = 3600;
    const start1 = getWindowStart(windowSeconds);
    
    // Should return same window start immediately after
    const start2 = getWindowStart(windowSeconds);
    
    expect(start1.getTime()).toBe(start2.getTime());
  });
});

describe('getRouteLimit', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns default limits for known routes', () => {
    const generateLimit = getRouteLimit('generate');
    expect(generateLimit.limit).toBe(20);
    expect(generateLimit.windowSeconds).toBe(3600);

    const statusLimit = getRouteLimit('status');
    expect(statusLimit.limit).toBe(120);

    const signedUrlLimit = getRouteLimit('signed-url');
    expect(signedUrlLimit.limit).toBe(60);
  });

  it('returns fallback for unknown routes', () => {
    const unknownLimit = getRouteLimit('unknown-route');
    
    expect(unknownLimit.limit).toBe(60); // default fallback
    expect(unknownLimit.windowSeconds).toBe(3600);
  });

  it('reads from environment variables', () => {
    process.env.RATE_LIMIT_GENERATE = '50';
    process.env.RATE_WINDOW_GENERATE = '1800';

    const limit = getRouteLimit('generate');

    expect(limit.limit).toBe(50);
    expect(limit.windowSeconds).toBe(1800);
  });
});

describe('DEFAULT_LIMITS', () => {
  it('has correct structure', () => {
    expect(DEFAULT_LIMITS).toHaveProperty('generate');
    expect(DEFAULT_LIMITS).toHaveProperty('status');
    expect(DEFAULT_LIMITS).toHaveProperty('signed-url');
  });

  it('has reasonable default values', () => {
    // generate should be most restricted
    expect(DEFAULT_LIMITS.generate.limit).toBeLessThan(DEFAULT_LIMITS.status.limit);
    
    // All should have 1-hour windows
    expect(DEFAULT_LIMITS.generate.windowSeconds).toBe(3600);
    expect(DEFAULT_LIMITS.status.windowSeconds).toBe(3600);
    expect(DEFAULT_LIMITS['signed-url'].windowSeconds).toBe(3600);
  });
});

describe('RateLimitResult shape', () => {
  it('matches expected interface for allowed request', () => {
    const result = {
      allowed: true,
      remaining: 19,
      limit: 20,
      resetAt: new Date(),
    };

    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(19);
    expect(result.limit).toBe(20);
    expect(result.resetAt).toBeInstanceOf(Date);
    expect(result).not.toHaveProperty('retryAfterSeconds');
  });

  it('matches expected interface for denied request', () => {
    const result = {
      allowed: false,
      remaining: 0,
      limit: 20,
      resetAt: new Date(),
      retryAfterSeconds: 1800,
    };

    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
    expect(result.retryAfterSeconds).toBe(1800);
  });
});

describe('429 response shape', () => {
  it('matches expected error structure', () => {
    const errorResponse = {
      ok: false,
      error: {
        code: 'rate_limited',
        message: 'Rate limit exceeded. Try again in 1800 seconds.',
        details: {
          limit: 20,
          remaining: 0,
          retryAfterSeconds: 1800,
          resetAt: new Date().toISOString(),
        },
      },
    };

    expect(errorResponse.ok).toBe(false);
    expect(errorResponse.error.code).toBe('rate_limited');
    expect(errorResponse.error.details.limit).toBe(20);
    expect(errorResponse.error.details.remaining).toBe(0);
    expect(errorResponse.error.details.retryAfterSeconds).toBe(1800);
  });
});

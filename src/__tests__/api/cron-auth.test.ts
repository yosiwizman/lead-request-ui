/**
 * Tests for shared cron authentication helper.
 *
 * Verifies:
 * - Authorization: Bearer <token> (Vercel Cron format)
 * - x-cron-secret header (legacy/manual)
 * - ?secret= query param (manual curl)
 * - Missing/invalid secrets
 * - Timing-safe comparison
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  verifyCronSecret,
  safeCompare,
  CRON_AUTH_ERROR_RESPONSE,
} from '../../../api/_lib/cron-auth';

// Mock VercelRequest type for testing
interface MockRequest {
  headers: Record<string, string | undefined>;
  query?: Record<string, string | undefined>;
}

describe('verifyCronSecret', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  describe('when CRON_SECRET is not configured', () => {
    it('returns false and logs warning', () => {
      delete process.env.CRON_SECRET;
      const consoleSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

      const req = { headers: { authorization: 'Bearer test-secret' } } as MockRequest;
      const result = verifyCronSecret(req as never);

      expect(result).toBe(false);
      expect(consoleSpy).toHaveBeenCalledWith(
        '[cron-auth] CRON_SECRET not configured - denying request'
      );

      consoleSpy.mockRestore();
    });
  });

  describe('Authorization: Bearer token (Vercel Cron format)', () => {
    beforeEach(() => {
      process.env.CRON_SECRET = 'my-cron-secret';
    });

    it('returns true for valid Bearer token', () => {
      const req = {
        headers: { authorization: 'Bearer my-cron-secret' },
      } as MockRequest;

      expect(verifyCronSecret(req as never)).toBe(true);
    });

    it('returns false for invalid Bearer token', () => {
      const req = {
        headers: { authorization: 'Bearer wrong-secret' },
      } as MockRequest;

      expect(verifyCronSecret(req as never)).toBe(false);
    });

    it('returns false for malformed Bearer header', () => {
      const req = {
        headers: { authorization: 'Bearermy-cron-secret' }, // no space
      } as MockRequest;

      expect(verifyCronSecret(req as never)).toBe(false);
    });

    it('returns false for Basic auth header', () => {
      const req = {
        headers: { authorization: 'Basic dXNlcjpwYXNz' },
      } as MockRequest;

      expect(verifyCronSecret(req as never)).toBe(false);
    });
  });

  describe('x-cron-secret header (legacy/manual)', () => {
    beforeEach(() => {
      process.env.CRON_SECRET = 'my-cron-secret';
    });

    it('returns true for valid x-cron-secret header', () => {
      const req = {
        headers: { 'x-cron-secret': 'my-cron-secret' },
      } as MockRequest;

      expect(verifyCronSecret(req as never)).toBe(true);
    });

    it('returns false for invalid x-cron-secret header', () => {
      const req = {
        headers: { 'x-cron-secret': 'wrong-secret' },
      } as MockRequest;

      expect(verifyCronSecret(req as never)).toBe(false);
    });
  });

  describe('?secret= query param (manual curl)', () => {
    beforeEach(() => {
      process.env.CRON_SECRET = 'my-cron-secret';
    });

    it('returns true for valid secret query param', () => {
      const req = {
        headers: {},
        query: { secret: 'my-cron-secret' },
      } as MockRequest;

      expect(verifyCronSecret(req as never)).toBe(true);
    });

    it('returns false for invalid secret query param', () => {
      const req = {
        headers: {},
        query: { secret: 'wrong-secret' },
      } as MockRequest;

      expect(verifyCronSecret(req as never)).toBe(false);
    });
  });

  describe('authentication priority', () => {
    beforeEach(() => {
      process.env.CRON_SECRET = 'my-cron-secret';
    });

    it('prefers Authorization header over x-cron-secret', () => {
      const req = {
        headers: {
          authorization: 'Bearer my-cron-secret',
          'x-cron-secret': 'wrong-secret',
        },
      } as MockRequest;

      // Should succeed because Authorization is checked first
      expect(verifyCronSecret(req as never)).toBe(true);
    });

    it('falls back to x-cron-secret when Authorization missing', () => {
      const req = {
        headers: {
          'x-cron-secret': 'my-cron-secret',
        },
      } as MockRequest;

      expect(verifyCronSecret(req as never)).toBe(true);
    });

    it('falls back to query param when headers missing', () => {
      const req = {
        headers: {},
        query: { secret: 'my-cron-secret' },
      } as MockRequest;

      expect(verifyCronSecret(req as never)).toBe(true);
    });
  });

  describe('missing credentials', () => {
    beforeEach(() => {
      process.env.CRON_SECRET = 'my-cron-secret';
    });

    it('returns false when no credentials provided', () => {
      const req = { headers: {} } as MockRequest;

      expect(verifyCronSecret(req as never)).toBe(false);
    });

    it('returns false when headers is empty and no query', () => {
      const req = { headers: {}, query: {} } as MockRequest;

      expect(verifyCronSecret(req as never)).toBe(false);
    });
  });
});

describe('safeCompare', () => {
  it('returns true for identical strings', () => {
    expect(safeCompare('test-secret', 'test-secret')).toBe(true);
    expect(safeCompare('', '')).toBe(true);
    expect(safeCompare('a', 'a')).toBe(true);
  });

  it('returns false for different strings', () => {
    expect(safeCompare('test-secret', 'wrong-secret')).toBe(false);
    expect(safeCompare('abc', 'xyz')).toBe(false);
  });

  it('returns false for different length strings', () => {
    expect(safeCompare('short', 'longer-string')).toBe(false);
    expect(safeCompare('a', 'ab')).toBe(false);
  });

  it('handles empty strings', () => {
    expect(safeCompare('', '')).toBe(true);
    expect(safeCompare('', 'a')).toBe(false);
    expect(safeCompare('a', '')).toBe(false);
  });

  it('handles unicode strings', () => {
    expect(safeCompare('héllo', 'héllo')).toBe(true);
    expect(safeCompare('héllo', 'hello')).toBe(false);
  });
});

describe('CRON_AUTH_ERROR_RESPONSE', () => {
  it('has correct structure', () => {
    expect(CRON_AUTH_ERROR_RESPONSE).toEqual({
      ok: false,
      error: {
        code: 'unauthorized',
        message: 'Invalid or missing cron secret',
      },
    });
  });

  it('is immutable (const assertion)', () => {
    // TypeScript enforces this at compile time
    // Runtime check that the object shape is as expected
    expect(CRON_AUTH_ERROR_RESPONSE.ok).toBe(false);
    expect(CRON_AUTH_ERROR_RESPONSE.error.code).toBe('unauthorized');
  });
});

describe('cron endpoint integration scenarios', () => {
  beforeEach(() => {
    process.env.CRON_SECRET = 'production-secret-abc123';
  });

  afterEach(() => {
    delete process.env.CRON_SECRET;
  });

  it('Vercel Cron invocation pattern (GET with Bearer)', () => {
    // Simulates how Vercel Cron calls the endpoint
    const req = {
      headers: {
        authorization: 'Bearer production-secret-abc123',
        'user-agent': 'vercel-cron/1.0',
      },
    } as MockRequest;

    expect(verifyCronSecret(req as never)).toBe(true);
  });

  it('manual curl with x-cron-secret header', () => {
    // curl -H "x-cron-secret: production-secret-abc123" https://...
    const req = {
      headers: {
        'x-cron-secret': 'production-secret-abc123',
        'user-agent': 'curl/7.79.1',
      },
    } as MockRequest;

    expect(verifyCronSecret(req as never)).toBe(true);
  });

  it('manual curl with query param', () => {
    // curl "https://...?secret=production-secret-abc123"
    const req = {
      headers: {
        'user-agent': 'curl/7.79.1',
      },
      query: { secret: 'production-secret-abc123' },
    } as MockRequest;

    expect(verifyCronSecret(req as never)).toBe(true);
  });

  it('browser access without credentials is rejected', () => {
    const req = {
      headers: {
        'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      },
    } as MockRequest;

    expect(verifyCronSecret(req as never)).toBe(false);
  });
});

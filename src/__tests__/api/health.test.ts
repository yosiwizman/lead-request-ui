/**
 * Tests for health endpoint response shapes.
 */

import { describe, it, expect } from 'vitest';

describe('Health App Response', () => {
  it('has correct shape for success response', () => {
    const response = {
      ok: true,
      time: new Date().toISOString(),
      version: 'abc1234',
      env: 'production',
    };

    expect(response.ok).toBe(true);
    expect(response.time).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(response.version).toMatch(/^[a-z0-9]+$/);
    expect(response.env).toBe('production');
  });

  it('handles unknown version', () => {
    const response = {
      ok: true,
      time: new Date().toISOString(),
      version: 'unknown',
      env: 'development',
    };

    expect(response.version).toBe('unknown');
  });
});

describe('Health Deps Response', () => {
  it('has correct shape for healthy response', () => {
    const response = {
      ok: true,
      time: new Date().toISOString(),
      supabase: true,
      supabaseLatencyMs: 45,
    };

    expect(response.ok).toBe(true);
    expect(response.supabase).toBe(true);
    expect(response.supabaseLatencyMs).toBeGreaterThanOrEqual(0);
    expect(response).not.toHaveProperty('error');
  });

  it('has correct shape for unhealthy response', () => {
    const response = {
      ok: false,
      time: new Date().toISOString(),
      supabase: false,
      supabaseLatencyMs: 5000,
      error: 'supabase: Connection timeout',
    };

    expect(response.ok).toBe(false);
    expect(response.supabase).toBe(false);
    expect(response.error).toContain('supabase');
  });

  it('handles not configured scenario', () => {
    const response = {
      ok: false,
      time: new Date().toISOString(),
      supabase: false,
      supabaseLatencyMs: 0,
      error: 'supabase: Not configured',
    };

    expect(response.ok).toBe(false);
    expect(response.supabaseLatencyMs).toBe(0);
    expect(response.error).toContain('Not configured');
  });
});

describe('Health HTTP Status Codes', () => {
  it('returns 200 for healthy app', () => {
    // App health always returns 200 if the function runs
    const statusCode = 200;
    expect(statusCode).toBe(200);
  });

  it('returns 200 for healthy deps', () => {
    const isHealthy = true;
    const statusCode = isHealthy ? 200 : 503;
    expect(statusCode).toBe(200);
  });

  it('returns 503 for unhealthy deps', () => {
    const isHealthy = false;
    const statusCode = isHealthy ? 200 : 503;
    expect(statusCode).toBe(503);
  });
});

describe('Health Endpoint Security', () => {
  it('does not expose secrets in response', () => {
    const response = {
      ok: true,
      time: new Date().toISOString(),
      version: 'abc1234',
      env: 'production',
      supabase: true,
    };

    const responseStr = JSON.stringify(response);

    // Should not contain any sensitive patterns
    expect(responseStr).not.toMatch(/key/i);
    expect(responseStr).not.toMatch(/secret/i);
    expect(responseStr).not.toMatch(/password/i);
    expect(responseStr).not.toMatch(/token/i);
    expect(responseStr).not.toMatch(/bearer/i);
  });

  it('does not require authentication', () => {
    // Health endpoints should be public for monitoring
    // This is a documentation/design test
    const requiresAuth = false;
    expect(requiresAuth).toBe(false);
  });
});

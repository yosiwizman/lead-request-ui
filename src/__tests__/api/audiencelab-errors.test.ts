import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateLeads } from '../../../api/_lib/providers/audiencelab';
import type { GenerateInput } from '../../../api/_lib/types';
import {
  AudienceLabAuthError,
  AudienceLabUpstreamError,
  AudienceLabContractError,
} from '../../../api/_lib/types';
import { ConfigError } from '../../../api/_lib/bytestring';

// Mock fetch globally
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe('AudienceLab provider error handling', () => {
  const originalEnv = process.env;
  const testInput: GenerateInput = {
    leadRequest: 'roofing',
    zips: ['33101'],
    scope: 'residential',
  };

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
    process.env.AUDIENCELAB_API_KEY = 'test-api-key';
    mockFetch.mockReset();
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('throws ConfigError when API key is missing', async () => {
    delete process.env.AUDIENCELAB_API_KEY;

    await expect(generateLeads(testInput)).rejects.toThrow(ConfigError);
    
    try {
      await generateLeads(testInput);
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      if (err instanceof ConfigError) {
        expect(err.code).toBe('CONFIG_MISSING');
        expect(err.label).toBe('AUDIENCELAB_API_KEY');
        expect(err.message).toContain('not configured');
      }
    }
  });

  it('throws AudienceLabAuthError on 401 during audience creation', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      headers: new Map([['x-request-id', 'req-123']]),
      text: async () => '{"error":"Unauthorized"}',
    });

    await expect(generateLeads(testInput)).rejects.toThrow(AudienceLabAuthError);
    
    try {
      await generateLeads(testInput);
    } catch (err) {
      expect(err).toBeInstanceOf(AudienceLabAuthError);
      if (err instanceof AudienceLabAuthError) {
        expect(err.code).toBe('AUDIENCELAB_UNAUTHORIZED');
        expect(err.status).toBe(401);
        expect(err.endpoint).toBe('/audiences');
        expect(err.method).toBe('POST');
        // Verify hint is present
        expect(err.hint).toContain('WRITE required');
      }
    }
  });

  it('throws AudienceLabAuthError on 403 during audience creation', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 403,
      headers: new Map(),
      text: async () => '{"error":"Forbidden"}',
    });

    await expect(generateLeads(testInput)).rejects.toThrow(AudienceLabAuthError);
  });

  it('throws AudienceLabUpstreamError on 5xx during audience creation', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 503,
      headers: new Map(),
      text: async () => '{"error":"Service Unavailable"}',
    });

    await expect(generateLeads(testInput)).rejects.toThrow(AudienceLabUpstreamError);
    
    try {
      await generateLeads(testInput);
    } catch (err) {
      if (err instanceof AudienceLabUpstreamError) {
        expect(err.code).toBe('AUDIENCELAB_UPSTREAM_ERROR');
        expect(err.status).toBe(503);
      }
    }
  });

  it('throws AudienceLabContractError when audience ID is missing from response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      headers: new Headers(),
      json: async () => ({ name: 'test audience' }), // Missing id
    });

    await expect(generateLeads(testInput)).rejects.toThrow(AudienceLabContractError);
    
    try {
      await generateLeads(testInput);
    } catch (err) {
      expect(err).toBeInstanceOf(AudienceLabContractError);
      if (err instanceof AudienceLabContractError) {
        expect(err.code).toBe('AUDIENCELAB_NO_AUDIENCE_ID');
        expect(err.requestId).toBeDefined();
        expect(err.responseShape).toContain('object');
      }
    }
  });

  it('throws AudienceLabUpstreamError on 5xx during members fetch', async () => {
    // First call: successful audience creation
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'audience-123' }),
    });
    // Second call: failed members fetch with 5xx
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      headers: new Map([['x-request-id', 'req-456']]),
      text: async () => '{"error":"Internal Server Error"}',
    });

    await expect(generateLeads(testInput)).rejects.toThrow(AudienceLabUpstreamError);
  });

  it('throws AudienceLabAuthError on 401 during members fetch', async () => {
    // First call: successful audience creation
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'audience-123' }),
    });
    // Second call: 401 on members fetch
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      headers: new Map(),
      text: async () => '{"error":"Unauthorized"}',
    });

    await expect(generateLeads(testInput)).rejects.toThrow(AudienceLabAuthError);
  });

  it('returns provider_no_results when no members found', async () => {
    // Successful audience creation
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'audience-123' }),
    });
    // Members fetch returns empty
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [] }),
    });

    const result = await generateLeads(testInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('provider_no_results');
      expect(result.error.message).toContain('No leads found');
    }
  });

  it('returns provider_error on network failure', async () => {
    mockFetch.mockRejectedValueOnce(new Error('Network error'));

    const result = await generateLeads(testInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('provider_error');
      expect(result.error.message).toContain('Network error');
    }
  });

  it('returns success with leads when API calls succeed', async () => {
    // Successful audience creation
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'audience-123' }),
    });
    // Successful members fetch
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        data: [
          { first_name: 'John', last_name: 'Doe', email: 'john@example.com' },
          { first_name: 'Jane', last_name: 'Smith', email: 'jane@example.com' },
        ],
      }),
    });

    const result = await generateLeads(testInput);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.leads).toHaveLength(2);
      expect(result.leads[0].first_name).toBe('John');
      expect(result.leads[0].source).toBe('audiencelab');
      expect(result.leads[1].first_name).toBe('Jane');
    }
  });

  it('handles members response with "members" field instead of "data"', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'audience-123' }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({
        members: [{ first_name: 'Bob', last_name: 'Builder' }],
      }),
    });

    const result = await generateLeads(testInput);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.leads).toHaveLength(1);
      expect(result.leads[0].first_name).toBe('Bob');
    }
  });

  it('caps leads at 50', async () => {
    const manyContacts = Array.from({ length: 100 }, (_, i) => ({
      first_name: `User${i}`,
      last_name: `Test`,
    }));

    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'audience-123' }),
    });
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: manyContacts }),
    });

    const result = await generateLeads(testInput);

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.leads).toHaveLength(50);
    }
  });
});

describe('AudienceLabAuthError', () => {
  it('never includes API key in error message or context', () => {
    const testKey = 'sk_live_supersecret123456';
    const err = new AudienceLabAuthError({
      status: 401,
      endpoint: '/audiences',
      method: 'POST',
      requestId: 'req-123',
    });

    // Check message doesn't contain key
    expect(err.message).not.toContain(testKey);
    expect(err.message).not.toContain('supersecret');
    
    // Check safe context doesn't contain key
    const ctx = err.toSafeContext();
    const ctxString = JSON.stringify(ctx);
    expect(ctxString).not.toContain(testKey);
    expect(ctxString).not.toContain('supersecret');
    
    // Verify it has expected safe fields
    expect(ctx.code).toBe('AUDIENCELAB_UNAUTHORIZED');
    expect(ctx.status).toBe(401);
    expect(ctx.endpoint).toBe('/audiences');
    expect(ctx.hint).toBeDefined();
  });

  it('AudienceLabUpstreamError never includes sensitive data', () => {
    const err = new AudienceLabUpstreamError({
      status: 503,
      endpoint: '/audiences/123',
      method: 'GET',
      requestId: 'req-789',
      body: 'secret data that should not appear',
    });

    const ctx = err.toSafeContext();
    const ctxString = JSON.stringify(ctx);
    
    // Body should not be in safe context
    expect(ctxString).not.toContain('secret data');
    expect(ctx.code).toBe('AUDIENCELAB_UPSTREAM_ERROR');
    expect(ctx.status).toBe(503);
  });
});

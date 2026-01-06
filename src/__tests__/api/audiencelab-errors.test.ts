import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { generateLeads } from '../../../api/_lib/providers/audiencelab';
import type { GenerateInput } from '../../../api/_lib/types';

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

  it('returns provider_error when API key is missing', async () => {
    delete process.env.AUDIENCELAB_API_KEY;

    const result = await generateLeads(testInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('provider_error');
      expect(result.error.message).toContain('AUDIENCELAB_API_KEY is not configured');
    }
  });

  it('returns provider_error on audience creation failure', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 401,
      text: async () => '{"error":"Unauthorized"}',
    });

    const result = await generateLeads(testInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('provider_error');
      expect(result.error.message).toContain('401');
      expect(result.error.message).toContain('audience creation');
    }
  });

  it('returns provider_error when audience ID is missing from response', async () => {
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ name: 'test audience' }), // Missing id
    });

    const result = await generateLeads(testInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('provider_error');
      expect(result.error.message).toContain('did not return an audience ID');
    }
  });

  it('returns provider_error on members fetch failure', async () => {
    // First call: successful audience creation
    mockFetch.mockResolvedValueOnce({
      ok: true,
      json: async () => ({ id: 'audience-123' }),
    });
    // Second call: failed members fetch
    mockFetch.mockResolvedValueOnce({
      ok: false,
      status: 500,
      text: async () => '{"error":"Internal Server Error"}',
    });

    const result = await generateLeads(testInput);

    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('provider_error');
      expect(result.error.message).toContain('500');
      expect(result.error.message).toContain('fetching members');
    }
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

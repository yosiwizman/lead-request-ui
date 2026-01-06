import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { getProviderName, validateProviderConfig } from '../../../api/_lib/providers';
import { ProviderConfigError } from '../../../api/_lib/types';

describe('getProviderName', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('returns mock when LEAD_PROVIDER is not set', () => {
    delete process.env.LEAD_PROVIDER;
    delete process.env.AUDIENCELAB_API_KEY;
    
    expect(getProviderName()).toBe('mock');
  });

  it('returns mock when LEAD_PROVIDER is mock', () => {
    process.env.LEAD_PROVIDER = 'mock';
    
    expect(getProviderName()).toBe('mock');
  });

  it('returns audiencelab when LEAD_PROVIDER=audiencelab and key is set', () => {
    process.env.LEAD_PROVIDER = 'audiencelab';
    process.env.AUDIENCELAB_API_KEY = 'test-key-123';
    
    expect(getProviderName()).toBe('audiencelab');
  });

  it('returns audiencelab when LEAD_PROVIDER=audiencelab even if key is missing (validation is separate)', () => {
    process.env.LEAD_PROVIDER = 'audiencelab';
    delete process.env.AUDIENCELAB_API_KEY;
    
    // getProviderName() doesn't validate keys - that's validateProviderConfig()'s job
    expect(getProviderName()).toBe('audiencelab');
  });

  it('handles case-insensitive LEAD_PROVIDER', () => {
    process.env.LEAD_PROVIDER = 'AUDIENCELAB';
    process.env.AUDIENCELAB_API_KEY = 'test-key';
    
    expect(getProviderName()).toBe('audiencelab');
  });

  it('handles LEAD_PROVIDER with whitespace', () => {
    process.env.LEAD_PROVIDER = '  audiencelab  ';
    process.env.AUDIENCELAB_API_KEY = 'test-key';
    
    expect(getProviderName()).toBe('audiencelab');
  });

  it('returns mock for unknown provider values', () => {
    process.env.LEAD_PROVIDER = 'unknown';
    
    expect(getProviderName()).toBe('mock');
  });
});

describe('validateProviderConfig', () => {
  const originalEnv = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...originalEnv };
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('does not throw when LEAD_PROVIDER=mock', () => {
    process.env.LEAD_PROVIDER = 'mock';
    delete process.env.AUDIENCELAB_API_KEY;
    
    expect(() => validateProviderConfig()).not.toThrow();
  });

  it('does not throw when audiencelab key is set', () => {
    process.env.LEAD_PROVIDER = 'audiencelab';
    process.env.AUDIENCELAB_API_KEY = 'test-key';
    
    expect(() => validateProviderConfig()).not.toThrow();
  });

  it('throws ProviderConfigError when LEAD_PROVIDER=audiencelab but key is missing', () => {
    process.env.LEAD_PROVIDER = 'audiencelab';
    delete process.env.AUDIENCELAB_API_KEY;
    
    expect(() => validateProviderConfig()).toThrow(ProviderConfigError);
  });

  it('includes helpful hint in error message', () => {
    process.env.LEAD_PROVIDER = 'audiencelab';
    delete process.env.AUDIENCELAB_API_KEY;
    
    try {
      validateProviderConfig();
    } catch (err) {
      expect(err).toBeInstanceOf(ProviderConfigError);
      if (err instanceof ProviderConfigError) {
        expect(err.hint).toContain('AUDIENCELAB_API_KEY');
      }
    }
  });
});

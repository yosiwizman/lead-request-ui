import type { GenerateInput, ProviderResult } from '../types.js';
import { ProviderConfigError } from '../types.js';
import { generateLeads as mockGenerateLeads } from './mock.js';
import { generateLeads as audiencelabGenerateLeads } from './audiencelab.js';

export type ProviderName = 'mock' | 'audiencelab';

/**
 * Determine which provider to use based on environment configuration.
 * - Returns 'audiencelab' if LEAD_PROVIDER=audiencelab (key validation happens later)
 * - Defaults to 'mock' otherwise
 */
export function getProviderName(): ProviderName {
  const env = process.env.LEAD_PROVIDER?.toLowerCase().trim();
  return env === 'audiencelab' ? 'audiencelab' : 'mock';
}

/**
 * Validate provider configuration.
 * Throws ProviderConfigError if audiencelab is requested but key is missing.
 * This ensures we NEVER silently fall back to mock when audiencelab is expected.
 */
export function validateProviderConfig(): void {
  const provider = getProviderName();
  
  if (provider === 'audiencelab' && !process.env.AUDIENCELAB_API_KEY) {
    throw new ProviderConfigError({
      provider: 'audiencelab',
      message: 'LEAD_PROVIDER is set to audiencelab but AUDIENCELAB_API_KEY is missing.',
      hint: 'Set AUDIENCELAB_API_KEY in environment variables, or change LEAD_PROVIDER to mock.',
    });
  }
}

export async function generateLeads(
  input: GenerateInput
): Promise<ProviderResult> {
  // Validate configuration before proceeding - throws if misconfigured
  validateProviderConfig();
  
  const provider = getProviderName();

  if (provider === 'audiencelab') {
    return audiencelabGenerateLeads(input);
  }

  // Mock provider is synchronous but we return a Promise for consistency
  return Promise.resolve(mockGenerateLeads(input));
}

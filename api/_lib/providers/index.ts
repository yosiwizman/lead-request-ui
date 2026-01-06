import type { GenerateInput, ProviderResult } from '../types.js';
import { generateLeads as mockGenerateLeads } from './mock.js';
import { generateLeads as audiencelabGenerateLeads } from './audiencelab.js';

export type ProviderName = 'mock' | 'audiencelab';

/**
 * Determine which provider to use based on environment configuration.
 * - Returns 'audiencelab' only if LEAD_PROVIDER=audiencelab AND AUDIENCELAB_API_KEY is set
 * - Falls back to 'mock' if audiencelab is requested but key is missing
 * - Defaults to 'mock' otherwise
 */
export function getProviderName(): ProviderName {
  const env = process.env.LEAD_PROVIDER?.toLowerCase().trim();
  
  if (env === 'audiencelab') {
    // Only use audiencelab if API key is configured
    if (process.env.AUDIENCELAB_API_KEY) {
      return 'audiencelab';
    }
    // Fallback to mock if key is missing (silent fallback for missing config)
    return 'mock';
  }
  
  return 'mock';
}

export async function generateLeads(
  input: GenerateInput
): Promise<ProviderResult> {
  const provider = getProviderName();

  if (provider === 'audiencelab') {
    return audiencelabGenerateLeads(input);
  }

  // Mock provider is synchronous but we return a Promise for consistency
  return Promise.resolve(mockGenerateLeads(input));
}

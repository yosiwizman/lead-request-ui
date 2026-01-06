import type { GenerateInput, ProviderResult } from '../types.js';
import { generateLeads as mockGenerateLeads } from './mock.js';
import { generateLeads as pdlGenerateLeads } from './pdl.js';

export type ProviderName = 'mock' | 'pdl';

export function getProviderName(): ProviderName {
  const env = process.env.LEAD_PROVIDER?.toLowerCase().trim();
  if (env === 'pdl') return 'pdl';
  return 'mock';
}

export async function generateLeads(
  input: GenerateInput
): Promise<ProviderResult> {
  const provider = getProviderName();

  if (provider === 'pdl') {
    return pdlGenerateLeads(input);
  }

  // Mock provider is synchronous but we return a Promise for consistency
  return Promise.resolve(mockGenerateLeads(input));
}

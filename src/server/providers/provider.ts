import type { Lead } from '../../types';

export type LeadScope = 'residential' | 'commercial' | 'both';

export interface GenerateInput {
  leadRequest: string;
  zips: string[];
  scope: LeadScope;
}

export type LeadProvider = (input: GenerateInput) => Lead[];

export interface ProviderModule {
  generateLeads: LeadProvider;
}
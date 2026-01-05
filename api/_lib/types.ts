export interface Lead {
  first_name: string;
  last_name: string;
  address: string;
  city: string;
  state: string;
  zip: string;
  phone: string;
  email: string;
  lead_type: string;
  tags: string;
  source: string;
}

export type LeadScope = 'residential' | 'commercial' | 'both';

export interface GenerateInput {
  leadRequest: string;
  zips: string[];
  scope: LeadScope;
}

export interface ValidatedPayload {
  leadRequest: string;
  zips: string[];
  scope: LeadScope;
}

export type Json = Record<string, unknown>;

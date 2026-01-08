import type { Lead, GenerateInput, ProviderResult } from '../types.js';

interface PDLPerson {
  first_name?: string;
  last_name?: string;
  mobile_phone?: string;
  work_email?: string;
  personal_emails?: string[];
  location_street_address?: string;
  location_locality?: string;
  location_region?: string;
  location_postal_code?: string;
  job_company_name?: string;
}

interface PDLSearchResponse {
  status: number;
  data?: PDLPerson[];
  error?: { type: string; message: string };
  total?: number;
}

export function mapPDLPersonToLead(
  person: PDLPerson,
  input: GenerateInput
): Lead {
  const email =
    person.work_email ||
    (person.personal_emails && person.personal_emails[0]) ||
    '';

  const phone = person.mobile_phone || '';
  return {
    first_name: person.first_name || '',
    last_name: person.last_name || '',
    address: person.location_street_address || '',
    city: person.location_locality || '',
    state: person.location_region || '',
    zip: person.location_postal_code || '',
    phone,
    email,
    lead_type: input.scope === 'both' ? 'residential' : input.scope,
    tags: input.leadRequest,
    source: 'pdl',
    best_phone: phone,
    phones_all: phone,
    wireless_phones: phone,
    landline_phones: '',
    match_score: 0,
    // Quality fields (default values, can be updated by processLeadsWithQuality)
    quality_score: 0,
    quality_tier: 'balanced',
    dnc_status: '',
    email_validation_status: '',
  };
}

export async function generateLeads(
  input: GenerateInput
): Promise<ProviderResult> {
  const apiKey = process.env.PDL_API_KEY;
  const baseUrl = process.env.PDL_BASE_URL || 'https://api.peopledatalabs.com';

  if (!apiKey) {
    return {
      ok: false,
      error: {
        code: 'provider_error',
        message: 'PDL_API_KEY is not configured.',
      },
    };
  }

  // Build SQL query for PDL Person Search
  const zipList = input.zips.map((z) => `'${z}'`).join(', ');
  const sqlQuery = `SELECT * FROM person WHERE location_postal_code IN (${zipList}) LIMIT 50`;

  try {
    const response = await fetch(`${baseUrl}/v5/person/search`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': apiKey,
      },
      body: JSON.stringify({
        sql: sqlQuery,
        size: 50,
        dataset: 'all',
      }),
    });

    if (!response.ok) {
      const errorBody = await response.text();
      return {
        ok: false,
        error: {
          code: 'provider_error',
          message: `PDL API returned ${response.status}`,
          details: { status: response.status, body: errorBody },
        },
      };
    }

    const data: PDLSearchResponse = await response.json();

    if (data.error) {
      return {
        ok: false,
        error: {
          code: 'provider_error',
          message: data.error.message || 'PDL API error',
          details: { type: data.error.type },
        },
      };
    }

    const people = data.data || [];

    if (people.length === 0) {
      return {
        ok: false,
        error: {
          code: 'provider_no_results',
          message: 'No leads found for the given criteria.',
          details: { zips: input.zips, scope: input.scope },
        },
      };
    }

    const leads = people.map((p) => mapPDLPersonToLead(p, input));

    return { ok: true, leads };
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Unknown error';
    return {
      ok: false,
      error: {
        code: 'provider_error',
        message: `PDL request failed: ${message}`,
      },
    };
  }
}

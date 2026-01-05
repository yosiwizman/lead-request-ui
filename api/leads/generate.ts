import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

// ============= Inlined Types =============
interface Lead {
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

type LeadScope = 'residential' | 'commercial' | 'both';

interface GenerateInput {
  leadRequest: string;
  zips: string[];
  scope: LeadScope;
}

interface ValidatedPayload {
  leadRequest: string;
  zips: string[];
  scope: LeadScope;
}

type Json = Record<string, unknown>;

// ============= Inlined Validation =============
const SCOPE_VALUES: LeadScope[] = ['residential', 'commercial', 'both'];

function parseZipCodes(raw: string): string[] {
  const parts = raw.split(/[\s,]+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return [];
  const valid = parts.filter((p) => /^[0-9]{5}$/.test(p));
  return Array.from(new Set(valid));
}

function validatePayload(body: Record<string, unknown>): 
  | { ok: true; data: ValidatedPayload }
  | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } } {
  
  const leadRequest = typeof body.leadRequest === 'string' ? body.leadRequest.trim() : '';
  const zipCodesRaw = typeof body.zipCodes === 'string' ? body.zipCodes : '';
  const leadScopeRaw = typeof body.leadScope === 'string' ? body.leadScope.toLowerCase().trim() : '';

  if (!leadRequest || leadRequest.length < 3 || leadRequest.length > 200) {
    return {
      ok: false,
      error: {
        code: 'invalid_lead_request',
        message: 'leadRequest must be 3-200 characters.',
        details: { leadRequestLength: leadRequest.length || 0 },
      },
    };
  }

  const zips = parseZipCodes(zipCodesRaw);
  if (zips.length < 1 || zips.length > 200) {
    return {
      ok: false,
      error: {
        code: 'invalid_zip_codes',
        message: 'Provide 1-200 valid ZIP codes (5 digits).',
        details: { count: zips.length },
      },
    };
  }

  if (!SCOPE_VALUES.includes(leadScopeRaw as LeadScope)) {
    return {
      ok: false,
      error: {
        code: 'invalid_scope',
        message: 'leadScope must be one of: residential|commercial|both.',
        details: { received: leadScopeRaw },
      },
    };
  }

  return {
    ok: true,
    data: { leadRequest, zips, scope: leadScopeRaw as LeadScope },
  };
}

// ============= Inlined Mock Provider =============
function seededRandom(seed: number) {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 0x100000000;
  };
}

function makeSeed(input: GenerateInput): number {
  const base = `${input.leadRequest}|${input.zips.join(',')}|${input.scope}`;
  let hash = 0;
  for (let i = 0; i < base.length; i++) {
    hash = (hash * 31 + base.charCodeAt(i)) >>> 0;
  }
  return hash;
}

const FIRST_NAMES = ['John', 'Jane', 'Mike', 'Sarah', 'David', 'Emily', 'Chris', 'Lisa', 'Tom', 'Anna'];
const LAST_NAMES = ['Smith', 'Johnson', 'Williams', 'Brown', 'Jones', 'Garcia', 'Miller', 'Davis', 'Rodriguez', 'Martinez'];
const STREETS = ['Main St', 'Oak Ave', 'Pine Rd', 'Maple Dr', 'Cedar Ln', 'Elm St', 'Park Ave', 'Lake Rd'];
const CITIES = ['Miami', 'Tampa', 'Orlando', 'Jacksonville', 'Fort Lauderdale'];
const STATES = ['FL', 'GA', 'AL'];

function pick<T>(rand: () => number, arr: T[]) {
  return arr[Math.floor(rand() * arr.length)];
}

function generateLeads(input: GenerateInput): Lead[] {
  const seed = makeSeed(input);
  const rand = seededRandom(seed);
  const count = 50;

  const out: Lead[] = [];
  for (let i = 0; i < count; i++) {
    const first = pick(rand, FIRST_NAMES);
    const last = pick(rand, LAST_NAMES);
    const leadType = input.scope === 'both' ? (rand() < 0.5 ? 'residential' : 'commercial') : input.scope;
    const zip = input.zips[Math.floor(rand() * input.zips.length)];

    out.push({
      first_name: first,
      last_name: last,
      address: `${Math.floor(rand() * 9999) + 1} ${pick(rand, STREETS)}`,
      city: pick(rand, CITIES),
      state: pick(rand, STATES),
      zip,
      phone: `(${Math.floor(rand() * 900) + 100}) ${Math.floor(rand() * 900) + 100}-${Math.floor(rand() * 9000) + 1000}`,
      email: `${first.toLowerCase()}.${last.toLowerCase()}@example.com`,
      lead_type: leadType,
      tags: input.leadRequest,
      source: 'lead-request-ui',
    });
  }
  return out;
}

// ============= Inlined CSV =============
const HEADERS = ['first_name', 'last_name', 'address', 'city', 'state', 'zip', 'phone', 'email', 'lead_type', 'tags', 'source'] as const;

function escapeCsv(value: unknown): string {
  const str = String(value ?? '');
  const escaped = str.replace(/"/g, '""');
  return `"${escaped}"`;
}

function leadsToCsv(leads: Lead[]): string {
  const lines: string[] = [];
  lines.push(HEADERS.join(','));
  for (const lead of leads) {
    const row = HEADERS.map((h) => escapeCsv(lead[h])).join(',');
    lines.push(row);
  }
  return lines.join('\n');
}

// ============= Handler =============
const jsonError = (res: VercelResponse, status: number, code: string, message: string, details?: Json) => {
  res.status(status).json({
    ok: false,
    error: { code, message, ...(details ? { details } : {}) },
  });
};

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    res.setHeader('Allow', 'POST');
    return jsonError(res, 405, 'invalid_method', 'Method not allowed. Use POST.');
  }

  if (!req.body || typeof req.body !== 'object') {
    return jsonError(res, 400, 'invalid_body', 'Request body is required JSON.');
  }

  const validation = validatePayload(req.body as Record<string, unknown>);
  if (!validation.ok) {
    const err = validation.error;
    return jsonError(res, 400, err.code, err.message, err.details);
  }

  const { leadRequest, zips, scope } = validation.data;

  const leads: Lead[] = generateLeads({ leadRequest, zips, scope });
  const csv = leadsToCsv(leads);

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return jsonError(res, 500, 'server_config_error', 'Missing Supabase configuration on server.', {
      missing: {
        SUPABASE_URL_or_VITE_SUPABASE_URL: !supabaseUrl,
        SUPABASE_SERVICE_ROLE_KEY: !serviceKey,
      },
    });
  }

  const supabase = createClient(supabaseUrl, serviceKey);

  const now = new Date();
  const yyyy = now.getFullYear();
  const mm = String(now.getMonth() + 1).padStart(2, '0');
  const dd = String(now.getDate()).padStart(2, '0');
  const dateDir = `${yyyy}-${mm}-${dd}`;
  const ts = Date.now();
  const rand = Math.random().toString(36).slice(2, 8);
  const path = `${dateDir}/${ts}-${rand}.csv`;
  const bucket = 'exports';

  const bytes = new TextEncoder().encode(csv);
  const uploadRes = await supabase.storage.from(bucket).upload(path, bytes, {
    contentType: 'text/csv',
    upsert: false,
  });

  if (uploadRes.error) {
    return jsonError(res, 500, 'upload_error', 'Failed to upload CSV to storage.', { message: uploadRes.error.message });
  }

  const expiresInSeconds = 24 * 60 * 60;
  const signedRes = await supabase.storage.from(bucket).createSignedUrl(path, expiresInSeconds);

  if (signedRes.error || !signedRes.data) {
    return jsonError(res, 500, 'signed_url_error', 'Failed to generate signed URL.', { message: signedRes.error?.message });
  }

  return res.status(200).json({
    ok: true,
    count: leads.length,
    bucket,
    path,
    signedUrl: signedRes.data.signedUrl,
    expiresInSeconds,
  });
}

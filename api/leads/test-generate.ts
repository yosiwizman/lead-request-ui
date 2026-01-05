import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

// Inline types and functions to test without src/ imports
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

function generateMockLeads(count: number): Lead[] {
  const leads: Lead[] = [];
  for (let i = 0; i < count; i++) {
    leads.push({
      first_name: 'John',
      last_name: 'Doe',
      address: '123 Main St',
      city: 'Miami',
      state: 'FL',
      zip: '33101',
      phone: '(305) 555-1234',
      email: 'john.doe@example.com',
      lead_type: 'residential',
      tags: 'test',
      source: 'lead-request-ui',
    });
  }
  return leads;
}

function leadsToCsv(leads: Lead[]): string {
  const headers = ['first_name', 'last_name', 'address', 'city', 'state', 'zip', 'phone', 'email', 'lead_type', 'tags', 'source'];
  const lines = [headers.join(',')];
  for (const lead of leads) {
    const row = headers.map((h) => `"${String(lead[h as keyof Lead]).replace(/"/g, '""')}"`).join(',');
    lines.push(row);
  }
  return lines.join('\n');
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'POST') {
    return res.status(405).json({ ok: false, error: { code: 'invalid_method', message: 'Use POST' } });
  }

  const leads = generateMockLeads(5);
  const csv = leadsToCsv(leads);

  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return res.status(500).json({
      ok: false,
      error: {
        code: 'config_error',
        message: 'Missing Supabase config',
        hasUrl: !!supabaseUrl,
        hasKey: !!serviceKey,
      },
    });
  }

  const supabase = createClient(supabaseUrl, serviceKey);
  const path = `test/${Date.now()}.csv`;

  const uploadRes = await supabase.storage.from('exports').upload(path, new TextEncoder().encode(csv), {
    contentType: 'text/csv',
  });

  if (uploadRes.error) {
    return res.status(500).json({ ok: false, error: { code: 'upload_error', message: uploadRes.error.message } });
  }

  const signedRes = await supabase.storage.from('exports').createSignedUrl(path, 86400);

  if (signedRes.error) {
    return res.status(500).json({ ok: false, error: { code: 'signed_url_error', message: signedRes.error.message } });
  }

  return res.status(200).json({
    ok: true,
    count: leads.length,
    signedUrl: signedRes.data.signedUrl,
  });
}

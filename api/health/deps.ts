/**
 * GET /api/health/deps
 * 
 * Dependency health check. Tests connectivity to external services.
 * Does NOT require authentication - this is a public health check.
 * Does NOT expose any secrets or sensitive data.
 */

import type { VercelRequest, VercelResponse } from '@vercel/node';
import { createClient } from '@supabase/supabase-js';

interface DepsHealth {
  ok: boolean;
  time: string;
  supabase: boolean;
  supabaseLatencyMs?: number;
  error?: string;
}

/**
 * Check Supabase connectivity with a simple query.
 */
async function checkSupabase(): Promise<{ ok: boolean; latencyMs: number; error?: string }> {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    return { ok: false, latencyMs: 0, error: 'Not configured' };
  }

  const start = Date.now();
  try {
    const supabase = createClient(supabaseUrl, serviceKey);
    
    // Simple connectivity check - just call the health endpoint
    // Using a lightweight query that doesn't require any specific table
    const { error } = await supabase.from('lead_exports').select('id').limit(1);
    
    const latencyMs = Date.now() - start;

    // PGRST116 means no rows found, which is fine for connectivity check
    if (error && error.code !== 'PGRST116') {
      return { ok: false, latencyMs, error: error.message };
    }

    return { ok: true, latencyMs };
  } catch (err) {
    const latencyMs = Date.now() - start;
    return { 
      ok: false, 
      latencyMs, 
      error: err instanceof Error ? err.message : 'Unknown error' 
    };
  }
}

export default async function handler(req: VercelRequest, res: VercelResponse) {
  if (req.method !== 'GET') {
    res.setHeader('Allow', 'GET');
    return res.status(405).json({ ok: false, error: 'Method not allowed' });
  }

  const supabaseCheck = await checkSupabase();

  const response: DepsHealth = {
    ok: supabaseCheck.ok,
    time: new Date().toISOString(),
    supabase: supabaseCheck.ok,
    supabaseLatencyMs: supabaseCheck.latencyMs,
  };

  // Include error details only if there's a problem
  if (!supabaseCheck.ok && supabaseCheck.error) {
    response.error = `supabase: ${supabaseCheck.error}`;
  }

  // Return 200 if all deps are healthy, 503 if any are down
  const statusCode = response.ok ? 200 : 503;

  return res.status(statusCode).json(response);
}

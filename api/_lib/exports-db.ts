/**
 * Database operations for lead_exports table.
 * Stores METADATA ONLY - no PII.
 */

import { createClient, SupabaseClient } from '@supabase/supabase-js';
import type { LeadQualityDiagnostics, FieldCoverage } from './types.js';

/**
 * Export record as stored in the database.
 */
export interface LeadExport {
  id: string;
  created_at: string;
  updated_at: string;
  provider: string;
  lead_request: string;
  zip_codes: string[];
  target: string;
  use_case: string;
  audience_id: string | null;
  request_id: string | null;
  status: 'building' | 'success' | 'no_results' | 'error';
  error_code: string | null;
  error_message: string | null;
  total_fetched: number | null;
  kept: number | null;
  diagnostics: LeadQualityDiagnostics | null;
  field_coverage: FieldCoverage | null;
  bucket: string | null;
  path: string | null;
  last_signed_url_at: string | null;
  /** AudienceLab request payload (sanitized, no PII) for debugging */
  request_payload: Record<string, unknown> | null;
  /** Number of leads originally requested */
  requested_count: number | null;
}

/**
 * Input for creating a new export record.
 */
export interface CreateExportInput {
  provider: string;
  leadRequest: string;
  zipCodes: string[];
  target: string;
  useCase: string;
  audienceId?: string;
  requestId?: string;
  status: 'building' | 'success' | 'no_results' | 'error';
  /** AudienceLab request payload for debugging (sanitized, no PII) */
  requestPayload?: Record<string, unknown>;
  /** Number of leads requested */
  requestedCount?: number;
}

/**
 * Input for updating an export on success.
 */
export interface UpdateExportSuccessInput {
  status: 'success';
  totalFetched: number;
  kept: number;
  diagnostics: LeadQualityDiagnostics | null;
  fieldCoverage: FieldCoverage | null;
  bucket: string;
  path: string;
}

/**
 * Input for updating an export on error or no results.
 */
export interface UpdateExportErrorInput {
  status: 'no_results' | 'error';
  errorCode?: string;
  errorMessage?: string;
  totalFetched?: number;
}

/**
 * Get Supabase client for database operations.
 * Throws if not configured.
 */
function getSupabaseClient(): SupabaseClient {
  const supabaseUrl = process.env.SUPABASE_URL || process.env.VITE_SUPABASE_URL;
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!supabaseUrl || !serviceKey) {
    throw new Error('Supabase not configured (missing SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY)');
  }

  return createClient(supabaseUrl, serviceKey);
}

/**
 * Create a new export record when a request starts.
 * Returns the created record ID for later updates.
 */
export async function createExport(input: CreateExportInput): Promise<string | null> {
  try {
    const supabase = getSupabaseClient();
    
    const { data, error } = await supabase
      .from('lead_exports')
      .insert({
        provider: input.provider,
        lead_request: input.leadRequest,
        zip_codes: input.zipCodes,
        target: input.target,
        use_case: input.useCase,
        audience_id: input.audienceId || null,
        request_id: input.requestId || null,
        status: input.status,
        request_payload: input.requestPayload || null,
        requested_count: input.requestedCount || null,
      })
      .select('id')
      .single();

    if (error) {
      console.error('Failed to create export record:', error.message);
      return null;
    }

    return data?.id || null;
  } catch (err) {
    console.error('Export DB error (create):', err);
    return null;
  }
}

/**
 * Update an export record on success.
 */
export async function updateExportSuccess(
  exportId: string,
  input: UpdateExportSuccessInput
): Promise<boolean> {
  try {
    const supabase = getSupabaseClient();

    const { error } = await supabase
      .from('lead_exports')
      .update({
        status: input.status,
        total_fetched: input.totalFetched,
        kept: input.kept,
        diagnostics: input.diagnostics,
        field_coverage: input.fieldCoverage,
        bucket: input.bucket,
        path: input.path,
      })
      .eq('id', exportId);

    if (error) {
      console.error('Failed to update export record:', error.message);
      return false;
    }

    return true;
  } catch (err) {
    console.error('Export DB error (updateSuccess):', err);
    return false;
  }
}

/**
 * Update an export record on error or no results.
 */
export async function updateExportError(
  exportId: string,
  input: UpdateExportErrorInput
): Promise<boolean> {
  try {
    const supabase = getSupabaseClient();

    const { error } = await supabase
      .from('lead_exports')
      .update({
        status: input.status,
        error_code: input.errorCode || null,
        error_message: input.errorMessage || null,
        total_fetched: input.totalFetched || null,
      })
      .eq('id', exportId);

    if (error) {
      console.error('Failed to update export error:', error.message);
      return false;
    }

    return true;
  } catch (err) {
    console.error('Export DB error (updateError):', err);
    return false;
  }
}

/**
 * Update export with audience_id after it becomes available.
 */
export async function updateExportAudienceId(
  exportId: string,
  audienceId: string
): Promise<boolean> {
  try {
    const supabase = getSupabaseClient();

    const { error } = await supabase
      .from('lead_exports')
      .update({ audience_id: audienceId })
      .eq('id', exportId);

    if (error) {
      console.error('Failed to update audience_id:', error.message);
      return false;
    }

    return true;
  } catch (err) {
    console.error('Export DB error (updateAudienceId):', err);
    return false;
  }
}

/**
 * Find export by audience_id (for status polling updates).
 */
export async function findExportByAudienceId(audienceId: string): Promise<LeadExport | null> {
  try {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from('lead_exports')
      .select('*')
      .eq('audience_id', audienceId)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error) {
      if (error.code !== 'PGRST116') { // Not found is OK
        console.error('Failed to find export by audience_id:', error.message);
      }
      return null;
    }

    return data as LeadExport;
  } catch (err) {
    console.error('Export DB error (findByAudienceId):', err);
    return null;
  }
}

/**
 * List recent exports (most recent first).
 */
export async function listExports(limit: number = 25): Promise<LeadExport[]> {
  try {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from('lead_exports')
      .select('*')
      .order('created_at', { ascending: false })
      .limit(limit);

    if (error) {
      console.error('Failed to list exports:', error.message);
      return [];
    }

    return (data || []) as LeadExport[];
  } catch (err) {
    console.error('Export DB error (list):', err);
    return [];
  }
}

/**
 * Get a single export by ID.
 */
export async function getExport(id: string): Promise<LeadExport | null> {
  try {
    const supabase = getSupabaseClient();

    const { data, error } = await supabase
      .from('lead_exports')
      .select('*')
      .eq('id', id)
      .single();

    if (error) {
      console.error('Failed to get export:', error.message);
      return null;
    }

    return data as LeadExport;
  } catch (err) {
    console.error('Export DB error (get):', err);
    return null;
  }
}

/**
 * Update last_signed_url_at timestamp.
 */
export async function updateLastSignedUrlAt(exportId: string): Promise<boolean> {
  try {
    const supabase = getSupabaseClient();

    const { error } = await supabase
      .from('lead_exports')
      .update({ last_signed_url_at: new Date().toISOString() })
      .eq('id', exportId);

    if (error) {
      console.error('Failed to update last_signed_url_at:', error.message);
      return false;
    }

    return true;
  } catch (err) {
    console.error('Export DB error (updateLastSignedUrlAt):', err);
    return false;
  }
}

/**
 * Create a signed URL for an existing export.
 * Returns null if export not found or has no path.
 */
export async function createSignedUrlForExport(
  exportId: string,
  expiresInSeconds: number = 86400
): Promise<{ signedUrl: string; expiresInSeconds: number } | null> {
  try {
    const exp = await getExport(exportId);
    if (!exp || !exp.bucket || !exp.path) {
      return null;
    }

    const supabase = getSupabaseClient();
    const { data, error } = await supabase.storage
      .from(exp.bucket)
      .createSignedUrl(exp.path, expiresInSeconds);

    if (error || !data?.signedUrl) {
      console.error('Failed to create signed URL:', error?.message);
      return null;
    }

    // Update last_signed_url_at
    await updateLastSignedUrlAt(exportId);

    return {
      signedUrl: data.signedUrl,
      expiresInSeconds,
    };
  } catch (err) {
    console.error('Export DB error (createSignedUrl):', err);
    return null;
  }
}

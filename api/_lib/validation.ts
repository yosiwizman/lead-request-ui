import type { LeadScope, UseCase, ValidatedPayload } from './types';

const SCOPE_VALUES: LeadScope[] = ['residential', 'commercial', 'both'];
const USE_CASE_VALUES: UseCase[] = ['call', 'email', 'both'];

export function parseZipCodes(raw: string): string[] {
  const parts = raw.split(/[\s,]+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return [];
  const valid = parts.filter((p) => /^[0-9]{5}$/.test(p));
  return Array.from(new Set(valid));
}

export function validatePayload(body: Record<string, unknown>):
  | { ok: true; data: ValidatedPayload }
  | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } } {

  const leadRequest = typeof body.leadRequest === 'string' ? body.leadRequest.trim() : '';
  const zipCodesRaw = typeof body.zipCodes === 'string' ? body.zipCodes : '';
  const leadScopeRaw = typeof body.leadScope === 'string' ? body.leadScope.toLowerCase().trim() : '';
  const useCaseRaw = typeof body.useCase === 'string' ? body.useCase.toLowerCase().trim() : 'both';

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

  if (!USE_CASE_VALUES.includes(useCaseRaw as UseCase)) {
    return {
      ok: false,
      error: {
        code: 'invalid_use_case',
        message: 'useCase must be one of: call|email|both.',
        details: { received: useCaseRaw },
      },
    };
  }

  return {
    ok: true,
    data: { leadRequest, zips, scope: leadScopeRaw as LeadScope, useCase: useCaseRaw as UseCase },
  };
}

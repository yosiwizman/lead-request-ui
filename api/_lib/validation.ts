import type { LeadScope, UseCase, ValidatedPayload } from './types';

const SCOPE_VALUES: LeadScope[] = ['residential', 'commercial', 'both'];
const USE_CASE_VALUES: UseCase[] = ['call', 'email', 'both'];

export function parseZipCodes(raw: string): string[] {
  const parts = raw.split(/[\s,]+/).map((p) => p.trim()).filter(Boolean);
  if (parts.length === 0) return [];
  const valid = parts.filter((p) => /^[0-9]{5}$/.test(p));
  return Array.from(new Set(valid));
}

/**
 * Parse minMatchScore from request body.
 * Valid values: 0, 1, 2, 3 (number or numeric string)
 * Returns undefined if not provided (defaults will be applied later based on useCase)
 */
function parseMinMatchScore(raw: unknown): number | undefined {
  if (raw === undefined || raw === null || raw === '') {
    return undefined;
  }
  const num = typeof raw === 'number' ? raw : parseInt(String(raw), 10);
  if (isNaN(num) || num < 0 || num > 3) {
    return undefined; // Invalid values are treated as "not provided"
  }
  return num;
}

export function validatePayload(body: Record<string, unknown>):
  | { ok: true; data: ValidatedPayload }
  | { ok: false; error: { code: string; message: string; details?: Record<string, unknown> } } {

  const leadRequest = typeof body.leadRequest === 'string' ? body.leadRequest.trim() : '';
  const zipCodesRaw = typeof body.zipCodes === 'string' ? body.zipCodes : '';
  const leadScopeRaw = typeof body.leadScope === 'string' ? body.leadScope.toLowerCase().trim() : '';
  const useCaseRaw = typeof body.useCase === 'string' ? body.useCase.toLowerCase().trim() : 'both';
  const minMatchScoreRaw = body.minMatchScore;

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

  // Parse minMatchScore (optional, defaults applied in recipe engine based on useCase)
  const minMatchScore = parseMinMatchScore(minMatchScoreRaw);
  
  // Validate minMatchScore if explicitly provided with invalid value
  if (minMatchScoreRaw !== undefined && minMatchScoreRaw !== null && minMatchScoreRaw !== '' && minMatchScore === undefined) {
    return {
      ok: false,
      error: {
        code: 'invalid_min_match_score',
        message: 'minMatchScore must be a number between 0 and 3.',
        details: { received: minMatchScoreRaw },
      },
    };
  }

  // Parse requestedCount (optional, default 200, max 1000)
  const requestedCountRaw = body.requestedCount;
  let requestedCount: number | undefined = undefined;
  if (requestedCountRaw !== undefined && requestedCountRaw !== null && requestedCountRaw !== '') {
    const num = typeof requestedCountRaw === 'number' ? requestedCountRaw : parseInt(String(requestedCountRaw), 10);
    if (isNaN(num) || num < 1 || num > 1000) {
      return {
        ok: false,
        error: {
          code: 'invalid_requested_count',
          message: 'requestedCount must be a number between 1 and 1000.',
          details: { received: requestedCountRaw },
        },
      };
    }
    requestedCount = num;
  }

  return {
    ok: true,
    data: { 
      leadRequest, 
      zips, 
      scope: leadScopeRaw as LeadScope, 
      useCase: useCaseRaw as UseCase,
      minMatchScore,
      requestedCount,
    },
  };
}

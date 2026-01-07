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

/**
 * Use case for lead quality filtering.
 * - 'call': Require phone present
 * - 'email': Require validated email present
 * - 'both': Either phone or email (default)
 */
export type UseCase = 'call' | 'email' | 'both';

export interface GenerateInput {
  leadRequest: string;
  zips: string[];
  scope: LeadScope;
  useCase?: UseCase;
}

export interface ValidatedPayload {
  leadRequest: string;
  zips: string[];
  scope: LeadScope;
  useCase: UseCase;
}

export type Json = Record<string, unknown>;

/**
 * Typed error for AudienceLab authentication/permission failures (401/403).
 * Contains sanitized request context (no secrets).
 */
export class AudienceLabAuthError extends Error {
  public readonly code = 'AUDIENCELAB_UNAUTHORIZED' as const;
  public readonly status: number;
  public readonly endpoint: string;
  public readonly method: string;
  public readonly requestId?: string;
  public readonly hint: string;

  constructor(opts: {
    status: number;
    endpoint: string;
    method: string;
    requestId?: string;
  }) {
    const hint =
      'Invalid key, wrong workspace, revoked key, or missing permissions (WRITE required for create).';
    super(`AudienceLab ${opts.status}: ${hint}`);
    this.name = 'AudienceLabAuthError';
    this.status = opts.status;
    this.endpoint = opts.endpoint;
    this.method = opts.method;
    this.requestId = opts.requestId;
    this.hint = hint;
  }

  /** Returns sanitized context safe for logging/responses (no secrets). */
  toSafeContext(): Record<string, unknown> {
    return {
      code: this.code,
      status: this.status,
      endpoint: this.endpoint,
      method: this.method,
      ...(this.requestId ? { requestId: this.requestId } : {}),
      hint: this.hint,
    };
  }
}

/**
 * Typed error for AudienceLab upstream failures (5xx).
 */
export class AudienceLabUpstreamError extends Error {
  public readonly code = 'AUDIENCELAB_UPSTREAM_ERROR' as const;
  public readonly status: number;
  public readonly endpoint: string;
  public readonly method: string;
  public readonly requestId?: string;

  constructor(opts: {
    status: number;
    endpoint: string;
    method: string;
    requestId?: string;
    body?: string;
  }) {
    super(`AudienceLab upstream error ${opts.status}`);
    this.name = 'AudienceLabUpstreamError';
    this.status = opts.status;
    this.endpoint = opts.endpoint;
    this.method = opts.method;
    this.requestId = opts.requestId;
  }

  toSafeContext(): Record<string, unknown> {
    return {
      code: this.code,
      status: this.status,
      endpoint: this.endpoint,
      method: this.method,
      ...(this.requestId ? { requestId: this.requestId } : {}),
    };
  }
}

/**
 * Typed error for AudienceLab API contract mismatches.
 * Thrown when response is 200 but doesn't contain expected data.
 */
export class AudienceLabContractError extends Error {
  public readonly code: string;
  public readonly endpoint: string;
  public readonly method: string;
  public readonly requestId?: string;
  public readonly hint: string;
  public readonly responseShape: string;
  public readonly upstreamMessage?: string;

  constructor(opts: {
    code: 'AUDIENCELAB_NO_AUDIENCE_ID' | 'AUDIENCELAB_ERROR_PAYLOAD';
    endpoint: string;
    method: string;
    requestId?: string;
    responseShape: string;
    upstreamMessage?: string;
  }) {
    const hint = opts.code === 'AUDIENCELAB_NO_AUDIENCE_ID'
      ? 'Response did not contain an audience ID in expected locations. Contact AudienceLab support with requestId.'
      : `AudienceLab returned an error: ${opts.upstreamMessage || 'unknown'}`;
    super(`AudienceLab contract error: ${hint}`);
    this.name = 'AudienceLabContractError';
    this.code = opts.code;
    this.endpoint = opts.endpoint;
    this.method = opts.method;
    this.requestId = opts.requestId;
    this.responseShape = opts.responseShape;
    this.upstreamMessage = opts.upstreamMessage;
    this.hint = hint;
  }

  toSafeContext(): Record<string, unknown> {
    return {
      code: this.code,
      endpoint: this.endpoint,
      method: this.method,
      responseShape: this.responseShape,
      ...(this.requestId ? { requestId: this.requestId } : {}),
      ...(this.upstreamMessage ? { upstreamMessage: this.upstreamMessage } : {}),
      hint: this.hint,
    };
  }
}

/**
 * Typed error for AudienceLab async/job responses.
 * Thrown when API returns a job ID instead of immediate result.
 */
export class AudienceLabAsyncError extends Error {
  public readonly code = 'AUDIENCELAB_ASYNC_RESPONSE' as const;
  public readonly endpoint: string;
  public readonly method: string;
  public readonly requestId?: string;
  public readonly jobId?: string;
  public readonly taskId?: string;
  public readonly hint: string;

  constructor(opts: {
    endpoint: string;
    method: string;
    requestId?: string;
    jobId?: string;
    taskId?: string;
  }) {
    const hint = 'AudienceLab returned an async job response. Polling is not yet implemented.';
    super(`AudienceLab async response: ${hint}`);
    this.name = 'AudienceLabAsyncError';
    this.endpoint = opts.endpoint;
    this.method = opts.method;
    this.requestId = opts.requestId;
    this.jobId = opts.jobId;
    this.taskId = opts.taskId;
    this.hint = hint;
  }

  toSafeContext(): Record<string, unknown> {
    return {
      code: this.code,
      endpoint: this.endpoint,
      method: this.method,
      ...(this.requestId ? { requestId: this.requestId } : {}),
      ...(this.jobId ? { jobId: this.jobId } : {}),
      ...(this.taskId ? { taskId: this.taskId } : {}),
      hint: this.hint,
    };
  }
}

// Provider result types
export type ProviderErrorCode = 'provider_error' | 'provider_no_results' | 'provider_building';

export interface ProviderError {
  code: ProviderErrorCode;
  message: string;
  details?: Json;
}

/**
 * Match-by accuracy tier for lead quality ranking.
 * Based on AudienceLab SKIPTRACE_MATCH_BY field.
 * - high: Contains ADDRESS + EMAIL (most accurate)
 * - medium: Contains NAME + ADDRESS
 * - low: Any other match method
 */
export type MatchByTier = 'high' | 'medium' | 'low';

/**
 * Counts per match-by accuracy tier.
 */
export interface MatchByTierCounts {
  high: number;
  medium: number;
  low: number;
}

/**
 * Diagnostics for lead quality filtering (never includes PII).
 */
export interface LeadQualityDiagnostics {
  totalFetched: number;
  kept: number;
  filteredMissingPhone: number;
  filteredInvalidEmail: number;
  filteredInvalidEmailEsp: number;
  filteredEmailTooOld: number;
  filteredDnc: number;
  missingNameOrAddressCount: number;
  matchByTier: MatchByTierCounts;
}

/**
 * Quality summary for API response (exposed to client).
 */
export interface QualitySummary {
  totalFetched: number;
  kept: number;
  filteredMissingPhone: number;
  filteredInvalidEmail: number;
  filteredInvalidEmailEsp: number;
  filteredEmailTooOld: number;
  filteredDnc: number;
  missingNameOrAddressCount: number;
  matchByTier: MatchByTierCounts;
}

/**
 * Field names tracked for coverage diagnostics.
 * These are the 8 core lead fields we care about.
 */
export type CoverageFieldName = 
  | 'first_name'
  | 'last_name'
  | 'address'
  | 'city'
  | 'state'
  | 'zip'
  | 'phone'
  | 'email';

/**
 * Field coverage statistics for a set of contacts/leads.
 * Used to diagnose data quality without exposing PII.
 */
export interface FieldCoverageBlock {
  /** Total number of contacts/leads in this set */
  total: number;
  /** Count of contacts with each field present (non-empty) */
  present: Record<CoverageFieldName, number>;
  /** Percentage (0-100) of contacts with each field present */
  pct: Record<CoverageFieldName, number>;
}

/**
 * Field coverage diagnostics for API response.
 * Provides before/after filtering coverage to identify data quality issues.
 */
export interface FieldCoverage {
  /** Coverage of raw fetched contacts (before quality filtering) */
  coverageFetched: FieldCoverageBlock;
  /** Coverage of kept leads (after quality filtering) */
  coverageKept: FieldCoverageBlock;
}

export type ProviderResult =
  | { ok: true; leads: Lead[]; audienceId?: string; requestId?: string; diagnostics?: LeadQualityDiagnostics; fieldCoverage?: FieldCoverage }
  | { ok: false; error: ProviderError };

/**
 * Result when audience is still building (async).
 */
export interface ProviderBuildingResult {
  building: true;
  audienceId: string;
  requestId: string;
}

/**
 * Configuration error thrown when provider is misconfigured.
 */
export class ProviderConfigError extends Error {
  public readonly code = 'server_config_error' as const;
  public readonly provider: string;
  public readonly hint: string;

  constructor(opts: { provider: string; message: string; hint: string }) {
    super(opts.message);
    this.name = 'ProviderConfigError';
    this.provider = opts.provider;
    this.hint = opts.hint;
  }

  toSafeContext(): Record<string, unknown> {
    return {
      code: this.code,
      provider: this.provider,
      hint: this.hint,
    };
  }
}

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

// Provider result types
export type ProviderErrorCode = 'provider_error' | 'provider_no_results';

export interface ProviderError {
  code: ProviderErrorCode;
  message: string;
  details?: Json;
}

export type ProviderResult =
  | { ok: true; leads: Lead[] }
  | { ok: false; error: ProviderError };

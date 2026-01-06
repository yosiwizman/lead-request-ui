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
export type ProviderErrorCode = 'provider_error' | 'provider_no_results';

export interface ProviderError {
  code: ProviderErrorCode;
  message: string;
  details?: Json;
}

export type ProviderResult =
  | { ok: true; leads: Lead[] }
  | { ok: false; error: ProviderError };

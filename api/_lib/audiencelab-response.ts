/**
 * AudienceLab response parsing utilities.
 * 
 * Handles various response shapes from AudienceLab API and provides
 * robust audience ID extraction with detailed diagnostics.
 */

/**
 * Result of audience ID extraction.
 */
export type ExtractAudienceIdResult =
  | { ok: true; audienceId: string; source: string }
  | { ok: false; reason: 'async'; jobId?: string; taskId?: string }
  | { ok: false; reason: 'error_payload'; errorMessage: string }
  | { ok: false; reason: 'not_found'; shape: string };

/**
 * Extract audience ID from various response shapes.
 * 
 * Handles:
 * - { id: "..." }
 * - { audience_id: "..." }
 * - { audienceId: "..." }
 * - { data: { id: "..." } }
 * - { data: { audience_id: "..." } }
 * - { audience: { id: "..." } }
 * - [ { id: "..." } ] (array response)
 * - Location header: /audiences/<id>
 * - Async/job responses: { job_id: "..." } or { task_id: "..." }
 */
export function extractAudienceId(
  body: unknown,
  headers?: Headers
): ExtractAudienceIdResult {
  // Try Location header first (common for 201 Created)
  if (headers) {
    const location = headers.get('location');
    if (location) {
      const match = location.match(/\/audiences\/([a-zA-Z0-9_-]+)/);
      if (match) {
        return { ok: true, audienceId: match[1], source: 'location_header' };
      }
    }
  }

  // Handle non-object responses
  if (!body || typeof body !== 'object') {
    return { ok: false, reason: 'not_found', shape: describeShape(body) };
  }

  // Handle array responses - take first item
  if (Array.isArray(body)) {
    if (body.length === 0) {
      return { ok: false, reason: 'not_found', shape: 'empty_array' };
    }
    const first = body[0];
    if (first && typeof first === 'object') {
      const idFromArray = extractIdFromObject(first as Record<string, unknown>);
      if (idFromArray) {
        return { ok: true, audienceId: idFromArray, source: 'array[0]' };
      }
    }
    return { ok: false, reason: 'not_found', shape: describeShape(body) };
  }

  const obj = body as Record<string, unknown>;

  // Check for async/job responses first
  if ('job_id' in obj || 'task_id' in obj || 'request_id' in obj) {
    const jobId = asString(obj.job_id);
    const taskId = asString(obj.task_id) || asString(obj.request_id);
    // Only treat as async if there's no ID present
    if (!extractIdFromObject(obj)) {
      return { ok: false, reason: 'async', jobId, taskId };
    }
  }

  // Check for error payloads (200 with error body)
  if (isErrorPayload(obj)) {
    const errorMessage = extractErrorMessage(obj);
    return { ok: false, reason: 'error_payload', errorMessage };
  }

  // Try root-level ID
  const rootId = extractIdFromObject(obj);
  if (rootId) {
    return { ok: true, audienceId: rootId, source: 'root' };
  }

  // Try nested under 'data'
  if ('data' in obj && obj.data && typeof obj.data === 'object') {
    const dataObj = obj.data as Record<string, unknown>;
    // Handle data as array
    if (Array.isArray(dataObj)) {
      if (dataObj.length > 0 && dataObj[0] && typeof dataObj[0] === 'object') {
        const idFromDataArray = extractIdFromObject(dataObj[0] as Record<string, unknown>);
        if (idFromDataArray) {
          return { ok: true, audienceId: idFromDataArray, source: 'data[0]' };
        }
      }
    } else {
      const idFromData = extractIdFromObject(dataObj);
      if (idFromData) {
        return { ok: true, audienceId: idFromData, source: 'data' };
      }
    }
  }

  // Try nested under 'audience'
  if ('audience' in obj && obj.audience && typeof obj.audience === 'object') {
    const idFromAudience = extractIdFromObject(obj.audience as Record<string, unknown>);
    if (idFromAudience) {
      return { ok: true, audienceId: idFromAudience, source: 'audience' };
    }
  }

  // Try nested under 'result'
  if ('result' in obj && obj.result && typeof obj.result === 'object') {
    const idFromResult = extractIdFromObject(obj.result as Record<string, unknown>);
    if (idFromResult) {
      return { ok: true, audienceId: idFromResult, source: 'result' };
    }
  }

  return { ok: false, reason: 'not_found', shape: describeShape(body) };
}

/**
 * Extract ID from an object trying common key names.
 */
function extractIdFromObject(obj: Record<string, unknown>): string | null {
  // Try common ID field names
  const idKeys = ['id', 'audience_id', 'audienceId', '_id', 'Id', 'ID'];
  for (const key of idKeys) {
    if (key in obj) {
      const val = obj[key];
      if (typeof val === 'string' && val.length > 0) {
        return val;
      }
      if (typeof val === 'number') {
        return String(val);
      }
    }
  }
  return null;
}

/**
 * Check if object looks like an error payload.
 */
function isErrorPayload(obj: Record<string, unknown>): boolean {
  // Common error indicators
  if ('error' in obj) return true;
  if ('errors' in obj && Array.isArray(obj.errors)) return true;
  if ('message' in obj && ('status' in obj || 'code' in obj || 'success' in obj)) {
    // { message, success: false } pattern
    if ('success' in obj && obj.success === false) return true;
    // { message, code } where code looks like an error
    if ('code' in obj && typeof obj.code === 'string' && /error|fail/i.test(obj.code)) return true;
  }
  return false;
}

/**
 * Extract error message from error payload.
 */
function extractErrorMessage(obj: Record<string, unknown>): string {
  if ('error' in obj) {
    if (typeof obj.error === 'string') return obj.error;
    if (obj.error && typeof obj.error === 'object' && 'message' in (obj.error as Record<string, unknown>)) {
      return String((obj.error as Record<string, unknown>).message);
    }
  }
  if ('message' in obj && typeof obj.message === 'string') {
    return obj.message;
  }
  if ('errors' in obj && Array.isArray(obj.errors) && obj.errors.length > 0) {
    const first = obj.errors[0];
    if (typeof first === 'string') return first;
    if (first && typeof first === 'object' && 'message' in first) {
      return String(first.message);
    }
  }
  return 'Unknown error';
}

/**
 * Convert unknown to string if possible.
 */
function asString(val: unknown): string | undefined {
  if (typeof val === 'string') return val;
  if (typeof val === 'number') return String(val);
  return undefined;
}

/**
 * Describe the shape of a response for diagnostics (no PII).
 * Returns a string like "object{id,name,data{...}}" or "array[3]".
 */
export function describeShape(value: unknown, depth = 0, maxDepth = 2): string {
  if (value === null) return 'null';
  if (value === undefined) return 'undefined';
  if (typeof value === 'string') return `string(${value.length})`;
  if (typeof value === 'number') return 'number';
  if (typeof value === 'boolean') return 'boolean';

  if (Array.isArray(value)) {
    if (value.length === 0) return 'array[]';
    if (depth >= maxDepth) return `array[${value.length}]`;
    const firstShape = describeShape(value[0], depth + 1, maxDepth);
    return `array[${value.length}]<${firstShape}>`;
  }

  if (typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const keys = Object.keys(obj);
    if (keys.length === 0) return 'object{}';
    if (depth >= maxDepth) return `object{${keys.length} keys}`;

    // Show key names (sanitized - skip values that look like PII)
    const safeKeys = keys
      .slice(0, 10) // Limit to first 10 keys
      .map(k => {
        const v = obj[k];
        if (v && typeof v === 'object') {
          return `${k}:${describeShape(v, depth + 1, maxDepth)}`;
        }
        return k;
      });
    
    const suffix = keys.length > 10 ? `,+${keys.length - 10}` : '';
    return `object{${safeKeys.join(',')}}${suffix}`;
  }

  return typeof value;
}

/**
 * Generate a unique request ID for correlation.
 */
export function generateRequestId(): string {
  const timestamp = Date.now().toString(36);
  const random = Math.random().toString(36).slice(2, 8);
  return `req_${timestamp}_${random}`;
}

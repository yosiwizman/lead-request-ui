/**
 * ByteString sanitization for HTTP headers.
 * 
 * HTTP header values must be Latin1/ISO-8859-1 (all char codes <= 255).
 * This module provides utilities to sanitize env vars that may contain
 * invisible characters like UTF-8 BOM (U+FEFF) which cause fetch() to crash.
 */

/**
 * Configuration error thrown when an env var contains invalid characters.
 * Safe to expose in error responses (never includes the raw value).
 */
export class ConfigError extends Error {
  public readonly code: string;
  public readonly hint: string;
  public readonly label: string;
  public readonly invalidCharIndex?: number;
  public readonly invalidCharCode?: number;

  constructor(opts: {
    code: string;
    message: string;
    hint: string;
    label: string;
    invalidCharIndex?: number;
    invalidCharCode?: number;
  }) {
    super(opts.message);
    this.name = 'ConfigError';
    this.code = opts.code;
    this.hint = opts.hint;
    this.label = opts.label;
    this.invalidCharIndex = opts.invalidCharIndex;
    this.invalidCharCode = opts.invalidCharCode;
  }

  /** Returns safe context for JSON responses (never includes raw values). */
  toSafeContext(): Record<string, unknown> {
    return {
      code: this.code,
      label: this.label,
      hint: this.hint,
      ...(this.invalidCharIndex !== undefined
        ? { invalidCharIndex: this.invalidCharIndex, invalidCharCode: this.invalidCharCode }
        : {}),
    };
  }
}

/**
 * Sanitize a string for use as an HTTP header value (ByteString).
 * 
 * - Strips leading BOM characters (U+FEFF)
 * - Trims whitespace
 * - Validates all characters are Latin1 (charCode <= 255)
 * 
 * @param input - The raw input string (e.g. from process.env)
 * @param label - Human-readable label for error messages (e.g. "AUDIENCELAB_API_KEY")
 * @returns Sanitized string safe for HTTP headers
 * @throws ConfigError if input is empty/undefined or contains non-Latin1 characters
 */
export function sanitizeByteString(input: string | undefined, label: string): string {
  // Check for missing/empty input
  if (!input) {
    throw new ConfigError({
      code: 'CONFIG_MISSING',
      message: `${label} is not configured`,
      hint: `Set ${label} in environment variables and redeploy.`,
      label,
    });
  }

  // Strip leading BOM(s) - U+FEFF (65279)
  let sanitized = input.replace(/^\uFEFF+/, '');

  // Trim whitespace
  sanitized = sanitized.trim();

  // Check if empty after sanitization
  if (sanitized.length === 0) {
    throw new ConfigError({
      code: 'CONFIG_EMPTY',
      message: `${label} is empty after sanitization`,
      hint: `Re-set ${label} in environment variables (was only whitespace/BOM).`,
      label,
    });
  }

  // Validate all characters are Latin1 (ByteString-safe: charCode <= 255)
  for (let i = 0; i < sanitized.length; i++) {
    const charCode = sanitized.charCodeAt(i);
    if (charCode > 255) {
      throw new ConfigError({
        code: 'INVALID_HEADER_VALUE',
        message: `${label} contains non-Latin1 characters; remove invisible characters and re-set env var`,
        hint: `Re-copy ${label} from source (avoid rich text editors). Character at index ${i} has code ${charCode}.`,
        label,
        invalidCharIndex: i,
        invalidCharCode: charCode,
      });
    }
  }

  return sanitized;
}

/**
 * Mask a string for safe logging (shows first 3 + last 3 chars only).
 * Use AFTER sanitization to avoid logging invalid chars.
 */
export function maskForLogging(value: string): string {
  if (value.length <= 6) {
    return '***';
  }
  return `${value.slice(0, 3)}…${value.slice(-3)}`;
}

import { describe, it, expect } from 'vitest';
import {
  sanitizeByteString,
  maskForLogging,
  ConfigError,
} from '../../../api/_lib/bytestring';

describe('sanitizeByteString', () => {
  it('returns clean string unchanged', () => {
    const input = 'sk_test_abc123';
    expect(sanitizeByteString(input, 'TEST_KEY')).toBe(input);
  });

  it('strips leading BOM (U+FEFF)', () => {
    const withBom = '\uFEFFsk_test_abc123';
    expect(sanitizeByteString(withBom, 'TEST_KEY')).toBe('sk_test_abc123');
  });

  it('strips multiple leading BOMs', () => {
    const withMultipleBom = '\uFEFF\uFEFF\uFEFFsk_test_abc123';
    expect(sanitizeByteString(withMultipleBom, 'TEST_KEY')).toBe('sk_test_abc123');
  });

  it('trims whitespace', () => {
    const withWhitespace = '  sk_test_abc123  ';
    expect(sanitizeByteString(withWhitespace, 'TEST_KEY')).toBe('sk_test_abc123');
  });

  it('strips BOM and trims whitespace together', () => {
    const messy = '\uFEFF  sk_test_abc123  ';
    expect(sanitizeByteString(messy, 'TEST_KEY')).toBe('sk_test_abc123');
  });

  it('throws CONFIG_MISSING for undefined input', () => {
    expect(() => sanitizeByteString(undefined, 'TEST_KEY')).toThrow(ConfigError);
    try {
      sanitizeByteString(undefined, 'TEST_KEY');
    } catch (err) {
      expect(err).toBeInstanceOf(ConfigError);
      if (err instanceof ConfigError) {
        expect(err.code).toBe('CONFIG_MISSING');
        expect(err.label).toBe('TEST_KEY');
      }
    }
  });

  it('throws CONFIG_MISSING for empty string', () => {
    expect(() => sanitizeByteString('', 'TEST_KEY')).toThrow(ConfigError);
    try {
      sanitizeByteString('', 'TEST_KEY');
    } catch (err) {
      if (err instanceof ConfigError) {
        expect(err.code).toBe('CONFIG_MISSING');
      }
    }
  });

  it('throws CONFIG_EMPTY for whitespace-only input', () => {
    expect(() => sanitizeByteString('   ', 'TEST_KEY')).toThrow(ConfigError);
    try {
      sanitizeByteString('   ', 'TEST_KEY');
    } catch (err) {
      if (err instanceof ConfigError) {
        expect(err.code).toBe('CONFIG_EMPTY');
      }
    }
  });

  it('throws CONFIG_EMPTY for BOM-only input', () => {
    expect(() => sanitizeByteString('\uFEFF', 'TEST_KEY')).toThrow(ConfigError);
    try {
      sanitizeByteString('\uFEFF', 'TEST_KEY');
    } catch (err) {
      if (err instanceof ConfigError) {
        expect(err.code).toBe('CONFIG_EMPTY');
      }
    }
  });

  it('throws INVALID_HEADER_VALUE for non-Latin1 chars (Cyrillic)', () => {
    const cyrillic = 'тест'; // Russian word "test"
    expect(() => sanitizeByteString(cyrillic, 'TEST_KEY')).toThrow(ConfigError);
    try {
      sanitizeByteString(cyrillic, 'TEST_KEY');
    } catch (err) {
      if (err instanceof ConfigError) {
        expect(err.code).toBe('INVALID_HEADER_VALUE');
        expect(err.invalidCharIndex).toBe(0);
        expect(err.invalidCharCode).toBeGreaterThan(255);
      }
    }
  });

  it('throws INVALID_HEADER_VALUE for emoji', () => {
    const withEmoji = 'sk_test_🔑';
    expect(() => sanitizeByteString(withEmoji, 'TEST_KEY')).toThrow(ConfigError);
    try {
      sanitizeByteString(withEmoji, 'TEST_KEY');
    } catch (err) {
      if (err instanceof ConfigError) {
        expect(err.code).toBe('INVALID_HEADER_VALUE');
        expect(err.invalidCharCode).toBeGreaterThan(255);
      }
    }
  });

  it('allows Latin1 extended chars (charCode 128-255)', () => {
    // é = 233, ñ = 241, ü = 252 - all valid Latin1
    const latin1Extended = 'café_niño_über';
    expect(sanitizeByteString(latin1Extended, 'TEST_KEY')).toBe(latin1Extended);
  });
});

describe('ConfigError', () => {
  it('never includes raw value in message or safe context', () => {
    const secretKey = 'sk_live_supersecret123456';
    const err = new ConfigError({
      code: 'TEST_ERROR',
      message: 'Test error message',
      hint: 'Test hint',
      label: 'SECRET_KEY',
    });

    // Message should not contain the secret
    expect(err.message).not.toContain(secretKey);
    
    // Safe context should not contain the secret
    const ctx = err.toSafeContext();
    const ctxString = JSON.stringify(ctx);
    expect(ctxString).not.toContain(secretKey);
    expect(ctxString).not.toContain('supersecret');
  });

  it('toSafeContext includes code, label, hint', () => {
    const err = new ConfigError({
      code: 'INVALID_HEADER_VALUE',
      message: 'Test message',
      hint: 'Test hint',
      label: 'API_KEY',
      invalidCharIndex: 5,
      invalidCharCode: 65279,
    });

    const ctx = err.toSafeContext();
    expect(ctx.code).toBe('INVALID_HEADER_VALUE');
    expect(ctx.label).toBe('API_KEY');
    expect(ctx.hint).toBe('Test hint');
    expect(ctx.invalidCharIndex).toBe(5);
    expect(ctx.invalidCharCode).toBe(65279);
  });
});

describe('maskForLogging', () => {
  it('masks long strings showing first 3 and last 3', () => {
    expect(maskForLogging('sk_test_abc123456')).toBe('sk_…456');
  });

  it('returns *** for short strings', () => {
    expect(maskForLogging('abc')).toBe('***');
    expect(maskForLogging('abcdef')).toBe('***');
  });

  it('masks 7+ char strings', () => {
    expect(maskForLogging('abcdefg')).toBe('abc…efg');
  });
});

describe('BOM reproduction test', () => {
  it('confirms BOM charCode is 65279', () => {
    const bom = '\uFEFF';
    expect(bom.charCodeAt(0)).toBe(65279);
  });

  it('demonstrates the exact error scenario', () => {
    // This is what happens when env var has a BOM prefix
    const bomPrefixedKey = '\uFEFFsk_DPa85qtvuK7lpxqHSc7E8xaarY7gWUjI8zUyRyAA';
    
    // Without sanitization, setting this as a header would crash:
    // "Cannot convert argument to a ByteString because the character at index 0 has a value of 65279"
    expect(bomPrefixedKey.charCodeAt(0)).toBe(65279);
    
    // With sanitization, it should work
    const sanitized = sanitizeByteString(bomPrefixedKey, 'AUDIENCELAB_API_KEY');
    expect(sanitized.charCodeAt(0)).not.toBe(65279);
    expect(sanitized).toBe('sk_DPa85qtvuK7lpxqHSc7E8xaarY7gWUjI8zUyRyAA');
    
    // All chars should be <= 255 (Latin1/ByteString safe)
    for (let i = 0; i < sanitized.length; i++) {
      expect(sanitized.charCodeAt(i)).toBeLessThanOrEqual(255);
    }
  });
});

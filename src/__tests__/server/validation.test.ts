import { describe, it, expect } from 'vitest';
import { parseZipCodes, validatePayload } from '../../../api/_lib/validation';

describe('zip parsing', () => {
  it('parses comma and space separated zips', () => {
    expect(parseZipCodes('33101, 33130 90210')).toEqual(['33101', '33130', '90210']);
  });

  it('filters invalid zips and dedupes', () => {
    expect(parseZipCodes('abc, 1234, 12345, 12345')).toEqual(['12345']);
  });
});

describe('payload validation', () => {
  it('rejects invalid scope', () => {
    const res = validatePayload({ leadRequest: 'test', zipCodes: '12345', leadScope: 'bad' });
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.error.code).toBe('invalid_scope');
    }
  });

  it('accepts valid payload', () => {
    const res = validatePayload({ leadRequest: 'roofing', zipCodes: '12345,23456', leadScope: 'both' });
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.data.zips).toEqual(['12345', '23456']);
      expect(res.data.scope).toBe('both');
    }
  });
});
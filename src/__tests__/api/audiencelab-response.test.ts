import { describe, it, expect } from 'vitest';
import {
  extractAudienceId,
  describeShape,
  generateRequestId,
} from '../../../api/_lib/audiencelab-response';

describe('extractAudienceId', () => {
  describe('root-level ID extraction', () => {
    it('extracts id from root', () => {
      const result = extractAudienceId({ id: 'aud_123' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.audienceId).toBe('aud_123');
        expect(result.source).toBe('root');
      }
    });

    it('extracts audience_id from root', () => {
      const result = extractAudienceId({ audience_id: 'aud_456' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.audienceId).toBe('aud_456');
        expect(result.source).toBe('root');
      }
    });

    it('extracts audienceId (camelCase) from root', () => {
      const result = extractAudienceId({ audienceId: 'aud_789' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.audienceId).toBe('aud_789');
        expect(result.source).toBe('root');
      }
    });

    it('extracts numeric id and converts to string', () => {
      const result = extractAudienceId({ id: 12345 });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.audienceId).toBe('12345');
      }
    });
  });

  describe('nested ID extraction', () => {
    it('extracts id from data object', () => {
      const result = extractAudienceId({ data: { id: 'nested_id' } });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.audienceId).toBe('nested_id');
        expect(result.source).toBe('data');
      }
    });

    it('extracts audience_id from data object', () => {
      const result = extractAudienceId({ data: { audience_id: 'nested_aud' } });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.audienceId).toBe('nested_aud');
        expect(result.source).toBe('data');
      }
    });

    it('extracts id from audience object', () => {
      const result = extractAudienceId({ audience: { id: 'from_audience' } });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.audienceId).toBe('from_audience');
        expect(result.source).toBe('audience');
      }
    });

    it('extracts id from result object', () => {
      const result = extractAudienceId({ result: { id: 'from_result' } });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.audienceId).toBe('from_result');
        expect(result.source).toBe('result');
      }
    });

    it('extracts id from data array', () => {
      const result = extractAudienceId({ data: [{ id: 'array_id' }] });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.audienceId).toBe('array_id');
        expect(result.source).toBe('data[0]');
      }
    });
  });

  describe('array responses', () => {
    it('extracts id from first array element', () => {
      const result = extractAudienceId([{ id: 'first_id' }, { id: 'second_id' }]);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.audienceId).toBe('first_id');
        expect(result.source).toBe('array[0]');
      }
    });

    it('returns not_found for empty array', () => {
      const result = extractAudienceId([]);
      expect(result.ok).toBe(false);
      if (!result.ok && result.reason === 'not_found') {
        expect(result.shape).toBe('empty_array');
      }
    });
  });

  describe('Location header', () => {
    it('extracts id from Location header', () => {
      const headers = new Headers();
      headers.set('location', 'https://api.audiencelab.io/audiences/header_id_123');
      const result = extractAudienceId({}, headers);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.audienceId).toBe('header_id_123');
        expect(result.source).toBe('location_header');
      }
    });

    it('handles relative Location header', () => {
      const headers = new Headers();
      headers.set('location', '/audiences/rel_id_456');
      const result = extractAudienceId({}, headers);
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.audienceId).toBe('rel_id_456');
        expect(result.source).toBe('location_header');
      }
    });
  });

  describe('async/job responses', () => {
    it('detects job_id response without audience id', () => {
      const result = extractAudienceId({ job_id: 'job_123', status: 'processing' });
      expect(result.ok).toBe(false);
      if (!result.ok && result.reason === 'async') {
        expect(result.jobId).toBe('job_123');
      }
    });

    it('detects task_id response without audience id', () => {
      const result = extractAudienceId({ task_id: 'task_456' });
      expect(result.ok).toBe(false);
      if (!result.ok && result.reason === 'async') {
        expect(result.taskId).toBe('task_456');
      }
    });

    it('prefers id over async indicators when both present', () => {
      const result = extractAudienceId({ id: 'aud_123', job_id: 'job_456' });
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.audienceId).toBe('aud_123');
      }
    });
  });

  describe('error payloads (200 with error)', () => {
    it('detects error field', () => {
      const result = extractAudienceId({ error: 'Something went wrong' });
      expect(result.ok).toBe(false);
      if (!result.ok && result.reason === 'error_payload') {
        expect(result.errorMessage).toBe('Something went wrong');
      }
    });

    it('detects nested error message', () => {
      const result = extractAudienceId({ error: { message: 'Nested error' } });
      expect(result.ok).toBe(false);
      if (!result.ok && result.reason === 'error_payload') {
        expect(result.errorMessage).toBe('Nested error');
      }
    });

    it('detects errors array', () => {
      const result = extractAudienceId({ errors: ['First error', 'Second error'] });
      expect(result.ok).toBe(false);
      if (!result.ok && result.reason === 'error_payload') {
        expect(result.errorMessage).toBe('First error');
      }
    });

    it('detects success: false pattern', () => {
      const result = extractAudienceId({ success: false, message: 'Failed' });
      expect(result.ok).toBe(false);
      if (!result.ok && result.reason === 'error_payload') {
        expect(result.errorMessage).toBe('Failed');
      }
    });
  });

  describe('not found cases', () => {
    it('returns not_found for null', () => {
      const result = extractAudienceId(null);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('not_found');
      }
    });

    it('returns not_found for undefined', () => {
      const result = extractAudienceId(undefined);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('not_found');
      }
    });

    it('returns not_found for object without id', () => {
      const result = extractAudienceId({ name: 'Test', status: 'active' });
      expect(result.ok).toBe(false);
      if (!result.ok && result.reason === 'not_found') {
        expect(result.shape).toContain('object');
      }
    });

    it('returns not_found for empty object', () => {
      const result = extractAudienceId({});
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.reason).toBe('not_found');
      }
    });
  });
});

describe('describeShape', () => {
  it('describes null', () => {
    expect(describeShape(null)).toBe('null');
  });

  it('describes undefined', () => {
    expect(describeShape(undefined)).toBe('undefined');
  });

  it('describes string with length', () => {
    expect(describeShape('hello')).toBe('string(5)');
  });

  it('describes number', () => {
    expect(describeShape(123)).toBe('number');
  });

  it('describes boolean', () => {
    expect(describeShape(true)).toBe('boolean');
  });

  it('describes empty array', () => {
    expect(describeShape([])).toBe('array[]');
  });

  it('describes array with items', () => {
    expect(describeShape([1, 2, 3])).toBe('array[3]<number>');
  });

  it('describes empty object', () => {
    expect(describeShape({})).toBe('object{}');
  });

  it('describes object with keys', () => {
    const shape = describeShape({ id: '123', name: 'test' });
    expect(shape).toContain('object{');
    expect(shape).toContain('id');
    expect(shape).toContain('name');
  });

  it('describes nested objects', () => {
    const shape = describeShape({ data: { id: '123' } });
    expect(shape).toContain('data:');
    expect(shape).toContain('object{');
  });

  it('respects maxDepth', () => {
    const deep = { a: { b: { c: { d: 1 } } } };
    const shape = describeShape(deep, 0, 2);
    expect(shape).toContain('keys}'); // Should stop at depth 2
  });

  it('limits keys shown', () => {
    const manyKeys: Record<string, number> = {};
    for (let i = 0; i < 20; i++) {
      manyKeys[`key${i}`] = i;
    }
    const shape = describeShape(manyKeys);
    expect(shape).toContain('+10'); // 20 keys, shows 10, mentions +10 more
  });
});

describe('generateRequestId', () => {
  it('generates unique IDs', () => {
    const id1 = generateRequestId();
    const id2 = generateRequestId();
    expect(id1).not.toBe(id2);
  });

  it('starts with req_ prefix', () => {
    const id = generateRequestId();
    expect(id).toMatch(/^req_/);
  });

  it('contains timestamp and random parts', () => {
    const id = generateRequestId();
    // Format: req_<timestamp>_<random>
    const parts = id.split('_');
    expect(parts.length).toBe(3);
    expect(parts[0]).toBe('req');
  });
});

describe('security - no secrets in output', () => {
  it('describeShape never includes PII-like values', () => {
    const data = {
      email: 'test@example.com',
      phone: '555-1234',
      id: 'safe_id',
    };
    const shape = describeShape(data);
    // Should only show key names, not values
    expect(shape).not.toContain('test@example.com');
    expect(shape).not.toContain('555-1234');
    expect(shape).toContain('email');
    expect(shape).toContain('phone');
  });

  it('extractAudienceId error messages do not contain full response', () => {
    const sensitiveData = {
      api_key: 'sk_secret_123',
      user_email: 'private@email.com',
    };
    const result = extractAudienceId(sensitiveData);
    expect(result.ok).toBe(false);
    if (!result.ok && result.reason === 'not_found') {
      // Shape should only have key names
      expect(result.shape).not.toContain('sk_secret');
      expect(result.shape).not.toContain('private@email');
    }
  });
});

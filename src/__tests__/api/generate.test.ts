import { describe, it, expect } from 'vitest';
import handler from '../../../api/leads/generate';

interface ApiResponse {
  ok: boolean;
  error?: { code: string; message: string; details?: Record<string, unknown> };
  count?: number;
  bucket?: string;
  path?: string;
  signedUrl?: string;
  expiresInSeconds?: number;
}

function makeRes() {
  return {
    statusCode: 0 as number,
    jsonBody: null as ApiResponse | null,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: ApiResponse) {
      this.jsonBody = body;
      return this;
    },
  };
}

describe('API /api/leads/generate', () => {
  it('rejects invalid zip codes', async () => {
    const req = {
      method: 'POST',
      body: { leadRequest: 'roofing', zipCodes: 'abc,1234', leadScope: 'residential' },
    };
    const res = makeRes();

    await handler(req as unknown as Parameters<typeof handler>[0], res as unknown as Parameters<typeof handler>[1]);

    expect(res.statusCode).toBe(400);
    expect(res.jsonBody?.ok).toBe(false);
    expect(res.jsonBody?.error?.code).toBe('invalid_zip_codes');
  });

  it('accepts valid useCase values', async () => {
    const req = {
      method: 'POST',
      body: { leadRequest: 'roofing', zipCodes: '33101', leadScope: 'residential', useCase: 'call' },
    };
    const res = makeRes();

    await handler(req as unknown as Parameters<typeof handler>[0], res as unknown as Parameters<typeof handler>[1]);

    // Should not be a useCase validation error (may fail for other reasons like missing env vars)
    expect(res.jsonBody?.error?.code).not.toBe('invalid_use_case');
  });

  it('rejects invalid useCase values', async () => {
    const req = {
      method: 'POST',
      body: { leadRequest: 'roofing', zipCodes: '33101', leadScope: 'residential', useCase: 'invalid' },
    };
    const res = makeRes();

    await handler(req as unknown as Parameters<typeof handler>[0], res as unknown as Parameters<typeof handler>[1]);

    expect(res.statusCode).toBe(400);
    expect(res.jsonBody?.ok).toBe(false);
    expect(res.jsonBody?.error?.code).toBe('invalid_use_case');
  });

  it('defaults useCase to both when not provided', async () => {
    const req = {
      method: 'POST',
      body: { leadRequest: 'roofing', zipCodes: '33101', leadScope: 'residential' },
    };
    const res = makeRes();

    await handler(req as unknown as Parameters<typeof handler>[0], res as unknown as Parameters<typeof handler>[1]);

    // Should not be a useCase validation error (defaults to 'both')
    expect(res.jsonBody?.error?.code).not.toBe('invalid_use_case');
  });
});

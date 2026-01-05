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

    await handler(req as Parameters<typeof handler>[0], res as Parameters<typeof handler>[1]);

    expect(res.statusCode).toBe(400);
    expect(res.jsonBody?.ok).toBe(false);
    expect(res.jsonBody?.error?.code).toBe('invalid_zip_codes');
  });
});
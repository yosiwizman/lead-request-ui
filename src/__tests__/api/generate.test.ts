import { describe, it, expect } from 'vitest';
import handler from '../../../api/leads/generate';

function makeRes() {
  return {
    statusCode: 0 as number,
    jsonBody: null as any,
    headers: {} as Record<string, string>,
    setHeader(name: string, value: string) {
      this.headers[name] = value;
    },
    status(code: number) {
      this.statusCode = code;
      return this;
    },
    json(body: any) {
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

    await handler(req as any, res as any);

    expect(res.statusCode).toBe(400);
    expect(res.jsonBody?.ok).toBe(false);
    expect(res.jsonBody?.error?.code).toBe('invalid_zip_codes');
  });
});
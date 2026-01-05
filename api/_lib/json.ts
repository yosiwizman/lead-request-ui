import type { VercelResponse } from '@vercel/node';
import type { Json } from './types';

export function jsonError(
  res: VercelResponse,
  status: number,
  code: string,
  message: string,
  details?: Json
) {
  res.status(status).json({
    ok: false,
    error: { code, message, ...(details ? { details } : {}) },
  });
}

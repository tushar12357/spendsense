// src/middleware/request-id.ts
// Attaches a correlation ID to every request (X-Request-ID header in and out).
// Client-supplied IDs are accepted only if they look like a safe token, which
// prevents log injection through the header.

import { randomUUID } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';

const SAFE_ID = /^[A-Za-z0-9._-]{8,64}$/;

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.headers['x-request-id'];
  const id = typeof incoming === 'string' && SAFE_ID.test(incoming) ? incoming : randomUUID();
  req.headers['x-request-id'] = id;
  res.setHeader('X-Request-ID', id);
  next();
}

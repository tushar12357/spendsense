// src/middleware/request-id.ts
// Attaches a UUID to every request as X-Request-ID header.
// Downstream code reads req.headers['x-request-id'] for logging correlation.

import type { Request, Response, NextFunction } from 'express';
import { v4 as uuidv4 } from 'uuid';

export function requestId(req: Request, res: Response, next: NextFunction): void {
  const id = (req.headers['x-request-id'] as string | undefined) ?? uuidv4();
  req.headers['x-request-id'] = id;
  res.setHeader('X-Request-ID', id);
  next();
}

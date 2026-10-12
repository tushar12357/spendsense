// src/middleware/authenticate.ts
// Verifies the Bearer JWT on protected routes.
// Sets req.user = { id, email } on success; throws AppError on failure.

import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { AppError } from '../shared/errors/AppError';

export const JWT_ISSUER = 'spendsense';
export const JWT_AUDIENCE = 'spendsense-api';
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface JwtPayload {
  sub: string;   // user UUID
  email: string;
  iat?: number;
  exp?: number;
}

// Augment Express request type
declare global {
  namespace Express {
    interface Request {
      user?: JwtPayload;
    }
  }
}

export function authenticate(req: Request, _res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization;

  if (!authHeader?.startsWith('Bearer ')) {
    throw AppError.unauthorized('Authorization header missing or malformed');
  }

  const token = authHeader.slice(7);

  try {
    const payload = jwt.verify(token, env.JWT_SECRET, {
      algorithms: ['HS256'], // pin the algorithm; never trust the token header
      issuer: JWT_ISSUER,
      audience: JWT_AUDIENCE,
    }) as JwtPayload;

    if (typeof payload.sub !== 'string' || !UUID_RE.test(payload.sub)) {
      throw AppError.unauthorized('Invalid token');
    }

    req.user = payload;
    next();
  } catch (err) {
    if (err instanceof AppError) throw err;
    if (err instanceof jwt.TokenExpiredError) {
      throw AppError.unauthorized('Token expired');
    }
    throw AppError.unauthorized('Invalid token');
  }
}

export function requireUser(req: Request): JwtPayload {
  if (!req.user) {
    throw AppError.unauthorized();
  }
  return req.user;
}

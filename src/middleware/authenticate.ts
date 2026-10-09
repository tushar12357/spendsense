// src/middleware/authenticate.ts
// Verifies the Bearer JWT on protected routes.
// Sets req.user = { id, email } on success; throws AppError on failure.

import type { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { env } from '../config/env';
import { AppError } from '../shared/errors/AppError';

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
      issuer: 'spendsense',
      audience: 'spendsense-api',
    }) as JwtPayload;

    req.user = payload;
    next();
  } catch (err) {
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

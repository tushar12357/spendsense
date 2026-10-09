// src/middleware/error-handler.ts
// Central error handler. All errors funnel here through next(err).
// Maps AppError instances to structured JSON; treats unknown errors as 500.
// Never leaks internal details in production.

import type { Request, Response, NextFunction } from 'express';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { AppError } from '../shared/errors/AppError';
import { logger } from '../infrastructure/logging/logger';
import { env } from '../config/env';

export function errorHandler(
  err: unknown,
  req: Request,
  res: Response,
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _next: NextFunction,
): void {
  const requestId = (req.headers['x-request-id'] as string | undefined) ?? 'unknown';

  // ── Zod validation errors ─────────────────────────────────
  if (err instanceof ZodError) {
    const details = (err as ZodError).issues.map((e) => ({
      field: e.path.join('.'),
      message: e.message,
    }));
    res.status(400).json({
      error: {
        code: 'VALIDATION_ERROR',
        message: 'Request validation failed',
        details,
        requestId,
      },
    });
    return;
  }

  // ── Known application errors ───────────────────────────────
  if (err instanceof AppError) {
    if (!err.isOperational) {
      logger.error({ err, requestId }, 'non-operational AppError');
    }
    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        details: err.details,
        requestId,
      },
    });
    return;
  }

  // ── Prisma known errors — map to application errors ────────
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    const prismaErr = err as Prisma.PrismaClientKnownRequestError;
    // P2002 = unique constraint violation
    if (prismaErr.code === 'P2002') {
      const fields = (prismaErr.meta?.['target'] as string[] | undefined) ?? [];
      res.status(409).json({
        error: {
          code: 'CONFLICT',
          message: 'A record with these values already exists',
          details: [{ field: fields.join(', '), message: 'Must be unique' }],
          requestId,
        },
      });
      return;
    }
    // P2025 = record not found (e.g. update/delete on non-existent row)
    if (prismaErr.code === 'P2025') {
      res.status(404).json({
        error: { code: 'NOT_FOUND', message: 'Record not found', details: [], requestId },
      });
      return;
    }
    // Log other Prisma errors without exposing query internals
    logger.error({ code: prismaErr.code, meta: prismaErr.meta, requestId }, 'prisma known error');
    res.status(500).json({
      error: { code: 'INTERNAL_ERROR', message: 'Database error', details: [], requestId },
    });
    return;
  }

  // ── Unknown / programming errors ───────────────────────────
  logger.error({ err, requestId }, 'unhandled error');

  const message =
    env.NODE_ENV !== 'production' && err instanceof Error
      ? err.message
      : 'An unexpected error occurred';

  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message, details: [], requestId },
  });
}

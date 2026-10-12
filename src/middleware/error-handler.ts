// src/middleware/error-handler.ts
// Central error handler. All errors funnel here (Express 5 forwards rejected promises).
// Maps known errors to a single JSON envelope; treats everything else as a 500.
// Never leaks internal details in production.

import type { Request, Response, NextFunction } from 'express';
import multer from 'multer';
import { ZodError } from 'zod';
import { Prisma } from '@prisma/client';
import { AppError, type ErrorCode, type ErrorDetail } from '../shared/errors/AppError';
import { logger } from '../infrastructure/logging/logger';
import { env } from '../config/env';

interface Envelope {
  status: number;
  code: ErrorCode;
  message: string;
  details?: ErrorDetail[];
}

function mapError(err: unknown): Envelope | null {
  if (err instanceof ZodError) {
    return {
      status: 400,
      code: 'VALIDATION_ERROR',
      message: 'Request validation failed',
      details: err.issues.map((i) => ({ field: i.path.join('.'), message: i.message })),
    };
  }

  if (err instanceof AppError) {
    return { status: err.statusCode, code: err.code, message: err.message, details: err.details };
  }

  if (err instanceof multer.MulterError) {
    if (err.code === 'LIMIT_FILE_SIZE') {
      return { status: 413, code: 'FILE_TOO_LARGE', message: `File exceeds the maximum allowed size of ${env.MAX_FILE_SIZE_MB} MB` };
    }
    return { status: 400, code: 'VALIDATION_ERROR', message: `Invalid upload: ${err.message}`, details: err.field ? [{ field: err.field, message: err.message }] : [] };
  }

  // body-parser errors carry an HTTP status and a stable `type`
  if (typeof err === 'object' && err !== null && 'type' in err && 'status' in err) {
    const { type, status } = err as { type: string; status: number };
    if (type === 'entity.parse.failed') return { status: 400, code: 'VALIDATION_ERROR', message: 'Malformed JSON body' };
    if (type === 'entity.too.large') return { status: 413, code: 'VALIDATION_ERROR', message: 'Request body too large' };
    if (status >= 400 && status < 500) return { status, code: 'VALIDATION_ERROR', message: 'Invalid request' };
  }

  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    switch (err.code) {
      case 'P2002': {
        const target = err.meta?.['target'];
        const fields = Array.isArray(target) ? (target as string[]).join(', ') : String(target ?? '');
        return { status: 409, code: 'CONFLICT', message: 'A record with these values already exists', details: [{ field: fields, message: 'Must be unique' }] };
      }
      case 'P2003': // FK violation: deleting a row that is still referenced, or referencing a missing/foreign row
        return { status: 409, code: 'CONFLICT', message: 'The operation conflicts with related records' };
      case 'P2025':
        return { status: 404, code: 'NOT_FOUND', message: 'Record not found' };
      case 'P2034': // serialization failure / deadlock - safe for the client to retry
        return { status: 409, code: 'CONFLICT', message: 'The request conflicted with a concurrent change; please retry' };
      case 'P2023': // malformed UUID etc.
        return { status: 400, code: 'VALIDATION_ERROR', message: 'Malformed identifier' };
    }
  }

  return null;
}

export function errorHandler(err: unknown, req: Request, res: Response, _next: NextFunction): void {
  const requestId = (req.headers['x-request-id'] as string | undefined) ?? 'unknown';
  const mapped = mapError(err);

  if (mapped) {
    if (err instanceof AppError && !err.isOperational) {
      logger.error({ err, requestId }, 'non-operational AppError');
    } else if (err instanceof Prisma.PrismaClientKnownRequestError && mapped.status >= 500) {
      logger.error({ code: err.code, requestId }, 'prisma known error');
    }
    res.status(mapped.status).json({
      error: { code: mapped.code, message: mapped.message, details: mapped.details ?? [], requestId },
    });
    return;
  }

  logger.error({ err, requestId }, 'unhandled error');
  const message =
    env.NODE_ENV === 'development' && err instanceof Error ? err.message : 'An unexpected error occurred';
  res.status(500).json({ error: { code: 'INTERNAL_ERROR', message, details: [], requestId } });
}

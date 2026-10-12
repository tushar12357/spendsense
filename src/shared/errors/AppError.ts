// src/shared/errors/AppError.ts
// Typed application errors that map cleanly to HTTP responses.
// Never expose raw Prisma or database errors to clients.

export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'AUTHENTICATION_REQUIRED'
  | 'INVALID_CREDENTIALS'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'DUPLICATE_IMPORT'
  | 'IMPORT_IN_PROGRESS'
  | 'IMPORT_PROCESSING_ERROR'
  | 'FILE_TOO_LARGE'
  | 'UNSUPPORTED_FILE'
  | 'RATE_LIMITED'
  | 'INTERNAL_ERROR'
  | 'SERVICE_UNAVAILABLE';

export interface ErrorDetail {
  field?: string;
  message: string;
}

export class AppError extends Error {
  public readonly statusCode: number;
  public readonly code: ErrorCode;
  public readonly details: ErrorDetail[];
  public readonly isOperational: boolean;

  constructor(
    statusCode: number,
    code: ErrorCode,
    message: string,
    details: ErrorDetail[] = [],
    isOperational = true,
  ) {
    super(message);
    this.name = 'AppError';
    this.statusCode = statusCode;
    this.code = code;
    this.details = details;
    this.isOperational = isOperational;
    Object.setPrototypeOf(this, new.target.prototype);
  }

  static badRequest(message: string, details: ErrorDetail[] = []): AppError {
    return new AppError(400, 'VALIDATION_ERROR', message, details);
  }

  static unauthorized(message = 'Authentication required'): AppError {
    return new AppError(401, 'AUTHENTICATION_REQUIRED', message);
  }

  static invalidCredentials(): AppError {
    return new AppError(401, 'INVALID_CREDENTIALS', 'Invalid email or password');
  }

  static forbidden(message = 'Access denied'): AppError {
    return new AppError(403, 'FORBIDDEN', message);
  }

  static notFound(resource: string): AppError {
    return new AppError(404, 'NOT_FOUND', `${resource} not found`);
  }

  static conflict(message: string, details: ErrorDetail[] = []): AppError {
    return new AppError(409, 'CONFLICT', message, details);
  }

  static duplicateImport(batchId: string): AppError {
    return new AppError(409, 'DUPLICATE_IMPORT', 'This file has already been imported', [
      { field: 'file', message: `Existing import batch: ${batchId}` },
    ]);
  }

  static importInProgress(batchId: string): AppError {
    return new AppError(409, 'IMPORT_IN_PROGRESS', 'This file is currently being processed', [
      { field: 'file', message: `Existing import batch: ${batchId}` },
    ]);
  }

  static fileTooLarge(maxMb: number): AppError {
    return new AppError(413, 'FILE_TOO_LARGE', `File exceeds the maximum allowed size of ${maxMb} MB`);
  }

  static unsupportedFile(message: string): AppError {
    return new AppError(415, 'UNSUPPORTED_FILE', message);
  }

  static unavailable(message = 'Service temporarily unavailable'): AppError {
    return new AppError(503, 'SERVICE_UNAVAILABLE', message);
  }

  static internal(message = 'An unexpected error occurred'): AppError {
    return new AppError(500, 'INTERNAL_ERROR', message, [], false);
  }
}

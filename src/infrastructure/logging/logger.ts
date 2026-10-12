// src/infrastructure/logging/logger.ts
// Structured logger (pino). Redacts credentials and financial payloads.

import pino from 'pino';
import { env } from '../../config/env';

export const logger = pino({
  level: env.NODE_ENV === 'test' && env.LOG_LEVEL === 'info' ? 'silent' : env.LOG_LEVEL,
  base: { service: 'spendsense-api' },
  redact: {
    paths: [
      'req.headers.authorization',
      'req.headers.cookie',
      'password',
      'newPassword',
      'currentPassword',
      'passwordHash',
      'token',
      'accessToken',
      'refreshToken',
      // Financial payloads must never reach logs
      'rawData',
      'normalizedData',
      'description',
      '*.password',
      '*.rawData',
      '*.description',
    ],
    censor: '[REDACTED]',
  },
  serializers: {
    req: pino.stdSerializers.req,
    res: pino.stdSerializers.res,
    err: pino.stdSerializers.err,
  },
  ...(env.NODE_ENV === 'development'
    ? {
        transport: {
          target: 'pino-pretty',
          options: { colorize: true, translateTime: 'SYS:standard', ignore: 'pid,hostname,service' },
        },
      }
    : {}),
});

export type Logger = typeof logger;

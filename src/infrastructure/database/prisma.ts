// src/infrastructure/database/prisma.ts
// Singleton PrismaClient instance.
// Re-uses a single connection pool across the application.
// In test environments, each test file should manage its own transactions or cleanup.

import { Prisma, PrismaClient } from '@prisma/client';
import { env } from '../../config/env';
import { logger } from '../logging/logger';

declare global {
  // Allow a global singleton in development to survive hot-reloads
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

function createPrismaClient(): PrismaClient {
  const client = new PrismaClient({
    log:
      env.NODE_ENV === 'development'
        ? [
            { emit: 'event', level: 'query' },
            { emit: 'event', level: 'error' },
            { emit: 'event', level: 'warn' },
          ]
        : [{ emit: 'event', level: 'error' }],
    errorFormat: 'minimal',
  });

  if (env.NODE_ENV === 'development') {
    // Log slow queries — helpful for identifying missing indexes
    (client as any).$on('query', (e: Prisma.QueryEvent) => {
      if (e.duration > 100) {
        logger.warn({ duration: e.duration, query: e.query }, 'slow query');
      }
    });
  }

  (client as any).$on('error', (e: Prisma.LogEvent) => {
    logger.error({ message: e.message, target: e.target }, 'prisma error');
  });

  return client;
}

export const prisma: PrismaClient =
  global.__prisma ?? (global.__prisma = createPrismaClient());

// Graceful disconnect helper used in server.ts and test teardown
export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}

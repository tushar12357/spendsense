// src/infrastructure/database/prisma.ts
// Singleton PrismaClient. One connection pool per process; survives tsx hot-reloads in dev.

import { Prisma, PrismaClient } from '@prisma/client';
import { env } from '../../config/env';
import { logger } from '../logging/logger';

declare global {
  // eslint-disable-next-line no-var
  var __prisma: PrismaClient | undefined;
}

function createPrismaClient(): PrismaClient {
  const client = new PrismaClient({
    log: [
      { emit: 'event', level: 'query' },
      { emit: 'event', level: 'error' },
      { emit: 'event', level: 'warn' },
    ],
    errorFormat: 'minimal',
  });

  const events = client as unknown as {
    $on(event: 'query' | 'error' | 'warn', cb: (e: never) => void): void;
  };

  // Only slow queries are logged; bound parameters are never logged (they hold financial data).
  events.$on('query', ((e: Prisma.QueryEvent) => {
    if (e.duration >= env.SLOW_QUERY_MS) {
      logger.warn({ durationMs: e.duration, query: e.query.slice(0, 500) }, 'slow query');
    }
  }) as (e: never) => void);
  events.$on('error', ((e: Prisma.LogEvent) => {
    logger.error({ message: e.message, target: e.target }, 'prisma error');
  }) as (e: never) => void);
  events.$on('warn', ((e: Prisma.LogEvent) => {
    logger.warn({ message: e.message, target: e.target }, 'prisma warning');
  }) as (e: never) => void);

  return client;
}

export const prisma: PrismaClient = (globalThis.__prisma ??= createPrismaClient());

export type Tx = Prisma.TransactionClient;

export async function disconnectPrisma(): Promise<void> {
  await prisma.$disconnect();
}

/** Cheap connectivity probe for the readiness endpoint. */
export async function pingDatabase(): Promise<void> {
  await prisma.$queryRaw`SELECT 1`;
}

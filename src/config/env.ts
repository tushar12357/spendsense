// src/config/env.ts
// Validates all environment variables at startup using Zod.
// The application will not start if any required variable is missing or invalid.

import dotenv from 'dotenv';
dotenv.config({ quiet: true });
import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const envSchema = z
  .object({
    NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
    PORT: z.coerce.number().int().positive().default(5000),
    LOG_LEVEL: z.enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal', 'silent']).default('info'),

    // Primary database
    DATABASE_URL: z.string().url(),
    // Test database (used instead of DATABASE_URL when NODE_ENV=test)
    TEST_DATABASE_URL: z.string().url().optional(),
    /** Slow-query threshold (ms) for Prisma query logging. */
    SLOW_QUERY_MS: z.coerce.number().int().positive().default(200),

    // Redis (BullMQ)
    REDIS_HOST: z.string().default('localhost'),
    REDIS_PORT: z.coerce.number().int().positive().default(6379),
    REDIS_PASSWORD: z.string().optional(),

    // Auth
    JWT_SECRET: z.string().min(32, 'JWT_SECRET must be at least 32 characters'),
    JWT_EXPIRES_IN: z.string().default('7d'),
    BCRYPT_ROUNDS: z.coerce.number().int().min(4).max(15).default(12),

    // HTTP
    /** Comma-separated list of allowed browser origins. Required in production. */
    ALLOWED_ORIGINS: z.string().optional(),
    /** Express "trust proxy" hop count (set to 1 behind a single reverse proxy / load balancer). */
    TRUST_PROXY: z.coerce.number().int().min(0).default(0),

    // Imports
    MAX_FILE_SIZE_MB: z.coerce.number().int().positive().default(10),
    UPLOAD_TEMP_DIR: z.string().default('./tmp/uploads'),
    /** When true, uploads are queued in BullMQ and processed by the worker process. */
    IMPORT_ASYNC: bool.default(false),
    IMPORT_JOB_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
    /** Base delay of the exponential retry backoff (5s, 10s, 20s...). */
    IMPORT_JOB_BACKOFF_MS: z.coerce.number().int().min(1).default(5_000),
    WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(20).default(2),
    /** A PROCESSING batch older than this is considered abandoned and may be re-run. */
    IMPORT_STALE_AFTER_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),

    // Rate limiting
    RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(15 * 60 * 1000),
    RATE_LIMIT_MAX_REQUESTS: z.coerce.number().int().positive().default(300),
    AUTH_RATE_LIMIT_MAX: z.coerce.number().int().positive().default(20),
  })
  .superRefine((e, ctx) => {
    if (e.NODE_ENV === 'production' && !e.ALLOWED_ORIGINS) {
      ctx.addIssue({
        code: 'custom',
        path: ['ALLOWED_ORIGINS'],
        message: 'ALLOWED_ORIGINS must be set in production',
      });
    }
  });

const raw = { ...process.env };
if (raw['NODE_ENV'] === 'test' && raw['TEST_DATABASE_URL']) {
  raw['DATABASE_URL'] = raw['TEST_DATABASE_URL'];
}

const parsed = envSchema.safeParse(raw);

if (!parsed.success) {
  console.error('Invalid environment variables:', JSON.stringify(parsed.error.flatten().fieldErrors, null, 2));
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;

// Safety net: the test suite truncates tables, so never let it touch a non-test database.
if (env.NODE_ENV === 'test' && !/test/i.test(new URL(env.DATABASE_URL).pathname)) {
  console.error('Refusing to run tests against a database whose name does not contain "test".');
  process.exit(1);
}

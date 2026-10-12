import { defineConfig } from 'vitest/config';
import dotenv from 'dotenv';

dotenv.config({ quiet: true });

const testDb = process.env['TEST_DATABASE_URL'];

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
    globalSetup: ['tests/setup/global-setup.ts'],
    // Integration tests share one PostgreSQL database and truncate it between tests,
    // so test FILES run one after another (tests inside a file are sequential already).
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    env: {
      NODE_ENV: 'test',
      LOG_LEVEL: 'silent',
      ...(testDb && { TEST_DATABASE_URL: testDb, DATABASE_URL: testDb }),
      JWT_SECRET: 'test-secret-test-secret-test-secret-0123456789',
      BCRYPT_ROUNDS: '4', // fast hashing; production default is 12
      RATE_LIMIT_MAX_REQUESTS: '100000',
      AUTH_RATE_LIMIT_MAX: '100000',
      IMPORT_ASYNC: 'false',
      UPLOAD_TEMP_DIR: './tmp/test-uploads',
      MAX_FILE_SIZE_MB: '1',
    },
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/server.ts', 'src/worker.ts', 'src/docs/**'],
    },
  },
});

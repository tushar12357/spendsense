// src/server.ts
// HTTP entry point: boots the app, seeds built-in data, and shuts down gracefully.

import { createApp } from './app';
import { env } from './config/env';
import { logger } from './infrastructure/logging/logger';
import { disconnectPrisma } from './infrastructure/database/prisma';
import { closeImportQueue } from './infrastructure/queue/import-queue';
import { ensureSystemCategories } from './modules/categories/system-categories';

async function main() {
  await ensureSystemCategories(); // idempotent: a fresh database is usable without a separate seed step

  const app = createApp();
  const server = app.listen(env.PORT, () => {
    logger.info({ port: env.PORT, env: env.NODE_ENV, asyncImports: env.IMPORT_ASYNC }, 'SpendSense API started');
  });

  let shuttingDown = false;
  async function shutdown(signal: string) {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, 'Graceful shutdown initiated');

    const force = setTimeout(() => {
      logger.error('Forced shutdown after timeout');
      process.exit(1);
    }, 10_000);
    force.unref();

    server.close(async () => {
      try {
        if (env.IMPORT_ASYNC) await closeImportQueue();
        await disconnectPrisma();
        logger.info('Shutdown complete');
        process.exit(0);
      } catch (err) {
        logger.error({ err }, 'Error during shutdown');
        process.exit(1);
      }
    });
    server.closeIdleConnections();
  }

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  logger.fatal({ err }, 'Failed to start server');
  process.exit(1);
});

process.on('unhandledRejection', (reason) => {
  logger.error({ reason }, 'unhandledRejection');
});

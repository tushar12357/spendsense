// src/server.ts
// Application entry point.
// Binds HTTP listener, attaches process signal handlers for graceful shutdown.

import { createApp } from './app';
import { env } from './config/env';
import { logger } from './infrastructure/logging/logger';
import { disconnectPrisma } from './infrastructure/database/prisma';

const app = createApp();

const server = app.listen(env.PORT, () => {
  logger.info({ port: env.PORT, env: env.NODE_ENV }, '🚀 SpendSense API server started');
});

async function shutdown(signal: string) {
  logger.info({ signal }, 'Graceful shutdown initiated');

  server.close(async () => {
    logger.info('HTTP server closed');
    try {
      await disconnectPrisma();
      logger.info('Database connection closed');
      process.exit(0);
    } catch (err) {
      logger.error({ err }, 'Error during database disconnect');
      process.exit(1);
    }
  });

  // Force close after 10s if connections linger
  setTimeout(() => {
    logger.error('Forced shutdown after timeout');
    process.exit(1);
  }, 10000).unref();
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));

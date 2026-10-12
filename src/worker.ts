// src/worker.ts
// Entry point for the background import worker:  npm run worker
// Runs separately from the HTTP server so imports never compete with API latency.

import { logger } from './infrastructure/logging/logger';
import { disconnectPrisma } from './infrastructure/database/prisma';
import { startImportWorker } from './modules/imports/import.worker';
import { closeImportQueue } from './infrastructure/queue/import-queue';

const worker = startImportWorker();
logger.info('Import worker started');

let shuttingDown = false;
async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info({ signal }, 'Worker shutdown: finishing in-flight jobs');
  const force = setTimeout(() => {
    logger.error('Forced worker shutdown after timeout');
    process.exit(1);
  }, 30_000);
  force.unref();
  try {
    await worker.close(); // waits for active jobs; they are idempotent if cut short anyway
    await closeImportQueue();
    await disconnectPrisma();
    process.exit(0);
  } catch (err) {
    logger.error({ err }, 'Error during worker shutdown');
    process.exit(1);
  }
}

process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('SIGINT', () => void shutdown('SIGINT'));

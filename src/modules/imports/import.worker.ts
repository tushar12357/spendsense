// src/modules/imports/import.worker.ts
// BullMQ worker that processes queued statement imports.
//
// A queue gives at-least-once delivery, so correctness never depends on a job running once:
// processBatch() is idempotent (COMPLETED batches are no-ops; each attempt is all-or-nothing).
//
// Error policy
//   PermanentImportError / missing file -> UnrecoverableError: no retries, batch FAILED.
//   anything else                       -> retried with exponential backoff up to IMPORT_JOB_ATTEMPTS;
//                                          batch is PARTIAL between attempts, FAILED after the last.

import { UnrecoverableError, Worker, type Job } from 'bullmq';
import { env } from '../../config/env';
import { logger } from '../../infrastructure/logging/logger';
import { prisma } from '../../infrastructure/database/prisma';
import {
  IMPORT_QUEUE_NAME,
  createRedisConnection,
  type ImportJobData,
} from '../../infrastructure/queue/import-queue';
import { PermanentImportError, processBatch } from './pipeline/process-batch';
import { deleteUpload, loadUpload, sweepOrphans } from './upload-store';

/** Exported for tests: the job handler without the Redis plumbing. */
export async function handleImportJob(job: Pick<Job<ImportJobData>, 'data' | 'attemptsMade' | 'opts' | 'id'>): Promise<void> {
  const { batchId, correlationId } = job.data;
  const log = logger.child({ batchId, correlationId, jobId: job.id, attempt: job.attemptsMade + 1 });
  const isFinalAttempt = job.attemptsMade + 1 >= (job.opts.attempts ?? env.IMPORT_JOB_ATTEMPTS);

  const file = await loadUpload(batchId);
  if (!file) {
    // Nothing to retry with: either already processed and cleaned up, or lost.
    const batch = await prisma.importBatch.findUnique({ where: { id: batchId }, select: { status: true } });
    if (batch?.status === 'COMPLETED') return;
    await prisma.importBatch.updateMany({
      where: { id: batchId, status: { not: 'COMPLETED' } },
      data: { status: 'FAILED', completedAt: new Date(), errorMeta: { reason: 'Uploaded file is no longer available; please upload it again', retryable: false } },
    });
    throw new UnrecoverableError('upload file missing');
  }

  try {
    await processBatch(batchId, file, { isFinalAttempt });
    await deleteUpload(batchId);
    log.info('import job done');
  } catch (err) {
    if (err instanceof PermanentImportError) {
      await deleteUpload(batchId);
      throw new UnrecoverableError(err.message);
    }
    if (isFinalAttempt) await deleteUpload(batchId);
    throw err;
  }
}

export function startImportWorker(): Worker<ImportJobData> {
  const worker = new Worker<ImportJobData>(IMPORT_QUEUE_NAME, handleImportJob, {
    connection: createRedisConnection(),
    concurrency: env.WORKER_CONCURRENCY,
  });

  worker.on('failed', async (job, err) => {
    logger.warn(
      { jobId: job?.id, batchId: job?.data.batchId, attemptsMade: job?.attemptsMade, error: err.name },
      'import job failed',
    );
    // Covers jobs that die without running our catch block (e.g. stalled too many times).
    if (job && job.attemptsMade >= (job.opts.attempts ?? 1)) {
      await prisma.importBatch.updateMany({
        where: { id: job.data.batchId, status: { in: ['PENDING', 'PROCESSING', 'PARTIAL'] } },
        data: { status: 'FAILED', completedAt: new Date() },
      }).catch(() => undefined);
      await deleteUpload(job.data.batchId).catch(() => undefined);
    }
  });
  worker.on('error', (err) => logger.error({ err }, 'import worker error'));

  // Housekeeping: remove temp files orphaned by crashes (older than a day).
  const sweeper = setInterval(() => {
    sweepOrphans(24 * 3_600_000)
      .then((n) => n > 0 && logger.info({ removed: n }, 'swept orphaned upload files'))
      .catch((err) => logger.warn({ err }, 'upload sweep failed'));
  }, 3_600_000);
  sweeper.unref();
  worker.on('closed', () => clearInterval(sweeper));

  return worker;
}

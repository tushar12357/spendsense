// src/infrastructure/queue/import-queue.ts
// BullMQ queue + Redis connection for background statement imports.
// Connections are created lazily so the API process only touches Redis when IMPORT_ASYNC=true.

import { Queue } from 'bullmq';
import IORedis from 'ioredis';
import { env } from '../../config/env';

export const IMPORT_QUEUE_NAME = 'statement-imports';

export interface ImportJobData {
  batchId: string;
  /** Propagated from the HTTP request so one import can be traced end to end in the logs. */
  correlationId: string;
}

export function createRedisConnection(): IORedis {
  return new IORedis({
    host: env.REDIS_HOST,
    port: env.REDIS_PORT,
    ...(env.REDIS_PASSWORD && { password: env.REDIS_PASSWORD }),
    maxRetriesPerRequest: null, // required by BullMQ workers
    lazyConnect: false,
  });
}

let connection: IORedis | undefined;
let queue: Queue<ImportJobData> | undefined;

export function getImportQueue(): Queue<ImportJobData> {
  if (!queue) {
    connection = createRedisConnection();
    queue = new Queue<ImportJobData>(IMPORT_QUEUE_NAME, {
      connection,
      defaultJobOptions: {
        attempts: env.IMPORT_JOB_ATTEMPTS,
        backoff: { type: 'exponential', delay: env.IMPORT_JOB_BACKOFF_MS },
        removeOnComplete: { age: 3_600, count: 1_000 },
        removeOnFail: { age: 7 * 24 * 3_600 },
      },
    });
  }
  return queue;
}

/**
 * Enqueue is idempotent: the batch id is the job id, so enqueueing a batch that is already waiting
 * or running is a no-op. A finished (failed/completed) job with the same id is cleared first -
 * otherwise re-uploading a FAILED file would silently never run again.
 */
export async function enqueueImport(data: ImportJobData): Promise<void> {
  const q = getImportQueue();
  const existing = await q.getJob(data.batchId);
  if (existing) {
    const state = await existing.getState();
    if (state !== 'failed' && state !== 'completed') return;
    await existing.remove();
  }
  await q.add('process-batch', data, { jobId: data.batchId });
}

export async function pingRedis(): Promise<void> {
  getImportQueue();
  await connection!.ping();
}

export async function closeImportQueue(): Promise<void> {
  await queue?.close();
  connection?.disconnect();
  queue = undefined;
  connection = undefined;
}

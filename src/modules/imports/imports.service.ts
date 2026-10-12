// src/modules/imports/imports.service.ts
import { prisma } from '../../infrastructure/database/prisma';
import { enqueueImport } from '../../infrastructure/queue/import-queue';
import { logger } from '../../infrastructure/logging/logger';
import { env } from '../../config/env';
import { AppError } from '../../shared/errors/AppError';
import { decodeCursor, decodeRowCursor, encodeCursor, encodeRowCursor } from '../../shared/validation/pagination.schema';
import type { ImportRowStatus, Prisma } from '@prisma/client';
import type { UploadInput } from './imports.schema';
import { registerImport } from './pipeline/register';
import { PermanentImportError, processBatch, type ImportSummary } from './pipeline/process-batch';
import { deleteUpload, saveUpload } from './upload-store';
import { listAdapters } from './adapters/registry';

const BATCH_SELECT = {
  id: true, fileName: true, adapterKey: true, status: true,
  totalRows: true, acceptedRows: true, duplicateRows: true,
  rejectedRows: true, skippedRows: true, warningCount: true, attempts: true,
  errorMeta: true, createdAt: true, startedAt: true, completedAt: true,
  account: { select: { id: true, name: true } },
} satisfies Prisma.ImportBatchSelect;

type BatchRow = Prisma.ImportBatchGetPayload<{ select: typeof BATCH_SELECT }>;

/** Terminal states: the client can stop polling. FAILED and PARTIAL batches accept a re-upload. */
function present(b: BatchRow) {
  return { ...b, isFinished: b.status === 'COMPLETED' || b.status === 'FAILED' };
}

export type UploadResult =
  | { mode: 'sync'; summary: ImportSummary }
  | { mode: 'async'; batch: ReturnType<typeof present> };

export async function uploadImport(
  userId: string,
  file: Express.Multer.File,
  input: UploadInput,
  correlationId: string,
): Promise<UploadResult> {
  const { batch } = await registerImport({
    userId,
    accountId: input.accountId,
    ...(input.adapterKey && { adapterKey: input.adapterKey }),
    fileName: file.originalname,
    fileBuffer: file.buffer,
  });

  if (env.IMPORT_ASYNC) {
    try {
      await saveUpload(batch.id, file.buffer);
      await enqueueImport({ batchId: batch.id, correlationId });
    } catch (err) {
      logger.error({ err, batchId: batch.id, correlationId }, 'could not enqueue import');
      await deleteUpload(batch.id).catch(() => undefined);
      await prisma.importBatch.update({
        where: { id: batch.id },
        data: { status: 'FAILED', completedAt: new Date(), errorMeta: { reason: 'Could not queue the import', retryable: true } },
      });
      throw AppError.unavailable('The import queue is unavailable; please try again shortly');
    }
    return { mode: 'async', batch: present(await getImportRow(userId, batch.id)) };
  }

  try {
    return { mode: 'sync', summary: await processBatch(batch.id, file.buffer, { isFinalAttempt: true }) };
  } catch (err) {
    if (err instanceof PermanentImportError) {
      throw new AppError(422, 'IMPORT_PROCESSING_ERROR', err.message);
    }
    throw new AppError(
      500,
      'IMPORT_PROCESSING_ERROR',
      'Import processing failed and was rolled back; nothing was saved. Upload the same file again to retry.',
      [{ field: 'batchId', message: batch.id }],
    );
  }
}

async function getImportRow(userId: string, batchId: string) {
  const batch = await prisma.importBatch.findFirst({ where: { id: batchId, userId }, select: BATCH_SELECT });
  if (!batch) throw AppError.notFound('Import batch');
  return batch;
}

export async function getImport(userId: string, batchId: string) {
  return present(await getImportRow(userId, batchId));
}

export async function listImports(userId: string, opts: { cursor?: string; limit: number }) {
  const c = opts.cursor ? decodeCursor(opts.cursor) : null;
  const rows = await prisma.importBatch.findMany({
    where: {
      userId,
      ...(c && { OR: [{ createdAt: { lt: c.occurredAt } }, { createdAt: c.occurredAt, id: { gt: c.id } }] }),
    },
    orderBy: [{ createdAt: 'desc' }, { id: 'asc' }],
    take: opts.limit + 1,
    select: BATCH_SELECT,
  });
  const hasMore = rows.length > opts.limit;
  const data = hasMore ? rows.slice(0, opts.limit) : rows;
  const last = data[data.length - 1];
  return {
    data: data.map(present),
    pagination: { hasMore, nextCursor: hasMore && last ? encodeCursor(last.id, last.createdAt) : null, count: data.length },
  };
}

export async function getImportRows(
  userId: string,
  batchId: string,
  opts: { status?: ImportRowStatus; cursor?: string; limit: number },
) {
  await getImportRow(userId, batchId); // ownership check -> 404 for other users' batches

  const after = opts.cursor ? decodeRowCursor(opts.cursor) : 0;
  const rows = await prisma.importRow.findMany({
    where: { batchId, rowNumber: { gt: after }, ...(opts.status && { status: opts.status }) },
    orderBy: { rowNumber: 'asc' },
    take: opts.limit + 1,
    select: {
      id: true, rowNumber: true, status: true, reason: true, transactionId: true,
      normalizedData: true,
      // Raw cells exist only for REJECTED rows (data minimisation); they are the user's own data.
      rawData: true,
    },
  });
  const hasMore = rows.length > opts.limit;
  const data = hasMore ? rows.slice(0, opts.limit) : rows;
  const last = data[data.length - 1];
  return {
    data: data.map(({ rawData, ...r }) => (r.status === 'REJECTED' ? { ...r, rawData } : r)),
    pagination: { hasMore, nextCursor: hasMore && last ? encodeRowCursor(last.rowNumber) : null, count: data.length },
  };
}

export function getAdapters() {
  return listAdapters();
}

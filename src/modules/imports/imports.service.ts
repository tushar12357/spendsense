// src/modules/imports/imports.service.ts
import { prisma } from '../../infrastructure/database/prisma';
import { AppError } from '../../shared/errors/AppError';
import type { UploadInput } from './imports.schema';
import { runImportPipeline } from './pipeline/pipeline';

export async function uploadImport(
  userId: string,
  file: Express.Multer.File,
  input: UploadInput,
) {
  // Verify account ownership
  const account = await prisma.account.findFirst({
    where: { id: input.accountId, userId },
    select: { id: true },
  });
  if (!account) throw AppError.notFound('Account');

  return runImportPipeline({
    userId,
    accountId: input.accountId,
    adapterKey: input.adapterKey,
    fileName: file.originalname,
    fileBuffer: file.buffer,
  });
}

export async function listImports(userId: string, limit: number) {
  return prisma.importBatch.findMany({
    where: { userId },
    orderBy: { createdAt: 'desc' },
    take: limit,
    select: {
      id: true, fileName: true, adapterKey: true, status: true,
      totalRows: true, acceptedRows: true, duplicateRows: true,
      rejectedRows: true, skippedRows: true, warningCount: true,
      createdAt: true, completedAt: true,
      account: { select: { id: true, name: true } },
    },
  });
}

export async function getImport(userId: string, batchId: string) {
  const batch = await prisma.importBatch.findFirst({
    where: { id: batchId, userId },
    select: {
      id: true, fileName: true, adapterKey: true, status: true,
      totalRows: true, acceptedRows: true, duplicateRows: true,
      rejectedRows: true, skippedRows: true, warningCount: true,
      errorMeta: true, createdAt: true, startedAt: true, completedAt: true,
      account: { select: { id: true, name: true } },
    },
  });
  if (!batch) throw AppError.notFound('Import batch');
  return batch;
}

export async function getImportRows(
  userId: string,
  batchId: string,
  opts: { status?: string; limit: number },
) {
  // Verify ownership
  await getImport(userId, batchId);

  return prisma.importRow.findMany({
    where: {
      batchId,
      ...(opts.status && { status: opts.status as 'ACCEPTED' | 'DUPLICATE' | 'REJECTED' | 'SKIPPED' }),
    },
    orderBy: { rowNumber: 'asc' },
    take: opts.limit,
    select: {
      id: true, rowNumber: true, status: true, reason: true, transactionId: true, createdAt: true,
      // Do NOT return rawData — it may contain sensitive financial statement data.
      normalizedData: true,
    },
  });
}

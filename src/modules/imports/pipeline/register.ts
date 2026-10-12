// src/modules/imports/pipeline/register.ts
// Step 1 of an import: validate the file and register (or revive) its ImportBatch.
//
// Idempotency of uploads is decided by the unique (user_id, file_hash) constraint:
//   no batch yet                   -> create PENDING
//   COMPLETED                      -> 409 DUPLICATE_IMPORT  (same file was fully imported)
//   PENDING / PROCESSING, fresh    -> 409 IMPORT_IN_PROGRESS
//   FAILED / PARTIAL / stale       -> revive the same batch and retry (a failed import left no rows behind)
// Two simultaneous uploads of one file race on the unique constraint; the loser gets a 409.

import { Prisma } from '@prisma/client';
import type { ImportBatch } from '@prisma/client';
import { prisma } from '../../../infrastructure/database/prisma';
import { env } from '../../../config/env';
import { AppError } from '../../../shared/errors/AppError';
import { hashFile, parseCsv } from './csv';

export interface RegisterInput {
  userId: string;
  accountId: string;
  adapterKey?: string;
  fileName: string;
  fileBuffer: Buffer;
}

export interface Registration {
  batch: ImportBatch;
  /** true when a previously FAILED/PARTIAL batch for the same file was revived. */
  revived: boolean;
}

const maxBytes = () => env.MAX_FILE_SIZE_MB * 1024 * 1024;

function isStale(batch: ImportBatch): boolean {
  return Date.now() - batch.updatedAt.getTime() > env.IMPORT_STALE_AFTER_MS;
}

/** Strip path components and control characters from a client-supplied file name. */
function safeFileName(name: string): string {
  return name.split(/[\\/]/).pop()!.replace(/[^\w.\- ()]/g, '_').slice(0, 200) || 'statement.csv';
}

export async function registerImport(input: RegisterInput): Promise<Registration> {
  const { userId, accountId, fileBuffer } = input;

  if (fileBuffer.length > maxBytes()) throw AppError.fileTooLarge(env.MAX_FILE_SIZE_MB);

  const account = await prisma.account.findFirst({
    where: { id: accountId, userId },
    select: { id: true, isActive: true },
  });
  if (!account) throw AppError.notFound('Account');
  if (!account.isActive) throw AppError.badRequest('Cannot import into an inactive account');

  // Fail fast on unusable files before touching the database.
  const { adapter, records } = parseCsv(fileBuffer, input.adapterKey);

  const fileHash = hashFile(fileBuffer);
  const data = {
    accountId,
    fileName: safeFileName(input.fileName),
    adapterKey: adapter.key,
    totalRows: records.length,
  };

  const existing = await prisma.importBatch.findUnique({
    where: { unique_user_file_hash: { userId, fileHash } },
  });

  if (existing) return reviveOrReject(existing, data);

  try {
    const batch = await prisma.importBatch.create({
      data: { userId, fileHash, status: 'PENDING', ...data },
    });
    return { batch, revived: false };
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002') {
      // Lost a race with a concurrent upload of the same file.
      const winner = await prisma.importBatch.findUnique({
        where: { unique_user_file_hash: { userId, fileHash } },
      });
      if (winner) return reviveOrReject(winner, data);
    }
    throw err;
  }
}

async function reviveOrReject(
  existing: ImportBatch,
  data: { accountId: string; fileName: string; adapterKey: string; totalRows: number },
): Promise<Registration> {
  if (existing.status === 'COMPLETED') throw AppError.duplicateImport(existing.id);
  if ((existing.status === 'PENDING' || existing.status === 'PROCESSING') && !isStale(existing)) {
    throw AppError.importInProgress(existing.id);
  }

  // Compare-and-set so two simultaneous retries cannot both win:
  //  - FAILED/PARTIAL: the first claim flips the status to PENDING, so the second no longer matches.
  //  - stale PENDING/PROCESSING: the first claim refreshes updated_at, so the staleness test fails
  //    for the second. (Staleness is a range test: timestamp equality is fragile because
  //    PostgreSQL stores microseconds and JavaScript dates only milliseconds.)
  const active = existing.status === 'PENDING' || existing.status === 'PROCESSING';
  const staleBefore = new Date(Date.now() - env.IMPORT_STALE_AFTER_MS);
  const claimed = await prisma.importBatch.updateMany({
    where: { id: existing.id, status: existing.status, ...(active && { updatedAt: { lt: staleBefore } }) },
    data: { ...data, status: 'PENDING', errorMeta: Prisma.JsonNull },
  });
  if (claimed.count === 0) throw AppError.importInProgress(existing.id);

  const batch = await prisma.importBatch.findUniqueOrThrow({ where: { id: existing.id } });
  return { batch, revived: true };
}

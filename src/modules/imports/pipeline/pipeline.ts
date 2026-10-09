// src/modules/imports/pipeline/pipeline.ts
// Synchronous CSV import pipeline.
//
// Steps:
//   1. Validate file (type, size, encoding)
//   2. Compute SHA-256 hash — detect repeated uploads
//   3. Parse CSV headers — select and validate adapter
//   4. Create ImportBatch (PENDING)
//   5. Parse rows through adapter (normalize, validate)
//   6. Detect duplicates (source_tx_id DB constraint + fingerprint check)
//   7. Persist accepted transactions in a Prisma transaction
//   8. Record ImportRow outcomes
//   9. Update ImportBatch status and counts
//  10. Return import summary
//
// Atomicity model:
//   - Rows are processed and persisted in a single Prisma interactive transaction.
//   - If the DB transaction fails, the batch is marked FAILED with an error_meta.
//   - The batch record itself is created outside the row transaction so its ID is
//     always available for status inspection.
//   - Re-uploading the same file returns the existing batch (file hash unique constraint).

import { createHash } from 'crypto';
import { parse } from 'csv-parse/sync';
import { Prisma } from '@prisma/client';
import { prisma } from '../../../infrastructure/database/prisma';
import { AppError } from '../../../shared/errors/AppError';
import { logger } from '../../../infrastructure/logging/logger';
import { getAdapter } from '../adapters/registry';
import { AdapterFileError, AdapterRowError } from '../adapters/adapter.interface';
import type { NormalizedRow } from '../adapters/adapter.interface';
import { generateFingerprint } from '../../../shared/utils/fingerprint';

const MAX_FILE_SIZE_BYTES = 10 * 1024 * 1024; // 10 MB

export interface ImportPipelineInput {
  userId: string;
  accountId: string;
  adapterKey: string;
  fileName: string;
  fileBuffer: Buffer;
}

export interface ImportSummary {
  batchId: string;
  status: string;
  totalRows: number;
  acceptedRows: number;
  duplicateRows: number;
  rejectedRows: number;
  skippedRows: number;
  warningCount: number;
  errors: Array<{ rowNumber?: number; reason: string }>;
}

// ── Row outcome types ─────────────────────────────────────────────────────────

type RowOutcome =
  | { status: 'ACCEPTED'; normalized: NormalizedRow; transactionId: string }
  | { status: 'DUPLICATE'; normalized: NormalizedRow; reason: string }
  | { status: 'REJECTED'; rawData: Record<string, string>; reason: string }
  | { status: 'SKIPPED'; rawData: Record<string, string>; reason: string };

// ── Pipeline ──────────────────────────────────────────────────────────────────

export async function runImportPipeline(input: ImportPipelineInput): Promise<ImportSummary> {
  const { userId, accountId, adapterKey, fileName, fileBuffer } = input;

  // Step 1: Size check
  if (fileBuffer.length > MAX_FILE_SIZE_BYTES) {
    throw AppError.badRequest(`File exceeds maximum allowed size of 10 MB`);
  }

  // Step 2: Compute file hash — check for repeated uploads
  const fileHash = createHash('sha256').update(fileBuffer).digest('hex');

  const existing = await prisma.importBatch.findFirst({
    where: { userId, fileHash },
    select: { id: true, status: true, acceptedRows: true, duplicateRows: true,
              rejectedRows: true, skippedRows: true, totalRows: true, warningCount: true },
  });
  if (existing) {
    throw AppError.duplicateImport(existing.id);
  }

  // Step 3: Validate adapter
  const adapter = getAdapter(adapterKey);

  // Step 4: Parse CSV
  let rows: Record<string, string>[];
  let headers: string[];

  try {
    const records = parse(fileBuffer, {
      columns: true,
      skip_empty_lines: true,
      trim: true,
      bom: true, // Handle BOM in some HDFC exports
    }) as Record<string, string>[];

    if (records.length === 0) {
      throw new AdapterFileError('CSV file is empty or contains only headers');
    }

    headers = Object.keys(records[0] ?? {});
    rows = records;
  } catch (err) {
    if (err instanceof AdapterFileError) throw AppError.badRequest(err.message);
    throw AppError.badRequest(`Failed to parse CSV: ${err instanceof Error ? err.message : 'unknown error'}`);
  }

  // Step 5: Validate headers
  try {
    adapter.validateHeaders(headers);
  } catch (err) {
    if (err instanceof AdapterFileError) throw AppError.badRequest(err.message);
    throw err;
  }

  // Step 6: Create ImportBatch (PENDING state)
  let batch = await prisma.importBatch.create({
    data: {
      userId,
      accountId,
      fileName,
      fileHash,
      adapterKey,
      status: 'PENDING',
      totalRows: rows.length,
    },
  });

  // Mark as PROCESSING
  batch = await prisma.importBatch.update({
    where: { id: batch.id },
    data: { status: 'PROCESSING', startedAt: new Date() },
  });

  // Step 7: Normalize and validate rows through adapter
  const outcomes: Array<{ rowNumber: number; outcome: RowOutcome }> = [];
  const rowsToInsert: Array<{ rowNumber: number; normalized: NormalizedRow }> = [];

  for (let i = 0; i < rows.length; i++) {
    const rowNumber = i + 1;
    const raw = rows[i] ?? {};

    try {
      const normalized = adapter.parseRow(raw, rowNumber);

      if (normalized === null) {
        outcomes.push({
          rowNumber,
          outcome: { status: 'SKIPPED', rawData: raw, reason: 'Row skipped by adapter' },
        });
        continue;
      }

      rowsToInsert.push({ rowNumber, normalized });
    } catch (err) {
      if (err instanceof AdapterRowError) {
        outcomes.push({
          rowNumber,
          outcome: { status: 'REJECTED', rawData: raw, reason: err.reason },
        });
      } else {
        outcomes.push({
          rowNumber,
          outcome: { status: 'REJECTED', rawData: raw, reason: 'Unexpected parse error' },
        });
        logger.warn({ err, rowNumber, batchId: batch.id }, 'unexpected row parse error');
      }
    }
  }

  // Step 8: Persist accepted rows and detect duplicates — in a single DB transaction
  try {
    await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      for (const { rowNumber, normalized } of rowsToInsert) {
        const fingerprint = generateFingerprint({
          accountId,
          occurredAt: normalized.occurredAt,
          amount: normalized.amount.toFixed(2),
          description: normalized.description,
        });

        // Check for fingerprint-based duplicate (same account, same date/amount/description)
        // This is a SECONDARY check — the DB constraint on (accountId, sourceTxId) is primary.
        const existingByFingerprint = await tx.transaction.findFirst({
          where: { fingerprint, accountId },
          select: { id: true },
        });

        if (existingByFingerprint) {
          outcomes.push({
            rowNumber,
            outcome: {
              status: 'DUPLICATE',
              normalized,
              reason: `Probable duplicate of existing transaction (fingerprint match)`,
            },
          });
          continue;
        }

        try {
          // Create ImportRow first (without transactionId)
          const importRow = await tx.importRow.create({
            data: {
              batchId: batch.id,
              rowNumber,
              rawData: normalized.rawData as Prisma.JsonObject,
              normalizedData: {
                occurredAt: normalized.occurredAt.toISOString(),
                amount: normalized.amount.toFixed(2),
                type: normalized.type,
                description: normalized.description,
                sourceTxId: normalized.sourceTxId ?? null,
              } as Prisma.JsonObject,
              status: 'ACCEPTED',
            },
          });

          // Create Transaction
          const transaction = await tx.transaction.create({
            data: {
              userId,
              accountId,
              type: normalized.type,
              amount: normalized.amount,
              currency: 'INR',
              occurredAt: normalized.occurredAt,
              description: normalized.description,
              sourceTxId: normalized.sourceTxId ?? null,
              fingerprint,
              importRowId: importRow.id,
            },
            select: { id: true },
          });

          // Link transaction back to import row
          await tx.importRow.update({
            where: { id: importRow.id },
            data: { transactionId: transaction.id },
          });

          outcomes.push({
            rowNumber,
            outcome: { status: 'ACCEPTED', normalized, transactionId: transaction.id },
          });
        } catch (err: unknown) {
          // P2002 = unique constraint violation (source_tx_id + account_id)
          if (
            err instanceof Prisma.PrismaClientKnownRequestError &&
            (err as Prisma.PrismaClientKnownRequestError).code === 'P2002'
          ) {
            outcomes.push({
              rowNumber,
              outcome: {
                status: 'DUPLICATE',
                normalized,
                reason: 'Duplicate source transaction ID (bank reference already imported)',
              },
            });
          } else {
            throw err; // Propagate unexpected errors — rolls back entire transaction
          }
        }
      }
    });
  } catch (err) {
    // Batch-level failure — mark batch FAILED
    logger.error({ err, batchId: batch.id }, 'import pipeline transaction failed');
    await prisma.importBatch.update({
      where: { id: batch.id },
      data: {
        status: 'FAILED',
        completedAt: new Date(),
        errorMeta: { reason: err instanceof Error ? err.message : 'Unknown error' },
      },
    });
    throw AppError.internal('Import processing failed. The batch has been marked as FAILED and can be retried with a corrected file.');
  }

  // Step 9: Compute counts and update batch
  let accepted = 0, duplicate = 0, rejected = 0, skipped = 0;
  const errors: Array<{ rowNumber?: number; reason: string }> = [];

  for (const { rowNumber, outcome } of outcomes) {
    switch (outcome.status) {
      case 'ACCEPTED': accepted++; break;
      case 'DUPLICATE':
        duplicate++;
        errors.push({ rowNumber, reason: outcome.reason });
        break;
      case 'REJECTED':
        rejected++;
        errors.push({ rowNumber, reason: outcome.reason });
        break;
      case 'SKIPPED': skipped++; break;
    }
  }

  // Persist non-accepted import rows
  const nonAcceptedOutcomes = outcomes.filter(({ outcome }) => outcome.status !== 'ACCEPTED');
  if (nonAcceptedOutcomes.length > 0) {
    await prisma.importRow.createMany({
      data: nonAcceptedOutcomes.map(({ rowNumber, outcome }) => ({
        batchId: batch.id,
        rowNumber,
        rawData: ('rawData' in outcome ? outcome.rawData : ('normalized' in outcome ? outcome.normalized.rawData : {})) as Prisma.JsonObject,
        normalizedData: Prisma.JsonNull,
        status: outcome.status,
        reason: 'reason' in outcome ? outcome.reason : null,
      })),
      skipDuplicates: true,
    });
  }

  const finalBatch = await prisma.importBatch.update({
    where: { id: batch.id },
    data: {
      status: 'COMPLETED',
      acceptedRows: accepted,
      duplicateRows: duplicate,
      rejectedRows: rejected,
      skippedRows: skipped,
      warningCount: duplicate + rejected,
      completedAt: new Date(),
    },
  });

  return {
    batchId: finalBatch.id,
    status: finalBatch.status,
    totalRows: finalBatch.totalRows,
    acceptedRows: finalBatch.acceptedRows,
    duplicateRows: finalBatch.duplicateRows,
    rejectedRows: finalBatch.rejectedRows,
    skippedRows: finalBatch.skippedRows,
    warningCount: finalBatch.warningCount,
    errors,
  };
}

// src/modules/imports/pipeline/process-batch.ts
// Step 2 of an import: turn a registered batch + its file into ledger transactions.
//
// ATOMICITY MODEL
//   All writes for one file (import rows, transactions, batch counters) happen in ONE database
//   transaction. Either the whole file is persisted and the batch is COMPLETED, or nothing is
//   persisted and the batch is marked PARTIAL (retryable) / FAILED (gave up). There is never a
//   half-imported file, so "retry" is simply "run it again".
//
// IDEMPOTENCY / CONCURRENCY
//   - A COMPLETED batch is never processed twice (re-checked under a row lock).
//   - pg_advisory_xact_lock(account) serialises imports into the same account, so the duplicate
//     look-ups below cannot interleave with another import writing the same transactions.
//   - The (account_id, source_tx_id) unique index is the last line of defence; inserts use
//     ON CONFLICT DO NOTHING and any shortfall aborts + rolls back the whole attempt.
//
// DUPLICATE POLICY (see docs/financial-rules.md)
//   - Row with a reliable bank reference  -> duplicate iff that reference exists on the account.
//   - Row without one                     -> duplicate iff an identical fingerprint exists
//     (account + local date + amount + description + occurrence ordinal).
//   - A reference repeated inside one file is NOT trusted as an identity (banks reuse them);
//     those rows fall back to the fingerprint policy.

import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';
import { prisma } from '../../../infrastructure/database/prisma';
import { logger } from '../../../infrastructure/logging/logger';
import { AppError } from '../../../shared/errors/AppError';
import { zonedToUtc } from '../../../shared/utils/date';
import { generateFingerprint, fingerprintBaseKey } from '../../../shared/utils/fingerprint';
import { AdapterRowError, type NormalizedRow } from '../adapters/adapter.interface';
import { categorize } from '../../merchant-rules/categorizer';
import { loadRules } from '../../merchant-rules/merchant-rules.service';
import { parseCsv } from './csv';

/** The failure cannot be fixed by retrying the same file (bad format, deleted account...). */
export class PermanentImportError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PermanentImportError';
  }
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
  errors: Array<{ rowNumber: number; status: 'DUPLICATE' | 'REJECTED'; reason: string }>;
  errorsTruncated: boolean;
}

const MAX_REPORTED_ERRORS = 100;
const CHUNK = 5_000; // keeps IN (...) lists far below PostgreSQL's 32,767 bind-parameter limit
const TX_TIMEOUT_MS = 120_000;

type RowStatus = 'ACCEPTED' | 'DUPLICATE' | 'SKIPPED' | 'REJECTED';

interface Outcome {
  rowNumber: number;
  status: RowStatus;
  reason: string | null;
  raw: Record<string, string>;
  normalized: NormalizedRow | null;
  occurredAt?: Date;
  fingerprint?: string;
  /** Reference used as the transaction's source_tx_id (null when untrusted/absent). */
  sourceTxId?: string | null;
  categoryId?: string | null;
  merchantName?: string | null;
  rowId: string;
  transactionId?: string;
}

function chunks<T>(items: T[], size = CHUNK): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/** Pure normalization pass: parse each row, assign occurrence ordinals, neutralise untrusted refs. */
function normalizeRows(
  records: Record<string, string>[],
  parseRow: (raw: Record<string, string>) => NormalizedRow | null,
  accountId: string,
  timezone: string,
): Outcome[] {
  const outcomes: Outcome[] = [];

  records.forEach((raw, i) => {
    const rowNumber = i + 1;
    const base = { rowNumber, raw, normalized: null, rowId: randomUUID() };
    try {
      const normalized = parseRow(raw);
      if (normalized === null) {
        outcomes.push({ ...base, status: 'SKIPPED', reason: 'No amount on this row (summary or opening-balance line)' });
        return;
      }
      outcomes.push({ ...base, normalized, status: 'ACCEPTED', reason: null });
    } catch (err) {
      const reason = err instanceof AdapterRowError ? err.reason : 'Unexpected parse error';
      if (!(err instanceof AdapterRowError)) logger.warn({ rowNumber }, 'unexpected row parse error');
      outcomes.push({ ...base, status: 'REJECTED', reason });
    }
  });

  // References that occur more than once in this file cannot identify a transaction.
  const refCounts = new Map<string, number>();
  for (const o of outcomes) {
    const ref = o.normalized?.sourceTxId;
    if (ref) refCounts.set(ref, (refCounts.get(ref) ?? 0) + 1);
  }

  const ordinals = new Map<string, number>();
  for (const o of outcomes) {
    if (!o.normalized) continue;
    const n = o.normalized;
    const [y, m, d] = n.localDate.split('-').map(Number) as [number, number, number];
    o.occurredAt = zonedToUtc({ year: y, month: m, day: d, hour: 12 }, timezone); // noon local: stable calendar day
    const key = fingerprintBaseKey({
      accountId,
      localDate: n.localDate,
      amount: n.amount.toFixed(2),
      description: n.description,
    });
    const ordinal = (ordinals.get(key) ?? 0) + 1;
    ordinals.set(key, ordinal);
    o.fingerprint = generateFingerprint({
      accountId,
      localDate: n.localDate,
      amount: n.amount.toFixed(2),
      description: n.description,
      ordinal,
    });
    o.sourceTxId = n.sourceTxId && refCounts.get(n.sourceTxId) === 1 ? n.sourceTxId : null;
  }
  return outcomes;
}

async function markAttemptFailed(batchId: string, err: unknown, final: boolean): Promise<void> {
  const permanent = err instanceof PermanentImportError;
  await prisma.importBatch.update({
    where: { id: batchId },
    data: {
      status: final || permanent ? 'FAILED' : 'PARTIAL',
      completedAt: final || permanent ? new Date() : null,
      // Never persist raw error text from the database/driver: it may quote financial values.
      errorMeta: {
        reason: permanent ? (err as Error).message : 'Processing failed; the attempt was rolled back and can be retried',
        retryable: !permanent,
        at: new Date().toISOString(),
      },
    },
  }).catch((e) => logger.error({ err: e, batchId }, 'could not record import failure'));
}

function toSummary(
  batch: { id: string; status: string; totalRows: number; acceptedRows: number; duplicateRows: number; rejectedRows: number; skippedRows: number; warningCount: number },
  errors: ImportSummary['errors'] = [],
): ImportSummary {
  return {
    batchId: batch.id,
    status: batch.status,
    totalRows: batch.totalRows,
    acceptedRows: batch.acceptedRows,
    duplicateRows: batch.duplicateRows,
    rejectedRows: batch.rejectedRows,
    skippedRows: batch.skippedRows,
    warningCount: batch.warningCount,
    errors: errors.slice(0, MAX_REPORTED_ERRORS),
    errorsTruncated: errors.length > MAX_REPORTED_ERRORS,
  };
}

/**
 * Processes one registered batch. Safe to call repeatedly (BullMQ may deliver a job twice).
 * @param isFinalAttempt when true, a retryable failure is recorded as FAILED instead of PARTIAL
 */
export async function processBatch(
  batchId: string,
  fileBuffer: Buffer,
  opts: { isFinalAttempt?: boolean } = {},
): Promise<ImportSummary> {
  const startedAt = Date.now();
  const batch = await prisma.importBatch.findUnique({
    where: { id: batchId },
    include: { user: { select: { timezone: true } } },
  });
  if (!batch) throw new PermanentImportError('Import batch no longer exists');
  if (batch.status === 'COMPLETED') return toSummary(batch); // idempotent re-delivery

  const log = logger.child({ batchId, userId: batch.userId });

  try {
    await prisma.importBatch.update({
      where: { id: batchId },
      data: { status: 'PROCESSING', startedAt: new Date(), attempts: { increment: 1 } },
    });

    let parsed;
    try {
      parsed = parseCsv(fileBuffer, batch.adapterKey);
    } catch (err) {
      // The same bytes will never parse differently on a retry.
      throw new PermanentImportError(err instanceof AppError ? err.message : 'File could not be parsed');
    }

    const rules = await loadRules(batch.userId);
    const outcomes = normalizeRows(parsed.records, parsed.adapter.parseRow, batch.accountId, batch.user.timezone);

    const summary = await prisma.$transaction(
      async (tx) => {
        // Serialise imports per account; released automatically at COMMIT/ROLLBACK.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${batch.accountId}, 0))`;

        // Re-check under lock + row lock: a concurrent worker may have finished this batch.
        const locked = await tx.$queryRaw<Array<{ status: string }>>`
          SELECT status::text AS status FROM import_batches WHERE id = ${batchId}::uuid FOR UPDATE`;
        if (locked[0]?.status === 'COMPLETED') {
          return toSummary(await tx.importBatch.findUniqueOrThrow({ where: { id: batchId } }));
        }

        const account = await tx.account.findFirst({ where: { id: batch.accountId, userId: batch.userId }, select: { id: true } });
        if (!account) throw new PermanentImportError('The target account no longer exists');

        // A previous failed attempt rolled back, but clear defensively so row numbers never collide.
        await tx.importRow.deleteMany({ where: { batchId } });

        // ── Duplicate detection against what is already in the ledger ────────────────
        const candidates = outcomes.filter((o) => o.status === 'ACCEPTED');
        const refs = candidates.flatMap((o) => (o.sourceTxId ? [o.sourceTxId] : []));
        const prints = candidates.flatMap((o) => (!o.sourceTxId && o.fingerprint ? [o.fingerprint] : []));

        const knownRefs = new Set<string>();
        for (const part of chunks(refs)) {
          const found = await tx.transaction.findMany({
            where: { accountId: batch.accountId, sourceTxId: { in: part } },
            select: { sourceTxId: true },
          });
          found.forEach((f) => f.sourceTxId && knownRefs.add(f.sourceTxId));
        }
        const knownPrints = new Set<string>();
        for (const part of chunks(prints)) {
          const found = await tx.transaction.findMany({
            where: { accountId: batch.accountId, fingerprint: { in: part } },
            select: { fingerprint: true },
          });
          found.forEach((f) => f.fingerprint && knownPrints.add(f.fingerprint));
        }

        for (const o of candidates) {
          if (o.sourceTxId && knownRefs.has(o.sourceTxId)) {
            o.status = 'DUPLICATE';
            o.reason = 'Bank reference already imported for this account';
          } else if (!o.sourceTxId && o.fingerprint && knownPrints.has(o.fingerprint)) {
            o.status = 'DUPLICATE';
            o.reason = 'Matches an existing transaction (same date, amount and description)';
          } else {
            const hit = categorize(o.normalized!.description, rules);
            o.categoryId = hit?.categoryId ?? null;
            o.merchantName = hit?.merchantName ?? null;
            o.transactionId = randomUUID();
          }
        }

        // ── Persist ──────────────────────────────────────────────────────────────────
        // Import rows are written for EVERY outcome so any row can be explained later. Raw cells
        // are retained only for rejected rows (data minimisation); the rest keep normalized values.
        for (const part of chunks(outcomes)) {
          await tx.importRow.createMany({
            data: part.map((o) => ({
              id: o.rowId,
              batchId,
              rowNumber: o.rowNumber,
              status: o.status,
              reason: o.reason,
              rawData: (o.status === 'REJECTED' ? o.raw : {}) as Prisma.InputJsonObject,
              normalizedData: o.normalized
                ? ({
                    localDate: o.normalized.localDate,
                    amount: o.normalized.amount.toFixed(2),
                    type: o.normalized.type,
                    description: o.normalized.description,
                    sourceTxId: o.normalized.sourceTxId ?? null,
                  } satisfies Prisma.InputJsonObject)
                : Prisma.JsonNull,
            })),
          });
        }

        const accepted = outcomes.filter((o) => o.status === 'ACCEPTED');
        let inserted = 0;
        for (const part of chunks(accepted)) {
          const res = await tx.transaction.createMany({
            data: part.map((o) => ({
              id: o.transactionId!,
              userId: batch.userId,
              accountId: batch.accountId,
              categoryId: o.categoryId ?? null,
              type: o.normalized!.type,
              amount: o.normalized!.amount,
              currency: 'INR',
              occurredAt: o.occurredAt!,
              description: o.normalized!.description,
              merchantName: o.merchantName ?? null,
              sourceTxId: o.sourceTxId ?? null,
              fingerprint: o.fingerprint!,
              importRowId: o.rowId,
            })),
            skipDuplicates: true, // ON CONFLICT DO NOTHING
          });
          inserted += res.count;
        }
        if (inserted !== accepted.length) {
          // Something wrote the same reference after our look-up (e.g. a manual entry). Abort the
          // whole attempt; the retry re-runs duplicate detection against the new state.
          throw new Error(`conflicting insert: expected ${accepted.length}, wrote ${inserted}`);
        }

        // import_rows.transaction_id <-> transactions.import_row_id reference each other, so the
        // back-link is filled in after both sides exist.
        await tx.$executeRaw`
          UPDATE import_rows r SET transaction_id = t.id
          FROM transactions t
          WHERE t.import_row_id = r.id AND r.batch_id = ${batchId}::uuid`;

        const count = (s: RowStatus) => outcomes.filter((o) => o.status === s).length;
        const finalBatch = await tx.importBatch.update({
          where: { id: batchId },
          data: {
            status: 'COMPLETED',
            totalRows: outcomes.length,
            acceptedRows: count('ACCEPTED'),
            duplicateRows: count('DUPLICATE'),
            rejectedRows: count('REJECTED'),
            skippedRows: count('SKIPPED'),
            warningCount: count('DUPLICATE') + count('REJECTED'),
            completedAt: new Date(),
            errorMeta: Prisma.JsonNull,
          },
        });

        return toSummary(
          finalBatch,
          outcomes.flatMap((o) =>
            o.status === 'DUPLICATE' || o.status === 'REJECTED'
              ? [{ rowNumber: o.rowNumber, status: o.status, reason: o.reason ?? '' }]
              : [],
          ),
        );
      },
      { timeout: TX_TIMEOUT_MS, maxWait: 15_000 },
    );

    log.info(
      {
        durationMs: Date.now() - startedAt,
        total: summary.totalRows,
        accepted: summary.acceptedRows,
        duplicates: summary.duplicateRows,
        rejected: summary.rejectedRows,
      },
      'import completed',
    );
    return summary;
  } catch (err) {
    log.error({ err: err instanceof Error ? { name: err.name, message: err.message } : 'unknown', durationMs: Date.now() - startedAt }, 'import attempt failed');
    await markAttemptFailed(batchId, err, opts.isFinalAttempt ?? false);
    throw err;
  }
}

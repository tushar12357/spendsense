// src/modules/imports/adapters/adapter.interface.ts
// Contract that every bank-statement CSV adapter must fulfill.
// Add a new adapter by implementing this interface — no changes to the pipeline required.

import type { Decimal } from '../../../shared/utils/decimal';

export type TransactionType = 'INCOME' | 'EXPENSE' | 'TRANSFER' | 'REFUND';

/** Output of a successfully parsed CSV row. */
export interface NormalizedRow {
  /** When the transaction occurred (parsed from statement date column). */
  occurredAt: Date;
  /** Always positive. Direction is encoded in `type`. */
  amount: Decimal;
  /** Inferred from debit/credit columns. Users can reclassify post-import. */
  type: TransactionType;
  /** Raw description from the statement. */
  description: string;
  /** Bank-provided reference number (UTR, cheque, etc.) — may be undefined. */
  sourceTxId?: string;
  /** Original CSV columns retained for ImportRow.raw_data. */
  rawData: Record<string, string>;
}

/** Error thrown by an adapter when a row cannot be parsed. */
export class AdapterRowError extends Error {
  constructor(
    public readonly rowNumber: number,
    public readonly reason: string,
    public readonly rawData: Record<string, string>,
  ) {
    super(`Row ${rowNumber}: ${reason}`);
    this.name = 'AdapterRowError';
  }
}

/** Error thrown when the file-level structure is invalid (e.g. wrong headers). */
export class AdapterFileError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'AdapterFileError';
  }
}

export interface BankStatementAdapter {
  /** Unique stable key — stored on ImportBatch.adapter_key */
  readonly key: string;
  readonly displayName: string;
  readonly requiredColumns: string[];

  /**
   * Validate that the parsed headers contain all required columns.
   * Throws AdapterFileError if invalid.
   */
  validateHeaders(headers: string[]): void;

  /**
   * Parse and normalize one CSV row.
   * Returns NormalizedRow on success.
   * Throws AdapterRowError on parse failure (row is marked REJECTED).
   * Returns null to silently skip the row (row is marked SKIPPED).
   */
  parseRow(
    raw: Record<string, string>,
    rowNumber: number,
  ): NormalizedRow | null;
}

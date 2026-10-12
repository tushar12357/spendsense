// src/modules/imports/adapters/adapter.interface.ts
// Contract every bank-statement CSV adapter fulfils. Adding a bank = implementing this interface
// and registering it; the pipeline, ledger and duplicate logic never change.

import type { Decimal } from '../../../shared/utils/decimal';

export type TransactionType = 'INCOME' | 'EXPENSE' | 'TRANSFER' | 'REFUND';

/** A successfully parsed and normalized statement row. */
export interface NormalizedRow {
  /** Calendar date printed on the statement, YYYY-MM-DD. The pipeline anchors it to the user's timezone. */
  localDate: string;
  /** Always positive. Direction is encoded in `type`. */
  amount: Decimal;
  /** Inferred from debit/credit columns and narration. Users can reclassify after import. */
  type: TransactionType;
  /** Description exactly as printed on the statement (trimmed). */
  description: string;
  /** Bank-provided reference number (UTR, cheque no.), when one exists. */
  sourceTxId?: string;
  /** Original CSV columns, retained on the import row for reconciliation. Treated as sensitive. */
  rawData: Record<string, string>;
}

/** Thrown by an adapter when one row cannot be parsed. The row is recorded as REJECTED. */
export class AdapterRowError extends Error {
  constructor(public readonly reason: string) {
    super(reason);
    this.name = 'AdapterRowError';
  }
}

/** Thrown when the file as a whole is unusable (wrong headers, wrong bank...). Nothing is persisted. */
export class AdapterFileError extends Error {
  constructor(reason: string) {
    super(reason);
    this.name = 'AdapterFileError';
  }
}

export interface BankStatementAdapter {
  /** Unique, stable key - stored on ImportBatch.adapter_key. */
  readonly key: string;
  readonly displayName: string;
  /** Human-readable description of the expected columns (returned by GET /imports/adapters). */
  readonly expectedColumns: string[];

  /** Cheap check used to auto-detect the adapter from the header row. */
  matches(headers: string[]): boolean;

  /** Throws AdapterFileError with an actionable message if the headers are unusable. */
  validateHeaders(headers: string[]): void;

  /**
   * Parse one data row.
   *  - returns a NormalizedRow on success
   *  - throws AdapterRowError to reject the row
   *  - returns null to skip it (e.g. opening-balance or summary rows)
   */
  parseRow(raw: Record<string, string>): NormalizedRow | null;
}

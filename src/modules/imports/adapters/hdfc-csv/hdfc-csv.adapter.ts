// src/modules/imports/adapters/hdfc-csv/hdfc-csv.adapter.ts
// HDFC Bank savings account statement CSV adapter.
//
// Expected columns (HDFC NetBanking export):
//   Date | Narration | Chq./Ref.No. | Value Dt | Withdrawal Amt. | Deposit Amt. | Closing Balance
//
// Notes:
//   - Amounts use comma-separated thousands (e.g. "1,23,456.78") — stripped before parsing.
//   - Both Withdrawal and Deposit may be empty (not zero) for non-applicable rows.
//   - Rows with both amounts empty are skipped (summary/header rows inside the data).
//   - Date format: DD/MM/YY or DD/MM/YYYY.
//   - Source Tx ID: Chq./Ref.No. if non-empty.

import { Decimal } from '../../../../shared/utils/decimal';
import type { BankStatementAdapter, NormalizedRow } from '../adapter.interface';
import { AdapterFileError, AdapterRowError } from '../adapter.interface';

const REQUIRED_COLUMNS = [
  'Date',
  'Narration',
  'Chq./Ref.No.',
  'Value Dt',
  'Withdrawal Amt.',
  'Deposit Amt.',
  'Closing Balance',
];

/** Parse DD/MM/YY or DD/MM/YYYY into a UTC-midnight Date */
function parseHdfcDate(raw: string, rowNumber: number): Date {
  const trimmed = raw.trim();
  // Match DD/MM/YY or DD/MM/YYYY
  const match = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(trimmed);
  if (!match) {
    throw new AdapterRowError(rowNumber, `Unparseable date: "${trimmed}"`, {});
  }
  const [, dayStr, monthStr, yearStr] = match;
  const day = parseInt(dayStr!, 10);
  const month = parseInt(monthStr!, 10);
  let year = parseInt(yearStr!, 10);
  if (year < 100) year += year >= 50 ? 1900 : 2000; // 2-digit year pivot

  if (month < 1 || month > 12 || day < 1 || day > 31) {
    throw new AdapterRowError(rowNumber, `Invalid date components: "${trimmed}"`, {});
  }

  // Store as UTC midnight — time zone adjustment happens at query time via AT TIME ZONE
  return new Date(Date.UTC(year, month - 1, day));
}

/** Strip Indian number formatting (commas) and parse as Decimal */
function parseAmount(raw: string): Decimal | null {
  const cleaned = raw.trim().replace(/,/g, '');
  if (cleaned === '' || cleaned === '-') return null;
  try {
    const d = new Decimal(cleaned);
    if (!d.isFinite() || d.isNegative()) return null;
    return d;
  } catch {
    return null;
  }
}

export const hdfcCsvAdapter: BankStatementAdapter = {
  key: 'hdfc-csv',
  displayName: 'HDFC Bank Savings Account (CSV)',
  requiredColumns: REQUIRED_COLUMNS,

  validateHeaders(headers: string[]): void {
    const normalized = headers.map((h) => h.trim());
    const missing = REQUIRED_COLUMNS.filter((col) => !normalized.includes(col));
    if (missing.length > 0) {
      throw new AdapterFileError(
        `Missing required columns: ${missing.join(', ')}. ` +
          'Ensure you exported the HDFC NetBanking statement in CSV format.',
      );
    }
  },

  parseRow(raw: Record<string, string>, rowNumber: number): NormalizedRow | null {
    const withdrawal = parseAmount(raw['Withdrawal Amt.'] ?? '');
    const deposit = parseAmount(raw['Deposit Amt.'] ?? '');

    // Skip summary/footer rows that have no amounts
    if (withdrawal === null && deposit === null) {
      return null; // SKIPPED
    }

    const occurredAt = parseHdfcDate(raw['Date'] ?? '', rowNumber);

    const description = (raw['Narration'] ?? '').trim();
    if (!description) {
      throw new AdapterRowError(rowNumber, 'Empty narration', raw);
    }

    const refNo = (raw['Chq./Ref.No.'] ?? '').trim();
    const sourceTxId = refNo !== '' && refNo !== '0' ? refNo : undefined;

    let amount: Decimal;
    let type: 'INCOME' | 'EXPENSE';

    if (withdrawal !== null && withdrawal.greaterThan(0)) {
      amount = withdrawal;
      type = 'EXPENSE';
    } else if (deposit !== null && deposit.greaterThan(0)) {
      amount = deposit;
      type = 'INCOME';
    } else {
      // Both zero — skip (e.g. reversed transaction that nets zero)
      return null;
    }

    return {
      occurredAt,
      amount,
      type,
      description,
      sourceTxId,
      rawData: raw,
    };
  },
};

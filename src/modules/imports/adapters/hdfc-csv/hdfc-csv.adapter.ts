// src/modules/imports/adapters/hdfc-csv/hdfc-csv.adapter.ts
// HDFC Bank savings-account statement CSV adapter.
//
// Columns (HDFC NetBanking export):
//   Date | Narration | Chq./Ref.No. | Value Dt | Withdrawal Amt. | Deposit Amt. | Closing Balance
//
// Rules:
//   - Amounts use Indian grouping ("1,23,456.78"); parsed exactly with Decimal.
//   - Exactly one of Withdrawal / Deposit should carry a value. Rows with neither are SKIPPED
//     (opening balance / summary lines). Rows with both are REJECTED as ambiguous.
//   - Withdrawal -> EXPENSE. Deposit -> INCOME, or REFUND when the narration says refund/reversal.
//   - Paying a credit-card bill is a TRANSFER (money moving to a liability), not an expense;
//     the card's own purchases are the expenses. See docs/financial-rules.md.
//   - sourceTxId is "<ref>:DR" / "<ref>:CR". Banks reuse the same reference for a payment and its
//     reversal, so the direction is part of the identity. A "0" / blank reference means "none".

import type { BankStatementAdapter, NormalizedRow, TransactionType } from '../adapter.interface';
import { AdapterFileError, AdapterRowError } from '../adapter.interface';
import { makeGetter, normalizeHeader, parseAmountCell, parseDateCell } from '../parsing';

const REQUIRED_COLUMNS = [
  'Date',
  'Narration',
  'Chq./Ref.No.',
  'Value Dt',
  'Withdrawal Amt.',
  'Deposit Amt.',
  'Closing Balance',
];

const REFUND_RE = /\b(refund|reversal|reversed|rev)\b/i;
const CARD_BILL_RE = /\b(credit\s?card|cc)\b.*\b(payment|bill|pymt)\b|\b(payment|bill|pymt)\b.*\b(credit\s?card)\b/i;

export const hdfcCsvAdapter: BankStatementAdapter = {
  key: 'hdfc-csv',
  displayName: 'HDFC Bank Savings Account (CSV)',
  expectedColumns: REQUIRED_COLUMNS,

  matches(headers) {
    const have = new Set(headers.map(normalizeHeader));
    return REQUIRED_COLUMNS.every((c) => have.has(normalizeHeader(c)));
  },

  validateHeaders(headers) {
    const have = new Set(headers.map(normalizeHeader));
    const missing = REQUIRED_COLUMNS.filter((c) => !have.has(normalizeHeader(c)));
    if (missing.length > 0) {
      throw new AdapterFileError(
        `Missing required columns: ${missing.join(', ')}. Export the statement from HDFC NetBanking in CSV format.`,
      );
    }
  },

  parseRow(raw): NormalizedRow | null {
    const get = makeGetter(raw);
    const withdrawal = parseAmountCell(get('Withdrawal Amt.'));
    const deposit = parseAmountCell(get('Deposit Amt.'));
    const hasW = withdrawal !== null && !withdrawal.isZero();
    const hasD = deposit !== null && !deposit.isZero();

    if (!hasW && !hasD) return null; // opening balance / summary / zero-value line
    if (hasW && hasD) throw new AdapterRowError('Row has both a withdrawal and a deposit amount');
    if ((withdrawal?.isNegative() ?? false) || (deposit?.isNegative() ?? false)) {
      throw new AdapterRowError('Negative amount in a withdrawal/deposit column');
    }

    const localDate = parseDateCell(get('Date'));
    const description = get('Narration').trim();
    if (!description) throw new AdapterRowError('Empty narration');

    const ref = get('Chq./Ref.No.').trim().replace(/^0+$/, '');
    const direction = hasW ? 'DR' : 'CR';

    let type: TransactionType;
    if (hasW) type = CARD_BILL_RE.test(description) ? 'TRANSFER' : 'EXPENSE';
    else type = REFUND_RE.test(description) ? 'REFUND' : 'INCOME';

    return {
      localDate,
      amount: (hasW ? withdrawal : deposit)!,
      type,
      description,
      ...(ref !== '' && { sourceTxId: `${ref}:${direction}` }),
      rawData: raw,
    };
  },
};

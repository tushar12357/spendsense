// src/modules/imports/adapters/generic-csv/generic-csv.adapter.ts
// A bank-agnostic CSV adapter for exports (or hand-made sheets) with simple headers.
//
//   Date          | Date, Txn Date, Transaction Date, Value Date
//   Description   | Description, Narration, Details, Particulars
//   Debit/Credit  | Debit, Withdrawal, Dr   /   Credit, Deposit, Cr
//   -- or --
//   Amount        | signed amount: negative = money out, positive = money in
//   Reference     | optional: Reference, Ref No, UTR, Transaction ID

import type { BankStatementAdapter, NormalizedRow, TransactionType } from '../adapter.interface';
import { AdapterFileError, AdapterRowError } from '../adapter.interface';
import { makeGetter, normalizeHeader, parseAmountCell, parseDateCell } from '../parsing';

const DATE = ['Date', 'Txn Date', 'Transaction Date', 'Value Date'];
const DESC = ['Description', 'Narration', 'Details', 'Particulars'];
const DEBIT = ['Debit', 'Withdrawal', 'Withdrawal Amt.', 'Dr'];
const CREDIT = ['Credit', 'Deposit', 'Deposit Amt.', 'Cr'];
const AMOUNT = ['Amount'];
const REF = ['Reference', 'Ref No', 'Ref No.', 'UTR', 'Transaction ID', 'Txn ID'];

const REFUND_RE = /\b(refund|reversal|reversed)\b/i;

function hasAny(have: Set<string>, names: string[]): boolean {
  return names.some((n) => have.has(normalizeHeader(n)));
}

function structure(headers: string[]) {
  const have = new Set(headers.map(normalizeHeader));
  const hasDate = hasAny(have, DATE);
  const hasDesc = hasAny(have, DESC);
  const hasSplit = hasAny(have, DEBIT) && hasAny(have, CREDIT);
  const hasSigned = hasAny(have, AMOUNT);
  return { hasDate, hasDesc, hasSplit, hasSigned };
}

export const genericCsvAdapter: BankStatementAdapter = {
  key: 'generic-csv',
  displayName: 'Generic CSV (Date, Description, Debit/Credit or Amount)',
  expectedColumns: ['Date', 'Description', 'Debit + Credit  (or a signed Amount)', 'Reference (optional)'],

  matches(headers) {
    const s = structure(headers);
    return s.hasDate && s.hasDesc && (s.hasSplit || s.hasSigned);
  },

  validateHeaders(headers) {
    const s = structure(headers);
    const missing: string[] = [];
    if (!s.hasDate) missing.push('Date');
    if (!s.hasDesc) missing.push('Description');
    if (!s.hasSplit && !s.hasSigned) missing.push('Debit+Credit or Amount');
    if (missing.length > 0) {
      throw new AdapterFileError(`Missing required columns: ${missing.join(', ')}.`);
    }
  },

  parseRow(raw): NormalizedRow | null {
    const get = makeGetter(raw);

    let signed: ReturnType<typeof parseAmountCell> = null;
    const debitCell = parseAmountCell(get(...DEBIT));
    const creditCell = parseAmountCell(get(...CREDIT));
    if (debitCell !== null || creditCell !== null) {
      const dr = debitCell && !debitCell.isZero() ? debitCell.abs() : null;
      const cr = creditCell && !creditCell.isZero() ? creditCell.abs() : null;
      if (dr && cr) throw new AdapterRowError('Row has both a debit and a credit amount');
      signed = dr ? dr.neg() : cr;
    } else {
      signed = parseAmountCell(get(...AMOUNT));
    }
    if (signed === null || signed.isZero()) return null;

    const localDate = parseDateCell(get(...DATE));
    const description = get(...DESC).trim();
    if (!description) throw new AdapterRowError('Empty description');

    const outflow = signed.isNegative();
    const type: TransactionType = outflow ? 'EXPENSE' : REFUND_RE.test(description) ? 'REFUND' : 'INCOME';
    const ref = get(...REF).trim();

    return {
      localDate,
      amount: signed.abs(),
      type,
      description,
      ...(ref !== '' && ref !== '0' && { sourceTxId: `${ref}:${outflow ? 'DR' : 'CR'}` }),
      rawData: raw,
    };
  },
};

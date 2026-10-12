import { describe, expect, it } from 'vitest';
import { AdapterFileError, AdapterRowError } from '../../src/modules/imports/adapters/adapter.interface';
import { hdfcCsvAdapter } from '../../src/modules/imports/adapters/hdfc-csv/hdfc-csv.adapter';
import { genericCsvAdapter } from '../../src/modules/imports/adapters/generic-csv/generic-csv.adapter';
import { detectAdapter, getAdapter } from '../../src/modules/imports/adapters/registry';

const hdfcRow = (over: Record<string, string>) => ({
  Date: '02/10/2026',
  Narration: 'UPI-SWIGGY BANGALORE',
  'Chq./Ref.No.': 'UTR123',
  'Value Dt': '02/10/2026',
  'Withdrawal Amt.': '1,250.50',
  'Deposit Amt.': '',
  'Closing Balance': '1,33,749.50',
  ...over,
});

describe('HDFC adapter', () => {
  it('classifies a withdrawal as an EXPENSE and namespaces the reference by direction', () => {
    const row = hdfcCsvAdapter.parseRow(hdfcRow({}))!;
    expect(row.type).toBe('EXPENSE');
    expect(row.amount.toFixed(2)).toBe('1250.50');
    expect(row.localDate).toBe('2026-10-02');
    expect(row.sourceTxId).toBe('UTR123:DR');
  });

  it('classifies a deposit as INCOME', () => {
    const row = hdfcCsvAdapter.parseRow(hdfcRow({ 'Withdrawal Amt.': '', 'Deposit Amt.': '85,000.00', Narration: 'SALARY' }))!;
    expect(row.type).toBe('INCOME');
    expect(row.sourceTxId).toBe('UTR123:CR');
  });

  it('classifies a refund / reversal deposit as REFUND', () => {
    const row = hdfcCsvAdapter.parseRow(hdfcRow({ 'Withdrawal Amt.': '', 'Deposit Amt.': '499.00', Narration: 'REFUND AMAZON ORDER' }))!;
    expect(row.type).toBe('REFUND');
  });

  it('classifies a credit-card bill payment as a TRANSFER, not an expense', () => {
    const row = hdfcCsvAdapter.parseRow(hdfcRow({ Narration: 'CREDIT CARD PAYMENT HDFC 4321' }))!;
    expect(row.type).toBe('TRANSFER');
  });

  it('gives the same reference different identities for a payment and its reversal', () => {
    const debit = hdfcCsvAdapter.parseRow(hdfcRow({}))!;
    const credit = hdfcCsvAdapter.parseRow(hdfcRow({ 'Withdrawal Amt.': '', 'Deposit Amt.': '1,250.50', Narration: 'REVERSAL SWIGGY' }))!;
    expect(debit.sourceTxId).not.toBe(credit.sourceTxId);
  });

  it('treats "0" and blank references as no reference', () => {
    expect(hdfcCsvAdapter.parseRow(hdfcRow({ 'Chq./Ref.No.': '0' }))!.sourceTxId).toBeUndefined();
    expect(hdfcCsvAdapter.parseRow(hdfcRow({ 'Chq./Ref.No.': '000000' }))!.sourceTxId).toBeUndefined();
    expect(hdfcCsvAdapter.parseRow(hdfcRow({ 'Chq./Ref.No.': '' }))!.sourceTxId).toBeUndefined();
  });

  it('skips rows with no amount and rejects ambiguous / invalid rows', () => {
    expect(hdfcCsvAdapter.parseRow(hdfcRow({ 'Withdrawal Amt.': '', 'Deposit Amt.': '' }))).toBeNull();
    expect(() => hdfcCsvAdapter.parseRow(hdfcRow({ 'Deposit Amt.': '10.00' }))).toThrow(AdapterRowError);
    expect(() => hdfcCsvAdapter.parseRow(hdfcRow({ Narration: '' }))).toThrow(AdapterRowError);
    expect(() => hdfcCsvAdapter.parseRow(hdfcRow({ Date: '31/02/2026' }))).toThrow(AdapterRowError);
    expect(() => hdfcCsvAdapter.parseRow(hdfcRow({ 'Withdrawal Amt.': 'abc' }))).toThrow(AdapterRowError);
  });

  it('validates headers case-insensitively and names the missing columns', () => {
    expect(() => hdfcCsvAdapter.validateHeaders(Object.keys(hdfcRow({})).map((h) => h.toUpperCase()))).not.toThrow();
    expect(() => hdfcCsvAdapter.validateHeaders(['Date', 'Narration'])).toThrow(AdapterFileError);
    expect(() => hdfcCsvAdapter.validateHeaders(['Date', 'Narration'])).toThrow(/Withdrawal Amt\./);
  });
});

describe('generic adapter', () => {
  it('handles Debit/Credit columns', () => {
    const out = genericCsvAdapter.parseRow({ Date: '2026-10-03', Description: 'Coffee', Debit: '150.00', Credit: '' })!;
    expect(out.type).toBe('EXPENSE');
    expect(out.amount.toFixed(2)).toBe('150.00');
    const inc = genericCsvAdapter.parseRow({ Date: '2026-10-03', Description: 'Freelance', Debit: '', Credit: '5,000' })!;
    expect(inc.type).toBe('INCOME');
  });

  it('handles a signed Amount column', () => {
    expect(genericCsvAdapter.parseRow({ Date: '03/10/2026', Details: 'Rent', Amount: '-25,000.00' })!.type).toBe('EXPENSE');
    expect(genericCsvAdapter.parseRow({ Date: '03/10/2026', Details: 'Interest', Amount: '120.00' })!.type).toBe('INCOME');
    expect(genericCsvAdapter.parseRow({ Date: '03/10/2026', Details: 'Refund of order', Amount: '120.00' })!.type).toBe('REFUND');
  });

  it('rejects rows with both debit and credit and skips empty-amount rows', () => {
    expect(() => genericCsvAdapter.parseRow({ Date: '2026-10-03', Description: 'x', Debit: '1', Credit: '2' })).toThrow(AdapterRowError);
    expect(genericCsvAdapter.parseRow({ Date: '2026-10-03', Description: 'Balance b/f', Debit: '', Credit: '' })).toBeNull();
  });
});

describe('adapter registry', () => {
  it('auto-detects HDFC before falling back to generic', () => {
    expect(detectAdapter(Object.keys(hdfcRow({})))!.key).toBe('hdfc-csv');
    expect(detectAdapter(['Date', 'Description', 'Debit', 'Credit'])!.key).toBe('generic-csv');
    expect(detectAdapter(['foo', 'bar'])).toBeUndefined();
  });

  it('looks adapters up by key', () => {
    expect(getAdapter('hdfc-csv')).toBe(hdfcCsvAdapter);
    expect(getAdapter('nope')).toBeUndefined();
  });
});

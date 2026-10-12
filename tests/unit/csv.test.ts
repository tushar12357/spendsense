import { describe, expect, it } from 'vitest';
import { hashFile, parseCsv } from '../../src/modules/imports/pipeline/csv';
import { AppError } from '../../src/shared/errors/AppError';

const HEADER = 'Date,Narration,Chq./Ref.No.,Value Dt,Withdrawal Amt.,Deposit Amt.,Closing Balance';
const ROW = '01/10/26,SALARY,REF1,01/10/26,,"85,000.00","1,35,000.00"';

describe('parseCsv', () => {
  it('parses a valid statement and auto-detects the adapter', () => {
    const out = parseCsv(Buffer.from(`${HEADER}\n${ROW}\n`));
    expect(out.adapter.key).toBe('hdfc-csv');
    expect(out.records).toHaveLength(1);
    expect(out.records[0]!['Deposit Amt.']).toBe('85,000.00');
  });

  it('handles a UTF-8 BOM', () => {
    const out = parseCsv(Buffer.from(`﻿${HEADER}\n${ROW}\n`));
    expect(out.headers[0]).toBe('Date');
  });

  it('falls back to Windows-1252 for non-UTF-8 bytes', () => {
    const buf = Buffer.concat([Buffer.from(`${HEADER}\n01/10/26,CAF`), Buffer.from([0xc9]), Buffer.from(',R1,01/10/26,10.00,,"1.00"\n')]);
    expect(parseCsv(buf).records[0]!['Narration']).toBe('CAFÉ');
  });

  it('tolerates rows with a missing trailing column instead of failing the whole file', () => {
    const out = parseCsv(Buffer.from(`${HEADER}\n01/10/26,SHORT ROW,R1\n${ROW}\n`));
    expect(out.records).toHaveLength(2);
  });

  it.each([
    ['empty file', Buffer.alloc(0)],
    ['header only', Buffer.from(`${HEADER}\n`)],
    ['binary content', Buffer.from([0x50, 0x4b, 0x03, 0x04, 0x00, 0x00, 0x01])],
    ['unrecognised columns', Buffer.from('foo,bar\n1,2\n')],
  ])('rejects %s with a 4xx AppError', (_name, buf) => {
    try {
      parseCsv(buf);
      expect.unreachable('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(AppError);
      expect((err as AppError).statusCode).toBeGreaterThanOrEqual(400);
      expect((err as AppError).statusCode).toBeLessThan(500);
    }
  });

  it('rejects an explicit adapter whose columns are missing, naming them', () => {
    expect(() => parseCsv(Buffer.from('Date,Description,Debit,Credit\n2026-10-01,x,1,\n'), 'hdfc-csv')).toThrow(/Missing required columns/);
  });

  it('rejects unknown adapter keys', () => {
    expect(() => parseCsv(Buffer.from(`${HEADER}\n${ROW}\n`), 'sbi-pdf')).toThrow(/Unknown adapter/);
  });

  it('does not leak cell content in malformed-CSV errors', () => {
    try {
      parseCsv(Buffer.from('Date,Narration\n"unterminated SECRET-NARRATION,1\n'));
      expect.unreachable();
    } catch (err) {
      expect((err as AppError).message).not.toContain('SECRET-NARRATION');
    }
  });
});

describe('hashFile', () => {
  it('is deterministic and content-sensitive', () => {
    expect(hashFile(Buffer.from('a'))).toBe(hashFile(Buffer.from('a')));
    expect(hashFile(Buffer.from('a'))).not.toBe(hashFile(Buffer.from('b')));
    expect(hashFile(Buffer.from('a'))).toHaveLength(64);
  });
});

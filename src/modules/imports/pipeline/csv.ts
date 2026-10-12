// src/modules/imports/pipeline/csv.ts
// File-level validation and CSV parsing. Pure (no database): throws AppError for unusable files.

import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { AppError } from '../../../shared/errors/AppError';
import { AdapterFileError, type BankStatementAdapter } from '../adapters/adapter.interface';
import { detectAdapter, getAdapter, listAdapters } from '../adapters/registry';

export const MAX_ROWS = 50_000;

export interface ParsedCsv {
  adapter: BankStatementAdapter;
  headers: string[];
  records: Record<string, string>[];
}

export function hashFile(buffer: Buffer): string {
  return createHash('sha256').update(buffer).digest('hex');
}

/** UTF-8 first (with optional BOM); fall back to Windows-1252, which many Indian bank exports use. */
function decode(buffer: Buffer): string {
  try {
    return new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(buffer);
  } catch {
    return new TextDecoder('windows-1252').decode(buffer);
  }
}

/**
 * Validates and parses an uploaded statement.
 * @param adapterKey explicit adapter, or undefined to auto-detect from the header row
 */
export function parseCsv(buffer: Buffer, adapterKey?: string): ParsedCsv {
  if (buffer.length === 0) throw AppError.badRequest('The uploaded file is empty');
  if (buffer.includes(0)) {
    throw AppError.unsupportedFile('The file looks binary, not like a CSV text file');
  }

  let records: Record<string, string>[];
  let headers: string[] = [];
  try {
    records = parse(decode(buffer), {
      // Capture the real header row (not the first data row, which may be short/malformed).
      columns: (header: string[]) => {
        headers = header.map((h) => h.trim());
        return headers;
      },
      skip_empty_lines: true,
      trim: true,
      bom: true,
      relax_column_count: true, // short/long rows surface as row-level problems, not a whole-file failure
      relax_quotes: false,
      max_record_size: 64 * 1024,
    }) as Record<string, string>[];
  } catch (err) {
    // csv-parse messages can quote cell content; expose only the error code.
    const code = (err as { code?: string }).code ?? 'CSV_PARSE_ERROR';
    throw AppError.badRequest(`Malformed CSV (${code})`);
  }

  if (records.length === 0) throw AppError.badRequest('The CSV contains a header row but no data rows');
  if (records.length > MAX_ROWS) throw AppError.badRequest(`The CSV has more than ${MAX_ROWS} rows; split it into smaller files`);

  let adapter: BankStatementAdapter | undefined;
  if (adapterKey) {
    adapter = getAdapter(adapterKey);
    if (!adapter) {
      throw AppError.badRequest(
        `Unknown adapter "${adapterKey}". Available: ${listAdapters().map((a) => a.key).join(', ')}`,
      );
    }
  } else {
    adapter = detectAdapter(headers);
    if (!adapter) {
      throw AppError.badRequest(
        'Could not recognise this statement format. Pass an explicit adapterKey (see GET /api/v1/imports/adapters).',
      );
    }
  }

  try {
    adapter.validateHeaders(headers);
  } catch (err) {
    if (err instanceof AdapterFileError) throw AppError.badRequest(err.message);
    throw err;
  }

  return { adapter, headers, records };
}

// src/shared/validation/pagination.schema.ts
// Cursor (keyset) pagination helpers. A cursor is an opaque base64url token wrapping the sort key
// of the last row returned: (occurredAt DESC, id ASC) for the ledger, rowNumber for import rows.

import { z } from 'zod';
import { AppError } from '../errors/AppError';

export const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export const uuidSchema = z.string().regex(UUID_RE, 'Must be a UUID');

export const paginationQuerySchema = z.object({
  cursor: z.string().max(512).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

function encode(payload: unknown): string {
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
}

function decode(cursor: string): unknown {
  try {
    return JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8'));
  } catch {
    return null;
  }
}

/** Ledger cursor: sort key of the last transaction on the page. */
export function encodeCursor(id: string, occurredAt: Date): string {
  return encode({ id, occurredAt: occurredAt.toISOString() });
}

/** Decodes and validates a ledger cursor. Throws a 400 AppError on any malformed input. */
export function decodeCursor(cursor: string): { id: string; occurredAt: Date } {
  const parsed = decode(cursor) as { id?: unknown; occurredAt?: unknown } | null;
  if (
    !parsed ||
    typeof parsed.id !== 'string' ||
    !UUID_RE.test(parsed.id) ||
    typeof parsed.occurredAt !== 'string'
  ) {
    throw AppError.badRequest('Invalid cursor');
  }
  const occurredAt = new Date(parsed.occurredAt);
  if (Number.isNaN(occurredAt.getTime())) throw AppError.badRequest('Invalid cursor');
  return { id: parsed.id, occurredAt };
}

/** Row-number cursor used for import rows. */
export function encodeRowCursor(rowNumber: number): string {
  return encode({ r: rowNumber });
}

export function decodeRowCursor(cursor: string): number {
  const parsed = decode(cursor) as { r?: unknown } | null;
  if (!parsed || typeof parsed.r !== 'number' || !Number.isInteger(parsed.r) || parsed.r < 0) {
    throw AppError.badRequest('Invalid cursor');
  }
  return parsed.r;
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: { hasMore: boolean; nextCursor: string | null; count: number };
}

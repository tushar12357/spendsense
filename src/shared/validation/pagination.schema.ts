// src/shared/validation/pagination.schema.ts
// Reusable cursor pagination Zod schemas.
// Cursor is an opaque base64-encoded string wrapping { id, occurredAt }.

import { z } from 'zod';

export const paginationQuerySchema = z.object({
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
});

export type PaginationQuery = z.infer<typeof paginationQuerySchema>;

/** Encode a cursor from a transaction's sort fields */
export function encodeCursor(id: string, occurredAt: Date): string {
  const payload = JSON.stringify({ id, occurredAt: occurredAt.toISOString() });
  return Buffer.from(payload, 'utf8').toString('base64url');
}

/** Decode a cursor. Returns null on invalid input. */
export function decodeCursor(cursor: string): { id: string; occurredAt: Date } | null {
  try {
    const json = Buffer.from(cursor, 'base64url').toString('utf8');
    const parsed = JSON.parse(json) as { id: string; occurredAt: string };
    if (typeof parsed.id !== 'string' || typeof parsed.occurredAt !== 'string') return null;
    return { id: parsed.id, occurredAt: new Date(parsed.occurredAt) };
  } catch {
    return null;
  }
}

export interface PaginatedResponse<T> {
  data: T[];
  pagination: {
    hasMore: boolean;
    nextCursor: string | null;
    count: number;
  };
}

export function buildPaginatedResponse<T extends { id: string; occurredAt?: Date }>(
  items: T[],
  limit: number,
): PaginatedResponse<T> {
  const hasMore = items.length > limit;
  const data = hasMore ? items.slice(0, limit) : items;
  const last = data[data.length - 1];
  const nextCursor =
    hasMore && last && last.occurredAt
      ? encodeCursor(last.id, last.occurredAt)
      : null;

  return { data, pagination: { hasMore, nextCursor, count: data.length } };
}

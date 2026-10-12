// src/shared/utils/sql.ts
// Prisma's `contains` passes the term to LIKE/ILIKE without escaping wildcards, so a search for
// "%" or "_" would match everything. Escape them with PostgreSQL's default LIKE escape character.

const BACKSLASH = '\\';

export function escapeLike(term: string): string {
  return term.replace(/[\\%_]/g, (ch) => BACKSLASH + ch);
}

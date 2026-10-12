// src/shared/utils/fingerprint.ts
// Content fingerprints for SECONDARY duplicate detection.
//
// The primary guard is the (account_id, source_tx_id) unique constraint. When a statement has no
// bank reference we fall back to a fingerprint of account + local date + amount + description.
//
// A fingerprint alone does not prove duplication: two real purchases can share all four fields.
// To stay conservative, the fingerprint also carries an *occurrence ordinal* - "this is the 2nd
// identical row in this file". That way:
//   - two identical coffees inside ONE statement get different fingerprints and are both kept;
//   - re-importing an overlapping statement matches occurrence 1 with 1, 2 with 2, and so on,
//     so only genuinely repeated rows are flagged, and an extra legitimate purchase still imports.

import { createHash } from 'node:crypto';

export interface FingerprintInput {
  accountId: string;
  /** Calendar date in the user's timezone, YYYY-MM-DD. */
  localDate: string;
  /** Decimal serialized with 2 fraction digits, e.g. "1234.50". */
  amount: string;
  description: string;
  /** 1-based occurrence of this exact (date, amount, description) within the source file. */
  ordinal?: number;
}

/** Lowercase, collapse whitespace, strip punctuation so cosmetic differences do not matter. */
export function normalizeDescription(description: string): string {
  return description
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** Key shared by every row that could be "the same transaction" (without the ordinal). */
export function fingerprintBaseKey(input: Omit<FingerprintInput, 'ordinal'>): string {
  return `${input.accountId}|${input.localDate}|${input.amount}|${normalizeDescription(input.description)}`;
}

export function generateFingerprint(input: FingerprintInput): string {
  const payload = `${fingerprintBaseKey(input)}|${input.ordinal ?? 1}`;
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

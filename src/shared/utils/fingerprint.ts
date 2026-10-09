// src/shared/utils/fingerprint.ts
// Generates a content-based fingerprint for duplicate detection.
// Used as a SECONDARY check — the primary is source_tx_id uniqueness.
// A fingerprint match is a CANDIDATE duplicate, not a definitive duplicate.

import { createHash } from 'crypto';

interface FingerprintInput {
  accountId: string;
  occurredAt: Date;
  amount: string;       // Decimal serialized as string e.g. "1234.50"
  description: string;
}

/**
 * Normalize a description for fingerprinting:
 * - Lowercase
 * - Remove common noise (multiple spaces, punctuation runs)
 * - Trim
 */
export function normalizeDescription(description: string): string {
  return description
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .replace(/[^a-z0-9 ]/g, '')
    .trim();
}

/**
 * Generate a SHA-256 fingerprint.
 * The fingerprint encodes: accountId + date (YYYY-MM-DD) + amount (fixed 2dp) + normalized description.
 * Two transactions with the same fingerprint in the same account on the same date are CANDIDATE duplicates.
 */
export function generateFingerprint(input: FingerprintInput): string {
  const datePart = input.occurredAt.toISOString().slice(0, 10); // YYYY-MM-DD
  const normalized = normalizeDescription(input.description);
  const payload = `${input.accountId}|${datePart}|${input.amount}|${normalized}`;
  return createHash('sha256').update(payload, 'utf8').digest('hex');
}

/**
 * Check if two fingerprints match (trivial equality).
 * Split out so tests can verify the comparison logic independently.
 */
export function fingerprintsMatch(a: string, b: string): boolean {
  return a === b;
}

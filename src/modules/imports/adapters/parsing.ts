// src/modules/imports/adapters/parsing.ts
// Parsing primitives shared by all CSV adapters. Pure functions - heavily unit-tested.

import { Decimal } from '../../../shared/utils/decimal';
import { AdapterRowError } from './adapter.interface';

/**
 * Parses an amount cell. Handles Indian digit grouping ("1,23,456.78"), currency symbols,
 * stray whitespace and accounting negatives "(1,200.00)".
 * Returns null for blank cells ("", "-"); throws AdapterRowError for non-numeric junk.
 * The sign is preserved - callers decide what a negative means for their column.
 */
export function parseAmountCell(raw: string | undefined): Decimal | null {
  if (raw === undefined) return null;
  let s = raw.trim();
  if (s === '' || s === '-' || s === '--') return null;

  let negative = false;
  if (/^\(.*\)$/.test(s)) {
    negative = true;
    s = s.slice(1, -1);
  }
  s = s.replace(/(?:Rs\.?|INR|₹)/gi, '').replace(/[,\s]/g, '');
  // Trailing Dr/Cr markers some banks append ("1250.00Dr")
  const marker = /(dr|cr)$/i.exec(s);
  if (marker) s = s.slice(0, -2);
  if (s.startsWith('-')) {
    negative = !negative;
    s = s.slice(1);
  }
  if (!/^\d+(\.\d+)?$/.test(s)) {
    throw new AdapterRowError(`Unparseable amount: "${raw.trim().slice(0, 30)}"`);
  }
  const d = new Decimal(s);
  if (d.decimalPlaces() > 2) throw new AdapterRowError(`Amount has more than 2 decimal places: "${raw.trim().slice(0, 30)}"`);
  return negative ? d.neg() : d;
}

function isRealDate(y: number, m: number, d: number): boolean {
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function toIso(y: number, m: number, d: number): string {
  return `${String(y).padStart(4, '0')}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/**
 * Parses DD/MM/YY, DD/MM/YYYY (also with "-" or "." separators) or ISO YYYY-MM-DD into
 * a YYYY-MM-DD calendar date. Impossible dates (31/02) are rejected.
 * Two-digit years: 00-69 -> 2000s, 70-99 -> 1900s.
 */
export function parseDateCell(raw: string | undefined): string {
  const s = (raw ?? '').trim();
  const iso = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (iso) {
    const [y, m, d] = [Number(iso[1]), Number(iso[2]), Number(iso[3])];
    if (!isRealDate(y, m, d)) throw new AdapterRowError(`Invalid date: "${s}"`);
    return toIso(y, m, d);
  }
  const dmy = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{2}|\d{4})$/.exec(s);
  if (!dmy) throw new AdapterRowError(`Unparseable date: "${s.slice(0, 30)}"`);
  const d = Number(dmy[1]);
  const m = Number(dmy[2]);
  let y = Number(dmy[3]);
  if (dmy[3]!.length === 2) y += y >= 70 ? 1900 : 2000;
  if (!isRealDate(y, m, d)) throw new AdapterRowError(`Invalid date: "${s}"`);
  return toIso(y, m, d);
}

/** Case/whitespace-insensitive header lookup: normalizeHeader("Chq./Ref.No. ") === normalizeHeader("chq./ref.no."). */
export function normalizeHeader(h: string): string {
  return h.replace(/^﻿/, '').trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Returns a row accessor that finds a column by any of its accepted names. */
export function makeGetter(raw: Record<string, string>) {
  const byName = new Map<string, string>();
  for (const [k, v] of Object.entries(raw)) byName.set(normalizeHeader(k), v ?? '');
  return (...names: string[]): string => {
    for (const n of names) {
      const v = byName.get(normalizeHeader(n));
      if (v !== undefined) return v;
    }
    return '';
  };
}

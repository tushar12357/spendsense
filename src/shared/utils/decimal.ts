// src/shared/utils/decimal.ts
// Decimal helpers. All monetary computation goes through Decimal - never JS numbers.
// Prisma's Decimal (decimal.js) is the single implementation used across the codebase.

import { Prisma } from '@prisma/client';

export const Decimal = Prisma.Decimal;
export type Decimal = Prisma.Decimal;

export type DecimalValue = string | number | Decimal;

export const ZERO = new Decimal(0);
const HUNDRED = new Decimal(100);

/** Parse a string or number into a Decimal. Throws if not a valid finite number. */
export function toDecimal(value: string | number | Decimal): Decimal {
  const d = new Decimal(value);
  if (!d.isFinite()) throw new Error(`Invalid monetary value: ${String(value)}`);
  return d;
}

/** Serialize money for API responses: always a 2-dp string to avoid float precision loss. */
export function serializeAmount(d: DecimalValue): string {
  return new Decimal(d).toFixed(2);
}

/** Sum a list of Decimals (empty list -> 0). */
export function sum(values: Iterable<DecimalValue>): Decimal {
  let total = new Decimal(0);
  for (const v of values) total = total.add(v);
  return total;
}

/** a / b as a percentage (0-100 scale), or null when b is zero. */
export function percentOf(a: DecimalValue, b: DecimalValue): Decimal | null {
  const denom = new Decimal(b);
  if (denom.isZero()) return null;
  return new Decimal(a).div(denom).mul(HUNDRED);
}

/** Percentage string with 2 dp, or null. */
export function serializePercent(p: Decimal | null): string | null {
  return p === null ? null : p.toFixed(2);
}

export function maxDecimal(a: DecimalValue, b: DecimalValue): Decimal {
  return Decimal.max(a, b);
}

/**
 * Savings rate = (income - netExpenses) / income x 100. Returns null when income is zero
 * (the ratio is undefined, not zero). Negative when the user spent more than they earned.
 */
export function savingsRate(income: DecimalValue, netExpenses: DecimalValue): Decimal | null {
  return percentOf(new Decimal(income).sub(netExpenses), income);
}

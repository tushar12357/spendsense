// src/shared/utils/decimal.ts
// Safe Decimal arithmetic wrappers.
// All monetary computation must go through these helpers — never use JS number for money.
// Prisma Decimal fields return Decimal (backed by decimal.js).

import { Decimal } from '@prisma/client/runtime/library';

export { Decimal };
export type MoneyDecimal = Decimal;

/** Parse a string or number into a Decimal. Throws if not a valid finite number. */
export function toDecimal(value: string | number): Decimal {
  const d = new Decimal(value);
  if (!d.isFinite()) {
    throw new Error(`Invalid monetary value: ${value}`);
  }
  return d;
}

/** Serialize a Decimal for API responses. Always a string to avoid float precision loss. */
export function serializeAmount(d: Decimal): string {
  return d.toFixed(2);
}

/** Add two Decimals */
export function addDecimal(a: Decimal, b: Decimal): Decimal {
  return a.add(b);
}

/** Subtract b from a */
export function subtractDecimal(a: Decimal, b: Decimal): Decimal {
  return a.sub(b);
}

/** Multiply two Decimals */
export function multiplyDecimal(a: Decimal, b: Decimal): Decimal {
  return a.mul(b);
}

/** Divide a by b. Returns null if b is zero. */
export function divideDecimal(
  a: Decimal,
  b: Decimal,
): Decimal | null {
  if (b.isZero()) return null;
  return a.div(b);
}

/** Zero constant */
export const ZERO = new Decimal(0);

/** Compute savings rate. Returns null if income is zero. Result is 0-100. */
export function savingsRate(
  income: Decimal,
  expenses: Decimal,
): Decimal | null {
  if (income.isZero()) return null;
  const netSavings = subtractDecimal(income, expenses);
  const rate = divideDecimal(netSavings, income);
  if (!rate) return null;
  return multiplyDecimal(rate, new Decimal(100));
}

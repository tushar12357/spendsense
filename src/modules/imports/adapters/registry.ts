// src/modules/imports/adapters/registry.ts
// Adapter registry. Add new bank formats here; the pipeline discovers them by key or by header sniffing.

import type { BankStatementAdapter } from './adapter.interface';
import { hdfcCsvAdapter } from './hdfc-csv/hdfc-csv.adapter';
import { genericCsvAdapter } from './generic-csv/generic-csv.adapter';

// Order matters for auto-detection: bank-specific adapters first, the generic one last.
const adapters: BankStatementAdapter[] = [hdfcCsvAdapter, genericCsvAdapter];
const byKey = new Map(adapters.map((a) => [a.key, a]));

export function getAdapter(key: string): BankStatementAdapter | undefined {
  return byKey.get(key);
}

export function detectAdapter(headers: string[]): BankStatementAdapter | undefined {
  return adapters.find((a) => a.matches(headers));
}

export function listAdapters() {
  return adapters.map(({ key, displayName, expectedColumns }) => ({ key, displayName, expectedColumns }));
}

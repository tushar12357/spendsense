// src/modules/imports/adapters/registry.ts
// Adapter registry — maps adapter keys to adapter instances.
// Add new adapters here; the pipeline discovers them via this registry.

import type { BankStatementAdapter } from './adapter.interface';
import { hdfcCsvAdapter } from './hdfc-csv/hdfc-csv.adapter';

const adapters: Map<string, BankStatementAdapter> = new Map([
  [hdfcCsvAdapter.key, hdfcCsvAdapter],
]);

export function getAdapter(key: string): BankStatementAdapter {
  const adapter = adapters.get(key);
  if (!adapter) {
    throw new Error(`Unknown adapter: "${key}". Available: ${[...adapters.keys()].join(', ')}`);
  }
  return adapter;
}

export function listAdapters(): Array<{ key: string; displayName: string }> {
  return [...adapters.values()].map(({ key, displayName }) => ({ key, displayName }));
}

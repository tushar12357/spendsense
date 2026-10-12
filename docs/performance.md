# Performance and query plans

Measured with `npm run db:explain` (`scripts/explain-queries.ts`) on PostgreSQL 18 (local, default settings): **600,000
transactions in the table**, 200,000 of them belonging to one heavy user (≈ 2 years; a real user is typically 10–100× smaller)
and the rest spread over 20 other users. Times are `Execution Time` from `EXPLAIN (ANALYZE, BUFFERS)`, warm cache.

| Query | Plan | Time |
|---|---|---|
| Ledger page 1 | Index scan `(user_id, occurred_at DESC)`, stops after 51 rows | 0.7 ms |
| Ledger deep page – **old** `OR` cursor predicate | Same index, but the `OR` cannot be an index range → walks and filters | **105 ms** (305 ms cold) |
| Ledger deep page – **new** two-step cursor, query 1 (ties) | Index scan, 1 timestamp | 0.16 ms |
| Ledger deep page – **new** two-step cursor, query 2 (older) | Index range scan + limit | 0.14 ms |
| Ledger by category | Index scan, filter | 0.9 ms |
| Ledger search `ILIKE '%term%'` | Scans the user's rows | 106 ms |
| Dashboard summary (1 month) | Bitmap scan on `(user_id, occurred_at)` | 3.9 ms |
| Category breakdown (2 months) | Bitmap scan + hash aggregate | 14 ms |
| Monthly trends (12 months, ~100k rows) | Bitmap scan + aggregate (CPU-bound by `date_trunc … AT TIME ZONE`) | 141 ms |
| Recurring-charge input (≤ 5,000 recent expenses) | Index scan, backward | 7 ms |
| Import duplicate check by bank reference | Index-only scan on the unique index | 0.15 ms |
| Import duplicate check by fingerprint | Index-only scan on `(account_id, fingerprint)` | 0.12 ms |
| Account balances (all history) | Parallel seq scan + aggregate | 118 ms |

## Changes made because of these plans

1. **Keyset pagination rewritten.** `occurredAt < X OR (occurredAt = X AND id > Y)` is the textbook cursor predicate, but
   PostgreSQL cannot turn that `OR` into an index range, so cost grew with how deep the user paged. The service now runs two
   simple queries (rows that tie on the cursor timestamp, then strictly older rows) that each use the index directly:
   ~100× faster and independent of depth. Covered by the pagination tests (ties, search + cursor).
2. **Fingerprint index** is now `(account_id, fingerprint)` instead of `(fingerprint)`: the import look-up is always per account,
   and the composite index serves it as an index-only scan.

## Experiments we rejected

* **Covering index** `(user_id, occurred_at DESC) INCLUDE (type, amount, category_id, account_id)` enabled index-only scans:
  dashboard 3.9 → 1.2 ms, categories 14 → 8.7 ms, but trends unchanged (CPU-bound) and the all-history balance query got
  *slower* (118 → 240 ms). The absolute savings are a few milliseconds while the index is much larger and slows the bulk
  inserts of every import. Not worth it at this scale; revisit if dashboards become the bottleneck.

## Known scan-everything queries (accepted for now)

* **Trends over 12+ months** and **account balances over all history** touch every row in range. ~100–140 ms for a 200k-row user
  is acceptable; a typical user is two orders of magnitude smaller. If needed: a per-user monthly rollup table maintained in the
  import transaction, or `SELECT … GROUP BY` on a materialised view. Per the project rules there is **no caching until a measured
  need**; correctness (corrections visible immediately) wins.
* **Substring search** is a per-user scan. If search latency matters, add `CREATE EXTENSION pg_trgm` and a GIN index on
  `description` (needs the extension available on the managed database).

## Import throughput

Processing the 7-row sample statement took ~220 ms in the worker (from its own completion log line). Bulk work is chunked
(`createMany` 5,000 rows, `IN` lists ≤ 5,000) inside one transaction with a 120 s budget; the file cap (10 MB / 50,000 rows)
keeps that comfortably bounded.

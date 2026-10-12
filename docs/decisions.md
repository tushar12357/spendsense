# Architecture decision log

Newest decisions at the bottom of each topic. Format: **Decision** · alternatives · why.

## 1. Modular monolith, two processes
**Decision:** one codebase and database; the same image runs the API and the import worker. · *Alternatives:* microservices; in-process
queue. · *Why:* a single deployable keeps transactions and refactors simple; a separate worker process keeps long imports from
competing with API latency and lets it scale/restart independently.

## 2. Prisma as the only database layer, raw SQL where it earns its keep
**Decision:** Prisma Client for CRUD; parameterised `$queryRaw` for `FILTER` aggregates, `generate_series`/`LAG`, time-zone bucketing,
advisory locks and row locks. No `pg`, no second ORM. · *Why:* type-safe everyday access, PostgreSQL's strengths where Prisma cannot
express them; all raw queries are tagged templates and tested with exact values.

## 3. Money is exact: `NUMERIC(14,2)` + decimal.js + string transport
**Decision:** never a JS number. Requests must send amounts as strings. · *Why:* `0.1 + 0.2` and silent rounding are unacceptable in
a ledger; strings round-trip losslessly through JSON.

## 4. Amount is a positive magnitude; direction is the `type`
**Decision:** `CHECK amount > 0`; `INCOME`/`EXPENSE`/`REFUND`/`TRANSFER` decide the sign. · *Alternative:* signed amounts. · *Why:*
statements use debit/credit columns and several sign conventions; one canonical representation avoids sign bugs, and a
reclassification is a one-field change.

## 5. Atomic imports: one transaction per file
**Decision:** a file is persisted completely or not at all; bookkeeping states (`PARTIAL`, `FAILED`) live outside the transaction. ·
*Alternatives:* per-row commits (cheaper locks, but leaves half-imported files and complicated resume logic); chunked commits. · *Why:* retry
becomes "run it again", counters always match what is in the ledger, and the 50k-row cap keeps the transaction short.

## 6. Duplicate detection: bank reference first, fingerprint with occurrence ordinal second
**Decision:** reference identity is `<ref>:DR|CR`; a reference repeated within one file is distrusted; reference-less rows use
`sha256(account|local date|amount|normalised description|ordinal)`. · *Alternatives:* fingerprint only (drops real repeat purchases);
`UNIQUE` on the fingerprint (same, and unrecoverable). · *Why:* the spec's warning – identical purchases are legitimate. The ordinal keeps
them while still de-duplicating overlapping statements. Banks reuse references for reversals, hence the direction suffix.

## 7. Serialise imports per account with an advisory lock (not SERIALIZABLE)
**Decision:** `pg_advisory_xact_lock(hash(account_id))` at the start of the import transaction. · *Alternatives:* `SERIALIZABLE` isolation
(aborts and retries under contention); relying on the unique index alone (correct but turns races into rollbacks). · *Why:* a demonstrated
concurrency hazard (look-up then insert) solved with the narrowest lock; unrelated accounts do not block. The unique index stays as the backstop.

## 8. Revive failed batches instead of creating new ones
**Decision:** the unique `(user_id, file_hash)` stays; `FAILED`/`PARTIAL`/abandoned batches are revived by compare-and-set on re-upload. ·
*Alternative:* allow many batches per hash. · *Why:* keeps "same file twice" a single concept and a single audit trail, with the retry path
tested (including simultaneous retries).

## 9. BullMQ with an on-disk hand-off, introduced only after the sync path was solid
**Decision:** `IMPORT_ASYNC` flag; Redis carries only the batch id; the CSV waits in a private temp directory. · *Alternatives:* put the file
in Redis (financial data in a cache, memory pressure); store the file in PostgreSQL (retention of raw statements). · *Why:* minimal data at rest,
files deleted as soon as the batch is terminal. Trade-off: API and worker must share the directory (a volume in Docker); object storage is
the next step for multi-host deployments.

## 10. JWT bearer tokens (HS256, pinned), no refresh tokens yet
**Decision:** short, stateless auth for an API-first backend. · *Alternatives:* cookie sessions + CSRF; opaque server-side tokens. · *Why:*
simplest secure option for a not-yet-built frontend or mobile app. Known gap: no revocation before expiry (documented in security-and-privacy.md).

## 11. Database-enforced ownership with composite foreign keys
**Decision:** `transactions` and `import_batches` reference `accounts (id, user_id)`. · *Alternative:* Row-Level Security. · *Why:* closes the
"transaction points at someone else's account" hole for every code path, with no per-connection user context to get wrong. RLS remains a
possible later layer.

## 12. Reporting calendar = the user's IANA time zone, computed on demand
**Decision:** store UTC instants; derive month boundaries from `users.timezone` at query time; imported dates anchor to noon local. ·
*Alternative:* store a precomputed month column. · *Why:* a time-zone change or correction is reflected instantly, nothing can go stale.

## 13. No caching of analytics
**Decision:** every dashboard call reads the ledger. · *Why:* measured at 1–15 ms for single-month queries; the spec requires corrections to be
visible immediately and to cache only on measured need (see performance.md).

## 14. Substring merchant rules, not regexes
**Decision:** rules match case-insensitive substrings. · *Why:* user-supplied regexes are a ReDoS vector; substrings cover the real use cases
("swiggy", "netflix") and are trivial to explain.

## 15. Estimates are explicit
**Decision:** forecast, recurring candidates and safe-to-spend carry `isEstimate`, `confidence`, `assumptions`; safe-to-spend is `null` rather
than guessed when no balance can be established. · *Why:* the product's trust depends on never presenting a guess as a fact.

## 16. Keyset pagination implemented as two queries
**Decision:** see performance.md – the single `OR` predicate degraded with depth (105 ms vs 0.3 ms at 200k rows).

## 17. Tests hit a real PostgreSQL; failures are injected with database triggers
**Decision:** no database mocks. Failure/atomicity tests install a temporary `BEFORE INSERT` trigger that raises (or silently skips rows)
because a JS spy cannot reach the transaction-scoped Prisma client – and a real trigger is a more faithful fault. · *Why:* the guarantees under
test (rollback, constraints, locks, SQL results) only exist in the database.

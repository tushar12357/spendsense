# Milestones, verification and known limitations

Status against the seven milestones in `ARCHITECTURE.md`.

| # | Milestone | Status |
|---|---|---|
| 1 | Repository inspection and architecture | ✅ `docs/architecture.md`, `data-model.md`, `financial-rules.md`, `api.md`, `decisions.md` |
| 2 | Database foundation | ✅ Schema + 2 migrations (clean-database replay is part of every test run), idempotent seed, DB-level constraint tests, Docker Compose |
| 3 | Authentication and ledger | ✅ Auth, accounts, categories, merchant rules, transaction CRUD, filters, keyset pagination, cross-user tests |
| 4 | CSV import pipeline | ✅ Adapters (HDFC, generic) + auto-detect, row outcomes, duplicate detection, atomic/idempotent/retryable, status & row endpoints |
| 5 | Analytics, budgets, savings | ✅ Summary, categories + MoM, trends, budgets, goals, forecast, recurring candidates, safe-to-spend, query-plan analysis |
| 6 | Background jobs and hardening | ✅ BullMQ worker, retries/backoff, permanent-vs-retryable errors, recovery, correlation ids, graceful shutdown, concurrency tests, index review |
| 7 | Final review and handoff | ✅ Clean-DB migration run, full suite, OpenAPI at `/api/v1/openapi.json`, examples, this document |

## Verification performed

Environment used for this run: PostgreSQL 18 (embedded, throw-away), Redis 5.0.14 (Windows build), Node 24. The repository's Docker
setup targets PostgreSQL 16 and Redis 7; **the Docker image and `docker compose` services were not started in this run** (the Docker daemon was
not running) – `docker compose config` validates, the Dockerfile has not been built.

| Check | Result |
|---|---|
| `npm run typecheck` | clean |
| `npm run build` | clean; compiled `dist/server.js` and `dist/worker.js` started as separate processes |
| Migrations from an empty database | applied (global test setup does this on every run); `prisma migrate diff` between migrations and `schema.prisma` is empty |
| `npm test` (with `REDIS_TEST=1`) | **16 files, 230 tests, all passing** (unit 95, integration 135 incl. 4 against real Redis/BullMQ) |
| Coverage | statements 92.2 %, branches 82.4 %, functions 92.6 %, lines 94.5 % |
| Live smoke test (compiled API + worker, `NODE_ENV=production`, `IMPORT_ASYNC=true`) | register → account → upload `samples/hdfc-savings-statement.csv` → `202` → worker completed (6 accepted, 1 skipped) → dashboard `totalIncome 85156.75`, `savingsRate 62.72`; balance `103407.25` equals the statement's own closing balance; disallowed CORS origin received no allow header; logs contained no narrations, amounts, tokens or passwords |
| Query plans | `npm run db:explain` on 600k rows – see `performance.md` |

Bugs found and fixed *by this verification* (each now has a regression test): CSV headers were taken from the first data row; unknown
`/api/v1/*` routes returned 401 instead of 404; search lost its filter when combined with a cursor; `%`/`_` in a search matched everything;
retry compare-and-set compared timestamps at the wrong precision; a Postgres error inside the old row-by-row import transaction would have
aborted the whole transaction; deep pagination degraded ~100×.

## Test inventory

| Area | Where | Highlights |
|---|---|---|
| Parsing & adapters | `tests/unit/parsing`, `adapters`, `csv` | Indian digit grouping, accounting negatives, impossible dates, BOM / Windows-1252, reversal sharing a reference, credit-card payment → transfer |
| Financial rules | `tests/unit/finance`, `date`, `fingerprint` | Savings rate with zero/negative income, forecast blending, recurring detection, safe-to-spend without a balance, DST month boundaries |
| Constraints | `integration/db-constraints` | Composite-FK ownership, CHECKs, partial unique index, unique references |
| Isolation | `integration/isolation` | Every resource family, read and write, as a second user |
| Ledger | `integration/transactions` | Tie-break ordering, paging without gaps, search+cursor, wildcard escaping, corrections |
| Imports | `integration/imports` | Repeat upload, overlapping statements, identical rows kept, reversal vs payment, row errors, injected DB faults with rollback and retry, 3 concurrent identical uploads, 3 concurrent overlapping files |
| Worker | `integration/worker`, `queue` | Re-delivery, simultaneous delivery, transient vs final failure, permanent error, missing file; real Redis end to end |
| Analytics | `integration/analytics` | Hand-computed month figures, reconciliation with the ledger, time-zone boundaries, MoM, trends gap-fill, budgets, goals, forecast/recurring/safe-to-spend |
| Account lifecycle | `integration/resources` | Balances, category/account deletion rules, rules applied only to unreviewed rows, export, account deletion |

## Known limitations and next steps

**Product**
* Single currency (INR); multi-currency needs per-currency totals or conversion.
* CSV only. PDF statements, bank APIs and SMS parsing are out of scope by design; add an adapter per format.
* Transfers are not auto-paired and carry no direction, so balances exclude them (flagged as an estimate). Next: store direction +
  `transfer_peer_id` pairing on import.
* Recurring candidates cannot yet be confirmed or dismissed; confirmed obligations would make safe-to-spend more precise.
* Goals' `currentAmount` is manual; linking a goal to an account or category is a possible next step.
* Budgets match the exact category (no sub-category roll-up).

**Platform**
* JWTs cannot be revoked before expiry (no refresh tokens, no token version); no email verification or password reset; no MFA.
* The upload hand-off uses a shared directory; multi-host deployments should move to object storage.
* Trends and all-history balances scan every row of the user (≈ 100–140 ms at 200k rows). A monthly rollup is the planned fix if needed.
* Substring search is a scan; add `pg_trgm` + GIN if it matters.
* Export loads the user's data into memory; stream it for very large accounts.
* The Dockerfile and compose `app` profile are untested here (see above); the CI workflow has not run on GitHub yet.
* Production readiness items outside this repo: managed PostgreSQL backups, TLS termination, secret management, log shipping, alerting on
  `FAILED` import batches and queue depth.

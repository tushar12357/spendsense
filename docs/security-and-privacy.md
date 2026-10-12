# Security and privacy

Financial data is sensitive. This page lists what is protected, how, and what is kept.

## Controls

| Area | Control |
|---|---|
| Passwords | bcrypt (cost `BCRYPT_ROUNDS`, default 12); min 10 chars with letters + digits; login compares against a dummy hash for unknown emails so timing and messages do not reveal which accounts exist |
| Tokens | JWT HS256 **pinned** (the token header cannot choose the algorithm), issuer + audience + expiry verified, `sub` must be a UUID. Secret ≥ 32 chars, from the environment only |
| Authorization | Every service query includes `userId`. Foreign ids return `404`. The database additionally enforces ownership with composite foreign keys (`transactions`/`import_batches` → `accounts (id, user_id)`). Cross-user tests cover accounts, transactions, imports, categories, budgets, goals, rules, analytics, export |
| Input | Zod on every body/query/param; money as strings; UUID-checked ids; cursors validated; JSON body ≤ 1 MB |
| SQL | Prisma Client, or tagged-template raw SQL (bind parameters). LIKE wildcards in user search terms are escaped. Merchant rules are substring matches, **not regexes** (no ReDoS) |
| Uploads | Size limit, `.csv` only, binary rejected, ≤ 50k rows; client file name is sanitised and never used as a path; temp files are named by batch UUID with mode 0600 outside any served directory, deleted when the batch is terminal, swept after 24 h |
| Transport | `helmet` headers, CORS allow-list (`ALLOWED_ORIGINS`, required in production), compression; run behind TLS (`Strict-Transport-Security` is sent) |
| Abuse | Per-IP global limit, stricter auth limit, per-user upload limit |
| Errors | One envelope; raw Prisma/SQL/driver messages never reach clients; import failure metadata is sanitised |
| Logging | Structured JSON. Redacts authorization, cookies, passwords, tokens, descriptions, raw/normalised row data. Request logs carry method + path only (no query string, no body). Import logs carry ids, counts and durations only. Prisma logs slow-query text but never bound parameters |
| Secrets | `.env` is git-ignored; `.env.example` has placeholders only; the app refuses to start with a missing/short `JWT_SECRET` |

## What is stored, and for how long

| Data | Purpose | Retention |
|---|---|---|
| Account, profile, password hash | Authentication, time zone for reports | Until the user deletes the account |
| Transactions, categories, rules, budgets, goals | The product itself | Until deleted by the user or with the account |
| Import batch metadata (file name, hash, counts, status) | Idempotency and reconciliation | Until the account is deleted |
| Import rows: normalised values (date, amount, type, narration, reference) | Explain every row's outcome | Until the account is deleted |
| Import rows: **raw CSV cells** | Only for `REJECTED` rows so the user can fix them; accepted/duplicate/skipped rows store `{}` | Until the account is deleted |
| Uploaded file bytes | Not stored. In sync mode they live in memory only; in async mode they sit in the temp dir until the batch finishes (≤ 24 h worst case) | Minutes |
| Redis | Job id + batch id only (no financial data); completed jobs expire after 1 h, failed after 7 d | ≤ 7 days |
| Logs | Operational metadata only (see above) | Per your log platform |

## Portability and deletion

* `GET /users/me/export` returns all of the user's data as JSON (including import rows and raw rejected-row cells).
* `DELETE /users/me` (password re-confirmed) removes the user and every owned row in one transaction; tested to leave other
  users and the shared system categories untouched. Backups follow your database provider's retention.

## Not covered yet

Token revocation before expiry (changing a password does not invalidate existing JWTs – shorten `JWT_EXPIRES_IN` or add a
token-version claim), refresh tokens, MFA, email verification / password reset, column-level encryption of statement data,
Row-Level Security (considered as defence in depth; deferred because every pooled connection would need a reliably set user
context), and a malware scan of uploads (files are parsed as text only, never executed or stored).

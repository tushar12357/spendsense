# API reference

Base URL `/api/v1`. JSON in, JSON out (imports are `multipart/form-data`). The machine-readable contract, generated from the
same Zod schemas the handlers validate with, is served at **`GET /api/v1/openapi.json`**.

## Conventions

| | |
|---|---|
| **Auth** | `Authorization: Bearer <jwt>` on everything except `register`, `login` and `/health*`. HS256, issuer `spendsense`, audience `spendsense-api`, 7-day default expiry. |
| **Money** | Decimal **strings** with two decimals: `"1250.50"`. Requests must send strings (`"amount": "1250.5"`), not numbers. |
| **Dates** | ISO-8601 with offset in requests (`2026-10-02T10:00:00+05:30`); UTC in responses. Calendar months follow the user's time zone. |
| **IDs** | UUIDs. Malformed ids are `400`, unknown *or other users'* ids are `404` (existence is never leaked). |
| **Correlation** | Send `X-Request-ID` (8–64 chars `[A-Za-z0-9._-]`) or one is generated; it is returned in the header and in every error body. |

### Error envelope

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Request validation failed",
    "details": [{ "field": "amount", "message": "Must be a decimal amount with at most 2 decimal places" }],
    "requestId": "8e7c35fb-1c9d-4a6f-b1c8-fd7e5e33a8af"
  }
}
```

| Status | `code` | When |
|---|---|---|
| 400 | `VALIDATION_ERROR` | Bad body/query/params/cursor, malformed JSON, unusable CSV |
| 401 | `AUTHENTICATION_REQUIRED` · `INVALID_CREDENTIALS` | Missing/invalid/expired token · wrong email or password (identical for both) |
| 404 | `NOT_FOUND` | Unknown route or resource (also another user's resource) |
| 409 | `CONFLICT` · `DUPLICATE_IMPORT` · `IMPORT_IN_PROGRESS` | Unique violation / dependent records · file already imported · file being processed |
| 413 | `FILE_TOO_LARGE` | Upload above `MAX_FILE_SIZE_MB` |
| 415 | `UNSUPPORTED_FILE` | Not a `.csv` / binary content |
| 422 | `IMPORT_PROCESSING_ERROR` | Permanent import failure (sync mode) |
| 429 | `RATE_LIMITED` | See below |
| 500 | `INTERNAL_ERROR` · `IMPORT_PROCESSING_ERROR` | Unexpected; import failures are rolled back, nothing saved |
| 503 | `SERVICE_UNAVAILABLE` | Import queue unavailable |

**Rate limits**: 300 requests / 15 min / IP across `/api`; 20 / 15 min / IP on register, login, change-password; 60 uploads / hour / user.
Responses carry `RateLimit-*` headers.

### Pagination

Lists that can grow use **keyset (cursor) pagination**: `?limit=50&cursor=<opaque>`.

```json
{ "data": [ … ], "pagination": { "hasMore": true, "nextCursor": "eyJpZCI6…", "count": 50 } }
```

Order is deterministic (`occurredAt DESC, id ASC` for the ledger; `rowNumber` for import rows). Pass `nextCursor` back as `cursor`
until `hasMore` is `false`. Cursors are validated; a tampered one is `400`. Inserts between pages never cause repeats or gaps.

## Endpoints

### Auth and profile
| | |
|---|---|
| `POST /auth/register` | `{ email, password (≥10, letters+digits), displayName, timezone? }` → `201 { user, token }` |
| `POST /auth/login` | `{ email, password }` → `{ user, token }` |
| `GET /auth/me` · `GET /users/me` | Profile |
| `PATCH /users/me` | `{ displayName?, timezone? }` (IANA zone, validated) |
| `POST /auth/change-password` | `{ currentPassword, newPassword }` → `204` |
| `GET /users/me/export` | Everything the user owns as a JSON download |
| `DELETE /users/me` | `{ password }` → `204`; permanently deletes the account and all data |

### Accounts · categories · merchant rules
| | |
|---|---|
| `GET/POST /accounts`, `GET/PATCH/DELETE /accounts/:id` | `{ name, type: SAVINGS\|CURRENT\|CREDIT_CARD\|WALLET\|CASH, openingBalance? }`; responses include `currentBalance` and `balanceIsEstimate`. Delete is `409` once an account has history – set `isActive:false` |
| `GET /categories`, `POST`, `PATCH/DELETE /categories/:id` | System + own categories; system ones are immutable. Delete keeps transactions (uncategorised) |
| `GET/POST /merchant-rules`, `PATCH/DELETE /merchant-rules/:id` | `{ pattern (substring, case-insensitive), categoryId, normalizedName?, priority? }` |
| `POST /merchant-rules/:id/apply` | Re-applies to **unreviewed** transactions → `{ updated }` |

### Transactions (ledger)
| | |
|---|---|
| `GET /transactions` | Filters: `from`, `to` (half-open), `type`, `categoryId`, `accountId`, `q` (description/merchant), `uncategorized=true`, `limit`, `cursor` |
| `POST /transactions` | Manual entry `{ accountId, type, amount, description, categoryId?, occurredAt?, merchantName?, notes? }` |
| `GET /transactions/:id` | |
| `PATCH /transactions/:id` | Corrections only: `{ categoryId?, merchantName?, notes?, type?, isReviewed? }` |
| `DELETE /transactions/:id` | `204`; import history is preserved |

### Imports
| | |
|---|---|
| `GET /imports/adapters` | Supported formats and their expected columns |
| `POST /imports` | `multipart/form-data`: `file` (`.csv`), `accountId`, `adapterKey?` (omit to auto-detect) |
| `GET /imports` | History, newest first (cursor-paginated) |
| `GET /imports/:id` | Status + counters + `isFinished` |
| `GET /imports/:id/rows?status=&limit=&cursor=` | Per-row outcome, reason, normalised values; `rawData` only for `REJECTED` rows |

**Formats.** `hdfc-csv`: `Date, Narration, Chq./Ref.No., Value Dt, Withdrawal Amt., Deposit Amt., Closing Balance`
(dates `DD/MM/YY[YY]`, Indian digit grouping). `generic-csv`: `Date`, `Description`, `Debit`+`Credit` *or* a signed `Amount`, optional
`Reference`. Max size `MAX_FILE_SIZE_MB` (10 MB), max 50,000 rows. UTF-8 (BOM ok) or Windows-1252. Row numbers count data rows (the header is not row 0).

**Status lifecycle**

```
PENDING ──▶ PROCESSING ──▶ COMPLETED            (terminal; every row has an outcome)
   ▲            │
   │            ├──▶ PARTIAL ──▶ (retry) ──▶ PROCESSING …     attempt failed, rolled back, will retry
   │            └──▶ FAILED                                    gave up / permanent error (terminal)
   └──── re-upload of the same file revives a FAILED/PARTIAL (or abandoned) batch
```

**Sync mode (default)** – `201` with the final summary:

```json
{ "batchId": "…", "status": "COMPLETED", "totalRows": 7, "acceptedRows": 6, "duplicateRows": 0,
  "rejectedRows": 0, "skippedRows": 1, "warningCount": 0, "errors": [], "errorsTruncated": false }
```

`errors` lists up to 100 `{ rowNumber, status: "DUPLICATE" | "REJECTED", reason }`; fetch `/rows` for the rest.

**Async mode (`IMPORT_ASYNC=true`)** – `202 Accepted`, `Location: /api/v1/imports/<id>`, body is the batch
(`status: "PENDING"`, `isFinished: false`). **Poll `GET /imports/:id` until `isFinished` is `true`** (`COMPLETED` or `FAILED`);
then read the counters or `errorMeta`.

**Retry behaviour.** Failed imports are all-or-nothing, so retrying is just uploading the same file again: the batch is revived and
processed again. A `COMPLETED` file re-upload is `409 DUPLICATE_IMPORT`. Overlapping statements are fine: rows already in the
ledger come back as `DUPLICATE`, new rows import.

### Analytics, budgets, goals
| | |
|---|---|
| `GET /dashboard/summary?year=&month=` | Income, expenses, refunds, net expenses, net cash flow, savings rate, counts. Defaults to the current month |
| `GET /analytics/categories?year=&month=` | Net spend per category + share + previous month + change |
| `GET /analytics/trends?months=12` | Gap-free monthly series (1–36) with income, net expenses, cash flow, savings rate, MoM change |
| `GET /insights` | `monthOverMonth`, `forecast`, `safeToSpend`, `recurringCandidates`, `budgetAlerts`, `savingsGoals` – estimates are flagged `isEstimate` |
| `GET /budgets?year=&month=` | Budgets with `spent`, `remaining`, `utilizationPct`, `status` (`ok`/`warning`/`exceeded`) + totals |
| `PUT /budgets/:categoryId` | `{ amount, year?, month? }` upsert |
| `DELETE /budgets/:categoryId?year=&month=` | |
| `GET/POST /savings-goals`, `PATCH/DELETE /savings-goals/:id` | `{ name, targetAmount, currentAmount?, targetDate? (YYYY-MM-DD), status? }`; responses add `remaining`, `progressPct`, `requiredMonthlySaving`, `monthsLeft`, `isOverdue` |

### Operations
`GET /health` (liveness) · `GET /health/ready` (`200`/`503` with per-dependency `checks`) · `GET /api/v1/openapi.json`

## Examples

Dashboard (from a real run against `samples/hdfc-savings-statement.csv`):

```json
{
  "period": { "year": 2026, "month": 10, "label": "2026-10", "timezone": "Asia/Kolkata" },
  "currency": "INR",
  "totalIncome": "85156.75", "totalExpenses": "31749.50", "totalRefunds": "0.00",
  "netExpenses": "31749.50", "netCashFlow": "53407.25", "savingsRate": "62.72",
  "transactionCount": 6, "transferCount": 0, "uncategorizedCount": 6
}
```

Safe-to-spend (inside `GET /insights`):

```json
{
  "isEstimate": true,
  "amount": "28404.00",
  "dailyAllowance": "1420.20",
  "shortfall": false,
  "breakdown": { "availableBalance": "33053.00", "upcomingObligations": "649.00", "remainingSavingsCommitment": "4000.00" },
  "upcomingObligations": [{ "label": "NETFLIX.COM 4455", "amount": "649.00", "dueDate": "2026-10-20" }],
  "assumptions": ["Account balances are derived from each account's opening balance plus its ledger …", "…"]
}
```

Repeat upload:

```http
POST /api/v1/imports            (same file again)
409 { "error": { "code": "DUPLICATE_IMPORT", "message": "This file has already been imported",
                 "details": [{ "field": "file", "message": "Existing import batch: 55de7aa1-…" }], "requestId": "…" } }
```

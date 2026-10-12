# Antigravity Project Prompt: SpendSense — Backend-First Expense Tracker

## 1. Your Role

Act as a senior backend engineer, PostgreSQL database architect, and pragmatic technical lead.

Build **SpendSense**, a production-minded personal expense tracker for young working professionals in India who want to understand their salary, expenses, recurring bills, budgets, and savings.

This is a real consumer product, not a tutorial CRUD application. Prioritize:

- Financial data correctness.
- Reliable transaction imports.
- Strong PostgreSQL fundamentals.
- Maintainable backend architecture.
- Secure user data isolation.
- Automated testing and failure recovery.
- Useful financial analytics.

### Development strategy: Backend first

Do not begin building the frontend.

First design and implement the database schema, transaction ledger, import pipeline, API contracts, analytics, and tests. Complete the backend in verifiable milestones before proposing frontend implementation.

Work incrementally. Inspect the existing repository before making changes, preserve useful existing work, and never claim something works without testing it.

---

## 2. Product Overview

The target audience is young working professionals in India who:

- Receive a monthly salary.
- Make frequent UPI, card, and cash payments.
- Pay recurring bills and subscriptions.
- Want to understand where their money goes.
- Want to save consistently without maintaining spreadsheets.
- Prefer importing transaction records rather than manually entering every expense.

### Core product promise

Help users understand:

1. Where their money goes.
2. How their spending changes over time.
3. How much they can reasonably spend after planned obligations.
4. Whether they are progressing toward their savings goals.

### MVP features

1. Bank-statement CSV imports.
2. Transaction normalization, validation, and duplicate detection.
3. A searchable transaction ledger.
4. Income, expense, transfer, and refund transaction types.
5. Categories and merchant normalization.
6. Monthly income, expense, and savings summaries.
7. Category-level spending analytics.
8. Monthly budgets and savings goals.
9. An explainable safe-to-spend estimate.
10. Basic recurring-expense detection.
11. Month-over-month comparisons.
12. Secure authentication and user-scoped data access.

Do not implement direct bank integrations, automatic SMS scraping, payment execution, investment management, shared household wallets, or AI chat in the initial MVP.

CSV imports are the first transaction source. Design an adapter-based ingestion architecture so additional sources can be introduced later without rewriting the transaction ledger.

---

## 3. Required Technology Stack

Use the following stack unless the existing repository requires a justified adjustment.

### Backend

- Runtime: Node.js.
- Language: TypeScript with strict type checking.
- HTTP framework: Express.
- API style: Versioned REST API.
- Validation: Zod.
- API documentation: OpenAPI.

### Database

- Database: PostgreSQL.
- ORM: Prisma ORM.
- Database client: Prisma Client.
- Schema migrations: Prisma Migrate.
- Complex analytics: Parameterized raw SQL through Prisma when appropriate.

**Prisma is the primary database access layer.** Do not use `pg` directly as a separate application-level database layer, and do not introduce a second ORM.

Use Prisma Client for standard CRUD and relational queries. Use raw SQL selectively for advanced aggregations, CTEs, window functions, and queries where PostgreSQL-specific capabilities improve clarity or performance.

### Background processing

- Redis.
- BullMQ.

Begin with a simple, bounded synchronous import implementation. Introduce background processing only after the basic import workflow is reliable and tested.

### Testing

- Vitest.
- Supertest.
- A dedicated PostgreSQL test database.
- Redis test configuration where required.

### Development and deployment

- Docker Compose for local PostgreSQL and Redis.
- Environment variables for configuration.
- A `.env.example` file containing placeholders only.
- Structured application logging.
- Automated tests and reproducible setup instructions.

Use compatible, stable dependency versions. Avoid unnecessary packages.

---

## 4. Architecture Principles

Use a **modular monolith**, not microservices.

Separate code by business domain and keep HTTP controllers thin.

Suggested structure:

```text
src/
  app.ts
  server.ts

  config/
    env.ts

  middleware/
    authenticate.ts
    authorize.ts
    error-handler.ts
    request-id.ts

  modules/
    auth/
    users/
    accounts/
    categories/
    transactions/
    imports/
    analytics/
    budgets/
    savings-goals/
    insights/

  infrastructure/
    database/
      prisma.ts
    queue/
    logging/

  shared/
    errors/
    types/
    validation/
    utils/

prisma/
  schema.prisma
  migrations/
  seed.ts

tests/
  unit/
  integration/

docs/
  architecture.md
  data-model.md
  financial-rules.md
  api.md
  decisions.md

.env.example
docker-compose.yml
README.md
```

Adapt the structure if needed, but maintain clear boundaries between routing, validation, business logic, database access, and infrastructure.

Avoid generic repository frameworks and unnecessary abstraction layers. Create repositories or service interfaces when they meaningfully improve testability or domain separation.

---

## 5. PostgreSQL and Prisma Data Model

Design the database before implementing business endpoints.

Create an ER diagram and document the purpose of every table, relationship, important constraint, and index.

### Required entities

At minimum, consider:

- `User`
- `Account`
- `Category`
- `Transaction`
- `ImportBatch`
- `ImportRow`
- `MerchantRule`
- `Budget`
- `SavingsGoal`

Add further entities only when justified by a concrete requirement.

### Schema requirements

1. Use UUID primary keys.
2. Use proper foreign keys and referential actions.
3. Use unique and check constraints where applicable.
4. Use exact monetary storage, such as `Decimal @db.Decimal(14, 2)`. Never use JavaScript floating-point arithmetic as the source of truth for money.
5. Store currency explicitly, defaulting to INR for the initial Indian-market MVP.
6. Store transaction occurrence time separately from creation and update timestamps.
7. Use timezone-aware database timestamps where appropriate.
8. Represent transaction types explicitly: `INCOME`, `EXPENSE`, `TRANSFER`, and `REFUND`.
9. Represent import processing status separately from transaction type.
10. Store the source transaction ID when available.
11. Preserve import batch history and enough row-level information to explain accepted, duplicate, skipped, and rejected rows.
12. Enforce ownership relationships so a user's transaction cannot reference another user's account or category.
13. Add indexes based on expected queries, especially user-scoped date filtering and category analytics.
14. Use Prisma Migrate to manage schema changes.
15. Never edit an already-applied migration in a way that causes deployed environments to diverge. Create a new migration for subsequent changes.

### Prisma-specific requirements

- Keep `schema.prisma` as the ORM schema source of truth.
- Generate Prisma Client after relevant schema changes.
- Use Prisma's `Decimal` type for monetary values and serialize amounts consistently in API responses.
- Use Prisma transactions for operations that must succeed or fail together.
- Use explicit isolation or locking strategies when required by a demonstrated concurrency problem.
- Use `select` and `include` intentionally; avoid unnecessarily loading large related records.
- Do not expose raw Prisma error messages to API clients.
- Translate expected database errors into consistent application errors.
- Use Prisma's generated types wherever appropriate instead of duplicating database types manually.

### Raw SQL policy

Use Prisma Client for normal CRUD and relational queries.

Use parameterized `$queryRaw` or `$executeRaw` when raw SQL is justified by:

- Complex analytics.
- CTEs and window functions.
- Advanced aggregation.
- PostgreSQL-specific operations that are awkward or inefficient through Prisma Client.

Never construct SQL by concatenating user-provided strings. Use safe tagged-template parameterization or another verified parameterized approach.

Document complex raw queries and include tests that verify their results.

### Duplicate detection

Do not assume a fingerprint alone proves that two transactions are duplicates. Two legitimate purchases can share the same amount, date, and description.

Use source transaction IDs when available. Otherwise, use normalized fingerprints, source/account context, and conservative duplicate-review behavior.

Define the uniqueness rules explicitly before adding constraints that could reject legitimate transactions.

### Financial domain rules

Document how the system handles:

- Transfers between accounts.
- Refunds.
- Reversals.
- Debit and credit columns.
- Negative amounts in source statements.
- Duplicate transactions.
- Time zones and monthly boundaries.
- User corrections after importing a statement.

The schema must support consistent financial reporting without treating transfers as new income or expenses.

---

## 6. Transaction Import Pipeline — Highest Priority

The import pipeline is the most important backend feature.

Implement one well-tested CSV format first. Design the ingestion system so additional bank-specific formats can be added through separate adapters.

### Required import flow

1. Accept a CSV upload.
2. Validate file type, size, encoding, and required columns.
3. Compute a file hash and register an import batch.
4. Parse source-specific columns.
5. Normalize dates, amounts, descriptions, and transaction types.
6. Validate each row independently.
7. Detect duplicates conservatively.
8. Persist accepted transactions safely.
9. Record row-level processing outcomes.
10. Update the batch status and counts.
11. Return an understandable import summary.

### Import result fields

Include:

- Import batch ID.
- Total row count.
- Accepted row count.
- Duplicate row count.
- Rejected row count.
- Warning count.
- Current processing status.
- Error details and affected row numbers, where appropriate.

### Import data model

`ImportBatch` should record:

- User and account.
- File hash or source identifier.
- Processing status.
- Row counts.
- Created and updated timestamps.
- Relevant processing error metadata.

`ImportRow` should record:

- Batch ID.
- Source row number.
- Raw or safely retained source data.
- Normalized row data.
- Processing status.
- Error or warning reason.
- Linked transaction ID when accepted.

Treat imported statement data as sensitive. Avoid unnecessary raw-data retention, and never log complete financial statements.

### Reliability requirements

The import implementation must handle:

- Repeated upload of the same file.
- Concurrent imports.
- Worker or process failures.
- Retry after a partial failure.
- Invalid rows within an otherwise valid file.
- Malformed CSV content.
- Empty values and invalid dates.
- Different debit/credit conventions.
- Amount precision and currency handling.
- Duplicate detection without incorrectly rejecting legitimate purchases.

Define the import atomicity model explicitly.

For small synchronous imports, use a bounded and documented transaction strategy. For asynchronous imports, use recoverable batch states and appropriately scoped database transactions.

Ensure import counts reflect persisted outcomes. Never report success if the underlying transaction writes failed.

### Idempotency

Idempotency is mandatory.

Reprocessing the same import must not silently create duplicate financial activity.

Use appropriate database constraints and conflict-handling logic to make retries safe. Do not rely exclusively on an in-memory check before insertion.

A file hash can identify repeated file uploads, but it is not sufficient to identify duplicate transactions across different files. Handle these cases separately.

---

## 7. Transaction Ledger APIs

Build a canonical transaction ledger.

Required endpoints:

```text
GET     /api/v1/transactions
GET     /api/v1/transactions/:id
PATCH   /api/v1/transactions/:id
DELETE  /api/v1/transactions/:id
```

Support:

- Cursor pagination.
- Deterministic ordering.
- Date-range filters.
- Category filters.
- Transaction type filters.
- Account filters.
- Merchant and description search.
- User-scoped access control.

Allow users to correct a transaction's category and merchant description. Ensure that subsequent analytics reflect the correction immediately or according to a clearly documented caching policy.

If deletion is supported, define its effect on linked import records and audit history. Avoid deleting information in a way that makes import reconciliation impossible.

---

## 8. Import APIs

Implement:

```text
POST /api/v1/imports
GET  /api/v1/imports
GET  /api/v1/imports/:id
GET  /api/v1/imports/:id/rows
```

Document:

- Multipart upload requirements.
- Supported CSV format.
- Maximum file size.
- Status transitions.
- Error response format.
- Retry behavior.
- How duplicates are handled.
- How the client determines whether processing has finished.

For synchronous processing, return the final result directly.

After introducing BullMQ, return an import batch ID and let the frontend poll the status endpoint.

Use consistent error response structures across the API.

---

## 9. Authentication and Authorization

Implement secure authentication appropriate for a consumer application with multiple users and private financial data.

Requirements:

- Secure password hashing using an appropriate algorithm.
- Validated login and registration inputs.
- Secure session or token handling.
- Authentication middleware.
- User-scoped authorization on every protected resource.
- Rate limiting on sensitive endpoints.
- Consistent authorization failures.
- No hardcoded secrets or credentials.

If using JWTs, validate their signatures, issuer, audience, and expiration where applicable. If using cookie-based sessions, configure secure cookie attributes and CSRF protection where appropriate.

Do not implement custom cryptographic algorithms.

Add integration tests that attempt to access another user's transactions, accounts, import batches, budgets, and savings goals.

Consider PostgreSQL Row-Level Security as defense in depth only if user context can be reliably and safely established for every database transaction.

---

## 10. Analytics and Financial Calculations

Use PostgreSQL for core aggregations rather than loading the entire ledger into JavaScript.

Implement:

```text
GET /api/v1/dashboard/summary
GET /api/v1/analytics/categories
GET /api/v1/analytics/trends
GET /api/v1/insights
```

Also implement the required budget and savings-goal endpoints.

### Required metrics

- Monthly income.
- Monthly expenses.
- Net cash flow.
- Savings rate.
- Category-wise spending.
- Month-over-month changes.
- Budget utilization.
- Basic month-end expense forecast.
- Candidate recurring expenses.
- Explainable safe-to-spend estimate.

### Financial correctness rules

Define these centrally and test them:

- Transfers do not inflate income or expenses.
- Refunds follow a consistent, documented reporting policy.
- Dashboard totals reconcile with ledger records.
- Monthly calculations respect the user's reporting time zone.
- All monetary arithmetic uses exact decimal handling.
- Categories and corrected transactions affect future calculations consistently.
- Estimates are clearly distinguished from confirmed financial facts.

Use SQL aggregations, CTEs, date functions, and window functions where they improve clarity.

### Savings rate

Define the savings-rate calculation explicitly.

A possible MVP definition is:

Savings rate = (eligible income − eligible expenses) / eligible income × 100

Handle zero income safely. Define whether refunds reduce expenses and exclude transfers from both sides of the calculation.

### Safe-to-spend

Do not invent a balance if the imported data cannot establish one.

Use a user-confirmed starting balance or another explicitly documented source. Then account for:

- Available balance.
- Upcoming obligations.
- Remaining savings commitment.
- Other planned expenses.

Avoid subtracting transactions twice when they are already reflected in the starting balance.

Label the result as an estimate if account balance or upcoming obligations are incomplete.

### Recurring-expense detection

Use deterministic rules initially.

Look for similar merchant descriptions, amounts, and approximate weekly or monthly intervals.

Generate candidate recurring expenses for user confirmation rather than silently treating every repeated purchase as a subscription.

### Month-end forecast

Start with a basic projection based on observed spending and elapsed days. Improve it using historical patterns when enough data exists.

Clearly communicate that early estimates have low confidence and that spending is not necessarily uniform throughout the month.

---

## 11. Budgets and Savings Goals

Implement:

```text
GET   /api/v1/budgets
PUT   /api/v1/budgets/:categoryId

GET   /api/v1/savings-goals
POST  /api/v1/savings-goals
PATCH /api/v1/savings-goals/:id
```

Budgets should support:

- User ownership.
- Category association.
- Monthly period.
- Budget amount.
- Current utilization derived from the transaction ledger.

Savings goals should support:

- Goal name.
- Target amount.
- Target date.
- Current progress.
- Status.

Avoid creating a separate editable total for spending when it can be derived from transactions.

If a manually maintained balance is introduced, define how it is reconciled with imported transactions.

---

## 12. Redis and BullMQ Background Processing

Do not introduce a queue before the basic import implementation works.

Once the synchronous pipeline and tests are reliable, move longer-running imports into BullMQ.

Requirements:

- Redis-backed job queue.
- Bounded retry policies.
- Exponential backoff where appropriate.
- Import progress and status tracking.
- Safe handling of repeated job execution.
- Job correlation IDs.
- Failure logging without exposing financial details.
- Recovery behavior for jobs that fail after partial progress.
- Clear distinction between retryable and permanent errors.
- Graceful worker shutdown.

Remember that a queue does not guarantee exactly-once execution.

Design jobs so repeated execution is safe through database constraints, idempotent operations, and explicit batch states.

Do not build distributed services or add unnecessary queue types.

---

## 13. Security and Privacy

Treat financial data as sensitive.

Implement:

- User-scoped data access.
- Input validation.
- Parameterized SQL.
- File upload size and type limits.
- Secure secret management.
- Appropriate CORS and HTTP security headers.
- Rate limiting.
- Safe error handling.
- No raw statements or credentials in logs.
- A data export and account-deletion strategy.
- Tests for cross-user access attempts.

Keep uploaded files outside publicly served directories. If temporary files are used, clean them up reliably.

Document what data is retained, for how long, and why.

Do not log passwords, access tokens, complete transaction descriptions, or full statement contents.

---

## 14. Testing Requirements

A running server does not mean the backend is complete.

Use Vitest and Supertest with a dedicated test database and reproducible setup.

### Unit tests

Test:

- CSV parsing.
- Date and amount normalization.
- Transaction classification.
- Duplicate fingerprint generation.
- Financial calculation rules.
- Safe-to-spend calculations.
- Recurring-expense detection.
- Request validation.

### Integration tests

Test:

- Database constraints.
- User-scoped authorization.
- Transaction CRUD.
- Import batch creation.
- Repeated imports.
- Concurrent imports.
- Import failure and retry behavior.
- Category corrections.
- Budget utilization.
- Monthly aggregates.
- Refund and transfer handling.
- Time-zone and month-boundary behavior.
- Pagination and filters.
- Invalid payloads and authentication failures.

Use small test fixtures with known expected totals.

For analytics, verify the exact expected values against the seeded ledger rather than merely checking that a response contains a number.

Test the actual PostgreSQL behavior, including relevant constraints and SQL queries. Do not replace all database integration tests with mocks.

---

## 15. Performance and Observability

Add practical observability without overengineering.

Requirements:

- Structured application logs.
- Request IDs and import/job correlation IDs.
- Consistent API error responses.
- Import-processing duration and failure counts.
- Database query duration logging where useful.
- Health and readiness endpoints.
- Graceful shutdown.
- Query-plan analysis for important dashboard queries.

Use `EXPLAIN ANALYZE` against representative PostgreSQL queries.

Add indexes based on actual query patterns and query plans. Avoid indexing every column speculatively.

Do not cache financial analytics until there is a measured need. If caching is introduced later, define invalidation behavior after transaction changes or imports.

---

## 16. Documentation Requirements

Maintain these files:

### `README.md`

Include:

- Project overview.
- Prerequisites.
- Environment setup.
- Docker commands.
- Prisma migration commands.
- Seed commands.
- Development and test commands.
- API documentation location.
- Known limitations.

### `docs/architecture.md`

Include:

- Component architecture.
- Request flow.
- Import processing flow.
- Background job design.
- Important reliability decisions.

### `docs/data-model.md`

Include:

- ER diagram.
- Table descriptions.
- Relationships.
- Constraints and indexes.
- Prisma-specific modeling decisions.

### `docs/financial-rules.md`

Document:

- Income and expense definitions.
- Transfers and refunds.
- Decimal arithmetic.
- Time-zone behavior.
- Savings-rate calculations.
- Safe-to-spend assumptions.
- Duplicate handling.

### `docs/api.md`

Document endpoints, authentication requirements, request schemas, response schemas, pagination, status codes, and error formats.

### `docs/decisions.md`

Maintain a concise architecture decision log containing significant decisions, alternatives considered, and reasons for the selected approach.

---

## 17. Implementation Milestones

Complete the following milestones in order.

### Milestone 1 — Repository inspection and architecture

- Inspect the repository and existing dependencies.
- Identify relevant existing code and constraints.
- Propose the module structure.
- Design the Prisma schema and ER diagram.
- Document financial rules.
- Define API contracts.
- Identify risks and assumptions.
- Explain why Prisma Client or raw SQL is appropriate for each major query category.

**Deliverable:** architecture plan and schema proposal.

Do not build frontend code.

### Milestone 2 — Database foundation

- Set up PostgreSQL and Docker Compose.
- Initialize Prisma if the project does not already use it.
- Create `schema.prisma`.
- Generate Prisma Client.
- Create initial migrations.
- Implement seed data.
- Verify migrations on a clean database.
- Add tests for important database constraints.
- Document schema and migration commands.

**Deliverable:** a working and tested database foundation.

### Milestone 3 — Authentication and transaction ledger

- Implement authentication.
- Implement user-scoped authorization.
- Create transaction CRUD APIs.
- Implement accounts and categories.
- Add validation, filtering, and pagination.
- Test cross-user isolation and transaction correctness.

**Deliverable:** a secure transaction ledger with working APIs.

### Milestone 4 — CSV import pipeline

- Implement one CSV adapter.
- Normalize and validate transaction rows.
- Implement import batches and row-level outcomes.
- Add duplicate detection.
- Implement safe persistence and retry handling.
- Add import status and row inspection endpoints.
- Test repeated imports and failure recovery.

**Deliverable:** reliable transaction ingestion.

This milestone must be thoroughly tested before proceeding.

### Milestone 5 — Analytics, budgets, and savings

- Implement dashboard summary queries.
- Implement category breakdowns and monthly trends.
- Use Prisma Client for ordinary queries.
- Use parameterized raw SQL for complex analytics where justified.
- Implement budgets and savings goals.
- Implement safe-to-spend.
- Add basic recurring-expense detection and a simple forecast.
- Verify results using exact test fixtures.
- Analyze the important SQL query plans.

**Deliverable:** accurate and documented analytics APIs.

### Milestone 6 — Background jobs and hardening

- Introduce Redis and BullMQ.
- Move import processing into background workers.
- Implement retries and batch recovery.
- Add job status tracking and observability.
- Review database indexes and slow queries.
- Complete security and integration tests.
- Validate the system under concurrent imports.
- Verify that Prisma transactions and database constraints preserve integrity.

**Deliverable:** a reliable asynchronous import workflow.

### Milestone 7 — Final review and handoff

- Run migrations from a clean database.
- Run the complete automated test suite.
- Verify documented commands.
- Generate or update OpenAPI documentation.
- Review error handling and authorization.
- Review the Prisma schema and migration history.
- Document unresolved issues and future improvements.
- Provide example API requests and responses.
- Summarize files changed, tests executed, and actual results.

**Deliverable:** a backend ready for frontend integration.

---

## 18. Working Rules for Antigravity

Follow these rules throughout development:

1. Inspect existing files before changing them.
2. Do not overwrite useful existing work without a clear reason.
3. Do not build the frontend during the backend phase.
4. Use Prisma as the primary ORM and PostgreSQL as the source of truth.
5. Do not introduce `pg` as a second application-level database access layer.
6. Use raw SQL only when it offers a meaningful advantage, and always parameterize it.
7. Do not skip migrations or edit deployed migration history casually.
8. Do not silently swallow errors or return fake success responses.
9. Do not claim tests pass unless they were executed successfully.
10. Do not hardcode credentials or commit secrets.
11. Do not build microservices or add unnecessary abstractions.
12. Explain important trade-offs briefly so the developer learns from the implementation.
13. Keep a milestone checklist updated.
14. At the end of each milestone, report:
    - What was implemented.
    - Files created or changed.
    - Database changes.
    - Tests executed and their actual results.
    - Known limitations.
    - The next milestone.
15. Ask for clarification only when a genuinely blocking decision cannot be resolved safely through a documented assumption.

---

## 19. Definition of Done

The backend is complete when:

- A developer can run the project using documented commands.
- PostgreSQL migrations work on a clean database.
- Prisma Client is generated correctly.
- The transaction ledger supports income, expenses, transfers, and refunds.
- A supported CSV statement can be imported and inspected.
- Repeated imports do not silently create duplicate financial activity.
- Failed imports have understandable, recoverable outcomes.
- Transaction and analytics APIs return consistent results.
- Dashboard figures reconcile with the ledger.
- Cross-user data access is prevented and tested.
- Background jobs can be retried safely.
- Important PostgreSQL queries have been examined and indexed appropriately.
- Automated tests pass in the documented environment.
- API documentation, architecture documentation, and setup instructions are available.
- Known limitations and assumptions are documented.

## 20. Immediate Instruction

**Begin with Milestone 1 only.**

Inspect the current workspace and report:

1. The existing repository structure.
2. Any relevant existing code or configuration.
3. The proposed backend architecture.
4. The initial Prisma schema and ER diagram.
5. The financial rules and import-idempotency strategy.
6. The initial API contracts.
7. The implementation plan and major risks.

Do not start frontend development. Do not generate the entire backend in one pass.

After presenting the plan, proceed incrementally through the milestones, validating each stage before moving to the next.
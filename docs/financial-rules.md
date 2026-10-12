# Financial rules

Every number the API returns follows these rules. Each rule has a test with exact expected values
(`tests/unit/finance.test.ts`, `tests/integration/analytics.test.ts`, `tests/integration/imports.test.ts`).

## Transaction types

| Type | Meaning | In income? | In expenses? | Moves the account balance |
|---|---|---|---|---|
| `INCOME` | Money earned (salary, interest, …) | **yes** | no | + |
| `EXPENSE` | Money spent | no | **yes** | − |
| `REFUND` | Money returned for an earlier expense, or a reversal | no | **reduces** expenses | + |
| `TRANSFER` | Movement between the user's own accounts, or a credit-card **bill payment** | no | no | not applied¹ |

¹ A transfer has no stored direction, so balances ignore it and are labelled `balanceIsEstimate: true` when one exists.
Transfers never inflate income or expenses; they are visible in the ledger and counted in `transferCount`.

`amount` is always **positive**; direction comes from `type`. The database enforces `amount > 0`.

## Money

* Stored as `NUMERIC(14,2)`; computed with decimal arithmetic (`Prisma.Decimal`); transported as strings with exactly two
  decimals (`"1250.50"`). Request amounts must be strings – JSON numbers are rejected. Percentages are 2-dp strings.
* `0.1 + 0.2 = 0.30` (tested). Rounding: money to 2 dp; the safe-to-spend daily allowance rounds **down** (never promise
  more than exists); the required monthly saving rounds **up** (never fall short).
* **Currency**: INR only for now. Account creation rejects other currencies because dashboards sum across accounts.

## Reporting formulas (per calendar month, in the user's time zone)

```
income        = Σ INCOME
expenses      = Σ EXPENSE
refunds       = Σ REFUND
net expenses  = expenses − refunds
net cash flow = income − net expenses
savings rate  = (income − net expenses) / income × 100        → null when income = 0
```

* A zero-income month has a **`null`** savings rate, not 0 % (the ratio is undefined). Spending more than earning gives a
  negative rate.
* **Refund policy**: a refund reduces spend in the category it is filed under (so file it under the original category).
  A refund larger than that category's spend makes the category total negative, which is shown as-is.
* **Dashboard reconciliation**: `totalIncome`, `totalExpenses`, `totalRefunds` equal the sums of the listed ledger rows for the
  same period, and `netCashFlow = totalIncome − netExpenses`. Tested by summing the API's own ledger output.
* Category breakdown percentages are each category's share of total net spend; `changePct` compares with the previous month
  and is `null` when the previous month was zero. `Uncategorized` is reported explicitly.

## Time zones and month boundaries

* Timestamps are stored as UTC `TIMESTAMPTZ`. A month is a **half-open interval `[first instant of the month, first instant of
  the next month)` in the user's IANA time zone** (`users.timezone`, default `Asia/Kolkata`).
* `2026-09-30T19:00Z` is 1 October 00:30 in India → October for an IST user, September for a UTC user.
  `31 Oct 23:59:59 IST` is October; `1 Nov 00:00:00 IST` is November. DST is handled (two-pass offset resolution).
* Changing the profile time zone re-buckets all history immediately; nothing is stored per month.
* Statement dates carry no time. An imported date `D` is stored as **12:00 noon on D in the user's time zone** so it stays on the
  right calendar day regardless of zone. The fingerprint uses the local calendar date.

## Statement interpretation (adapters)

* **Debit/credit columns** – HDFC: `Withdrawal Amt.` → EXPENSE, `Deposit Amt.` → INCOME. Both filled → row rejected as ambiguous.
  Neither filled (or zero) → row **skipped** (opening balance / footer lines).
* **Signed amounts** – the generic adapter reads a single `Amount` column: negative → money out, positive → money in. Accounting
  negatives `(1,200.00)`, `Dr`/`Cr` suffixes, `₹`/`Rs.` and Indian digit grouping `1,23,456.78` are understood.
* **Refunds / reversals** – a deposit whose narration contains *refund*, *reversal* or *reversed* is classified `REFUND`.
  Anything the heuristics get wrong can be corrected with `PATCH /transactions/:id { "type": … }`.
* **Credit-card bill payments** – a withdrawal whose narration mentions *credit card* + *payment/bill* is a `TRANSFER`: the money
  is moving to a liability, and the card's own purchases are the expenses. Counting both would double-count spending.
* **Bad rows** – unparseable/impossible dates (31 Feb), non-numeric or sub-paisa amounts, empty narrations are `REJECTED` with a
  reason and the row number; the rest of the file still imports.

## Duplicate handling

Two layers, deliberately conservative – **a wrongly dropped transaction is worse than a flagged duplicate**.

1. **File level** – SHA-256 of the bytes, unique per user. Re-uploading a completed file is `409`.
2. **Row level**
   * **Bank reference present**: the identity is `"<ref>:DR"` or `"<ref>:CR"` (direction included, because banks reuse one
     reference for a payment and its reversal). A row is a duplicate iff that reference already exists on the account
     (`UNIQUE (account_id, source_tx_id)` enforces it). A reference repeated *inside one file* is not trusted and falls back to (b).
   * **No reference** (UPI cash-style rows, ATM): fingerprint = account + local date + amount + normalised description +
     **occurrence ordinal**. Three identical ₹40 chai purchases in one statement get ordinals 1, 2, 3 → all kept. If a later,
     wider export repeats them, ordinals 1–3 match and are flagged, while a genuine 4th is imported.
   * Manual entries also store a fingerprint, so a later statement row matching one is flagged as a duplicate.
* `DUPLICATE` rows are recorded with a reason and are not transactions. Nothing is merged or deleted automatically.

## User corrections

* `PATCH /transactions/:id` can change `categoryId`, `merchantName`, `notes`, `type`, `isReviewed`. Amount and date are immutable
  (delete and re-add instead) so the ledger always reconciles with the statement.
* A category/type correction marks the row `isReviewed = true`. **Merchant rules never overwrite reviewed rows.**
* Analytics read the ledger live (no caching), so a correction is visible in the very next request.
* Deleting a transaction keeps its import row (unlinked, with a reason) so reconciliation is still possible.

## Budgets and savings goals

* Budget utilisation = `(EXPENSE − REFUND)` for that category in that month ÷ budget amount. Status: `ok` < 80 %, `warning` ≥ 80 %,
  `exceeded` > 100 %. Budgets match the exact category (sub-categories are not rolled up).
* Savings goal: `remaining = max(target − current, 0)`; `requiredMonthlySaving = ⌈remaining / months left⌉` where months left
  counts the current month through the target month (minimum 1). Goals with no date have no schedule. Reaching the target
  auto-sets `ACHIEVED`. `currentAmount` is user-maintained (the spec's "current progress"); it is not derived from the ledger.

## Estimates (always labelled `isEstimate: true`)

### Month-end forecast
* run-rate = spent so far ÷ days elapsed × days in month.
* With a previous full month: `projection = runRate × w + previousMonth × (1 − w)`, `w = daysElapsed / daysInMonth`.
* Never below what is already spent. Confidence: `low` before day 7, `medium` before day 15 or without history, otherwise `high`.
  Notes explain that early projections are weak and spending is not uniform (rent and bills cluster).

### Recurring-charge candidates
* Expenses of the last 6 months (≤ 5,000 rows), grouped by a normalised merchant key (digits and reference noise removed),
  then by amount (within 10 % or ₹10).
* A candidate needs **≥ 3** charges with gaps that are consistently weekly (6–8 days median) or monthly (26–35 days), ≥ 75 % of
  gaps in tolerance. `confidence: high` needs ≥ 4 occurrences and perfectly regular gaps.
* Candidates are **suggestions** (`status: UNCONFIRMED`); they are never treated as facts elsewhere except as an *estimated*
  obligation in safe-to-spend.

### Safe-to-spend
```
safe to spend = available balance − upcoming obligations − remaining savings commitment
daily allowance = max(safe to spend, 0) ÷ days left in month (including today), rounded down
```
* **Available balance** = Σ over active cash/bank/wallet accounts of `opening_balance + INCOME + REFUND − EXPENSE` (credit cards
  are liabilities and excluded). Because the balance already includes everything posted **up to now**, only **future**
  obligations are subtracted – nothing is counted twice.
* **Upcoming obligations** = recurring candidates still due between tomorrow and month end (weekly ones repeat).
* **Remaining savings commitment** = Σ `requiredMonthlySaving` of active goals (assumes nothing was set aside yet this month).
* **No account of the right kind → `amount: null`.** A balance is never invented.
* The response lists its `assumptions` (opening-balance meaning, unconfirmed obligations, transfers excluded from balances) and
  a `shortfall` flag when the result is negative.
* Planned budgets are intentionally *not* deducted: a budget is a spending allowance, not a commitment, and subtracting it would
  double-count obligations such as rent.

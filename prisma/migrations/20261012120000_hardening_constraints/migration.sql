-- DropForeignKey
ALTER TABLE "import_batches" DROP CONSTRAINT "import_batches_account_id_fkey";

-- DropForeignKey
ALTER TABLE "transactions" DROP CONSTRAINT "transactions_account_id_fkey";

-- DropIndex
DROP INDEX "transactions_fingerprint_idx";

-- AlterTable
ALTER TABLE "import_batches" ADD COLUMN     "attempts" INTEGER NOT NULL DEFAULT 0;

-- CreateIndex
CREATE UNIQUE INDEX "accounts_id_user_id_key" ON "accounts"("id", "user_id");

-- CreateIndex
CREATE INDEX "transactions_account_id_fingerprint_idx" ON "transactions"("account_id", "fingerprint");

-- AddForeignKey
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_account_id_user_id_fkey" FOREIGN KEY ("account_id", "user_id") REFERENCES "accounts"("id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_account_id_user_id_fkey" FOREIGN KEY ("account_id", "user_id") REFERENCES "accounts"("id", "user_id") ON DELETE RESTRICT ON UPDATE CASCADE;


-- ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------
-- Hand-written integrity rules (not expressible in schema.prisma)
-- ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------

-- System categories (user_id IS NULL) are not covered by UNIQUE (user_id, name)
-- because NULLs are distinct. This partial index keeps them unique and makes
-- seeding idempotent.
CREATE UNIQUE INDEX "categories_system_name_key" ON "categories" ("name") WHERE "user_id" IS NULL;

-- Money is stored as a positive magnitude; direction comes from `type`.
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_amount_positive" CHECK ("amount" > 0);
ALTER TABLE "budgets"      ADD CONSTRAINT "budgets_amount_positive"      CHECK ("amount" > 0);
ALTER TABLE "savings_goals" ADD CONSTRAINT "savings_goals_target_positive"  CHECK ("target_amount" > 0);
ALTER TABLE "savings_goals" ADD CONSTRAINT "savings_goals_current_nonneg"   CHECK ("current_amount" >= 0);

-- ISO-4217 shaped currency codes.
ALTER TABLE "accounts"      ADD CONSTRAINT "accounts_currency_format"      CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "transactions"  ADD CONSTRAINT "transactions_currency_format"  CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "budgets"       ADD CONSTRAINT "budgets_currency_format"       CHECK ("currency" ~ '^[A-Z]{3}$');
ALTER TABLE "savings_goals" ADD CONSTRAINT "savings_goals_currency_format" CHECK ("currency" ~ '^[A-Z]{3}$');

-- Budgets are keyed by the first day of a month.
ALTER TABLE "budgets" ADD CONSTRAINT "budgets_period_first_of_month"
  CHECK ("period_month" = date_trunc('month', "period_month")::date);

-- Import counters can never go negative and can never exceed the row total.
ALTER TABLE "import_batches" ADD CONSTRAINT "import_batches_counts_valid" CHECK (
  "total_rows" >= 0 AND "accepted_rows" >= 0 AND "duplicate_rows" >= 0
  AND "rejected_rows" >= 0 AND "skipped_rows" >= 0 AND "attempts" >= 0
  AND "accepted_rows" + "duplicate_rows" + "rejected_rows" + "skipped_rows" <= "total_rows"
);

-- A transaction cannot be its own transfer peer.
ALTER TABLE "transactions" ADD CONSTRAINT "transactions_no_self_peer"
  CHECK ("transfer_peer_id" IS NULL OR "transfer_peer_id" <> "id");

-- -----------------------------------------------------------------------------
-- Backfill: align rows imported by the previous pipeline with the new duplicate rules,
-- so re-importing an overlapping statement after the upgrade does not create duplicates.
-- (A no-op on an empty database.)
-- -----------------------------------------------------------------------------

-- 1) Bank references now carry their direction ("<ref>:DR" / "<ref>:CR"), because banks reuse a
--    reference for a payment and its reversal. Only imported rows (import_row_id set) are touched.
UPDATE "transactions"
SET "source_tx_id" = "source_tx_id" || CASE WHEN "type" IN ('INCOME', 'REFUND') THEN ':CR' ELSE ':DR' END
WHERE "source_tx_id" IS NOT NULL
  AND "import_row_id" IS NOT NULL
  AND "source_tx_id" NOT LIKE '%:DR'
  AND "source_tx_id" NOT LIKE '%:CR';

-- 2) Fingerprints are now sha256(account | local date | amount | normalised description | occurrence ordinal).
--    Recompute for every row; the ordinal numbers identical rows in creation order.
WITH keyed AS (
  SELECT t."id", t."created_at",
         t."account_id"::text
           || '|' || to_char(t."occurred_at" AT TIME ZONE u."timezone", 'YYYY-MM-DD')
           || '|' || to_char(t."amount", 'FM999999999990.00')
           || '|' || btrim(regexp_replace(regexp_replace(lower(t."description"), '[^a-z0-9 ]', ' ', 'g'), '\s+', ' ', 'g')) AS "key"
  FROM "transactions" t
  JOIN "users" u ON u."id" = t."user_id"
),
numbered AS (
  SELECT "id", "key", row_number() OVER (PARTITION BY "key" ORDER BY "created_at", "id") AS "n"
  FROM keyed
)
UPDATE "transactions" t
SET "fingerprint" = encode(sha256(convert_to(n."key" || '|' || n."n"::text, 'UTF8')), 'hex')
FROM numbered n
WHERE t."id" = n."id";

CREATE TYPE "IdBusinessV2FinanceCurrency" AS ENUM ('CNY', 'MYR', 'USDT');
CREATE TYPE "IdBusinessV2FinanceAccountType" AS ENUM ('bank', 'cash', 'ewallet', 'usdt_wallet');
CREATE TYPE "IdBusinessV2FinanceAccountStatus" AS ENUM ('active', 'disabled');
CREATE TYPE "IdBusinessV2FinanceJournalType" AS ENUM (
  'supplier_deposit',
  'supplier_refund',
  'supplier_adjustment',
  'gift_card_purchase',
  'gift_card_redemption_loss',
  'gift_card_withdrawal_pending',
  'gift_card_refund_received',
  'gift_card_refund_write_off',
  'account_purchase',
  'order_completed',
  'order_refund',
  'order_cancel',
  'order_recovery',
  'account_loss',
  'expense',
  'opening_balance',
  'fx_gain_loss',
  'manual_adjustment',
  'historical_backfill',
  'reversal'
);
CREATE TYPE "IdBusinessV2FinanceSourceType" AS ENUM (
  'supplier_wallet',
  'supplier_payment',
  'gift_card',
  'account',
  'account_loss',
  'order',
  'expense',
  'opening_balance',
  'historical_backfill',
  'manual'
);
CREATE TYPE "IdBusinessV2FinanceJournalStatus" AS ENUM ('posted', 'reversed');
CREATE TYPE "IdBusinessV2FinanceLineDirection" AS ENUM ('debit', 'credit');
CREATE TYPE "IdBusinessV2FinanceAccountCode" AS ENUM (
  'cash',
  'supplier_prepayment',
  'supplier_refund_receivable',
  'gift_card_inventory',
  'id_inventory',
  'sales_revenue',
  'platform_fee',
  'gift_card_cost',
  'id_cost',
  'refund_loss',
  'gift_card_redemption_loss',
  'balance_loss',
  'id_purchase_loss',
  'operating_expense',
  'realized_fx_gain_loss',
  'opening_equity',
  'manual_adjustment'
);
CREATE TYPE "IdBusinessV2FinanceFxRateSource" AS ENUM (
  'cny_fixed',
  'combined_p2p',
  'binance',
  'okx',
  'ecb_cross',
  'manual',
  'legacy_assumed_cny',
  'opening_balance'
);
CREATE TYPE "IdBusinessV2FinancePeriodStatus" AS ENUM ('open', 'closed', 'reopened');
CREATE TYPE "IdBusinessV2FinanceHistoryStatus" AS ENUM (
  'not_started',
  'in_progress',
  'incomplete',
  'completed'
);
CREATE TYPE "IdBusinessV2FinanceRefundStatus" AS ENUM (
  'none',
  'pending',
  'received',
  'written_off'
);

ALTER TABLE "id_business_v2_topup_supplier_accounts"
DROP CONSTRAINT IF EXISTS "id_business_v2_topup_supplier_accounts_supplier_option_id_key";

DROP INDEX IF EXISTS "id_business_v2_topup_supplier_accounts_supplier_option_id_key";

ALTER TABLE "id_business_v2_topup_supplier_accounts"
ADD COLUMN "currency" "IdBusinessV2FinanceCurrency" NOT NULL DEFAULT 'CNY',
ADD COLUMN "opening_balance" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN "current_balance" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN "opening_balance_cny" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN "status" "IdBusinessV2FinanceAccountStatus" NOT NULL DEFAULT 'active';

UPDATE "id_business_v2_topup_supplier_accounts"
SET "current_balance" = "current_balance_cny";

CREATE UNIQUE INDEX "id_business_v2_topup_supplier_accounts_supplier_option_id_currency_key"
ON "id_business_v2_topup_supplier_accounts"("supplier_option_id", "currency");

CREATE INDEX "id_business_v2_topup_supplier_accounts_status_idx"
ON "id_business_v2_topup_supplier_accounts"("status");

CREATE INDEX "id_business_v2_topup_supplier_accounts_current_balance_idx"
ON "id_business_v2_topup_supplier_accounts"("current_balance");

DROP TRIGGER IF EXISTS id_business_v2_topup_supplier_payments_immutable
ON public.id_business_v2_topup_supplier_payments;

DROP TRIGGER IF EXISTS id_business_v2_topup_supplier_ledger_immutable
ON public.id_business_v2_topup_supplier_ledger;

ALTER TABLE "id_business_v2_topup_supplier_payments"
ADD COLUMN "finance_account_id" UUID,
ADD COLUMN "fx_rate_snapshot_id" UUID,
ADD COLUMN "paid_currency" "IdBusinessV2FinanceCurrency" NOT NULL DEFAULT 'USDT',
ADD COLUMN "paid_amount" DECIMAL(18,4),
ADD COLUMN "network_fee_amount" DECIMAL(18,4),
ADD COLUMN "fx_rate_to_cny" DECIMAL(18,8),
ADD COLUMN "credited_amount" DECIMAL(18,4);

UPDATE "id_business_v2_topup_supplier_payments"
SET
  "paid_amount" = "received_usdt",
  "network_fee_amount" = "network_fee_usdt",
  "fx_rate_to_cny" = "settlement_rate_cny_usdt",
  "credited_amount" = ROUND("credited_cny" / "settlement_rate_cny_usdt", 4);

ALTER TABLE "id_business_v2_topup_supplier_payments"
ALTER COLUMN "paid_amount" SET NOT NULL,
ALTER COLUMN "network_fee_amount" SET NOT NULL,
ALTER COLUMN "network_fee_amount" SET DEFAULT 0,
ALTER COLUMN "fx_rate_to_cny" SET NOT NULL,
ALTER COLUMN "credited_amount" SET NOT NULL,
ALTER COLUMN "received_usdt" DROP NOT NULL,
ALTER COLUMN "network_fee_usdt" DROP NOT NULL,
ALTER COLUMN "settlement_rate_cny_usdt" DROP NOT NULL;

ALTER TABLE "id_business_v2_topup_supplier_payments"
DROP CONSTRAINT IF EXISTS "id_business_v2_topup_supplier_payments_amount_check";

ALTER TABLE "id_business_v2_topup_supplier_payments"
ADD CONSTRAINT "id_business_v2_topup_supplier_payments_amount_check"
CHECK (
  "paid_amount" > 0::numeric
  AND "network_fee_amount" >= 0::numeric
  AND "fx_rate_to_cny" > 0::numeric
  AND "credited_amount" > 0::numeric
  AND "credited_cny" > 0::numeric
);

CREATE INDEX "id_business_v2_topup_supplier_payments_finance_account_id_paid_at_idx"
ON "id_business_v2_topup_supplier_payments"("finance_account_id", "paid_at");

CREATE INDEX "id_business_v2_topup_supplier_payments_fx_rate_snapshot_id_idx"
ON "id_business_v2_topup_supplier_payments"("fx_rate_snapshot_id");

ALTER TABLE "id_business_v2_topup_supplier_ledger"
ADD COLUMN "currency" "IdBusinessV2FinanceCurrency" NOT NULL DEFAULT 'CNY',
ADD COLUMN "amount" DECIMAL(18,4),
ADD COLUMN "balance_before" DECIMAL(18,4),
ADD COLUMN "balance_after" DECIMAL(18,4);

UPDATE "id_business_v2_topup_supplier_ledger"
SET
  "amount" = "amount_cny",
  "balance_before" = "balance_before_cny",
  "balance_after" = "balance_after_cny";

ALTER TABLE "id_business_v2_topup_supplier_ledger"
ALTER COLUMN "amount" SET NOT NULL,
ALTER COLUMN "balance_before" SET NOT NULL,
ALTER COLUMN "balance_after" SET NOT NULL;

ALTER TABLE "id_business_v2_topup_supplier_ledger"
DROP CONSTRAINT IF EXISTS "id_business_v2_topup_supplier_ledger_reference_check";

ALTER TABLE "id_business_v2_topup_supplier_ledger"
ADD CONSTRAINT "id_business_v2_topup_supplier_ledger_reference_check"
CHECK (
  (
    "entry_type"::text = 'opening_balance'
    AND "payment_id" IS NULL
    AND "gift_card_id" IS NULL
    AND "reversal_of_entry_id" IS NULL
    AND "direction"::text = 'adjustment'
  )
  OR (
    "entry_type"::text = 'payment_credit'
    AND "payment_id" IS NOT NULL
    AND "gift_card_id" IS NULL
    AND "reversal_of_entry_id" IS NULL
    AND "direction"::text = 'credit'
  )
  OR (
    "entry_type"::text = 'gift_card_debit'
    AND "payment_id" IS NULL
    AND "gift_card_id" IS NOT NULL
    AND "reversal_of_entry_id" IS NULL
    AND "direction"::text = 'debit'
  )
  OR (
    "entry_type"::text = 'gift_card_withdrawal_reversal'
    AND "payment_id" IS NULL
    AND "gift_card_id" IS NOT NULL
    AND "reversal_of_entry_id" IS NOT NULL
    AND "direction"::text = 'credit'
  )
  OR (
    "entry_type"::text = 'manual_adjustment'
    AND "payment_id" IS NULL
    AND "reversal_of_entry_id" IS NULL
    AND "direction"::text = 'adjustment'
  )
  OR (
    "entry_type"::text = 'payment_reversal'
    AND "payment_id" IS NOT NULL
    AND "gift_card_id" IS NULL
    AND "reversal_of_entry_id" IS NOT NULL
    AND "direction"::text = 'debit'
  )
  OR (
    "entry_type"::text IN ('supplier_refund', 'id_purchase_debit')
    AND "payment_id" IS NULL
    AND "gift_card_id" IS NULL
    AND "reversal_of_entry_id" IS NULL
    AND "direction"::text = 'debit'
  )
  OR (
    "entry_type"::text = 'gift_card_refund_received'
    AND "payment_id" IS NULL
    AND "gift_card_id" IS NOT NULL
    AND "reversal_of_entry_id" IS NULL
    AND "direction"::text = 'credit'
  )
  OR (
    "entry_type"::text = 'refund_write_off'
    AND "payment_id" IS NULL
    AND "gift_card_id" IS NOT NULL
    AND "reversal_of_entry_id" IS NULL
    AND "direction"::text = 'debit'
  )
);

ALTER TABLE "id_business_v2_topup_supplier_ledger"
ADD CONSTRAINT "id_business_v2_topup_supplier_ledger_original_balance_check"
CHECK (
  (
    "direction"::text = 'credit'
    AND "balance_after" = "balance_before" + "amount"
  )
  OR (
    "direction"::text = 'debit'
    AND "balance_after" = "balance_before" - "amount"
  )
  OR (
    "direction"::text = 'adjustment'
    AND abs("balance_after" - "balance_before") = "amount"
  )
);

CREATE TRIGGER id_business_v2_topup_supplier_payments_immutable
BEFORE UPDATE OR DELETE ON public.id_business_v2_topup_supplier_payments
FOR EACH ROW EXECUTE FUNCTION public.id_business_v2_prevent_topup_supplier_financial_mutation();

CREATE TRIGGER id_business_v2_topup_supplier_ledger_immutable
BEFORE UPDATE OR DELETE ON public.id_business_v2_topup_supplier_ledger
FOR EACH ROW EXECUTE FUNCTION public.id_business_v2_prevent_topup_supplier_financial_mutation();

ALTER TABLE "id_business_v2_accounts"
ADD COLUMN "purchase_original_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN "purchase_currency" "IdBusinessV2FinanceCurrency" NOT NULL DEFAULT 'CNY',
ADD COLUMN "purchase_fx_rate_to_cny" DECIMAL(18,8) NOT NULL DEFAULT 1,
ADD COLUMN "purchase_fx_snapshot_id" UUID,
ADD COLUMN "purchase_finance_account_id" UUID,
ADD COLUMN "purchase_supplier_account_id" UUID,
ADD COLUMN "purchased_at" TIMESTAMPTZ(6);

UPDATE "id_business_v2_accounts"
SET
  "purchase_original_amount" = "purchase_cost",
  "purchased_at" = "created_at";

ALTER TABLE "id_business_v2_gift_cards"
ADD COLUMN "purchase_original_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN "purchase_currency" "IdBusinessV2FinanceCurrency" NOT NULL DEFAULT 'CNY',
ADD COLUMN "purchase_fx_rate_to_cny" DECIMAL(18,8) NOT NULL DEFAULT 1,
ADD COLUMN "purchase_fx_snapshot_id" UUID,
ADD COLUMN "purchase_finance_account_id" UUID,
ADD COLUMN "purchase_supplier_account_id" UUID,
ADD COLUMN "paid_at" TIMESTAMPTZ(6),
ADD COLUMN "supplier_refund_status" "IdBusinessV2FinanceRefundStatus" NOT NULL DEFAULT 'none',
ADD COLUMN "supplier_refund_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN "supplier_refund_amount_cny" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN "supplier_refund_closed_at" TIMESTAMPTZ(6);

UPDATE "id_business_v2_gift_cards"
SET
  "purchase_original_amount" = "cost_amount",
  "paid_at" = "created_at";

ALTER TABLE "id_business_v2_orders"
ADD COLUMN "received_original_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
ADD COLUMN "received_currency" "IdBusinessV2FinanceCurrency" NOT NULL DEFAULT 'CNY',
ADD COLUMN "received_fx_rate_to_cny" DECIMAL(18,8) NOT NULL DEFAULT 1,
ADD COLUMN "received_fx_snapshot_id" UUID,
ADD COLUMN "received_finance_account_id" UUID,
ADD COLUMN "received_at" TIMESTAMPTZ(6);

UPDATE "id_business_v2_orders"
SET
  "received_original_amount" = "received_amount",
  "received_at" = COALESCE("opened_at", "created_at");

ALTER TABLE "id_business_v2_account_losses"
ADD COLUMN "id_purchase_cost_loss_amount" DECIMAL(18,4) NOT NULL DEFAULT 0;

UPDATE "id_business_v2_account_losses" loss
SET "id_purchase_cost_loss_amount" = CASE
  WHEN loss."sale_state" = 'available'::"IdBusinessV2AccountLossSaleState"
    THEN account."purchase_cost"
  ELSE 0::numeric
END
FROM "id_business_v2_accounts" account
WHERE account."id" = loss."account_id";

CREATE TABLE "id_business_v2_finance_settings" (
  "id" INTEGER NOT NULL DEFAULT 1,
  "base_currency" "IdBusinessV2FinanceCurrency" NOT NULL DEFAULT 'CNY',
  "timezone" VARCHAR(80) NOT NULL DEFAULT 'Asia/Kuala_Lumpur',
  "enabled_at" TIMESTAMPTZ(6),
  "history_status" "IdBusinessV2FinanceHistoryStatus" NOT NULL DEFAULT 'not_started',
  "history_completed_at" TIMESTAMPTZ(6),
  "history_note" TEXT,
  "updated_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "id_business_v2_finance_settings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "id_business_v2_finance_settings_singleton_check" CHECK ("id" = 1),
  CONSTRAINT "id_business_v2_finance_settings_base_currency_check" CHECK ("base_currency" = 'CNY')
);

CREATE TABLE "id_business_v2_finance_accounts" (
  "id" UUID NOT NULL,
  "name" VARCHAR(160) NOT NULL,
  "account_type" "IdBusinessV2FinanceAccountType" NOT NULL,
  "currency" "IdBusinessV2FinanceCurrency" NOT NULL,
  "opening_balance" DECIMAL(18,4) NOT NULL DEFAULT 0,
  "current_balance" DECIMAL(18,4) NOT NULL DEFAULT 0,
  "opening_balance_cny" DECIMAL(18,4) NOT NULL DEFAULT 0,
  "current_balance_cny" DECIMAL(18,4) NOT NULL DEFAULT 0,
  "status" "IdBusinessV2FinanceAccountStatus" NOT NULL DEFAULT 'active',
  "remark" TEXT,
  "created_by_user_id" UUID,
  "updated_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "id_business_v2_finance_accounts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "id_business_v2_finance_fx_rate_snapshots" (
  "id" UUID NOT NULL,
  "currency" "IdBusinessV2FinanceCurrency" NOT NULL,
  "rate_to_cny" DECIMAL(18,8) NOT NULL,
  "source" "IdBusinessV2FinanceFxRateSource" NOT NULL,
  "source_reference" VARCHAR(500),
  "source_evidence" JSONB,
  "business_date" DATE NOT NULL,
  "captured_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "expires_at" TIMESTAMPTZ(6),
  "manual_reason" TEXT,
  "created_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "id_business_v2_finance_fx_rate_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "id_business_v2_finance_fx_rate_snapshots_rate_check"
    CHECK ("rate_to_cny" > 0::numeric),
  CONSTRAINT "id_business_v2_finance_fx_rate_snapshots_manual_reason_check"
    CHECK (
      "source" <> 'manual'::"IdBusinessV2FinanceFxRateSource"
      OR char_length(btrim(COALESCE("manual_reason", ''))) >= 2
    ),
  CONSTRAINT "id_business_v2_finance_fx_rate_snapshots_cny_check"
    CHECK (
      "currency" <> 'CNY'::"IdBusinessV2FinanceCurrency"
      OR "rate_to_cny" = 1::numeric
    )
);

CREATE TABLE "id_business_v2_finance_journals" (
  "id" UUID NOT NULL,
  "journal_no" VARCHAR(40) NOT NULL,
  "journal_type" "IdBusinessV2FinanceJournalType" NOT NULL,
  "source_type" "IdBusinessV2FinanceSourceType" NOT NULL,
  "source_id" VARCHAR(160),
  "source_reference" VARCHAR(200),
  "business_date" DATE NOT NULL,
  "period_month" VARCHAR(7) NOT NULL,
  "occurred_at" TIMESTAMPTZ(6) NOT NULL,
  "status" "IdBusinessV2FinanceJournalStatus" NOT NULL DEFAULT 'posted',
  "reversal_of_journal_id" UUID,
  "reversed_at" TIMESTAMPTZ(6),
  "summary" VARCHAR(300) NOT NULL,
  "metadata" JSONB,
  "idempotency_key" VARCHAR(180) NOT NULL,
  "created_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "id_business_v2_finance_journals_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "id_business_v2_finance_journals_period_check"
    CHECK ("period_month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT "id_business_v2_finance_journals_reversal_check"
    CHECK (
      (
        "journal_type" = 'reversal'::"IdBusinessV2FinanceJournalType"
        AND "reversal_of_journal_id" IS NOT NULL
      )
      OR (
        "journal_type" <> 'reversal'::"IdBusinessV2FinanceJournalType"
        AND "reversal_of_journal_id" IS NULL
      )
    )
);

CREATE TABLE "id_business_v2_finance_journal_lines" (
  "id" UUID NOT NULL,
  "journal_id" UUID NOT NULL,
  "line_no" INTEGER NOT NULL,
  "account_code" "IdBusinessV2FinanceAccountCode" NOT NULL,
  "direction" "IdBusinessV2FinanceLineDirection" NOT NULL,
  "currency" "IdBusinessV2FinanceCurrency" NOT NULL,
  "amount_original" DECIMAL(18,4) NOT NULL,
  "fx_rate_to_cny" DECIMAL(18,8) NOT NULL,
  "amount_cny" DECIMAL(18,4) NOT NULL,
  "finance_account_id" UUID,
  "supplier_account_id" UUID,
  "fx_rate_snapshot_id" UUID,
  "memo" VARCHAR(300),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "id_business_v2_finance_journal_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "id_business_v2_finance_journal_lines_amount_check"
    CHECK (
      "amount_original" >= 0::numeric
      AND "fx_rate_to_cny" > 0::numeric
      AND "amount_cny" >= 0::numeric
    )
);

CREATE TABLE "id_business_v2_finance_expenses" (
  "id" UUID NOT NULL,
  "journal_id" UUID NOT NULL,
  "category_option_id" UUID NOT NULL,
  "finance_account_id" UUID NOT NULL,
  "fx_rate_snapshot_id" UUID,
  "currency" "IdBusinessV2FinanceCurrency" NOT NULL,
  "amount_original" DECIMAL(18,4) NOT NULL,
  "fx_rate_to_cny" DECIMAL(18,8) NOT NULL,
  "amount_cny" DECIMAL(18,4) NOT NULL,
  "occurred_at" TIMESTAMPTZ(6) NOT NULL,
  "payee" VARCHAR(200),
  "receipt_attachment_id" UUID,
  "remark" TEXT,
  "idempotency_key" VARCHAR(180) NOT NULL,
  "created_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "id_business_v2_finance_expenses_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "id_business_v2_finance_expenses_amount_check"
    CHECK (
      "amount_original" > 0::numeric
      AND "fx_rate_to_cny" > 0::numeric
      AND "amount_cny" > 0::numeric
    )
);

CREATE TABLE "id_business_v2_finance_periods" (
  "month" VARCHAR(7) NOT NULL,
  "status" "IdBusinessV2FinancePeriodStatus" NOT NULL DEFAULT 'open',
  "closed_at" TIMESTAMPTZ(6),
  "closed_by_user_id" UUID,
  "reopen_reason" TEXT,
  "reopened_at" TIMESTAMPTZ(6),
  "reopened_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "id_business_v2_finance_periods_pkey" PRIMARY KEY ("month"),
  CONSTRAINT "id_business_v2_finance_periods_month_check"
    CHECK ("month" ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  CONSTRAINT "id_business_v2_finance_periods_reopen_reason_check"
    CHECK (
      "status" <> 'reopened'::"IdBusinessV2FinancePeriodStatus"
      OR char_length(btrim(COALESCE("reopen_reason", ''))) >= 2
    )
);

CREATE UNIQUE INDEX "id_business_v2_finance_journals_journal_no_key"
ON "id_business_v2_finance_journals"("journal_no");
CREATE UNIQUE INDEX "id_business_v2_finance_journals_reversal_of_journal_id_key"
ON "id_business_v2_finance_journals"("reversal_of_journal_id");
CREATE UNIQUE INDEX "id_business_v2_finance_journals_idempotency_key_key"
ON "id_business_v2_finance_journals"("idempotency_key");
CREATE UNIQUE INDEX "id_business_v2_finance_journal_lines_journal_id_line_no_key"
ON "id_business_v2_finance_journal_lines"("journal_id", "line_no");
CREATE UNIQUE INDEX "id_business_v2_finance_expenses_journal_id_key"
ON "id_business_v2_finance_expenses"("journal_id");
CREATE UNIQUE INDEX "id_business_v2_finance_expenses_idempotency_key_key"
ON "id_business_v2_finance_expenses"("idempotency_key");

CREATE INDEX "id_business_v2_finance_settings_history_status_idx"
ON "id_business_v2_finance_settings"("history_status");
CREATE INDEX "id_business_v2_finance_accounts_currency_status_idx"
ON "id_business_v2_finance_accounts"("currency", "status");
CREATE INDEX "id_business_v2_finance_accounts_account_type_status_idx"
ON "id_business_v2_finance_accounts"("account_type", "status");
CREATE INDEX "id_business_v2_finance_fx_rate_snapshots_currency_business_date_captured_at_idx"
ON "id_business_v2_finance_fx_rate_snapshots"("currency", "business_date", "captured_at");
CREATE INDEX "id_business_v2_finance_journals_journal_type_business_date_idx"
ON "id_business_v2_finance_journals"("journal_type", "business_date");
CREATE INDEX "id_business_v2_finance_journals_source_type_source_id_idx"
ON "id_business_v2_finance_journals"("source_type", "source_id");
CREATE INDEX "id_business_v2_finance_journals_period_month_status_idx"
ON "id_business_v2_finance_journals"("period_month", "status");
CREATE INDEX "id_business_v2_finance_journal_lines_account_code_created_at_idx"
ON "id_business_v2_finance_journal_lines"("account_code", "created_at");
CREATE INDEX "id_business_v2_finance_journal_lines_currency_created_at_idx"
ON "id_business_v2_finance_journal_lines"("currency", "created_at");
CREATE INDEX "id_business_v2_finance_journal_lines_finance_account_id_created_at_idx"
ON "id_business_v2_finance_journal_lines"("finance_account_id", "created_at");
CREATE INDEX "id_business_v2_finance_journal_lines_supplier_account_id_created_at_idx"
ON "id_business_v2_finance_journal_lines"("supplier_account_id", "created_at");
CREATE INDEX "id_business_v2_finance_expenses_category_option_id_occurred_at_idx"
ON "id_business_v2_finance_expenses"("category_option_id", "occurred_at");
CREATE INDEX "id_business_v2_finance_expenses_finance_account_id_occurred_at_idx"
ON "id_business_v2_finance_expenses"("finance_account_id", "occurred_at");
CREATE INDEX "id_business_v2_finance_expenses_currency_occurred_at_idx"
ON "id_business_v2_finance_expenses"("currency", "occurred_at");
CREATE INDEX "id_business_v2_finance_periods_status_month_idx"
ON "id_business_v2_finance_periods"("status", "month");

CREATE INDEX "id_business_v2_accounts_purchase_fx_snapshot_id_idx"
ON "id_business_v2_accounts"("purchase_fx_snapshot_id");
CREATE INDEX "id_business_v2_accounts_purchase_finance_account_id_idx"
ON "id_business_v2_accounts"("purchase_finance_account_id");
CREATE INDEX "id_business_v2_accounts_purchase_supplier_account_id_idx"
ON "id_business_v2_accounts"("purchase_supplier_account_id");
CREATE INDEX "id_business_v2_gift_cards_purchase_fx_snapshot_id_idx"
ON "id_business_v2_gift_cards"("purchase_fx_snapshot_id");
CREATE INDEX "id_business_v2_gift_cards_purchase_finance_account_id_idx"
ON "id_business_v2_gift_cards"("purchase_finance_account_id");
CREATE INDEX "id_business_v2_gift_cards_purchase_supplier_account_id_idx"
ON "id_business_v2_gift_cards"("purchase_supplier_account_id");
CREATE INDEX "id_business_v2_gift_cards_supplier_refund_status_idx"
ON "id_business_v2_gift_cards"("supplier_refund_status");
CREATE INDEX "id_business_v2_orders_received_fx_snapshot_id_idx"
ON "id_business_v2_orders"("received_fx_snapshot_id");
CREATE INDEX "id_business_v2_orders_received_finance_account_id_idx"
ON "id_business_v2_orders"("received_finance_account_id");

ALTER TABLE "id_business_v2_finance_settings"
ADD CONSTRAINT "id_business_v2_finance_settings_updated_by_user_id_fkey"
FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "id_business_v2_finance_accounts"
ADD CONSTRAINT "id_business_v2_finance_accounts_created_by_user_id_fkey"
FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "id_business_v2_finance_accounts"
ADD CONSTRAINT "id_business_v2_finance_accounts_updated_by_user_id_fkey"
FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "id_business_v2_finance_fx_rate_snapshots"
ADD CONSTRAINT "id_business_v2_finance_fx_rate_snapshots_created_by_user_id_fkey"
FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "id_business_v2_finance_journals"
ADD CONSTRAINT "id_business_v2_finance_journals_reversal_of_journal_id_fkey"
FOREIGN KEY ("reversal_of_journal_id") REFERENCES "id_business_v2_finance_journals"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "id_business_v2_finance_journals"
ADD CONSTRAINT "id_business_v2_finance_journals_created_by_user_id_fkey"
FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "id_business_v2_finance_journal_lines"
ADD CONSTRAINT "id_business_v2_finance_journal_lines_journal_id_fkey"
FOREIGN KEY ("journal_id") REFERENCES "id_business_v2_finance_journals"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "id_business_v2_finance_journal_lines"
ADD CONSTRAINT "id_business_v2_finance_journal_lines_finance_account_id_fkey"
FOREIGN KEY ("finance_account_id") REFERENCES "id_business_v2_finance_accounts"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "id_business_v2_finance_journal_lines"
ADD CONSTRAINT "id_business_v2_finance_journal_lines_supplier_account_id_fkey"
FOREIGN KEY ("supplier_account_id") REFERENCES "id_business_v2_topup_supplier_accounts"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "id_business_v2_finance_journal_lines"
ADD CONSTRAINT "id_business_v2_finance_journal_lines_fx_rate_snapshot_id_fkey"
FOREIGN KEY ("fx_rate_snapshot_id") REFERENCES "id_business_v2_finance_fx_rate_snapshots"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "id_business_v2_finance_expenses"
ADD CONSTRAINT "id_business_v2_finance_expenses_journal_id_fkey"
FOREIGN KEY ("journal_id") REFERENCES "id_business_v2_finance_journals"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "id_business_v2_finance_expenses"
ADD CONSTRAINT "id_business_v2_finance_expenses_category_option_id_fkey"
FOREIGN KEY ("category_option_id") REFERENCES "id_business_v2_options"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "id_business_v2_finance_expenses"
ADD CONSTRAINT "id_business_v2_finance_expenses_finance_account_id_fkey"
FOREIGN KEY ("finance_account_id") REFERENCES "id_business_v2_finance_accounts"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "id_business_v2_finance_expenses"
ADD CONSTRAINT "id_business_v2_finance_expenses_fx_rate_snapshot_id_fkey"
FOREIGN KEY ("fx_rate_snapshot_id") REFERENCES "id_business_v2_finance_fx_rate_snapshots"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "id_business_v2_finance_expenses"
ADD CONSTRAINT "id_business_v2_finance_expenses_receipt_attachment_id_fkey"
FOREIGN KEY ("receipt_attachment_id") REFERENCES "attachments"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "id_business_v2_finance_expenses"
ADD CONSTRAINT "id_business_v2_finance_expenses_created_by_user_id_fkey"
FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "id_business_v2_finance_periods"
ADD CONSTRAINT "id_business_v2_finance_periods_closed_by_user_id_fkey"
FOREIGN KEY ("closed_by_user_id") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "id_business_v2_finance_periods"
ADD CONSTRAINT "id_business_v2_finance_periods_reopened_by_user_id_fkey"
FOREIGN KEY ("reopened_by_user_id") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "id_business_v2_topup_supplier_payments"
ADD CONSTRAINT "id_business_v2_topup_supplier_payments_finance_account_id_fkey"
FOREIGN KEY ("finance_account_id") REFERENCES "id_business_v2_finance_accounts"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "id_business_v2_topup_supplier_payments"
ADD CONSTRAINT "id_business_v2_topup_supplier_payments_fx_rate_snapshot_id_fkey"
FOREIGN KEY ("fx_rate_snapshot_id") REFERENCES "id_business_v2_finance_fx_rate_snapshots"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "id_business_v2_accounts"
ADD CONSTRAINT "id_business_v2_accounts_purchase_fx_snapshot_id_fkey"
FOREIGN KEY ("purchase_fx_snapshot_id") REFERENCES "id_business_v2_finance_fx_rate_snapshots"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "id_business_v2_accounts"
ADD CONSTRAINT "id_business_v2_accounts_purchase_finance_account_id_fkey"
FOREIGN KEY ("purchase_finance_account_id") REFERENCES "id_business_v2_finance_accounts"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "id_business_v2_accounts"
ADD CONSTRAINT "id_business_v2_accounts_purchase_supplier_account_id_fkey"
FOREIGN KEY ("purchase_supplier_account_id") REFERENCES "id_business_v2_topup_supplier_accounts"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "id_business_v2_gift_cards"
ADD CONSTRAINT "id_business_v2_gift_cards_purchase_fx_snapshot_id_fkey"
FOREIGN KEY ("purchase_fx_snapshot_id") REFERENCES "id_business_v2_finance_fx_rate_snapshots"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "id_business_v2_gift_cards"
ADD CONSTRAINT "id_business_v2_gift_cards_purchase_finance_account_id_fkey"
FOREIGN KEY ("purchase_finance_account_id") REFERENCES "id_business_v2_finance_accounts"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "id_business_v2_gift_cards"
ADD CONSTRAINT "id_business_v2_gift_cards_purchase_supplier_account_id_fkey"
FOREIGN KEY ("purchase_supplier_account_id") REFERENCES "id_business_v2_topup_supplier_accounts"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "id_business_v2_orders"
ADD CONSTRAINT "id_business_v2_orders_received_fx_snapshot_id_fkey"
FOREIGN KEY ("received_fx_snapshot_id") REFERENCES "id_business_v2_finance_fx_rate_snapshots"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "id_business_v2_orders"
ADD CONSTRAINT "id_business_v2_orders_received_finance_account_id_fkey"
FOREIGN KEY ("received_finance_account_id") REFERENCES "id_business_v2_finance_accounts"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "id_business_v2_finance_settings" (
  "id",
  "base_currency",
  "timezone",
  "history_status",
  "history_note",
  "created_at",
  "updated_at"
)
VALUES (
  1,
  'CNY',
  'Asia/Kuala_Lumpur',
  'incomplete',
  '等待确认期初资金、卡商余额和系统外历史开支',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "id_business_v2_options" (
  "id",
  "type",
  "code",
  "name",
  "unique_key",
  "sort_order",
  "status",
  "is_system",
  "created_at",
  "updated_at"
)
VALUES
  (gen_random_uuid(), 'expense_category', 'mobile_device', '手机及设备', 'expense_category:root:手机及设备', 10, 'active', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'expense_category', 'office', '办公开支', 'expense_category:root:办公开支', 20, 'active', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'expense_category', 'salary', '工资', 'expense_category:root:工资', 30, 'active', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'expense_category', 'logistics', '物流', 'expense_category:root:物流', 40, 'active', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'expense_category', 'fee', '手续费', 'expense_category:root:手续费', 50, 'active', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'expense_category', 'other', '其他开支', 'expense_category:root:其他开支', 60, 'active', true, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("unique_key") DO NOTHING;

INSERT INTO "permissions" ("id", "name", "code", "module", "action")
VALUES
  (gen_random_uuid(), '查看财务', 'finance.view', 'finance', 'view'),
  (gen_random_uuid(), '财务记账', 'finance.post', 'finance', 'post'),
  (gen_random_uuid(), '财务调整', 'finance.adjust', 'finance', 'adjust'),
  (gen_random_uuid(), '管理财务', 'finance.manage', 'finance', 'manage'),
  (gen_random_uuid(), '财务关账', 'finance.close', 'finance', 'close'),
  (gen_random_uuid(), '查看经营分析', 'data.analytics.view', 'data.analytics', 'view')
ON CONFLICT ("code") DO UPDATE SET
  "name" = EXCLUDED."name",
  "module" = EXCLUDED."module",
  "action" = EXCLUDED."action";

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT admin_role."id", permission."id"
FROM "roles" admin_role
CROSS JOIN "permissions" permission
WHERE
  admin_role."code" = 'admin'
  AND permission."code" IN (
    'finance.view',
    'finance.post',
    'finance.adjust',
    'finance.manage',
    'finance.close',
    'data.analytics.view'
  )
ON CONFLICT DO NOTHING;

INSERT INTO "id_business_v2_scope_versions" ("scope", "version")
VALUES
  ('finance-accounts', 0),
  ('finance-ledger', 0),
  ('finance-reports', 0)
ON CONFLICT ("scope") DO NOTHING;

CREATE OR REPLACE FUNCTION public.id_business_v2_prevent_finance_line_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' AND right(current_database(), 11) = '_acceptance' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'Posted finance journal lines are immutable'
    USING ERRCODE = '55000';
END;
$function$;

CREATE TRIGGER id_business_v2_finance_journal_lines_immutable
BEFORE UPDATE OR DELETE ON public.id_business_v2_finance_journal_lines
FOR EACH ROW EXECUTE FUNCTION public.id_business_v2_prevent_finance_line_mutation();

CREATE OR REPLACE FUNCTION public.id_business_v2_prevent_finance_journal_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' AND right(current_database(), 11) = '_acceptance' THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'UPDATE'
    AND OLD."status" = 'posted'::"IdBusinessV2FinanceJournalStatus"
    AND NEW."status" = 'reversed'::"IdBusinessV2FinanceJournalStatus"
    AND NEW."reversed_at" IS NOT NULL
    AND (
      to_jsonb(NEW) - ARRAY['status', 'reversed_at', 'updated_at']
    ) = (
      to_jsonb(OLD) - ARRAY['status', 'reversed_at', 'updated_at']
    )
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION 'Posted finance journals can only be reversed'
    USING ERRCODE = '55000';
END;
$function$;

CREATE TRIGGER id_business_v2_finance_journals_immutable
BEFORE UPDATE OR DELETE ON public.id_business_v2_finance_journals
FOR EACH ROW EXECUTE FUNCTION public.id_business_v2_prevent_finance_journal_mutation();

CREATE OR REPLACE FUNCTION public.id_business_v2_reject_closed_finance_period()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM public.id_business_v2_finance_periods period
    WHERE
      period.month = NEW.period_month
      AND period.status = 'closed'::"IdBusinessV2FinancePeriodStatus"
  ) THEN
    RAISE EXCEPTION 'Finance period % is closed', NEW.period_month
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER id_business_v2_finance_journals_closed_period
BEFORE INSERT ON public.id_business_v2_finance_journals
FOR EACH ROW EXECUTE FUNCTION public.id_business_v2_reject_closed_finance_period();

CREATE OR REPLACE FUNCTION public.id_business_v2_check_finance_journal_balance()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
DECLARE
  target_journal_id uuid;
  debit_total numeric(24,4);
  credit_total numeric(24,4);
BEGIN
  target_journal_id := COALESCE(NEW.journal_id, OLD.journal_id);

  SELECT
    COALESCE(SUM(CASE WHEN direction = 'debit' THEN amount_cny ELSE 0 END), 0),
    COALESCE(SUM(CASE WHEN direction = 'credit' THEN amount_cny ELSE 0 END), 0)
  INTO debit_total, credit_total
  FROM public.id_business_v2_finance_journal_lines
  WHERE journal_id = target_journal_id;

  IF debit_total <> credit_total THEN
    RAISE EXCEPTION 'Finance journal % is not balanced: debit %, credit %',
      target_journal_id,
      debit_total,
      credit_total
      USING ERRCODE = '23514';
  END IF;

  RETURN NULL;
END;
$function$;

CREATE CONSTRAINT TRIGGER id_business_v2_finance_journal_balance
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_finance_journal_lines
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION public.id_business_v2_check_finance_journal_balance();

CREATE TRIGGER id_business_v2_finance_accounts_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_finance_accounts
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change(
  'finance-accounts',
  'finance-reports'
);

CREATE TRIGGER id_business_v2_finance_journals_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_finance_journals
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change(
  'finance-ledger',
  'finance-reports'
);

CREATE TRIGGER id_business_v2_finance_journal_lines_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_finance_journal_lines
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change(
  'finance-ledger',
  'finance-reports'
);

CREATE TRIGGER id_business_v2_finance_expenses_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_finance_expenses
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change(
  'finance-ledger',
  'finance-reports'
);

CREATE TRIGGER id_business_v2_finance_periods_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_finance_periods
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change(
  'finance-ledger',
  'finance-reports'
);

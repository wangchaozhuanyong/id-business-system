ALTER TABLE "id_business_v2_orders"
ADD COLUMN "balance_currency_code" VARCHAR(3);

UPDATE "id_business_v2_orders" target
SET "balance_currency_code" = UPPER(country."currency_code")
FROM "id_business_v2_accounts" account
INNER JOIN "id_business_v2_options" country
  ON country."id" = account."country_option_id"
WHERE target."account_id" = account."id"
  AND country."currency_code" IS NOT NULL;

CREATE TABLE "id_business_v2_order_balance_returns" (
  "id" UUID NOT NULL,
  "order_id" UUID NOT NULL,
  "account_id" UUID NOT NULL,
  "active_key" VARCHAR(80),
  "status" "IdBusinessV2OrderBalanceReturnStatus" NOT NULL DEFAULT 'active',
  "currency_code" VARCHAR(3) NOT NULL,
  "returned_balance_amount" DECIMAL(18, 4) NOT NULL,
  "restored_balance_cost_amount" DECIMAL(18, 4) NOT NULL,
  "restored_applied_balance_cost_amount" DECIMAL(18, 4) NOT NULL,
  "original_profit_amount" DECIMAL(18, 4) NOT NULL,
  "adjusted_profit_amount" DECIMAL(18, 4) NOT NULL,
  "balance_ledger_entry_id" UUID NOT NULL,
  "finance_journal_id" UUID,
  "idempotency_key" VARCHAR(160) NOT NULL,
  "reason" TEXT NOT NULL,
  "created_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "reversal_balance_ledger_entry_id" UUID,
  "reversal_finance_journal_id" UUID,
  "reversal_idempotency_key" VARCHAR(160),
  "reversal_reason" TEXT,
  "reversed_by_user_id" UUID,
  "reversed_at" TIMESTAMPTZ(6),

  CONSTRAINT "id_business_v2_order_balance_returns_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "id_business_v2_order_balance_returns_order_id_fkey"
    FOREIGN KEY ("order_id") REFERENCES "id_business_v2_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "id_business_v2_order_balance_returns_account_id_fkey"
    FOREIGN KEY ("account_id") REFERENCES "id_business_v2_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "id_business_v2_order_balance_returns_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "id_business_v2_order_balance_returns_reversed_by_user_id_fkey"
    FOREIGN KEY ("reversed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "id_business_v2_order_balance_returns_amount_check"
    CHECK (
      "returned_balance_amount" > 0
      AND "restored_balance_cost_amount" >= 0
      AND "restored_applied_balance_cost_amount" >= 0
      AND "restored_applied_balance_cost_amount" <= "restored_balance_cost_amount"
    ),
  CONSTRAINT "id_business_v2_order_balance_returns_state_check"
    CHECK (
      (
        "status" = 'active'
        AND "active_key" IS NOT NULL
        AND "reversal_balance_ledger_entry_id" IS NULL
        AND "reversal_finance_journal_id" IS NULL
        AND "reversal_idempotency_key" IS NULL
        AND "reversal_reason" IS NULL
        AND "reversed_by_user_id" IS NULL
        AND "reversed_at" IS NULL
      )
      OR (
        "status" = 'reversed'
        AND "active_key" IS NULL
        AND "reversal_balance_ledger_entry_id" IS NOT NULL
        AND "reversal_idempotency_key" IS NOT NULL
        AND "reversal_reason" IS NOT NULL
        AND "reversed_at" IS NOT NULL
      )
    )
);

CREATE UNIQUE INDEX "id_business_v2_order_balance_returns_active_key_key"
ON "id_business_v2_order_balance_returns"("active_key");

CREATE UNIQUE INDEX "id_business_v2_order_balance_returns_balance_ledger_entry_id_key"
ON "id_business_v2_order_balance_returns"("balance_ledger_entry_id");

CREATE UNIQUE INDEX "id_business_v2_order_balance_returns_finance_journal_id_key"
ON "id_business_v2_order_balance_returns"("finance_journal_id");

CREATE UNIQUE INDEX "id_business_v2_order_balance_returns_idempotency_key_key"
ON "id_business_v2_order_balance_returns"("idempotency_key");

CREATE UNIQUE INDEX "id_business_v2_order_balance_returns_reversal_balance_ledger_entry_id_key"
ON "id_business_v2_order_balance_returns"("reversal_balance_ledger_entry_id");

CREATE UNIQUE INDEX "id_business_v2_order_balance_returns_reversal_finance_journal_id_key"
ON "id_business_v2_order_balance_returns"("reversal_finance_journal_id");

CREATE UNIQUE INDEX "id_business_v2_order_balance_returns_reversal_idempotency_key_key"
ON "id_business_v2_order_balance_returns"("reversal_idempotency_key");

CREATE INDEX "id_business_v2_order_balance_returns_order_id_created_at_idx"
ON "id_business_v2_order_balance_returns"("order_id", "created_at");

CREATE INDEX "id_business_v2_order_balance_returns_account_id_created_at_idx"
ON "id_business_v2_order_balance_returns"("account_id", "created_at");

CREATE INDEX "id_business_v2_order_balance_returns_status_created_at_idx"
ON "id_business_v2_order_balance_returns"("status", "created_at");

CREATE INDEX "id_business_v2_order_balance_returns_created_by_user_id_idx"
ON "id_business_v2_order_balance_returns"("created_by_user_id");

CREATE INDEX "id_business_v2_order_balance_returns_reversed_by_user_id_idx"
ON "id_business_v2_order_balance_returns"("reversed_by_user_id");

DROP INDEX IF EXISTS "id_business_v2_balance_ledger_order_id_entry_type_key";

CREATE INDEX "id_business_v2_balance_ledger_order_id_entry_type_idx"
ON "id_business_v2_balance_ledger"("order_id", "entry_type");

CREATE UNIQUE INDEX "id_business_v2_balance_ledger_single_order_entry_key"
ON "id_business_v2_balance_ledger"("order_id", "entry_type")
WHERE "entry_type" IN ('order_consumption', 'order_consumption_reversal');

ALTER TABLE "id_business_v2_balance_ledger"
DROP CONSTRAINT "id_business_v2_balance_ledger_business_reference_check";

ALTER TABLE "id_business_v2_balance_ledger"
ADD CONSTRAINT "id_business_v2_balance_ledger_business_reference_check"
CHECK (
  (
    "entry_type" = 'gift_card_credit'
    AND "direction" = 'credit'
    AND "gift_card_id" IS NOT NULL
    AND "order_id" IS NULL
    AND "reversal_of_entry_id" IS NULL
  )
  OR (
    "entry_type" IN ('gift_card_redeemed', 'gift_card_withdrawal')
    AND "direction" = 'debit'
    AND "gift_card_id" IS NOT NULL
    AND "order_id" IS NULL
    AND "reversal_of_entry_id" IS NOT NULL
  )
  OR (
    "entry_type" = 'order_consumption'
    AND "direction" = 'debit'
    AND "gift_card_id" IS NULL
    AND "order_id" IS NOT NULL
    AND "reversal_of_entry_id" IS NULL
  )
  OR (
    "entry_type" = 'order_consumption_reversal'
    AND "direction" = 'credit'
    AND "gift_card_id" IS NULL
    AND "order_id" IS NOT NULL
    AND "reversal_of_entry_id" IS NOT NULL
  )
  OR (
    "entry_type" = 'order_upgrade_balance_return'
    AND "direction" = 'credit'
    AND "gift_card_id" IS NULL
    AND "order_id" IS NOT NULL
    AND "reversal_of_entry_id" IS NULL
  )
  OR (
    "entry_type" = 'order_upgrade_balance_return_reversal'
    AND "direction" = 'debit'
    AND "gift_card_id" IS NULL
    AND "order_id" IS NOT NULL
    AND "reversal_of_entry_id" IS NOT NULL
  )
  OR (
    "entry_type" = 'opening_balance'
    AND "direction" = 'credit'
    AND "gift_card_id" IS NULL
    AND "order_id" IS NULL
    AND "reversal_of_entry_id" IS NULL
  )
  OR (
    "entry_type" = 'manual_adjustment'
    AND "direction" = 'adjustment'
    AND "gift_card_id" IS NULL
    AND "order_id" IS NULL
    AND "reversal_of_entry_id" IS NULL
  )
  OR (
    "entry_type" = 'account_loss'
    AND "direction" IN ('debit', 'adjustment')
    AND "gift_card_id" IS NULL
    AND "order_id" IS NULL
    AND "reversal_of_entry_id" IS NULL
  )
);

CREATE OR REPLACE FUNCTION "id_business_v2_order_balance_return_guard"()
RETURNS TRIGGER AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'Upgrade balance return records cannot be deleted';
  END IF;

  IF NOT (
    OLD."status" = 'active'
    AND NEW."status" = 'reversed'
    AND NEW."active_key" IS NULL
    AND NEW."reversal_balance_ledger_entry_id" IS NOT NULL
    AND NEW."reversal_idempotency_key" IS NOT NULL
    AND NEW."reversal_reason" IS NOT NULL
    AND NEW."reversed_at" IS NOT NULL
    AND NEW."id" = OLD."id"
    AND NEW."order_id" = OLD."order_id"
    AND NEW."account_id" = OLD."account_id"
    AND NEW."currency_code" = OLD."currency_code"
    AND NEW."returned_balance_amount" = OLD."returned_balance_amount"
    AND NEW."restored_balance_cost_amount" = OLD."restored_balance_cost_amount"
    AND NEW."restored_applied_balance_cost_amount" = OLD."restored_applied_balance_cost_amount"
    AND NEW."original_profit_amount" = OLD."original_profit_amount"
    AND NEW."adjusted_profit_amount" = OLD."adjusted_profit_amount"
    AND NEW."balance_ledger_entry_id" = OLD."balance_ledger_entry_id"
    AND NEW."finance_journal_id" IS NOT DISTINCT FROM OLD."finance_journal_id"
    AND NEW."idempotency_key" = OLD."idempotency_key"
    AND NEW."reason" = OLD."reason"
    AND NEW."created_by_user_id" IS NOT DISTINCT FROM OLD."created_by_user_id"
    AND NEW."created_at" = OLD."created_at"
  ) THEN
    RAISE EXCEPTION 'Upgrade balance return snapshots are immutable';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER "id_business_v2_order_balance_returns_guard"
BEFORE UPDATE OR DELETE ON "id_business_v2_order_balance_returns"
FOR EACH ROW EXECUTE FUNCTION "id_business_v2_order_balance_return_guard"();

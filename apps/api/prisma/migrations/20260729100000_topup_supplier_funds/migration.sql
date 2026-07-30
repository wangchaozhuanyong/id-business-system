CREATE TYPE "IdBusinessV2TopupSupplierLedgerEntryType" AS ENUM (
  'opening_balance',
  'payment_credit',
  'gift_card_debit',
  'gift_card_withdrawal_reversal',
  'manual_adjustment',
  'payment_reversal'
);

ALTER TABLE "id_business_v2_gift_cards"
ADD COLUMN "country_option_id" UUID,
ADD COLUMN "country_name_snapshot" VARCHAR(160),
ADD COLUMN "currency_code_snapshot" VARCHAR(3),
ADD COLUMN "supplier_name_snapshot" VARCHAR(160);

UPDATE "id_business_v2_gift_cards" gift_card
SET
  "country_option_id" = account."country_option_id",
  "country_name_snapshot" = country_option."name",
  "currency_code_snapshot" = country_option."currency_code"
FROM "id_business_v2_accounts" account
INNER JOIN "id_business_v2_options" country_option
  ON country_option."id" = account."country_option_id"
WHERE gift_card."account_id" = account."id";

UPDATE "id_business_v2_gift_cards" gift_card
SET "supplier_name_snapshot" = supplier_option."name"
FROM "id_business_v2_options" supplier_option
WHERE gift_card."supplier_option_id" = supplier_option."id";

ALTER TABLE "id_business_v2_gift_cards"
ALTER COLUMN "country_option_id" SET NOT NULL,
ALTER COLUMN "country_name_snapshot" SET NOT NULL;

CREATE INDEX "id_business_v2_gift_cards_country_option_id_created_at_idx"
ON "id_business_v2_gift_cards"("country_option_id", "created_at");

ALTER TABLE "id_business_v2_gift_cards"
ADD CONSTRAINT "id_business_v2_gift_cards_country_option_id_fkey"
FOREIGN KEY ("country_option_id") REFERENCES "id_business_v2_options"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "id_business_v2_topup_supplier_accounts" (
  "id" UUID NOT NULL,
  "supplier_option_id" UUID NOT NULL,
  "current_balance_cny" DECIMAL(18,4) NOT NULL DEFAULT 0,
  "initialized_at" TIMESTAMPTZ(6),
  "initialized_by_user_id" UUID,
  "updated_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,

  CONSTRAINT "id_business_v2_topup_supplier_accounts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "id_business_v2_topup_supplier_accounts_initialization_check"
    CHECK (
      ("initialized_at" IS NULL AND "initialized_by_user_id" IS NULL)
      OR "initialized_at" IS NOT NULL
    )
);

CREATE UNIQUE INDEX "id_business_v2_topup_supplier_accounts_supplier_option_id_key"
ON "id_business_v2_topup_supplier_accounts"("supplier_option_id");

CREATE INDEX "id_business_v2_topup_supplier_accounts_initialized_at_idx"
ON "id_business_v2_topup_supplier_accounts"("initialized_at");

CREATE INDEX "id_business_v2_topup_supplier_accounts_current_balance_cny_idx"
ON "id_business_v2_topup_supplier_accounts"("current_balance_cny");

CREATE INDEX "id_business_v2_topup_supplier_accounts_updated_by_user_id_idx"
ON "id_business_v2_topup_supplier_accounts"("updated_by_user_id");

CREATE TABLE "id_business_v2_topup_supplier_payments" (
  "id" UUID NOT NULL,
  "supplier_account_id" UUID NOT NULL,
  "supplier_name_snapshot" VARCHAR(160) NOT NULL,
  "received_usdt" DECIMAL(18,4) NOT NULL,
  "network_fee_usdt" DECIMAL(18,4) NOT NULL DEFAULT 0,
  "settlement_rate_cny_usdt" DECIMAL(18,8) NOT NULL,
  "credited_cny" DECIMAL(18,4) NOT NULL,
  "network" VARCHAR(40),
  "transaction_hash" VARCHAR(180),
  "paid_at" TIMESTAMPTZ(6) NOT NULL,
  "remark" TEXT,
  "idempotency_key" VARCHAR(160) NOT NULL,
  "created_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "id_business_v2_topup_supplier_payments_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "id_business_v2_topup_supplier_payments_amount_check"
    CHECK (
      "received_usdt" > 0::numeric
      AND "network_fee_usdt" >= 0::numeric
      AND "settlement_rate_cny_usdt" > 0::numeric
      AND "credited_cny" > 0::numeric
    )
);

CREATE UNIQUE INDEX "id_business_v2_topup_supplier_payments_idempotency_key_key"
ON "id_business_v2_topup_supplier_payments"("idempotency_key");

CREATE INDEX "id_business_v2_topup_supplier_payments_supplier_account_id_paid_at_idx"
ON "id_business_v2_topup_supplier_payments"("supplier_account_id", "paid_at");

CREATE INDEX "id_business_v2_topup_supplier_payments_transaction_hash_idx"
ON "id_business_v2_topup_supplier_payments"("transaction_hash");

CREATE INDEX "id_business_v2_topup_supplier_payments_created_by_user_id_idx"
ON "id_business_v2_topup_supplier_payments"("created_by_user_id");

CREATE INDEX "id_business_v2_topup_supplier_payments_created_at_idx"
ON "id_business_v2_topup_supplier_payments"("created_at");

CREATE TABLE "id_business_v2_topup_supplier_ledger" (
  "id" UUID NOT NULL,
  "supplier_account_id" UUID NOT NULL,
  "payment_id" UUID,
  "gift_card_id" UUID,
  "entry_type" "IdBusinessV2TopupSupplierLedgerEntryType" NOT NULL,
  "direction" "IdBusinessV2BalanceDirection" NOT NULL,
  "amount_cny" DECIMAL(18,4) NOT NULL,
  "balance_before_cny" DECIMAL(18,4) NOT NULL,
  "balance_after_cny" DECIMAL(18,4) NOT NULL,
  "supplier_name_snapshot" VARCHAR(160) NOT NULL,
  "reversal_of_entry_id" UUID,
  "idempotency_key" VARCHAR(160) NOT NULL,
  "reason" TEXT,
  "created_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "id_business_v2_topup_supplier_ledger_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "id_business_v2_topup_supplier_ledger_amount_check"
    CHECK (
      (
        "entry_type" = 'opening_balance'::"IdBusinessV2TopupSupplierLedgerEntryType"
        AND "amount_cny" >= 0::numeric
      )
      OR "amount_cny" > 0::numeric
    ),
  CONSTRAINT "id_business_v2_topup_supplier_ledger_reference_check"
    CHECK (
      (
        "entry_type" = 'opening_balance'::"IdBusinessV2TopupSupplierLedgerEntryType"
        AND "payment_id" IS NULL
        AND "gift_card_id" IS NULL
        AND "reversal_of_entry_id" IS NULL
        AND "direction" = 'adjustment'::"IdBusinessV2BalanceDirection"
      )
      OR (
        "entry_type" = 'payment_credit'::"IdBusinessV2TopupSupplierLedgerEntryType"
        AND "payment_id" IS NOT NULL
        AND "gift_card_id" IS NULL
        AND "reversal_of_entry_id" IS NULL
        AND "direction" = 'credit'::"IdBusinessV2BalanceDirection"
      )
      OR (
        "entry_type" = 'gift_card_debit'::"IdBusinessV2TopupSupplierLedgerEntryType"
        AND "payment_id" IS NULL
        AND "gift_card_id" IS NOT NULL
        AND "reversal_of_entry_id" IS NULL
        AND "direction" = 'debit'::"IdBusinessV2BalanceDirection"
      )
      OR (
        "entry_type" = 'gift_card_withdrawal_reversal'::"IdBusinessV2TopupSupplierLedgerEntryType"
        AND "payment_id" IS NULL
        AND "gift_card_id" IS NOT NULL
        AND "reversal_of_entry_id" IS NOT NULL
        AND "direction" = 'credit'::"IdBusinessV2BalanceDirection"
      )
      OR (
        "entry_type" = 'manual_adjustment'::"IdBusinessV2TopupSupplierLedgerEntryType"
        AND "payment_id" IS NULL
        AND "reversal_of_entry_id" IS NULL
        AND "direction" = 'adjustment'::"IdBusinessV2BalanceDirection"
      )
      OR (
        "entry_type" = 'payment_reversal'::"IdBusinessV2TopupSupplierLedgerEntryType"
        AND "payment_id" IS NOT NULL
        AND "gift_card_id" IS NULL
        AND "reversal_of_entry_id" IS NOT NULL
        AND "direction" = 'debit'::"IdBusinessV2BalanceDirection"
      )
    ),
  CONSTRAINT "id_business_v2_topup_supplier_ledger_balance_check"
    CHECK (
      (
        "direction" = 'credit'::"IdBusinessV2BalanceDirection"
        AND "balance_after_cny" = "balance_before_cny" + "amount_cny"
      )
      OR (
        "direction" = 'debit'::"IdBusinessV2BalanceDirection"
        AND "balance_after_cny" = "balance_before_cny" - "amount_cny"
      )
      OR (
        "direction" = 'adjustment'::"IdBusinessV2BalanceDirection"
        AND abs("balance_after_cny" - "balance_before_cny") = "amount_cny"
      )
    )
);

CREATE UNIQUE INDEX "id_business_v2_topup_supplier_ledger_reversal_of_entry_id_key"
ON "id_business_v2_topup_supplier_ledger"("reversal_of_entry_id");

CREATE UNIQUE INDEX "id_business_v2_topup_supplier_ledger_idempotency_key_key"
ON "id_business_v2_topup_supplier_ledger"("idempotency_key");

CREATE INDEX "id_business_v2_topup_supplier_ledger_supplier_account_id_created_at_idx"
ON "id_business_v2_topup_supplier_ledger"("supplier_account_id", "created_at");

CREATE INDEX "id_business_v2_topup_supplier_ledger_payment_id_idx"
ON "id_business_v2_topup_supplier_ledger"("payment_id");

CREATE INDEX "id_business_v2_topup_supplier_ledger_gift_card_id_idx"
ON "id_business_v2_topup_supplier_ledger"("gift_card_id");

CREATE INDEX "id_business_v2_topup_supplier_ledger_entry_type_created_at_idx"
ON "id_business_v2_topup_supplier_ledger"("entry_type", "created_at");

CREATE INDEX "id_business_v2_topup_supplier_ledger_created_by_user_id_idx"
ON "id_business_v2_topup_supplier_ledger"("created_by_user_id");

ALTER TABLE "id_business_v2_topup_supplier_accounts"
ADD CONSTRAINT "id_business_v2_topup_supplier_accounts_supplier_option_id_fkey"
FOREIGN KEY ("supplier_option_id") REFERENCES "id_business_v2_options"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "id_business_v2_topup_supplier_accounts"
ADD CONSTRAINT "id_business_v2_topup_supplier_accounts_initialized_by_user_id_fkey"
FOREIGN KEY ("initialized_by_user_id") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "id_business_v2_topup_supplier_accounts"
ADD CONSTRAINT "id_business_v2_topup_supplier_accounts_updated_by_user_id_fkey"
FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "id_business_v2_topup_supplier_payments"
ADD CONSTRAINT "id_business_v2_topup_supplier_payments_supplier_account_id_fkey"
FOREIGN KEY ("supplier_account_id") REFERENCES "id_business_v2_topup_supplier_accounts"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "id_business_v2_topup_supplier_payments"
ADD CONSTRAINT "id_business_v2_topup_supplier_payments_created_by_user_id_fkey"
FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "id_business_v2_topup_supplier_ledger"
ADD CONSTRAINT "id_business_v2_topup_supplier_ledger_supplier_account_id_fkey"
FOREIGN KEY ("supplier_account_id") REFERENCES "id_business_v2_topup_supplier_accounts"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "id_business_v2_topup_supplier_ledger"
ADD CONSTRAINT "id_business_v2_topup_supplier_ledger_payment_id_fkey"
FOREIGN KEY ("payment_id") REFERENCES "id_business_v2_topup_supplier_payments"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "id_business_v2_topup_supplier_ledger"
ADD CONSTRAINT "id_business_v2_topup_supplier_ledger_gift_card_id_fkey"
FOREIGN KEY ("gift_card_id") REFERENCES "id_business_v2_gift_cards"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "id_business_v2_topup_supplier_ledger"
ADD CONSTRAINT "id_business_v2_topup_supplier_ledger_reversal_of_entry_id_fkey"
FOREIGN KEY ("reversal_of_entry_id") REFERENCES "id_business_v2_topup_supplier_ledger"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "id_business_v2_topup_supplier_ledger"
ADD CONSTRAINT "id_business_v2_topup_supplier_ledger_created_by_user_id_fkey"
FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE FUNCTION public.id_business_v2_prevent_topup_supplier_financial_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' AND right(current_database(), 11) = '_acceptance' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'Topup supplier financial records are immutable'
    USING ERRCODE = '55000';
END;
$function$;

CREATE TRIGGER id_business_v2_topup_supplier_payments_immutable
BEFORE UPDATE OR DELETE ON public.id_business_v2_topup_supplier_payments
FOR EACH ROW EXECUTE FUNCTION public.id_business_v2_prevent_topup_supplier_financial_mutation();

CREATE TRIGGER id_business_v2_topup_supplier_ledger_immutable
BEFORE UPDATE OR DELETE ON public.id_business_v2_topup_supplier_ledger
FOR EACH ROW EXECUTE FUNCTION public.id_business_v2_prevent_topup_supplier_financial_mutation();

INSERT INTO "permissions" ("id", "name", "code", "module", "action")
VALUES
  (gen_random_uuid(), '查看加卡供应商资金', 'apple.topup_supplier_fund.view', 'apple.topup_supplier_fund', 'view'),
  (gen_random_uuid(), '管理加卡供应商资金', 'apple.topup_supplier_fund.manage', 'apple.topup_supplier_fund', 'manage'),
  (gen_random_uuid(), '查看完整礼品卡号', 'apple.gift_card.view_full', 'apple.gift_card', 'view_full')
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
    'apple.topup_supplier_fund.view',
    'apple.topup_supplier_fund.manage',
    'apple.gift_card.view_full'
  )
ON CONFLICT DO NOTHING;

INSERT INTO "id_business_v2_scope_versions" ("scope", "version")
VALUES
  ('supplier-funds', 0),
  ('supplier-payments', 0)
ON CONFLICT ("scope") DO NOTHING;

DROP TRIGGER IF EXISTS id_business_v2_gift_cards_change
ON public.id_business_v2_gift_cards;

CREATE TRIGGER id_business_v2_gift_cards_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_gift_cards
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change(
  'accounts',
  'balances',
  'balance-records',
  'supplier-funds',
  'supplier-payments',
  'orders',
  'renewals',
  'order-entry-matching',
  'order-entry-manual-candidates'
);

CREATE TRIGGER id_business_v2_topup_supplier_accounts_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_topup_supplier_accounts
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change(
  'supplier-funds',
  'supplier-payments',
  'balance-records'
);

CREATE TRIGGER id_business_v2_topup_supplier_payments_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_topup_supplier_payments
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change(
  'supplier-funds',
  'supplier-payments'
);

CREATE TRIGGER id_business_v2_topup_supplier_ledger_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_topup_supplier_ledger
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change(
  'supplier-funds',
  'supplier-payments',
  'balance-records'
);

ALTER TABLE "public"."id_business_v2_balance_ledger"
DROP CONSTRAINT "id_business_v2_balance_ledger_business_reference_check";

ALTER TABLE "public"."id_business_v2_balance_ledger"
ADD CONSTRAINT "id_business_v2_balance_ledger_business_reference_check"
CHECK (
  (
    entry_type = 'gift_card_credit'::"IdBusinessV2BalanceLedgerEntryType"
    AND direction = 'credit'::"IdBusinessV2BalanceDirection"
    AND gift_card_id IS NOT NULL
    AND order_id IS NULL
    AND reversal_of_entry_id IS NULL
  )
  OR (
    entry_type = ANY (
      ARRAY[
        'gift_card_redeemed'::"IdBusinessV2BalanceLedgerEntryType",
        'gift_card_withdrawal'::"IdBusinessV2BalanceLedgerEntryType"
      ]
    )
    AND direction = 'debit'::"IdBusinessV2BalanceDirection"
    AND gift_card_id IS NOT NULL
    AND order_id IS NULL
    AND reversal_of_entry_id IS NOT NULL
  )
  OR (
    entry_type = 'order_consumption'::"IdBusinessV2BalanceLedgerEntryType"
    AND direction = 'debit'::"IdBusinessV2BalanceDirection"
    AND gift_card_id IS NULL
    AND order_id IS NOT NULL
    AND reversal_of_entry_id IS NULL
  )
  OR (
    entry_type = 'order_consumption_reversal'::"IdBusinessV2BalanceLedgerEntryType"
    AND direction = 'credit'::"IdBusinessV2BalanceDirection"
    AND gift_card_id IS NULL
    AND order_id IS NOT NULL
    AND reversal_of_entry_id IS NOT NULL
  )
  OR (
    entry_type = 'opening_balance'::"IdBusinessV2BalanceLedgerEntryType"
    AND direction = 'credit'::"IdBusinessV2BalanceDirection"
    AND gift_card_id IS NULL
    AND order_id IS NULL
    AND reversal_of_entry_id IS NULL
  )
  OR (
    entry_type = 'manual_adjustment'::"IdBusinessV2BalanceLedgerEntryType"
    AND direction = 'adjustment'::"IdBusinessV2BalanceDirection"
    AND gift_card_id IS NULL
    AND order_id IS NULL
    AND reversal_of_entry_id IS NULL
  )
  OR (
    entry_type = 'account_loss'::"IdBusinessV2BalanceLedgerEntryType"
    AND direction = 'debit'::"IdBusinessV2BalanceDirection"
    AND gift_card_id IS NULL
    AND order_id IS NULL
    AND reversal_of_entry_id IS NULL
  )
);

ALTER TABLE "public"."id_business_v2_balance_ledger"
DROP CONSTRAINT "id_business_v2_balance_ledger_movement_amount_check";

ALTER TABLE "public"."id_business_v2_balance_ledger"
ADD CONSTRAINT "id_business_v2_balance_ledger_movement_amount_check"
CHECK (
  balance_amount > 0::numeric
  OR cost_amount > 0::numeric
  OR (
    entry_type = 'account_loss'::"IdBusinessV2BalanceLedgerEntryType"
    AND balance_amount = 0::numeric
    AND cost_amount = 0::numeric
  )
);

CREATE TYPE "IdBusinessV2AccountLossSaleState" AS ENUM ('available', 'sold');

ALTER TABLE "id_business_v2_accounts"
ADD COLUMN "loss_reported_at" TIMESTAMPTZ(6);

CREATE TABLE "id_business_v2_account_losses" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "ledger_entry_id" UUID NOT NULL,
    "apple_id_masked" VARCHAR(255) NOT NULL,
    "country_option_id" UUID NOT NULL,
    "country_name" VARCHAR(160) NOT NULL,
    "currency_code" VARCHAR(3),
    "supplier_option_id" UUID,
    "supplier_name" VARCHAR(160),
    "sale_state" "IdBusinessV2AccountLossSaleState" NOT NULL,
    "sold_order_id" UUID,
    "sold_order_no" VARCHAR(40),
    "loss_balance" DECIMAL(18,4) NOT NULL,
    "loss_cost_amount" DECIMAL(18,4) NOT NULL,
    "reason" TEXT NOT NULL,
    "idempotency_key" VARCHAR(160) NOT NULL,
    "reported_by_user_id" UUID,
    "reported_by_name" VARCHAR(160),
    "reported_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "id_business_v2_account_losses_pkey" PRIMARY KEY ("id"),
    CONSTRAINT "id_business_v2_account_losses_amount_check"
      CHECK ("loss_balance" >= 0::numeric AND "loss_cost_amount" >= 0::numeric),
    CONSTRAINT "id_business_v2_account_losses_reason_check"
      CHECK (char_length(btrim("reason")) BETWEEN 2 AND 500),
    CONSTRAINT "id_business_v2_account_losses_sale_evidence_check"
      CHECK (
        (
          "sale_state" = 'available'::"IdBusinessV2AccountLossSaleState"
          AND "sold_order_id" IS NULL
          AND "sold_order_no" IS NULL
        )
        OR (
          "sale_state" = 'sold'::"IdBusinessV2AccountLossSaleState"
          AND "sold_order_id" IS NOT NULL
          AND "sold_order_no" IS NOT NULL
        )
      )
);

CREATE UNIQUE INDEX "id_business_v2_account_losses_account_id_key"
ON "id_business_v2_account_losses"("account_id");

CREATE UNIQUE INDEX "id_business_v2_account_losses_ledger_entry_id_key"
ON "id_business_v2_account_losses"("ledger_entry_id");

CREATE UNIQUE INDEX "id_business_v2_account_losses_idempotency_key_key"
ON "id_business_v2_account_losses"("idempotency_key");

CREATE INDEX "id_business_v2_account_losses_reported_at_idx"
ON "id_business_v2_account_losses"("reported_at");

CREATE INDEX "id_business_v2_account_losses_country_option_id_reported_at_idx"
ON "id_business_v2_account_losses"("country_option_id", "reported_at");

CREATE INDEX "id_business_v2_account_losses_country_name_idx"
ON "id_business_v2_account_losses"("country_name");

CREATE INDEX "id_business_v2_account_losses_sale_state_reported_at_idx"
ON "id_business_v2_account_losses"("sale_state", "reported_at");

CREATE INDEX "id_business_v2_account_losses_sold_order_id_idx"
ON "id_business_v2_account_losses"("sold_order_id");

CREATE INDEX "id_business_v2_account_losses_sold_order_no_idx"
ON "id_business_v2_account_losses"("sold_order_no");

CREATE INDEX "id_business_v2_account_losses_reported_by_user_id_idx"
ON "id_business_v2_account_losses"("reported_by_user_id");

CREATE INDEX "id_business_v2_accounts_loss_reported_at_idx"
ON "id_business_v2_accounts"("loss_reported_at");

ALTER TABLE "id_business_v2_account_losses"
ADD CONSTRAINT "id_business_v2_account_losses_account_id_fkey"
FOREIGN KEY ("account_id") REFERENCES "id_business_v2_accounts"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "id_business_v2_account_losses"
ADD CONSTRAINT "id_business_v2_account_losses_ledger_entry_id_fkey"
FOREIGN KEY ("ledger_entry_id") REFERENCES "id_business_v2_balance_ledger"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "id_business_v2_account_losses"
ADD CONSTRAINT "id_business_v2_account_losses_reported_by_user_id_fkey"
FOREIGN KEY ("reported_by_user_id") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE FUNCTION public.id_business_v2_prevent_account_loss_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'ID account loss records are immutable'
    USING ERRCODE = '55000';
END;
$function$;

CREATE TRIGGER id_business_v2_account_losses_immutable
BEFORE UPDATE OR DELETE ON public.id_business_v2_account_losses
FOR EACH ROW EXECUTE FUNCTION public.id_business_v2_prevent_account_loss_mutation();

CREATE FUNCTION public.id_business_v2_enforce_reported_account_loss()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.loss_reported_at IS NOT NULL THEN
    RAISE EXCEPTION 'Loss-reported ID accounts are permanently immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.loss_reported_at IS NOT NULL AND (
    NEW.current_balance <> 0::numeric
    OR NEW.balance_cost_amount <> 0::numeric
    OR NEW.record_status::text <> 'disabled'
    OR NOT EXISTS (
      SELECT 1
      FROM public.id_business_v2_options status_option
      WHERE
        status_option.id = NEW.status_option_id
        AND status_option.type = 'id_status'
        AND status_option.code = 'frozen'
        AND status_option.status::text = 'active'
        AND status_option.is_system = true
        AND status_option.deleted_at IS NULL
    )
    OR NOT EXISTS (
      SELECT 1
      FROM public.id_business_v2_account_losses loss_record
      WHERE loss_record.account_id = NEW.id
    )
  ) THEN
    RAISE EXCEPTION 'Loss reporting must freeze and clear the ID account atomically'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER id_business_v2_accounts_permanent_loss
BEFORE UPDATE ON public.id_business_v2_accounts
FOR EACH ROW EXECUTE FUNCTION public.id_business_v2_enforce_reported_account_loss();

DO $block$
BEGIN
  UPDATE "id_business_v2_options"
  SET
    "name" = '冻结',
    "status" = 'active',
    "is_system" = true,
    "deleted_at" = NULL,
    "updated_at" = CURRENT_TIMESTAMP
  WHERE "type" = 'id_status' AND "code" = 'frozen';

  IF NOT FOUND THEN
    UPDATE "id_business_v2_options"
    SET
      "code" = 'frozen',
      "name" = '冻结',
      "status" = 'active',
      "is_system" = true,
      "deleted_at" = NULL,
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = (
      SELECT "id"
      FROM "id_business_v2_options"
      WHERE "type" = 'id_status' AND "name" = '冻结'
      ORDER BY "created_at" ASC
      LIMIT 1
    );
  END IF;

  IF NOT FOUND THEN
    INSERT INTO "id_business_v2_options" (
      "id",
      "type",
      "code",
      "name",
      "unique_key",
      "sort_order",
      "status",
      "is_system",
      "remark",
      "created_at",
      "updated_at"
    )
    VALUES (
      gen_random_uuid(),
      'id_status',
      'frozen',
      '冻结',
      'id_status:root:冻结',
      20,
      'active',
      true,
      '系统固定报损冻结状态',
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    );
  END IF;
END;
$block$;

INSERT INTO "id_business_v2_scope_versions" ("scope", "version")
VALUES ('account-losses', 0)
ON CONFLICT ("scope") DO NOTHING;

CREATE TRIGGER id_business_v2_account_losses_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_account_losses
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change(
  'account-losses',
  'accounts',
  'balances',
  'balance-records',
  'orders',
  'activations',
  'renewals',
  'renewal-warning-summary',
  'order-entry-matching',
  'order-entry-manual-candidates'
);

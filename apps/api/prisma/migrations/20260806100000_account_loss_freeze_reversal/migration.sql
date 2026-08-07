-- Convert ID account loss from irreversible zeroing into a reversible frozen-loss lifecycle.
-- Existing loss rows stay active; future unfreeze operations reverse the finance journal instead of deleting history.

CREATE TYPE "IdBusinessV2AccountLossStatus" AS ENUM ('active', 'reversed');

ALTER TABLE "users"
ADD COLUMN "created_by_user_id" UUID;

ALTER TABLE "id_business_v2_accounts"
ADD COLUMN "active_loss_record_id" UUID;

ALTER TABLE "id_business_v2_account_losses"
ADD COLUMN "status" "IdBusinessV2AccountLossStatus" NOT NULL DEFAULT 'active',
ADD COLUMN "previous_status_option_id" UUID,
ADD COLUMN "previous_status_name" VARCHAR(160),
ADD COLUMN "previous_record_status" "IdBusinessV2RecordStatus",
ADD COLUMN "finance_journal_id" UUID,
ADD COLUMN "reversal_finance_journal_id" UUID,
ADD COLUMN "reversed_by_user_id" UUID,
ADD COLUMN "reversed_by_name" VARCHAR(160),
ADD COLUMN "reversal_reason" TEXT,
ADD COLUMN "reversed_at" TIMESTAMPTZ(6);

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
    AND direction = ANY (
      ARRAY[
        'debit'::"IdBusinessV2BalanceDirection",
        'adjustment'::"IdBusinessV2BalanceDirection"
      ]
    )
    AND gift_card_id IS NULL
    AND order_id IS NULL
    AND reversal_of_entry_id IS NULL
  )
);

DROP TRIGGER IF EXISTS id_business_v2_account_losses_immutable
ON public.id_business_v2_account_losses;

DROP TRIGGER IF EXISTS id_business_v2_accounts_permanent_loss
ON public.id_business_v2_accounts;

UPDATE "id_business_v2_account_losses" loss
SET "finance_journal_id" = journal."id"
FROM "id_business_v2_finance_journals" journal
WHERE
  journal."source_type" = 'account_loss'
  AND journal."journal_type" = 'account_loss'
  AND journal."source_id" = loss."id"::text;

UPDATE "id_business_v2_accounts" account
SET "active_loss_record_id" = loss."id"
FROM "id_business_v2_account_losses" loss
WHERE
  loss."account_id" = account."id"
  AND account."loss_reported_at" IS NOT NULL
  AND loss."status" = 'active';

DROP INDEX IF EXISTS "id_business_v2_account_losses_account_id_key";

CREATE UNIQUE INDEX "id_business_v2_accounts_active_loss_record_id_key"
ON "id_business_v2_accounts"("active_loss_record_id");

CREATE INDEX "users_created_by_user_id_idx"
ON "users"("created_by_user_id");

CREATE INDEX "id_business_v2_account_losses_account_id_idx"
ON "id_business_v2_account_losses"("account_id");

CREATE INDEX "id_business_v2_account_losses_status_reported_at_idx"
ON "id_business_v2_account_losses"("status", "reported_at");

CREATE UNIQUE INDEX "id_business_v2_account_losses_finance_journal_id_key"
ON "id_business_v2_account_losses"("finance_journal_id");

CREATE UNIQUE INDEX "id_business_v2_account_losses_reversal_finance_journal_id_key"
ON "id_business_v2_account_losses"("reversal_finance_journal_id");

CREATE INDEX "id_business_v2_account_losses_reversed_by_user_id_idx"
ON "id_business_v2_account_losses"("reversed_by_user_id");

ALTER TABLE "users"
ADD CONSTRAINT "users_created_by_user_id_fkey"
FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "id_business_v2_accounts"
ADD CONSTRAINT "id_business_v2_accounts_active_loss_record_id_fkey"
FOREIGN KEY ("active_loss_record_id") REFERENCES "id_business_v2_account_losses"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "id_business_v2_account_losses"
ADD CONSTRAINT "id_business_v2_account_losses_reversed_by_user_id_fkey"
FOREIGN KEY ("reversed_by_user_id") REFERENCES "users"("id")
ON DELETE SET NULL ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION public.id_business_v2_prevent_account_loss_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'ID account loss records cannot be deleted'
      USING ERRCODE = '55000';
  END IF;

  IF TG_OP = 'UPDATE' AND (
    NEW.id IS DISTINCT FROM OLD.id
    OR NEW.account_id IS DISTINCT FROM OLD.account_id
    OR NEW.ledger_entry_id IS DISTINCT FROM OLD.ledger_entry_id
    OR NEW.apple_id_masked IS DISTINCT FROM OLD.apple_id_masked
    OR NEW.country_option_id IS DISTINCT FROM OLD.country_option_id
    OR NEW.country_name IS DISTINCT FROM OLD.country_name
    OR NEW.currency_code IS DISTINCT FROM OLD.currency_code
    OR NEW.supplier_option_id IS DISTINCT FROM OLD.supplier_option_id
    OR NEW.supplier_name IS DISTINCT FROM OLD.supplier_name
    OR NEW.sale_state IS DISTINCT FROM OLD.sale_state
    OR NEW.sold_order_id IS DISTINCT FROM OLD.sold_order_id
    OR NEW.sold_order_no IS DISTINCT FROM OLD.sold_order_no
    OR NEW.loss_balance IS DISTINCT FROM OLD.loss_balance
    OR NEW.loss_cost_amount IS DISTINCT FROM OLD.loss_cost_amount
    OR NEW.id_purchase_cost_loss_amount IS DISTINCT FROM OLD.id_purchase_cost_loss_amount
    OR NEW.reason IS DISTINCT FROM OLD.reason
    OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
    OR NEW.reported_by_user_id IS DISTINCT FROM OLD.reported_by_user_id
    OR NEW.reported_by_name IS DISTINCT FROM OLD.reported_by_name
    OR NEW.reported_at IS DISTINCT FROM OLD.reported_at
  ) THEN
    RAISE EXCEPTION 'ID account loss snapshot fields are immutable'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER id_business_v2_account_losses_immutable
BEFORE UPDATE OR DELETE ON public.id_business_v2_account_losses
FOR EACH ROW EXECUTE FUNCTION public.id_business_v2_prevent_account_loss_mutation();

CREATE OR REPLACE FUNCTION public.id_business_v2_enforce_reported_account_loss()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  IF OLD.loss_reported_at IS NOT NULL AND NEW.loss_reported_at IS NOT NULL THEN
    RAISE EXCEPTION 'Loss-reported ID accounts are frozen until unfreeze is completed'
      USING ERRCODE = '55000';
  END IF;

  IF NEW.loss_reported_at IS NOT NULL AND (
    NEW.record_status::text <> 'disabled'
    OR NEW.active_loss_record_id IS NULL
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
      WHERE
        loss_record.id = NEW.active_loss_record_id
        AND loss_record.account_id = NEW.id
        AND loss_record.status = 'active'
    )
  ) THEN
    RAISE EXCEPTION 'Loss reporting must freeze the ID account and link an active loss record atomically'
      USING ERRCODE = '23514';
  END IF;

  IF OLD.loss_reported_at IS NOT NULL AND NEW.loss_reported_at IS NULL AND (
    OLD.active_loss_record_id IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM public.id_business_v2_account_losses loss_record
      WHERE
        loss_record.id = OLD.active_loss_record_id
        AND loss_record.account_id = OLD.id
        AND loss_record.status = 'reversed'
        AND loss_record.reversed_at IS NOT NULL
        AND loss_record.reversal_finance_journal_id IS NOT NULL
    )
  ) THEN
    RAISE EXCEPTION 'Loss-reported ID accounts can only unfreeze after loss reversal is posted'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER id_business_v2_accounts_permanent_loss
BEFORE UPDATE ON public.id_business_v2_accounts
FOR EACH ROW EXECUTE FUNCTION public.id_business_v2_enforce_reported_account_loss();

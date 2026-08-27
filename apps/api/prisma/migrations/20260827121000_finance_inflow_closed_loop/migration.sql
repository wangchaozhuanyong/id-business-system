CREATE TABLE "id_business_v2_finance_inflows" (
  "id" UUID NOT NULL,
  "journal_id" UUID NOT NULL,
  "nature" "IdBusinessV2FinanceInflowNature" NOT NULL,
  "category_option_id" UUID,
  "category_name_snapshot" VARCHAR(160),
  "finance_account_id" UUID NOT NULL,
  "finance_account_name_snapshot" VARCHAR(160) NOT NULL,
  "fx_rate_snapshot_id" UUID,
  "currency" "IdBusinessV2FinanceCurrency" NOT NULL,
  "amount_original" DECIMAL(18, 4) NOT NULL,
  "fx_rate_to_cny" DECIMAL(18, 8) NOT NULL,
  "amount_cny" DECIMAL(18, 4) NOT NULL,
  "occurred_at" TIMESTAMPTZ(6) NOT NULL,
  "payer" VARCHAR(200),
  "external_reference" VARCHAR(200) NOT NULL,
  "receipt_attachment_id" UUID NOT NULL,
  "remark" TEXT,
  "idempotency_key" VARCHAR(180) NOT NULL,
  "created_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "id_business_v2_finance_inflows_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "id_business_v2_finance_inflows_amount_check"
    CHECK ("amount_original" > 0 AND "fx_rate_to_cny" > 0 AND "amount_cny" > 0),
  CONSTRAINT "id_business_v2_finance_inflows_category_check"
    CHECK (
      (
        "nature" = 'operating_income'
        AND "category_option_id" IS NOT NULL
        AND "category_name_snapshot" IS NOT NULL
      )
      OR (
        "nature" IN ('capital_contribution', 'borrowed_funds')
        AND "category_option_id" IS NULL
        AND "category_name_snapshot" IS NULL
      )
    ),
  CONSTRAINT "id_business_v2_finance_inflows_journal_id_fkey"
    FOREIGN KEY ("journal_id") REFERENCES "id_business_v2_finance_journals"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "id_business_v2_finance_inflows_category_option_id_fkey"
    FOREIGN KEY ("category_option_id") REFERENCES "id_business_v2_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "id_business_v2_finance_inflows_finance_account_id_fkey"
    FOREIGN KEY ("finance_account_id") REFERENCES "id_business_v2_finance_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "id_business_v2_finance_inflows_fx_rate_snapshot_id_fkey"
    FOREIGN KEY ("fx_rate_snapshot_id") REFERENCES "id_business_v2_finance_fx_rate_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "id_business_v2_finance_inflows_receipt_attachment_id_fkey"
    FOREIGN KEY ("receipt_attachment_id") REFERENCES "attachments"("id") ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "id_business_v2_finance_inflows_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "id_business_v2_finance_inflows_journal_id_key"
ON "id_business_v2_finance_inflows"("journal_id");

CREATE UNIQUE INDEX "id_business_v2_finance_inflows_idempotency_key_key"
ON "id_business_v2_finance_inflows"("idempotency_key");

CREATE INDEX "id_business_v2_finance_inflows_nature_occurred_at_idx"
ON "id_business_v2_finance_inflows"("nature", "occurred_at");

CREATE INDEX "id_business_v2_finance_inflows_category_occurred_at_idx"
ON "id_business_v2_finance_inflows"("category_option_id", "occurred_at");

CREATE INDEX "id_business_v2_finance_inflows_account_occurred_at_idx"
ON "id_business_v2_finance_inflows"("finance_account_id", "occurred_at");

CREATE INDEX "id_business_v2_finance_inflows_currency_occurred_at_idx"
ON "id_business_v2_finance_inflows"("currency", "occurred_at");

CREATE INDEX "id_business_v2_finance_inflows_external_reference_idx"
ON "id_business_v2_finance_inflows"("external_reference");

CREATE INDEX "id_business_v2_finance_inflows_fx_rate_snapshot_id_idx"
ON "id_business_v2_finance_inflows"("fx_rate_snapshot_id");

CREATE INDEX "id_business_v2_finance_inflows_receipt_attachment_id_idx"
ON "id_business_v2_finance_inflows"("receipt_attachment_id");

CREATE INDEX "id_business_v2_finance_inflows_created_by_user_id_idx"
ON "id_business_v2_finance_inflows"("created_by_user_id");

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
  (gen_random_uuid(), 'income_category', 'extra_service', '额外服务收入', 'income_category:root:额外服务收入', 10, 'active', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'income_category', 'commission', '佣金收入', 'income_category:root:佣金收入', 20, 'active', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'income_category', 'rebate', '返利收入', 'income_category:root:返利收入', 30, 'active', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'income_category', 'fee_income', '手续费收入', 'income_category:root:手续费收入', 40, 'active', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP),
  (gen_random_uuid(), 'income_category', 'other_operating', '其他经营收入', 'income_category:root:其他经营收入', 50, 'active', false, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
ON CONFLICT ("unique_key") DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'id_business_v2_runtime') THEN
    GRANT SELECT, INSERT
      ON TABLE public.id_business_v2_finance_inflows
      TO id_business_v2_runtime;
    REVOKE UPDATE, DELETE
      ON TABLE public.id_business_v2_finance_inflows
      FROM id_business_v2_runtime;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'id_business_v2_audit') THEN
    GRANT SELECT
      ON TABLE public.id_business_v2_finance_inflows
      TO id_business_v2_audit;
  END IF;
END
$$;

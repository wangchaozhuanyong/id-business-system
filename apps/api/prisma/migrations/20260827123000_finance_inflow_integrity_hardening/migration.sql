ALTER TABLE "attachments"
  ADD COLUMN "content_encrypted" TEXT,
  ADD COLUMN "content_sha256" CHAR(64),
  ADD CONSTRAINT "attachments_encrypted_content_pair_check"
    CHECK (("content_encrypted" IS NULL) = ("content_sha256" IS NULL));

CREATE TYPE "IdBusinessV2FinanceIncomeReferenceSource" AS ENUM ('inflow', 'order');

CREATE TABLE "id_business_v2_finance_income_references" (
  "normalized_reference" VARCHAR(200) NOT NULL,
  "source_type" "IdBusinessV2FinanceIncomeReferenceSource" NOT NULL,
  "first_inflow_id" UUID,
  "order_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "id_business_v2_finance_income_references_pkey"
    PRIMARY KEY ("normalized_reference"),
  CONSTRAINT "finance_income_references_owner_check"
    CHECK (
      ("source_type" = 'inflow' AND "first_inflow_id" IS NOT NULL AND "order_id" IS NULL)
      OR
      ("source_type" = 'order' AND "first_inflow_id" IS NULL AND "order_id" IS NOT NULL)
    ),
  CONSTRAINT "finance_income_references_inflow_fkey"
    FOREIGN KEY ("first_inflow_id") REFERENCES "id_business_v2_finance_inflows"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "finance_income_references_order_fkey"
    FOREIGN KEY ("order_id") REFERENCES "id_business_v2_orders"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX "finance_income_refs_first_inflow_idx"
ON "id_business_v2_finance_income_references"("first_inflow_id");

CREATE INDEX "finance_income_refs_order_idx"
ON "id_business_v2_finance_income_references"("order_id");

INSERT INTO "id_business_v2_finance_income_references" (
  "normalized_reference",
  "source_type",
  "order_id",
  "created_at"
)
SELECT lower(btrim("order_no")), 'order', "id", "created_at"
FROM "id_business_v2_orders"
WHERE "deleted_at" IS NULL
ON CONFLICT ("normalized_reference") DO NOTHING;

INSERT INTO "id_business_v2_finance_income_references" (
  "normalized_reference",
  "source_type",
  "order_id",
  "created_at"
)
SELECT lower(btrim("platform_order_no")), 'order', "id", "created_at"
FROM "id_business_v2_orders"
WHERE "deleted_at" IS NULL
  AND "platform_order_no" IS NOT NULL
  AND btrim("platform_order_no") <> ''
ON CONFLICT ("normalized_reference") DO NOTHING;

INSERT INTO "id_business_v2_finance_income_references" (
  "normalized_reference",
  "source_type",
  "first_inflow_id",
  "created_at"
)
SELECT DISTINCT ON (lower(btrim("external_reference")))
  lower(btrim("external_reference")),
  'inflow',
  "id",
  "created_at"
FROM "id_business_v2_finance_inflows"
WHERE "external_reference" IS NOT NULL
  AND btrim("external_reference") <> ''
ORDER BY lower(btrim("external_reference")), "created_at", "id"
ON CONFLICT ("normalized_reference") DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'id_business_v2_runtime') THEN
    GRANT SELECT, INSERT
      ON TABLE public.id_business_v2_finance_income_references
      TO id_business_v2_runtime;
    REVOKE UPDATE, DELETE
      ON TABLE public.id_business_v2_finance_income_references
      FROM id_business_v2_runtime;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'id_business_v2_audit') THEN
    GRANT SELECT
      ON TABLE public.id_business_v2_finance_income_references
      TO id_business_v2_audit;
  END IF;
END
$$;

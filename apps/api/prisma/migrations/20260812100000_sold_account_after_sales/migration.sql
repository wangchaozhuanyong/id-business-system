CREATE TYPE "IdBusinessV2OrderAccountSource" AS ENUM ('inventory', 'customer_owned');

ALTER TABLE "id_business_v2_orders"
ADD COLUMN "account_source" "IdBusinessV2OrderAccountSource" NOT NULL DEFAULT 'inventory',
ADD COLUMN "source_sold_order_id" UUID,
ADD COLUMN "applied_account_cost_amount" DECIMAL(18, 4) NOT NULL DEFAULT 0;

UPDATE "id_business_v2_orders"
SET "applied_account_cost_amount" = CASE
  WHEN "account_disposition" = 'sold' THEN "account_cost_amount"
  ELSE 0
END;

ALTER TABLE "id_business_v2_orders"
ADD CONSTRAINT "id_business_v2_orders_source_sold_order_id_fkey"
FOREIGN KEY ("source_sold_order_id")
REFERENCES "id_business_v2_orders"("id")
ON DELETE RESTRICT
ON UPDATE CASCADE;

ALTER TABLE "id_business_v2_orders"
ADD CONSTRAINT "id_business_v2_orders_account_source_check"
CHECK (
  (
    "account_source" = 'inventory'
    AND "source_sold_order_id" IS NULL
  )
  OR
  (
    "account_source" = 'customer_owned'
    AND "source_sold_order_id" IS NOT NULL
    AND "source_sold_order_id" <> "id"
    AND "account_disposition" = 'retained'
    AND "account_cost_amount" = 0
    AND "applied_account_cost_amount" = 0
  )
);

ALTER TABLE "id_business_v2_orders"
ADD CONSTRAINT "id_business_v2_orders_applied_account_cost_check"
CHECK (
  "applied_account_cost_amount" >= 0
  AND (
    (
      "account_source" = 'inventory'
      AND "account_disposition" = 'sold'
      AND "applied_account_cost_amount" = "account_cost_amount"
    )
    OR
    (
      NOT (
        "account_source" = 'inventory'
        AND "account_disposition" = 'sold'
      )
      AND "applied_account_cost_amount" = 0
    )
  )
);

CREATE INDEX "id_business_v2_orders_account_source_status_changed_at_idx"
ON "id_business_v2_orders"("account_source", "status", "status_changed_at");

CREATE INDEX "id_business_v2_orders_source_sold_order_id_idx"
ON "id_business_v2_orders"("source_sold_order_id");

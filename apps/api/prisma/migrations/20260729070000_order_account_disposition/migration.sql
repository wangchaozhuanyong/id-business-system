-- CreateEnum
CREATE TYPE "IdBusinessV2OrderAccountDisposition" AS ENUM ('retained', 'sold', 'recovered');

-- AlterTable
ALTER TABLE "id_business_v2_orders"
ADD COLUMN "account_disposition" "IdBusinessV2OrderAccountDisposition" NOT NULL DEFAULT 'retained';

ALTER TABLE "id_business_v2_accounts"
ADD COLUMN "sold_by_order_id" UUID,
ADD COLUMN "sold_at" TIMESTAMPTZ(6);

-- CreateIndex
CREATE INDEX "id_business_v2_orders_account_disposition_idx"
ON "id_business_v2_orders"("account_disposition");

CREATE UNIQUE INDEX "id_business_v2_accounts_sold_by_order_id_key"
ON "id_business_v2_accounts"("sold_by_order_id");

-- AddConstraint
ALTER TABLE "id_business_v2_accounts"
ADD CONSTRAINT "id_business_v2_accounts_sale_evidence_check"
CHECK (
  ("sold_by_order_id" IS NULL AND "sold_at" IS NULL)
  OR
  ("sold_by_order_id" IS NOT NULL AND "sold_at" IS NOT NULL)
);

ALTER TABLE "id_business_v2_accounts"
ADD CONSTRAINT "id_business_v2_accounts_sold_by_order_id_fkey"
FOREIGN KEY ("sold_by_order_id")
REFERENCES "id_business_v2_orders"("id")
ON DELETE RESTRICT
ON UPDATE CASCADE;

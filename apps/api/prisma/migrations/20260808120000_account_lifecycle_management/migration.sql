ALTER TABLE "id_business_v2_accounts"
ADD COLUMN "disabled_reason" TEXT,
ADD COLUMN "disabled_at" TIMESTAMPTZ(6);

UPDATE "id_business_v2_accounts"
SET
  "disabled_reason" = COALESCE(NULLIF(BTRIM("remark"), ''), '历史停用记录，原因待补充'),
  "disabled_at" = COALESCE("updated_at", "created_at")
WHERE
  "record_status" = 'disabled'
  AND "deleted_at" IS NULL;

ALTER TABLE "id_business_v2_accounts"
ADD CONSTRAINT "id_business_v2_accounts_disabled_reason_check"
CHECK (
  "deleted_at" IS NOT NULL
  OR "loss_reported_at" IS NOT NULL
  OR "record_status" <> 'disabled'
  OR (
    "disabled_reason" IS NOT NULL
    AND LENGTH(BTRIM("disabled_reason")) BETWEEN 2 AND 200
    AND "disabled_at" IS NOT NULL
  )
);

CREATE INDEX "id_business_v2_accounts_disabled_at_idx"
ON "id_business_v2_accounts"("disabled_at");

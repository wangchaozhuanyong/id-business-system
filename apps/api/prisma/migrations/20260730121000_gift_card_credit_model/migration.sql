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
  'gift_card_name',
  'apple_gift_card',
  '苹果礼品卡',
  'gift_card_name:root:苹果礼品卡',
  0,
  'active',
  false,
  '系统预置的默认卡片名称，可在选项设置中维护',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
)
ON CONFLICT ("type", "code") DO UPDATE SET
  "name" = EXCLUDED."name",
  "unique_key" = EXCLUDED."unique_key",
  "sort_order" = EXCLUDED."sort_order",
  "status" = 'active',
  "deleted_at" = NULL,
  "updated_at" = CURRENT_TIMESTAMP;

ALTER TABLE "id_business_v2_gift_cards"
  ADD COLUMN "card_name_option_id" UUID,
  ADD COLUMN "card_name_snapshot" VARCHAR(160),
  ADD COLUMN "credited_at" TIMESTAMPTZ(6);

UPDATE "id_business_v2_gift_cards"
SET
  "card_name_option_id" = (
    SELECT "id"
    FROM "id_business_v2_options"
    WHERE
      "type" = 'gift_card_name'
      AND "code" = 'apple_gift_card'
      AND "deleted_at" IS NULL
    LIMIT 1
  ),
  "card_name_snapshot" = '苹果礼品卡',
  "credited_at" = "created_at";

ALTER TABLE "id_business_v2_gift_cards"
  ALTER COLUMN "card_name_option_id" SET NOT NULL,
  ALTER COLUMN "card_name_snapshot" SET NOT NULL,
  ALTER COLUMN "credited_at" SET DEFAULT CURRENT_TIMESTAMP,
  ALTER COLUMN "credited_at" SET NOT NULL;

CREATE INDEX "id_business_v2_gift_cards_account_id_credited_at_idx"
  ON "id_business_v2_gift_cards"("account_id", "credited_at");

CREATE INDEX "id_business_v2_gift_cards_card_name_option_id_credited_at_idx"
  ON "id_business_v2_gift_cards"("card_name_option_id", "credited_at");

CREATE INDEX "id_business_v2_gift_cards_country_option_id_credited_at_idx"
  ON "id_business_v2_gift_cards"("country_option_id", "credited_at");

ALTER TABLE "id_business_v2_gift_cards"
  ADD CONSTRAINT "id_business_v2_gift_cards_card_name_option_id_fkey"
  FOREIGN KEY ("card_name_option_id")
  REFERENCES "id_business_v2_options"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

ALTER TABLE "id_business_v2_accounts"
ADD COLUMN "phone_search_tokens" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "id_business_v2_customers"
ADD COLUMN "phone_search_tokens" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "wechat_encrypted" TEXT,
ADD COLUMN "wechat_hash" VARCHAR(64),
ADD COLUMN "wechat_masked" VARCHAR(120),
ADD COLUMN "wechat_search_tokens" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "qq_encrypted" TEXT,
ADD COLUMN "qq_hash" VARCHAR(64),
ADD COLUMN "qq_masked" VARCHAR(120),
ADD COLUMN "qq_search_tokens" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
ADD COLUMN "whatsapp_search_tokens" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "id_business_v2_gift_cards"
ADD COLUMN "code_search_tokens" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE INDEX "id_business_v2_accounts_phone_search_tokens_idx"
ON "id_business_v2_accounts" USING GIN ("phone_search_tokens");

CREATE INDEX "id_business_v2_customers_phone_search_tokens_idx"
ON "id_business_v2_customers" USING GIN ("phone_search_tokens");

CREATE INDEX "id_business_v2_customers_wechat_hash_idx"
ON "id_business_v2_customers" ("wechat_hash");

CREATE INDEX "id_business_v2_customers_wechat_search_tokens_idx"
ON "id_business_v2_customers" USING GIN ("wechat_search_tokens");

CREATE INDEX "id_business_v2_customers_qq_hash_idx"
ON "id_business_v2_customers" ("qq_hash");

CREATE INDEX "id_business_v2_customers_qq_search_tokens_idx"
ON "id_business_v2_customers" USING GIN ("qq_search_tokens");

CREATE INDEX "id_business_v2_customers_whatsapp_search_tokens_idx"
ON "id_business_v2_customers" USING GIN ("whatsapp_search_tokens");

CREATE INDEX "id_business_v2_gift_cards_code_search_tokens_idx"
ON "id_business_v2_gift_cards" USING GIN ("code_search_tokens");

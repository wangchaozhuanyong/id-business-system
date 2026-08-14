ALTER TABLE "id_business_v2_accounts"
ADD COLUMN "apple_id_search_tokens" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

ALTER TABLE "id_business_v2_orders"
ADD COLUMN "website_account_search_tokens" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

CREATE INDEX "id_business_v2_accounts_apple_id_search_tokens_idx"
ON "id_business_v2_accounts" USING GIN ("apple_id_search_tokens");

CREATE INDEX "id_business_v2_orders_website_account_search_tokens_idx"
ON "id_business_v2_orders" USING GIN ("website_account_search_tokens");

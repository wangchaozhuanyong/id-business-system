CREATE TYPE "IdBusinessV2PurchaseRateRoundingMode" AS ENUM (
  'ROUND_DOWN',
  'ROUND_HALF_UP',
  'ROUND_UP'
);

CREATE TYPE "IdBusinessV2PurchaseMarketRateSource" AS ENUM ('manual');

CREATE TABLE "id_business_v2_purchase_currencies" (
  "code" VARCHAR(3) NOT NULL,
  "name_cn" VARCHAR(50) NOT NULL,
  "display_name" VARCHAR(100),
  "purchase_ratio" DECIMAL(12, 8) NOT NULL,
  "quote_unit" DECIMAL(18, 8) NOT NULL DEFAULT 1,
  "decimal_places" INTEGER NOT NULL DEFAULT 4,
  "rounding_mode" "IdBusinessV2PurchaseRateRoundingMode" NOT NULL DEFAULT 'ROUND_DOWN',
  "enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "updated_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "id_business_v2_purchase_currencies_pkey" PRIMARY KEY ("code"),
  CONSTRAINT "id_business_v2_purchase_currencies_code_check"
    CHECK ("code" ~ '^[A-Z]{3}$'),
  CONSTRAINT "id_business_v2_purchase_currencies_ratio_check"
    CHECK ("purchase_ratio" > 0 AND "purchase_ratio" <= 1),
  CONSTRAINT "id_business_v2_purchase_currencies_quote_unit_check"
    CHECK ("quote_unit" > 0),
  CONSTRAINT "id_business_v2_purchase_currencies_decimal_places_check"
    CHECK ("decimal_places" >= 0 AND "decimal_places" <= 8)
);

CREATE TABLE "id_business_v2_purchase_rate_snapshots" (
  "id" UUID NOT NULL,
  "currency_code" VARCHAR(3) NOT NULL,
  "market_rate_cny_per_unit" DECIMAL(18, 8) NOT NULL,
  "purchase_ratio" DECIMAL(12, 8) NOT NULL,
  "quote_unit" DECIMAL(18, 8) NOT NULL,
  "purchase_rate_raw" DECIMAL(18, 8) NOT NULL,
  "purchase_rate_display" DECIMAL(18, 8) NOT NULL,
  "decimal_places" INTEGER NOT NULL,
  "rounding_mode" "IdBusinessV2PurchaseRateRoundingMode" NOT NULL,
  "market_rate_source" "IdBusinessV2PurchaseMarketRateSource" NOT NULL DEFAULT 'manual',
  "market_rate_source_reference" VARCHAR(500),
  "market_rate_captured_at" TIMESTAMPTZ(6) NOT NULL,
  "created_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "id_business_v2_purchase_rate_snapshots_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "id_business_v2_purchase_rate_snapshots_values_check"
    CHECK (
      "market_rate_cny_per_unit" > 0
      AND "purchase_ratio" > 0
      AND "purchase_ratio" <= 1
      AND "quote_unit" > 0
      AND "purchase_rate_raw" > 0
      AND "purchase_rate_display" >= 0
      AND "decimal_places" >= 0
      AND "decimal_places" <= 8
    )
);

CREATE INDEX "id_business_v2_purchase_currencies_enabled_sort_order_idx"
  ON "id_business_v2_purchase_currencies"("enabled", "sort_order");
CREATE INDEX "id_business_v2_purchase_currencies_updated_by_user_id_idx"
  ON "id_business_v2_purchase_currencies"("updated_by_user_id");
CREATE INDEX "id_business_v2_purchase_rate_snapshots_currency_code_created_at_idx"
  ON "id_business_v2_purchase_rate_snapshots"("currency_code", "created_at");
CREATE INDEX "id_business_v2_purchase_rate_snapshots_market_rate_captured_at_idx"
  ON "id_business_v2_purchase_rate_snapshots"("market_rate_captured_at");
CREATE INDEX "id_business_v2_purchase_rate_snapshots_created_by_user_id_idx"
  ON "id_business_v2_purchase_rate_snapshots"("created_by_user_id");

ALTER TABLE "id_business_v2_purchase_currencies"
  ADD CONSTRAINT "id_business_v2_purchase_currencies_updated_by_user_id_fkey"
  FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "id_business_v2_purchase_rate_snapshots"
  ADD CONSTRAINT "id_business_v2_purchase_rate_snapshots_currency_code_fkey"
  FOREIGN KEY ("currency_code") REFERENCES "id_business_v2_purchase_currencies"("code")
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "id_business_v2_purchase_rate_snapshots"
  ADD CONSTRAINT "id_business_v2_purchase_rate_snapshots_created_by_user_id_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "id_business_v2_purchase_currencies" (
  "code",
  "name_cn",
  "display_name",
  "purchase_ratio",
  "quote_unit",
  "decimal_places",
  "rounding_mode",
  "enabled",
  "sort_order"
)
VALUES
  ('USD', '美元', '美元', 0.70000000, 1, 4, 'ROUND_DOWN', TRUE, 1),
  ('EUR', '欧元', '欧元', 0.60000000, 1, 4, 'ROUND_DOWN', TRUE, 2),
  ('GBP', '英镑', '英镑', 0.65000000, 1, 4, 'ROUND_DOWN', TRUE, 3),
  ('MYR', '马币', '马币', 0.72000000, 1, 4, 'ROUND_DOWN', TRUE, 4),
  ('SGD', '新加坡元', '新加坡元', 0.68000000, 1, 4, 'ROUND_DOWN', TRUE, 5),
  ('AUD', '澳元', '澳元', 0.70000000, 1, 4, 'ROUND_DOWN', TRUE, 6),
  ('CAD', '加元', '加元', 0.70000000, 1, 4, 'ROUND_DOWN', TRUE, 7),
  ('CHF', '瑞士法郎', '瑞士法郎', 0.70000000, 1, 4, 'ROUND_DOWN', TRUE, 8),
  ('NZD', '新西兰元', '新西兰元', 0.70000000, 1, 4, 'ROUND_DOWN', TRUE, 9),
  ('HKD', '港币', '港币', 0.70000000, 1, 4, 'ROUND_DOWN', TRUE, 10),
  ('PHP', '菲律宾比索', '菲律宾比索', 0.70000000, 1, 5, 'ROUND_DOWN', TRUE, 11),
  ('JPY', '日元', '日元', 0.70000000, 1, 5, 'ROUND_DOWN', TRUE, 12),
  ('KRW', '韩元', '韩元', 0.70000000, 1, 6, 'ROUND_DOWN', TRUE, 13),
  ('THB', '泰铢', '泰铢', 0.70000000, 1, 5, 'ROUND_DOWN', TRUE, 14),
  ('TWD', '新台币', '新台币', 0.70000000, 1, 5, 'ROUND_DOWN', TRUE, 15);

CREATE OR REPLACE FUNCTION public.prevent_id_business_v2_purchase_rate_snapshot_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $function$
BEGIN
  RAISE EXCEPTION 'purchase rate snapshots are immutable';
END;
$function$;

CREATE TRIGGER id_business_v2_purchase_rate_snapshot_immutable
BEFORE UPDATE OR DELETE ON public.id_business_v2_purchase_rate_snapshots
FOR EACH ROW EXECUTE FUNCTION public.prevent_id_business_v2_purchase_rate_snapshot_mutation();

CREATE TRIGGER id_business_v2_purchase_currencies_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_purchase_currencies
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change('exchange-rates');

CREATE TRIGGER id_business_v2_purchase_rate_snapshots_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_purchase_rate_snapshots
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change('exchange-rates');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'id_business_v2_runtime') THEN
    GRANT SELECT, INSERT, UPDATE
      ON TABLE public.id_business_v2_purchase_currencies
      TO id_business_v2_runtime;
    GRANT SELECT, INSERT
      ON TABLE public.id_business_v2_purchase_rate_snapshots
      TO id_business_v2_runtime;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'id_business_v2_audit') THEN
    GRANT SELECT
      ON TABLE
        public.id_business_v2_purchase_currencies,
        public.id_business_v2_purchase_rate_snapshots
      TO id_business_v2_audit;
  END IF;
END
$$;

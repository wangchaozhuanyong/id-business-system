-- CreateEnum
CREATE TYPE "IdBusinessV2CustomerServiceSource" AS ENUM ('manual_legacy', 'activation');

-- AlterTable
ALTER TABLE "id_business_v2_customers"
ADD COLUMN "qq" VARCHAR(120),
ADD COLUMN "whatsapp_encrypted" TEXT,
ADD COLUMN "whatsapp_hash" VARCHAR(64),
ADD COLUMN "whatsapp_masked" VARCHAR(80),
ADD COLUMN "whatsapp_tail" VARCHAR(8);

-- AlterTable
ALTER TABLE "id_business_v2_customer_services"
ADD COLUMN "source" "IdBusinessV2CustomerServiceSource" NOT NULL DEFAULT 'manual_legacy',
ADD COLUMN "first_opened_at" TIMESTAMPTZ(6),
ADD COLUMN "last_opened_at" TIMESTAMPTZ(6),
ADD COLUMN "activation_count" INTEGER NOT NULL DEFAULT 0;

ALTER TABLE "id_business_v2_customer_services"
ADD CONSTRAINT "id_business_v2_customer_services_history_evidence_check"
CHECK (
  (
    "source" = 'manual_legacy'
    AND "activation_count" = 0
    AND "first_opened_at" IS NULL
    AND "last_opened_at" IS NULL
  )
  OR
  (
    "source" = 'activation'
    AND "activation_count" > 0
    AND "first_opened_at" IS NOT NULL
    AND "last_opened_at" IS NOT NULL
    AND "first_opened_at" <= "last_opened_at"
  )
);

-- Prevent an activation created during deployment from falling between the backfill and trigger.
LOCK TABLE "id_business_v2_activations" IN SHARE ROW EXCLUSIVE MODE;
LOCK TABLE "id_business_v2_customer_services" IN SHARE ROW EXCLUSIVE MODE;

-- Backfill the durable, distinct history summary from every real activation, regardless of status.
WITH "activation_history" AS (
  SELECT
    "customer_id",
    "service_option_id",
    MIN("opened_at") AS "first_opened_at",
    MAX("opened_at") AS "last_opened_at",
    COUNT(*)::INTEGER AS "activation_count"
  FROM "id_business_v2_activations"
  GROUP BY "customer_id", "service_option_id"
)
INSERT INTO "id_business_v2_customer_services" (
  "customer_id",
  "option_id",
  "source",
  "first_opened_at",
  "last_opened_at",
  "activation_count",
  "created_at"
)
SELECT
  "customer_id",
  "service_option_id",
  'activation'::"IdBusinessV2CustomerServiceSource",
  "first_opened_at",
  "last_opened_at",
  "activation_count",
  "first_opened_at"
FROM "activation_history"
ON CONFLICT ("customer_id", "option_id") DO UPDATE SET
  "source" = 'activation',
  "first_opened_at" = EXCLUDED."first_opened_at",
  "last_opened_at" = EXCLUDED."last_opened_at",
  "activation_count" = EXCLUDED."activation_count";

-- Keep the history summary synchronized for normal orders, renewals and future activation entrypoints.
CREATE OR REPLACE FUNCTION public.id_business_v2_sync_customer_service_history()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $function$
BEGIN
  INSERT INTO public.id_business_v2_customer_services (
    customer_id,
    option_id,
    source,
    first_opened_at,
    last_opened_at,
    activation_count,
    created_at
  )
  VALUES (
    NEW.customer_id,
    NEW.service_option_id,
    'activation',
    NEW.opened_at,
    NEW.opened_at,
    1,
    NEW.opened_at
  )
  ON CONFLICT (customer_id, option_id) DO UPDATE SET
    source = 'activation',
    first_opened_at = LEAST(
      COALESCE(id_business_v2_customer_services.first_opened_at, EXCLUDED.first_opened_at),
      EXCLUDED.first_opened_at
    ),
    last_opened_at = GREATEST(
      COALESCE(id_business_v2_customer_services.last_opened_at, EXCLUDED.last_opened_at),
      EXCLUDED.last_opened_at
    ),
    activation_count = CASE
      WHEN id_business_v2_customer_services.source = 'activation'
        THEN id_business_v2_customer_services.activation_count + 1
      ELSE 1
    END;

  RETURN NEW;
END;
$function$;

CREATE TRIGGER id_business_v2_activation_customer_service_history
AFTER INSERT ON public.id_business_v2_activations
FOR EACH ROW EXECUTE FUNCTION public.id_business_v2_sync_customer_service_history();

-- CreateIndex
CREATE INDEX "id_business_v2_customers_qq_idx"
ON "id_business_v2_customers"("qq");

CREATE INDEX "id_business_v2_customers_whatsapp_hash_idx"
ON "id_business_v2_customers"("whatsapp_hash");

CREATE INDEX "id_business_v2_customers_whatsapp_tail_idx"
ON "id_business_v2_customers"("whatsapp_tail");

CREATE INDEX "id_business_v2_customer_services_source_option_id_idx"
ON "id_business_v2_customer_services"("source", "option_id");

CREATE INDEX "id_business_v2_customer_services_customer_id_source_last_opened_at_idx"
ON "id_business_v2_customer_services"("customer_id", "source", "last_opened_at");

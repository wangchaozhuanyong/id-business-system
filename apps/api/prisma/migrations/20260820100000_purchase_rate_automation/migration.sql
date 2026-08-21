CREATE TYPE "IdBusinessV2PurchaseRateFetchRunStatus" AS ENUM (
  'running',
  'success',
  'failed',
  'pending_review',
  'rejected'
);

CREATE TYPE "IdBusinessV2PurchaseRateValidationStatus" AS ENUM (
  'normal',
  'confirmed_abnormal'
);

CREATE TABLE "id_business_v2_purchase_rate_settings" (
  "id" INTEGER NOT NULL DEFAULT 1,
  "auto_enabled" BOOLEAN NOT NULL DEFAULT TRUE,
  "interval_minutes" INTEGER NOT NULL DEFAULT 60,
  "stale_minutes" INTEGER NOT NULL DEFAULT 120,
  "abnormal_change_rate" DECIMAL(9, 8) NOT NULL DEFAULT 0.10000000,
  "next_run_at" TIMESTAMPTZ(6),
  "updated_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "id_business_v2_purchase_rate_settings_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "id_business_v2_purchase_rate_settings_singleton_check" CHECK ("id" = 1),
  CONSTRAINT "id_business_v2_purchase_rate_settings_interval_check" CHECK ("interval_minutes" = 60),
  CONSTRAINT "id_business_v2_purchase_rate_settings_stale_check"
    CHECK ("stale_minutes" >= 30 AND "stale_minutes" <= 1440),
  CONSTRAINT "id_business_v2_purchase_rate_settings_abnormal_check"
    CHECK ("abnormal_change_rate" > 0 AND "abnormal_change_rate" <= 1)
);

CREATE TABLE "id_business_v2_purchase_rate_fetch_runs" (
  "id" UUID NOT NULL,
  "status" "IdBusinessV2PurchaseRateFetchRunStatus" NOT NULL DEFAULT 'running',
  "trigger_type" "IdBusinessV2ExchangeRateTriggerType" NOT NULL,
  "provider" "IdBusinessV2PurchaseMarketRateSource" NOT NULL DEFAULT 'currencyapi',
  "base_currency" VARCHAR(3) NOT NULL DEFAULT 'CNY',
  "requested_currency_codes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "abnormal_currency_codes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
  "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "finished_at" TIMESTAMPTZ(6),
  "provider_updated_at" TIMESTAMPTZ(6),
  "published_at" TIMESTAMPTZ(6),
  "attempt_count" INTEGER NOT NULL DEFAULT 0,
  "source_contract" VARCHAR(120),
  "source_reference" VARCHAR(500),
  "candidate_quotes" JSONB,
  "maximum_change_rate" DECIMAL(26, 8),
  "error_code" VARCHAR(120),
  "error_message" TEXT,
  "error_retryable" BOOLEAN,
  "triggered_by_user_id" UUID,
  "reviewed_by_user_id" UUID,
  "reviewed_at" TIMESTAMPTZ(6),
  "review_remark" VARCHAR(500),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "id_business_v2_purchase_rate_fetch_runs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "id_business_v2_purchase_rate_fetch_runs_provider_check"
    CHECK ("provider" <> 'manual'),
  CONSTRAINT "id_business_v2_purchase_rate_fetch_runs_base_check"
    CHECK ("base_currency" = 'CNY'),
  CONSTRAINT "id_business_v2_purchase_rate_fetch_runs_attempt_check"
    CHECK ("attempt_count" >= 0 AND "attempt_count" <= 3),
  CONSTRAINT "id_business_v2_purchase_rate_fetch_runs_candidate_check"
    CHECK ("candidate_quotes" IS NULL OR jsonb_typeof("candidate_quotes") = 'array'),
  CONSTRAINT "id_business_v2_purchase_rate_fetch_runs_change_check"
    CHECK ("maximum_change_rate" IS NULL OR "maximum_change_rate" >= 0)
);

ALTER TABLE "id_business_v2_purchase_rate_snapshots"
  ADD COLUMN "fetch_run_id" UUID,
  ADD COLUMN "change_rate" DECIMAL(26, 8),
  ADD COLUMN "validation_status" "IdBusinessV2PurchaseRateValidationStatus" NOT NULL DEFAULT 'normal';

ALTER TABLE "id_business_v2_purchase_rate_snapshots"
  ADD CONSTRAINT "id_business_v2_purchase_rate_snapshots_change_rate_check"
  CHECK ("change_rate" IS NULL OR "change_rate" >= 0);

CREATE INDEX "id_business_v2_purchase_rate_settings_next_run_at_idx"
  ON "id_business_v2_purchase_rate_settings"("next_run_at");
CREATE INDEX "id_business_v2_purchase_rate_settings_updated_by_user_id_idx"
  ON "id_business_v2_purchase_rate_settings"("updated_by_user_id");
CREATE INDEX "id_business_v2_purchase_rate_fetch_runs_status_started_at_idx"
  ON "id_business_v2_purchase_rate_fetch_runs"("status", "started_at");
CREATE INDEX "id_business_v2_purchase_rate_fetch_runs_trigger_type_started_at_idx"
  ON "id_business_v2_purchase_rate_fetch_runs"("trigger_type", "started_at");
CREATE INDEX "id_business_v2_purchase_rate_fetch_runs_triggered_by_user_id_idx"
  ON "id_business_v2_purchase_rate_fetch_runs"("triggered_by_user_id");
CREATE INDEX "id_business_v2_purchase_rate_fetch_runs_reviewed_by_user_id_idx"
  ON "id_business_v2_purchase_rate_fetch_runs"("reviewed_by_user_id");
CREATE INDEX "id_business_v2_purchase_rate_fetch_runs_created_at_idx"
  ON "id_business_v2_purchase_rate_fetch_runs"("created_at");
CREATE UNIQUE INDEX "id_business_v2_purchase_rate_fetch_runs_one_running_idx"
  ON "id_business_v2_purchase_rate_fetch_runs" ((1))
  WHERE "status" = 'running';
CREATE INDEX "id_business_v2_purchase_rate_snapshots_fetch_run_id_idx"
  ON "id_business_v2_purchase_rate_snapshots"("fetch_run_id");

ALTER TABLE "id_business_v2_purchase_rate_settings"
  ADD CONSTRAINT "id_business_v2_purchase_rate_settings_updated_by_user_id_fkey"
  FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "id_business_v2_purchase_rate_fetch_runs"
  ADD CONSTRAINT "id_business_v2_purchase_rate_fetch_runs_triggered_by_user_id_fkey"
  FOREIGN KEY ("triggered_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "id_business_v2_purchase_rate_fetch_runs"
  ADD CONSTRAINT "id_business_v2_purchase_rate_fetch_runs_reviewed_by_user_id_fkey"
  FOREIGN KEY ("reviewed_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "id_business_v2_purchase_rate_snapshots"
  ADD CONSTRAINT "id_business_v2_purchase_rate_snapshots_fetch_run_id_fkey"
  FOREIGN KEY ("fetch_run_id") REFERENCES "id_business_v2_purchase_rate_fetch_runs"("id")
  ON DELETE RESTRICT ON UPDATE CASCADE;

INSERT INTO "id_business_v2_purchase_rate_settings" (
  "id",
  "auto_enabled",
  "interval_minutes",
  "stale_minutes",
  "abnormal_change_rate",
  "next_run_at"
)
VALUES (
  1,
  TRUE,
  60,
  120,
  0.10000000,
  date_trunc('hour', CURRENT_TIMESTAMP) +
    CASE
      WHEN EXTRACT(MINUTE FROM CURRENT_TIMESTAMP) < 5 THEN INTERVAL '5 minutes'
      ELSE INTERVAL '65 minutes'
    END
)
ON CONFLICT ("id") DO NOTHING;

CREATE TRIGGER id_business_v2_purchase_rate_settings_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_purchase_rate_settings
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change('exchange-rates');

CREATE TRIGGER id_business_v2_purchase_rate_fetch_runs_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_purchase_rate_fetch_runs
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change('exchange-rates');

DO $$
DECLARE
  existing_job_id BIGINT;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'pg_cron is unavailable; purchase-rate Cron job was not installed';
    RETURN;
  END IF;

  FOR existing_job_id IN
    EXECUTE 'SELECT "jobid" FROM cron.job WHERE "jobname" = $1'
    USING 'id-business-v2-purchase-rate-hourly'
  LOOP
    EXECUTE 'SELECT cron.unschedule($1)' USING existing_job_id;
  END LOOP;

  EXECUTE $schedule$
    SELECT cron.schedule(
      'id-business-v2-purchase-rate-hourly',
      '5 * * * *',
      'SELECT public.invoke_id_business_v2_exchange_rate_cron();'
    )
  $schedule$;
END;
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'id_business_v2_runtime') THEN
    GRANT SELECT, INSERT, UPDATE
      ON TABLE
        public.id_business_v2_purchase_rate_settings,
        public.id_business_v2_purchase_rate_fetch_runs
      TO id_business_v2_runtime;
    GRANT SELECT, INSERT
      ON TABLE public.id_business_v2_purchase_rate_snapshots
      TO id_business_v2_runtime;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'id_business_v2_audit') THEN
    GRANT SELECT
      ON TABLE
        public.id_business_v2_purchase_rate_settings,
        public.id_business_v2_purchase_rate_fetch_runs,
        public.id_business_v2_purchase_rate_snapshots
      TO id_business_v2_audit;
  END IF;
END
$$;

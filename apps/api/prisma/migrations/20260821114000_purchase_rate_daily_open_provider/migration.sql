ALTER TABLE "id_business_v2_purchase_rate_fetch_runs"
  ALTER COLUMN "provider" SET DEFAULT 'exchange_rate_api';

ALTER TABLE "id_business_v2_purchase_rate_settings"
  DROP CONSTRAINT IF EXISTS "id_business_v2_purchase_rate_settings_interval_check",
  DROP CONSTRAINT IF EXISTS "id_business_v2_purchase_rate_settings_stale_check",
  ALTER COLUMN "interval_minutes" SET DEFAULT 1440,
  ALTER COLUMN "stale_minutes" SET DEFAULT 1800;

UPDATE "id_business_v2_purchase_rate_settings"
SET
  "interval_minutes" = 1440,
  "stale_minutes" = GREATEST("stale_minutes", 1800),
  "next_run_at" = CASE
    WHEN "auto_enabled" = FALSE THEN NULL
    WHEN (
      date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + INTERVAL '1 hour 5 minutes'
    ) AT TIME ZONE 'UTC' > CURRENT_TIMESTAMP
      THEN (
        date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'UTC') + INTERVAL '1 hour 5 minutes'
      ) AT TIME ZONE 'UTC'
    ELSE (
      date_trunc('day', CURRENT_TIMESTAMP AT TIME ZONE 'UTC')
      + INTERVAL '1 day 1 hour 5 minutes'
    ) AT TIME ZONE 'UTC'
  END,
  "updated_at" = CURRENT_TIMESTAMP
WHERE "id" = 1;

ALTER TABLE "id_business_v2_purchase_rate_settings"
  ADD CONSTRAINT "id_business_v2_purchase_rate_settings_interval_check"
    CHECK ("interval_minutes" = 1440),
  ADD CONSTRAINT "id_business_v2_purchase_rate_settings_stale_check"
    CHECK ("stale_minutes" >= 1440 AND "stale_minutes" <= 4320);

DO $$
DECLARE
  existing_job_id BIGINT;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'pg_cron is unavailable; daily purchase-rate Cron job was not installed';
    RETURN;
  END IF;

  FOR existing_job_id IN
    EXECUTE 'SELECT "jobid" FROM cron.job WHERE "jobname" = ANY($1)'
    USING ARRAY[
      'id-business-v2-purchase-rate-hourly',
      'id-business-v2-purchase-rate-daily'
    ]::TEXT[]
  LOOP
    EXECUTE 'SELECT cron.unschedule($1)' USING existing_job_id;
  END LOOP;

  EXECUTE $schedule$
    SELECT cron.schedule(
      'id-business-v2-purchase-rate-daily',
      '5 1 * * *',
      'SELECT public.invoke_id_business_v2_exchange_rate_cron();'
    )
  $schedule$;
END;
$$;

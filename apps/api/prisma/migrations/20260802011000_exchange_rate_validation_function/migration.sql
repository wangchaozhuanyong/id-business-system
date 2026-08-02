CREATE OR REPLACE FUNCTION public.validate_id_business_v2_exchange_rate_run(target_run_id UUID)
RETURNS VOID
LANGUAGE plpgsql
AS $function$
DECLARE
  run_record RECORD;
  snapshot_record RECORD;
  snapshot_count INTEGER;
  provider_count INTEGER;
  invalid_sample_count INTEGER;
BEGIN
  SELECT *
  INTO run_record
  FROM "id_business_v2_exchange_rate_runs"
  WHERE "id" = target_run_id;

  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT COUNT(*)::int
  INTO snapshot_count
  FROM "id_business_v2_exchange_rate_snapshots"
  WHERE "run_id" = target_run_id;

  IF run_record."status" = 'success' THEN
    IF snapshot_count <> 1 THEN
      RAISE EXCEPTION 'successful exchange-rate run requires exactly one snapshot';
    END IF;

    SELECT *
    INTO snapshot_record
    FROM "id_business_v2_exchange_rate_snapshots"
    WHERE "run_id" = target_run_id;

    IF snapshot_record."averaged_at" < run_record."started_at"
      OR snapshot_record."averaged_at" > run_record."finished_at" THEN
      RAISE EXCEPTION 'exchange-rate snapshot timestamp is outside the run';
    END IF;

    SELECT COUNT(*)::int
    INTO provider_count
    FROM "id_business_v2_exchange_rate_provider_snapshots"
    WHERE "snapshot_id" = snapshot_record."id";

    IF provider_count <> 4 OR EXISTS (
      SELECT 1
      FROM (
        VALUES
          ('binance'::"IdBusinessV2OtcProvider", 'merchant_buy'::"IdBusinessV2OtcSide"),
          ('binance'::"IdBusinessV2OtcProvider", 'merchant_sell'::"IdBusinessV2OtcSide"),
          ('okx'::"IdBusinessV2OtcProvider", 'merchant_buy'::"IdBusinessV2OtcSide"),
          ('okx'::"IdBusinessV2OtcProvider", 'merchant_sell'::"IdBusinessV2OtcSide")
      ) AS required_pair("provider", "side")
      WHERE NOT EXISTS (
        SELECT 1
        FROM "id_business_v2_exchange_rate_provider_snapshots" provider_snapshot
        WHERE provider_snapshot."snapshot_id" = snapshot_record."id"
          AND provider_snapshot."provider" = required_pair."provider"
          AND provider_snapshot."side" = required_pair."side"
      )
    ) THEN
      RAISE EXCEPTION 'successful exchange-rate snapshot requires four provider-side records';
    END IF;

    SELECT COUNT(*)::int
    INTO invalid_sample_count
    FROM "id_business_v2_exchange_rate_provider_snapshots" provider_snapshot
    WHERE provider_snapshot."snapshot_id" = snapshot_record."id"
      AND provider_snapshot."valid_ad_count" <> (
        SELECT COUNT(*)::int
        FROM "id_business_v2_exchange_rate_quote_samples" sample
        WHERE sample."provider_snapshot_id" = provider_snapshot."id"
      );

    IF invalid_sample_count <> 0 THEN
      RAISE EXCEPTION 'exchange-rate valid sample counts do not reconcile';
    END IF;
  ELSIF snapshot_count <> 0 THEN
    RAISE EXCEPTION 'non-success exchange-rate run cannot own a snapshot';
  END IF;
END;
$function$;

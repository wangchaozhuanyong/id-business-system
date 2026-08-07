ALTER TYPE "IdBusinessV2FinanceCurrency" ADD VALUE IF NOT EXISTS 'USD';

ALTER TABLE "public"."id_business_v2_exchange_rate_settings"
ADD COLUMN IF NOT EXISTS "retention_days" INTEGER NOT NULL DEFAULT 30;

ALTER TABLE "public"."id_business_v2_exchange_rate_settings"
DROP CONSTRAINT IF EXISTS "id_business_v2_exchange_rate_settings_retention_days_check";

ALTER TABLE "public"."id_business_v2_exchange_rate_settings"
ADD CONSTRAINT "id_business_v2_exchange_rate_settings_retention_days_check"
CHECK ("retention_days" >= 7 AND "retention_days" <= 3650);

CREATE OR REPLACE FUNCTION public.cleanup_id_business_v2_exchange_rate_history()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  configured_retention_days INTEGER := 30;
  cutoff_at TIMESTAMPTZ;
  eligible_run_ids UUID[];
  eligible_fx_snapshot_ids UUID[];
  deleted_run_count INTEGER := 0;
  deleted_snapshot_count INTEGER := 0;
  deleted_provider_snapshot_count INTEGER := 0;
  deleted_quote_sample_count INTEGER := 0;
  deleted_fx_snapshot_count INTEGER := 0;
  preserved_referenced_run_count INTEGER := 0;
  preserved_referenced_fx_snapshot_count INTEGER := 0;
BEGIN
  SELECT COALESCE("retention_days", 30)
  INTO configured_retention_days
  FROM "id_business_v2_exchange_rate_settings"
  WHERE "id" = 1;

  configured_retention_days := LEAST(GREATEST(configured_retention_days, 7), 3650);
  cutoff_at := clock_timestamp() - make_interval(days => configured_retention_days);

  SELECT COALESCE(array_agg(run."id"), ARRAY[]::UUID[])
  INTO eligible_run_ids
  FROM "id_business_v2_exchange_rate_runs" run
  WHERE run."status" <> 'running'
    AND run."started_at" < cutoff_at
    AND NOT EXISTS (
      SELECT 1
      FROM "id_business_v2_exchange_rate_snapshots" snapshot
      JOIN "id_business_v2_gift_cards" gift_card
        ON gift_card."exchange_rate_snapshot_id" = snapshot."id"
      WHERE snapshot."run_id" = run."id"
    )
    AND NOT EXISTS (
      SELECT 1
      FROM "id_business_v2_exchange_rate_snapshots" snapshot
      JOIN "id_business_v2_finance_fx_rate_snapshots" fx_snapshot
        ON fx_snapshot."source" = 'combined_p2p'
       AND fx_snapshot."source_reference" = snapshot."id"::TEXT
      WHERE snapshot."run_id" = run."id"
    );

  SELECT COUNT(*)::INTEGER
  INTO preserved_referenced_run_count
  FROM "id_business_v2_exchange_rate_runs" run
  WHERE run."status" <> 'running'
    AND run."started_at" < cutoff_at
    AND (
      EXISTS (
        SELECT 1
        FROM "id_business_v2_exchange_rate_snapshots" snapshot
        JOIN "id_business_v2_gift_cards" gift_card
          ON gift_card."exchange_rate_snapshot_id" = snapshot."id"
        WHERE snapshot."run_id" = run."id"
      )
      OR EXISTS (
        SELECT 1
        FROM "id_business_v2_exchange_rate_snapshots" snapshot
        JOIN "id_business_v2_finance_fx_rate_snapshots" fx_snapshot
          ON fx_snapshot."source" = 'combined_p2p'
         AND fx_snapshot."source_reference" = snapshot."id"::TEXT
        WHERE snapshot."run_id" = run."id"
      )
    );

  SELECT COALESCE(array_agg(fx_snapshot."id"), ARRAY[]::UUID[])
  INTO eligible_fx_snapshot_ids
  FROM "id_business_v2_finance_fx_rate_snapshots" fx_snapshot
  WHERE fx_snapshot."source" IN ('combined_p2p', 'binance', 'okx', 'ecb_cross')
    AND fx_snapshot."captured_at" < cutoff_at
    AND NOT EXISTS (
      SELECT 1 FROM "id_business_v2_finance_journal_lines" line
      WHERE line."fx_rate_snapshot_id" = fx_snapshot."id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "id_business_v2_finance_expenses" expense
      WHERE expense."fx_rate_snapshot_id" = fx_snapshot."id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "id_business_v2_topup_supplier_payments" payment
      WHERE payment."fx_rate_snapshot_id" = fx_snapshot."id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "id_business_v2_accounts" account
      WHERE account."purchase_fx_snapshot_id" = fx_snapshot."id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "id_business_v2_gift_cards" gift_card
      WHERE gift_card."purchase_fx_snapshot_id" = fx_snapshot."id"
    )
    AND NOT EXISTS (
      SELECT 1 FROM "id_business_v2_orders" order_row
      WHERE order_row."received_fx_snapshot_id" = fx_snapshot."id"
    );

  SELECT COUNT(*)::INTEGER
  INTO preserved_referenced_fx_snapshot_count
  FROM "id_business_v2_finance_fx_rate_snapshots" fx_snapshot
  WHERE fx_snapshot."source" IN ('combined_p2p', 'binance', 'okx', 'ecb_cross')
    AND fx_snapshot."captured_at" < cutoff_at
    AND (
      EXISTS (
        SELECT 1 FROM "id_business_v2_finance_journal_lines" line
        WHERE line."fx_rate_snapshot_id" = fx_snapshot."id"
      )
      OR EXISTS (
        SELECT 1 FROM "id_business_v2_finance_expenses" expense
        WHERE expense."fx_rate_snapshot_id" = fx_snapshot."id"
      )
      OR EXISTS (
        SELECT 1 FROM "id_business_v2_topup_supplier_payments" payment
        WHERE payment."fx_rate_snapshot_id" = fx_snapshot."id"
      )
      OR EXISTS (
        SELECT 1 FROM "id_business_v2_accounts" account
        WHERE account."purchase_fx_snapshot_id" = fx_snapshot."id"
      )
      OR EXISTS (
        SELECT 1 FROM "id_business_v2_gift_cards" gift_card
        WHERE gift_card."purchase_fx_snapshot_id" = fx_snapshot."id"
      )
      OR EXISTS (
        SELECT 1 FROM "id_business_v2_orders" order_row
        WHERE order_row."received_fx_snapshot_id" = fx_snapshot."id"
      )
    );

  PERFORM set_config(
    'app.id_business_v2_exchange_rate_retention_cleanup',
    'on',
    true
  );

  IF cardinality(eligible_fx_snapshot_ids) > 0 THEN
    DELETE FROM "id_business_v2_finance_fx_rate_snapshots"
    WHERE "id" = ANY(eligible_fx_snapshot_ids);
    GET DIAGNOSTICS deleted_fx_snapshot_count = ROW_COUNT;
  END IF;

  IF cardinality(eligible_run_ids) > 0 THEN
    DELETE FROM "id_business_v2_exchange_rate_quote_samples" sample
    USING "id_business_v2_exchange_rate_provider_snapshots" provider_snapshot,
      "id_business_v2_exchange_rate_snapshots" snapshot
    WHERE sample."provider_snapshot_id" = provider_snapshot."id"
      AND provider_snapshot."snapshot_id" = snapshot."id"
      AND snapshot."run_id" = ANY(eligible_run_ids);
    GET DIAGNOSTICS deleted_quote_sample_count = ROW_COUNT;

    DELETE FROM "id_business_v2_exchange_rate_provider_snapshots" provider_snapshot
    USING "id_business_v2_exchange_rate_snapshots" snapshot
    WHERE provider_snapshot."snapshot_id" = snapshot."id"
      AND snapshot."run_id" = ANY(eligible_run_ids);
    GET DIAGNOSTICS deleted_provider_snapshot_count = ROW_COUNT;

    DELETE FROM "id_business_v2_exchange_rate_snapshots"
    WHERE "run_id" = ANY(eligible_run_ids);
    GET DIAGNOSTICS deleted_snapshot_count = ROW_COUNT;

    DELETE FROM "id_business_v2_exchange_rate_runs"
    WHERE "id" = ANY(eligible_run_ids);
    GET DIAGNOSTICS deleted_run_count = ROW_COUNT;
  END IF;

  PERFORM set_config(
    'app.id_business_v2_exchange_rate_retention_cleanup',
    'off',
    true
  );

  RETURN jsonb_build_object(
    'cutoff',
    cutoff_at,
    'retentionDays',
    configured_retention_days,
    'deletedRuns',
    deleted_run_count,
    'deletedSnapshots',
    deleted_snapshot_count,
    'deletedProviderSnapshots',
    deleted_provider_snapshot_count,
    'deletedQuoteSamples',
    deleted_quote_sample_count,
    'deletedFxRateSnapshots',
    deleted_fx_snapshot_count,
    'preservedReferencedRuns',
    preserved_referenced_run_count,
    'preservedReferencedFxRateSnapshots',
    preserved_referenced_fx_snapshot_count
  );
END;
$function$;

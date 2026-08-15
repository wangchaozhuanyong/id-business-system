REVOKE EXECUTE ON FUNCTION public.cleanup_id_business_v2_exchange_rate_history() FROM PUBLIC;
REVOKE EXECUTE ON FUNCTION public.invoke_id_business_v2_exchange_rate_cron() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.execute_id_business_v2_governance_exchange_rate_cleanup(
  p_item_id UUID,
  p_run_id UUID
)
RETURNS JSONB
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  governance_item RECORD;
  run_status TEXT;
  run_started_at TIMESTAMPTZ;
  run_snapshot_id UUID;
  preview_cutoff TIMESTAMPTZ;
  preview_retention_days INTEGER;
  configured_retention_days INTEGER := 30;
  current_cutoff TIMESTAMPTZ;
  deleted_snapshot_count INTEGER := 0;
  deleted_provider_snapshot_count INTEGER := 0;
  deleted_quote_sample_count INTEGER := 0;
BEGIN
  SELECT
    item."eligibility",
    item."status" AS item_status,
    job."status" AS job_status,
    job."backup_evidence",
    job."requested_by_user_id",
    job."executed_by_user_id",
    job."preview_hash" AS job_preview_hash,
    approval."approver_user_id",
    approval."decision",
    approval."preview_hash" AS approval_preview_hash
  INTO governance_item
  FROM "id_business_v2_governance_job_items" item
  JOIN "id_business_v2_governance_jobs" job ON job."id" = item."job_id"
  JOIN "id_business_v2_governance_approvals" approval ON approval."job_id" = job."id"
  WHERE item."id" = p_item_id
    AND item."entity_type" = 'exchange_rate_run'
    AND item."entity_id" = p_run_id
    AND job."type" = 'exchange_rate_cleanup'
  FOR UPDATE OF item, job;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'approved governance cleanup item does not exist';
  END IF;
  IF governance_item.item_status <> 'processing'
    OR governance_item.job_status <> 'running'
    OR governance_item.decision <> 'approved'
    OR governance_item.requested_by_user_id = governance_item.approver_user_id
    OR governance_item.job_preview_hash <> governance_item.approval_preview_hash
    OR governance_item.executed_by_user_id IS NULL
    OR char_length(btrim(governance_item.backup_evidence)) < 8 THEN
    RAISE EXCEPTION 'governance cleanup approval evidence is invalid';
  END IF;
  IF governance_item.eligibility ->> 'eligible' <> 'true'
    OR governance_item.eligibility ->> 'expectedStatus' IS NULL
    OR governance_item.eligibility ->> 'cutoff' IS NULL
    OR governance_item.eligibility ->> 'retentionDays' IS NULL THEN
    RAISE EXCEPTION 'governance cleanup preview evidence is invalid';
  END IF;

  BEGIN
    preview_cutoff := (governance_item.eligibility ->> 'cutoff')::TIMESTAMPTZ;
    preview_retention_days := (governance_item.eligibility ->> 'retentionDays')::INTEGER;
  EXCEPTION
    WHEN invalid_text_representation OR datetime_field_overflow THEN
      RAISE EXCEPTION 'governance cleanup preview evidence is invalid';
  END;
  IF preview_retention_days < 7 OR preview_retention_days > 3650 THEN
    RAISE EXCEPTION 'governance cleanup retention evidence is invalid';
  END IF;

  SELECT COALESCE((
    SELECT "retention_days"
    FROM "id_business_v2_exchange_rate_settings"
    WHERE "id" = 1
  ), 30)
  INTO configured_retention_days
  ;
  configured_retention_days := LEAST(GREATEST(configured_retention_days, 7), 3650);
  current_cutoff := clock_timestamp() - make_interval(
    days => GREATEST(preview_retention_days, configured_retention_days)
  );

  SELECT run."status"::TEXT, run."started_at", snapshot."id"
  INTO run_status, run_started_at, run_snapshot_id
  FROM "id_business_v2_exchange_rate_runs" run
  LEFT JOIN "id_business_v2_exchange_rate_snapshots" snapshot
    ON snapshot."run_id" = run."id"
  WHERE run."id" = p_run_id
  FOR UPDATE OF run;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'exchange-rate cleanup source does not exist';
  END IF;
  IF run_status = 'running'
    OR run_status <> (governance_item.eligibility ->> 'expectedStatus')
    OR run_started_at >= preview_cutoff
    OR run_started_at >= current_cutoff
    OR run_snapshot_id IS DISTINCT FROM NULLIF(
      governance_item.eligibility ->> 'snapshotId',
      ''
    )::UUID THEN
    RAISE EXCEPTION 'exchange-rate cleanup source changed after preview';
  END IF;
  IF EXISTS (
    SELECT 1
    FROM "id_business_v2_gift_cards" gift_card
    WHERE gift_card."exchange_rate_snapshot_id" = run_snapshot_id
  ) OR EXISTS (
    SELECT 1
    FROM "id_business_v2_finance_fx_rate_snapshots" fx_snapshot
    WHERE fx_snapshot."source" = 'combined_p2p'
      AND fx_snapshot."source_reference" = run_snapshot_id::TEXT
  ) THEN
    RAISE EXCEPTION 'exchange-rate cleanup source is referenced';
  END IF;

  PERFORM set_config('app.id_business_v2_exchange_rate_retention_cleanup', 'on', true);
  IF run_snapshot_id IS NOT NULL THEN
    DELETE FROM "id_business_v2_exchange_rate_quote_samples" sample
    USING "id_business_v2_exchange_rate_provider_snapshots" provider_snapshot
    WHERE sample."provider_snapshot_id" = provider_snapshot."id"
      AND provider_snapshot."snapshot_id" = run_snapshot_id;
    GET DIAGNOSTICS deleted_quote_sample_count = ROW_COUNT;

    DELETE FROM "id_business_v2_exchange_rate_provider_snapshots"
    WHERE "snapshot_id" = run_snapshot_id;
    GET DIAGNOSTICS deleted_provider_snapshot_count = ROW_COUNT;

    DELETE FROM "id_business_v2_exchange_rate_snapshots" WHERE "id" = run_snapshot_id;
    GET DIAGNOSTICS deleted_snapshot_count = ROW_COUNT;
  END IF;
  DELETE FROM "id_business_v2_exchange_rate_runs" WHERE "id" = p_run_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'exchange-rate cleanup source changed during execution';
  END IF;
  PERFORM set_config('app.id_business_v2_exchange_rate_retention_cleanup', 'off', true);

  RETURN jsonb_build_object(
    'deletedSnapshots', deleted_snapshot_count,
    'deletedProviderSnapshots', deleted_provider_snapshot_count,
    'deletedQuoteSamples', deleted_quote_sample_count
  );
END;
$function$;

REVOKE EXECUTE ON FUNCTION public.execute_id_business_v2_governance_exchange_rate_cleanup(UUID, UUID)
  FROM PUBLIC;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'id_business_v2_runtime') THEN
    REVOKE DELETE ON TABLE
      public.id_business_v2_exchange_rate_runs,
      public.id_business_v2_exchange_rate_snapshots,
      public.id_business_v2_exchange_rate_provider_snapshots,
      public.id_business_v2_exchange_rate_quote_samples
      FROM id_business_v2_runtime;
    REVOKE EXECUTE ON FUNCTION public.cleanup_id_business_v2_exchange_rate_history()
      FROM id_business_v2_runtime;
    REVOKE EXECUTE ON FUNCTION public.invoke_id_business_v2_exchange_rate_cron()
      FROM id_business_v2_runtime;
    GRANT EXECUTE ON FUNCTION
      public.execute_id_business_v2_governance_exchange_rate_cleanup(UUID, UUID)
      TO id_business_v2_runtime;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'id_business_v2_audit') THEN
    REVOKE EXECUTE ON FUNCTION public.cleanup_id_business_v2_exchange_rate_history()
      FROM id_business_v2_audit;
    REVOKE EXECUTE ON FUNCTION public.invoke_id_business_v2_exchange_rate_cron()
      FROM id_business_v2_audit;
    REVOKE EXECUTE ON FUNCTION
      public.execute_id_business_v2_governance_exchange_rate_cleanup(UUID, UUID)
      FROM id_business_v2_audit;
  END IF;
END
$$;

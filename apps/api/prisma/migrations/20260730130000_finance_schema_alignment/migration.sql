CREATE INDEX IF NOT EXISTS "id_business_v2_finance_accounts_created_by_user_id_idx"
ON "id_business_v2_finance_accounts"("created_by_user_id");

CREATE INDEX IF NOT EXISTS "id_business_v2_finance_accounts_updated_by_user_id_idx"
ON "id_business_v2_finance_accounts"("updated_by_user_id");

CREATE INDEX IF NOT EXISTS "id_business_v2_finance_expenses_fx_rate_snapshot_id_idx"
ON "id_business_v2_finance_expenses"("fx_rate_snapshot_id");

CREATE INDEX IF NOT EXISTS "id_business_v2_finance_expenses_receipt_attachment_id_idx"
ON "id_business_v2_finance_expenses"("receipt_attachment_id");

CREATE INDEX IF NOT EXISTS "id_business_v2_finance_expenses_created_by_user_id_idx"
ON "id_business_v2_finance_expenses"("created_by_user_id");

CREATE INDEX IF NOT EXISTS "id_business_v2_finance_fx_rate_snapshots_source_captured_at_idx"
ON "id_business_v2_finance_fx_rate_snapshots"("source", "captured_at");

CREATE INDEX IF NOT EXISTS "id_business_v2_finance_fx_rate_snapshots_created_by_user_id_idx"
ON "id_business_v2_finance_fx_rate_snapshots"("created_by_user_id");

CREATE INDEX IF NOT EXISTS "id_business_v2_finance_journal_lines_fx_rate_snapshot_id_idx"
ON "id_business_v2_finance_journal_lines"("fx_rate_snapshot_id");

CREATE INDEX IF NOT EXISTS "id_business_v2_finance_journals_status_occurred_at_idx"
ON "id_business_v2_finance_journals"("status", "occurred_at");

CREATE INDEX IF NOT EXISTS "id_business_v2_finance_journals_created_by_user_id_idx"
ON "id_business_v2_finance_journals"("created_by_user_id");

CREATE INDEX IF NOT EXISTS "id_business_v2_finance_periods_closed_by_user_id_idx"
ON "id_business_v2_finance_periods"("closed_by_user_id");

CREATE INDEX IF NOT EXISTS "id_business_v2_finance_periods_reopened_by_user_id_idx"
ON "id_business_v2_finance_periods"("reopened_by_user_id");

CREATE INDEX IF NOT EXISTS "id_business_v2_finance_settings_updated_by_user_id_idx"
ON "id_business_v2_finance_settings"("updated_by_user_id");

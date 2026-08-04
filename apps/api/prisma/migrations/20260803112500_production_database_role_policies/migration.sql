DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'id_business_v2_runtime') THEN
    CREATE ROLE id_business_v2_runtime NOLOGIN;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'id_business_v2_audit') THEN
    CREATE ROLE id_business_v2_audit NOLOGIN;
  END IF;
END
$$;

DO $$
DECLARE
  target_table text;
  target_tables text[] := ARRAY[
    'users',
    'login_logs',
    'active_sessions',
    'security_settings',
    'ip_whitelists',
    'sensitive_access_logs',
    'sensitive_access_approvals',
    'roles',
    'permissions',
    'user_roles',
    'role_permissions',
    'audit_logs',
    'attachments',
    'v2_auth_identities',
    'id_business_v2_options',
    'id_business_v2_customers',
    'id_business_v2_customer_tags',
    'id_business_v2_customer_services',
    'id_business_v2_accounts',
    'id_business_v2_gift_cards',
    'id_business_v2_topup_supplier_accounts',
    'id_business_v2_topup_supplier_payments',
    'id_business_v2_topup_supplier_ledger',
    'id_business_v2_finance_settings',
    'id_business_v2_finance_accounts',
    'id_business_v2_finance_fx_rate_snapshots',
    'id_business_v2_finance_journals',
    'id_business_v2_finance_journal_lines',
    'id_business_v2_finance_expenses',
    'id_business_v2_finance_periods',
    'id_business_v2_balance_ledger',
    'id_business_v2_account_losses',
    'id_business_v2_orders',
    'id_business_v2_account_locks',
    'id_business_v2_activations',
    'id_business_v2_renewal_warning_settings',
    'id_business_v2_exchange_rate_runs',
    'id_business_v2_exchange_rate_entries',
    'id_business_v2_exchange_rate_snapshots',
    'id_business_v2_exchange_rate_settings',
    'id_business_v2_exchange_rate_provider_snapshots',
    'id_business_v2_exchange_rate_quote_samples',
    'id_business_v2_governance_jobs',
    'id_business_v2_governance_job_items',
    'id_business_v2_governance_approvals',
    'id_business_v2_governance_checkpoints',
    'id_business_v2_scope_versions'
  ];
BEGIN
  FOREACH target_table IN ARRAY target_tables LOOP
    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = target_table
        AND policyname = 'id_business_v2_runtime_access'
    ) THEN
      EXECUTE format(
        'CREATE POLICY id_business_v2_runtime_access ON public.%I FOR ALL TO id_business_v2_runtime USING (true) WITH CHECK (true)',
        target_table
      );
    END IF;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = target_table
        AND policyname = 'id_business_v2_audit_read'
    ) THEN
      EXECUTE format(
        'CREATE POLICY id_business_v2_audit_read ON public.%I FOR SELECT TO id_business_v2_audit USING (true)',
        target_table
      );
    END IF;
  END LOOP;
END
$$;

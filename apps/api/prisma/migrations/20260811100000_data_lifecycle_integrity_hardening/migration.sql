ALTER TABLE public.id_business_v2_topup_supplier_accounts
ADD COLUMN disabled_by_option_deletion_at timestamptz(6);

ALTER TABLE public.id_business_v2_options
ADD COLUMN status_before_deletion "IdBusinessV2OptionStatus",
ADD COLUMN deleted_by_parent_option_id uuid;

UPDATE public.id_business_v2_options
SET status_before_deletion = status
WHERE deleted_at IS NOT NULL
  AND status_before_deletion IS NULL;

UPDATE public.id_business_v2_options
SET unique_key = 'deleted:' || id::text || ':' || unique_key
WHERE deleted_at IS NOT NULL
  AND unique_key NOT LIKE 'deleted:' || id::text || ':%';

WITH unambiguous_parent_deletions AS (
  SELECT
    service.id AS service_id,
    max(parent_option.id::text)::uuid AS parent_option_id
  FROM public.id_business_v2_options service
  JOIN public.id_business_v2_options parent_option
    ON parent_option.id IN (service.parent_id, service.country_option_id)
   AND parent_option.deleted_at = service.deleted_at
  WHERE service.type::text = 'service'
    AND service.deleted_at IS NOT NULL
  GROUP BY service.id
  HAVING count(*) = 1
)
UPDATE public.id_business_v2_options service
SET deleted_by_parent_option_id = candidate.parent_option_id
FROM unambiguous_parent_deletions candidate
WHERE service.id = candidate.service_id;

CREATE INDEX id_business_v2_options_deleted_by_parent_option_id_idx
ON public.id_business_v2_options(deleted_by_parent_option_id);

CREATE INDEX id_business_v2_topup_supplier_accounts_disabled_by_option_deletion_at_idx
ON public.id_business_v2_topup_supplier_accounts(disabled_by_option_deletion_at);

ALTER TABLE public.id_business_v2_finance_expenses
ADD COLUMN category_name_snapshot varchar(160),
ADD COLUMN finance_account_name_snapshot varchar(120);

UPDATE public.id_business_v2_finance_expenses expense
SET
  category_name_snapshot = category.name,
  finance_account_name_snapshot = finance_account.name
FROM public.id_business_v2_options category,
     public.id_business_v2_finance_accounts finance_account
WHERE category.id = expense.category_option_id
  AND finance_account.id = expense.finance_account_id;

CREATE FUNCTION public.protect_id_business_v2_finance_expense_display_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    SELECT name INTO NEW.category_name_snapshot
    FROM public.id_business_v2_options
    WHERE id = NEW.category_option_id;
    SELECT name INTO NEW.finance_account_name_snapshot
    FROM public.id_business_v2_finance_accounts
    WHERE id = NEW.finance_account_id;
    RETURN NEW;
  END IF;
  IF NEW.category_name_snapshot IS DISTINCT FROM OLD.category_name_snapshot
     OR NEW.finance_account_name_snapshot IS DISTINCT FROM OLD.finance_account_name_snapshot THEN
    RAISE EXCEPTION '经营开支历史展示快照不可修改';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER id_business_v2_finance_expense_display_snapshot_immutable
BEFORE INSERT OR UPDATE ON public.id_business_v2_finance_expenses
FOR EACH ROW EXECUTE FUNCTION public.protect_id_business_v2_finance_expense_display_snapshot();

REVOKE ALL ON FUNCTION public.protect_id_business_v2_finance_expense_display_snapshot() FROM PUBLIC;

ALTER TABLE public.id_business_v2_finance_expenses
ALTER COLUMN category_name_snapshot SET NOT NULL,
ALTER COLUMN finance_account_name_snapshot SET NOT NULL;

CREATE TABLE public.id_business_v2_order_display_snapshots (
  order_id uuid NOT NULL,
  customer_name varchar(120) NOT NULL,
  service_name varchar(160) NOT NULL,
  service_category_name varchar(160),
  account_label varchar(255),
  account_country_name varchar(160),
  settlement_platform_name varchar(160),
  captured_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT id_business_v2_order_display_snapshots_pkey PRIMARY KEY (order_id),
  CONSTRAINT id_business_v2_order_display_snapshots_order_id_fkey
    FOREIGN KEY (order_id) REFERENCES public.id_business_v2_orders(id)
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE INDEX id_business_v2_order_display_snapshots_captured_at_idx
ON public.id_business_v2_order_display_snapshots(captured_at);

INSERT INTO public.id_business_v2_order_display_snapshots (
  order_id,
  customer_name,
  service_name,
  service_category_name,
  account_label,
  account_country_name,
  settlement_platform_name,
  captured_at,
  updated_at
)
SELECT
  orders.id,
  customer.name,
  service.name,
  category.name,
  account.apple_id_masked,
  account_country.name,
  settlement.name,
  orders.created_at,
  CURRENT_TIMESTAMP
FROM public.id_business_v2_orders orders
JOIN public.id_business_v2_customers customer ON customer.id = orders.customer_id
JOIN public.id_business_v2_options service ON service.id = orders.service_option_id
LEFT JOIN public.id_business_v2_options category ON category.id = service.parent_id
LEFT JOIN public.id_business_v2_accounts account ON account.id = orders.account_id
LEFT JOIN public.id_business_v2_options account_country ON account_country.id = account.country_option_id
LEFT JOIN public.id_business_v2_options settlement
  ON settlement.id = orders.settlement_platform_option_id;

CREATE FUNCTION public.capture_id_business_v2_order_display_snapshot()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  INSERT INTO public.id_business_v2_order_display_snapshots (
    order_id,
    customer_name,
    service_name,
    service_category_name,
    account_label,
    account_country_name,
    settlement_platform_name,
    captured_at,
    updated_at
  )
  SELECT
    NEW.id,
    customer.name,
    service.name,
    category.name,
    account.apple_id_masked,
    account_country.name,
    settlement.name,
    COALESCE(NEW.created_at, CURRENT_TIMESTAMP),
    CURRENT_TIMESTAMP
  FROM public.id_business_v2_customers customer
  JOIN public.id_business_v2_options service ON service.id = NEW.service_option_id
  LEFT JOIN public.id_business_v2_options category ON category.id = service.parent_id
  LEFT JOIN public.id_business_v2_accounts account ON account.id = NEW.account_id
  LEFT JOIN public.id_business_v2_options account_country
    ON account_country.id = account.country_option_id
  LEFT JOIN public.id_business_v2_options settlement
    ON settlement.id = NEW.settlement_platform_option_id
  WHERE customer.id = NEW.customer_id
  ON CONFLICT (order_id) DO UPDATE SET
    customer_name = CASE
      WHEN NEW.customer_id IS DISTINCT FROM OLD.customer_id THEN EXCLUDED.customer_name
      ELSE id_business_v2_order_display_snapshots.customer_name
    END,
    service_name = CASE
      WHEN NEW.service_option_id IS DISTINCT FROM OLD.service_option_id THEN EXCLUDED.service_name
      ELSE id_business_v2_order_display_snapshots.service_name
    END,
    service_category_name = CASE
      WHEN NEW.service_option_id IS DISTINCT FROM OLD.service_option_id
      THEN EXCLUDED.service_category_name
      ELSE id_business_v2_order_display_snapshots.service_category_name
    END,
    account_label = CASE
      WHEN NEW.account_id IS DISTINCT FROM OLD.account_id THEN EXCLUDED.account_label
      ELSE id_business_v2_order_display_snapshots.account_label
    END,
    account_country_name = CASE
      WHEN NEW.account_id IS DISTINCT FROM OLD.account_id THEN EXCLUDED.account_country_name
      ELSE id_business_v2_order_display_snapshots.account_country_name
    END,
    settlement_platform_name = CASE
      WHEN NEW.settlement_platform_option_id IS DISTINCT FROM OLD.settlement_platform_option_id
      THEN EXCLUDED.settlement_platform_name
      ELSE id_business_v2_order_display_snapshots.settlement_platform_name
    END,
    updated_at = CURRENT_TIMESTAMP;
  RETURN NEW;
END;
$$;

CREATE TRIGGER id_business_v2_order_display_snapshot_capture
AFTER INSERT OR UPDATE OF customer_id, service_option_id, account_id, settlement_platform_option_id
ON public.id_business_v2_orders
FOR EACH ROW EXECUTE FUNCTION public.capture_id_business_v2_order_display_snapshot();

REVOKE ALL ON FUNCTION public.capture_id_business_v2_order_display_snapshot() FROM PUBLIC;

CREATE FUNCTION public.protect_id_business_v2_order_display_snapshot()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF pg_trigger_depth() <= 1 THEN
    RAISE EXCEPTION '订单历史展示快照不可直接修改或删除';
  END IF;
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END;
$$;

CREATE TRIGGER id_business_v2_order_display_snapshot_immutable
BEFORE UPDATE OR DELETE ON public.id_business_v2_order_display_snapshots
FOR EACH ROW EXECUTE FUNCTION public.protect_id_business_v2_order_display_snapshot();

CREATE FUNCTION public.protect_audit_log_immutability()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '审计日志不可修改或删除';
END;
$$;

CREATE TRIGGER audit_logs_immutable
BEFORE UPDATE OR DELETE ON public.audit_logs
FOR EACH ROW EXECUTE FUNCTION public.protect_audit_log_immutability();

INSERT INTO public.audit_logs (
  id,
  module,
  action,
  object_type,
  object_id,
  after_data,
  remark,
  created_at
)
SELECT
  gen_random_uuid(),
  'id_business_v2_integrity',
  'id_business_v2.integrity.legacy_soft_delete_reconciled',
  'id_business_v2_option',
  deleted_option.id,
  jsonb_build_object(
    'deletedAt', deleted_option.deleted_at,
    'historicalActorKnown', false,
    'source', 'data_lifecycle_integrity_hardening_migration'
  ),
  '迁移发现缺少原始审计的历史软删除；原操作人和原因不可追溯，本记录只声明遗留事实。',
  CURRENT_TIMESTAMP
FROM public.id_business_v2_options deleted_option
WHERE deleted_option.deleted_at IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM public.audit_logs existing_audit
    WHERE existing_audit.object_type = 'id_business_v2_option'
      AND existing_audit.object_id = deleted_option.id
      AND existing_audit.action IN (
        'id_business_v2.option.delete',
        'id_business_v2.integrity.legacy_soft_delete_reconciled'
      )
  );

ALTER TABLE public.id_business_v2_order_display_snapshots ENABLE ROW LEVEL SECURITY;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'id_business_v2_runtime') THEN
    REVOKE DELETE ON ALL TABLES IN SCHEMA public FROM id_business_v2_runtime;
    GRANT DELETE ON TABLE
      public.ip_whitelists,
      public.user_roles,
      public.role_permissions,
      public.id_business_v2_user_table_preferences,
      public.id_business_v2_exchange_rate_runs,
      public.id_business_v2_exchange_rate_snapshots,
      public.id_business_v2_exchange_rate_provider_snapshots,
      public.id_business_v2_exchange_rate_quote_samples
    TO id_business_v2_runtime;
    GRANT SELECT ON TABLE public.id_business_v2_order_display_snapshots
    TO id_business_v2_runtime;
    CREATE POLICY id_business_v2_runtime_snapshot_read
      ON public.id_business_v2_order_display_snapshots
      FOR SELECT TO id_business_v2_runtime USING (true);
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'id_business_v2_audit') THEN
    GRANT SELECT ON TABLE public.id_business_v2_order_display_snapshots
    TO id_business_v2_audit;
    CREATE POLICY id_business_v2_audit_snapshot_read
      ON public.id_business_v2_order_display_snapshots
      FOR SELECT TO id_business_v2_audit USING (true);
  END IF;
END
$$;

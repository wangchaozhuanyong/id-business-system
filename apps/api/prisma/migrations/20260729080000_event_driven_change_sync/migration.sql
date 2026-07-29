CREATE TABLE "id_business_v2_scope_versions" (
  "scope" VARCHAR(80) NOT NULL,
  "version" BIGINT NOT NULL DEFAULT 0,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "id_business_v2_scope_versions_pkey" PRIMARY KEY ("scope")
);

INSERT INTO "id_business_v2_scope_versions" ("scope", "version")
SELECT "scope", 0
FROM unnest(ARRAY[
  'accounts',
  'accounts-options',
  'activations',
  'balances',
  'balances-options',
  'balance-records',
  'balance-record-options',
  'customers',
  'customers-options',
  'exchange-rates',
  'options',
  'options-page',
  'options-reference',
  'orders',
  'orders-options',
  'order-entry-manual-candidates',
  'order-entry-matching',
  'order-entry-options',
  'renewals',
  'renewals-options',
  'renewal-warning-settings',
  'renewal-warning-summary'
]::text[]) AS "scope";

CREATE OR REPLACE FUNCTION public.id_business_v2_publish_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  change_scopes jsonb;
  change_payload jsonb;
BEGIN
  WITH requested_scopes AS (
    SELECT DISTINCT requested.scope
    FROM unnest(TG_ARGV) AS requested(scope)
  ),
  bumped_scopes AS (
    INSERT INTO public.id_business_v2_scope_versions AS current_version (
      scope,
      version,
      updated_at
    )
    SELECT requested.scope, 1, transaction_timestamp()
    FROM requested_scopes AS requested
    ON CONFLICT (scope) DO UPDATE
      SET version = current_version.version + 1,
          updated_at = transaction_timestamp()
    RETURNING scope, version
  )
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'scope', bumped.scope,
        'version', bumped.version::text
      )
      ORDER BY bumped.scope
    ),
    '[]'::jsonb
  )
  INTO change_scopes
  FROM bumped_scopes AS bumped;

  change_payload := jsonb_build_object(
    'schemaVersion', 1,
    'eventId', gen_random_uuid()::text,
    'occurredAt', transaction_timestamp(),
    'scopes', change_scopes
  );

  IF to_regprocedure('realtime.send(jsonb,text,text,boolean)') IS NOT NULL THEN
    PERFORM realtime.send(
      change_payload,
      'change',
      'id-business-v2:changes',
      true
    );
  END IF;

  RETURN NULL;
END;
$function$;

REVOKE ALL ON FUNCTION public.id_business_v2_publish_change() FROM PUBLIC;

CREATE OR REPLACE FUNCTION public.id_business_v2_can_receive_changes()
RETURNS boolean
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = ''
AS $function$
  SELECT EXISTS (
    SELECT 1
    FROM public.v2_auth_identities AS identity
    INNER JOIN public.users AS internal_user
      ON internal_user.id = identity.user_id
    WHERE identity.auth_user_id =
      NULLIF(current_setting('request.jwt.claim.sub', true), '')::uuid
      AND identity.enabled = true
      AND internal_user.status = 'active'
      AND internal_user.deleted_at IS NULL
  );
$function$;

REVOKE ALL ON FUNCTION public.id_business_v2_can_receive_changes() FROM PUBLIC;

DO $block$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    GRANT EXECUTE ON FUNCTION public.id_business_v2_can_receive_changes() TO authenticated;
  END IF;

  IF to_regclass('realtime.messages') IS NOT NULL
     AND EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN
    BEGIN
      EXECUTE 'ALTER TABLE realtime.messages ENABLE ROW LEVEL SECURITY';
      EXECUTE 'DROP POLICY IF EXISTS id_business_v2_receive_private_changes ON realtime.messages';
      EXECUTE $policy$
        CREATE POLICY id_business_v2_receive_private_changes
        ON realtime.messages
        FOR SELECT
        TO authenticated
        USING (
          realtime.topic() = 'id-business-v2:changes'
          AND extension = 'broadcast'
          AND public.id_business_v2_can_receive_changes()
        )
      $policy$;
    EXCEPTION
      WHEN insufficient_privilege THEN
        RAISE NOTICE
          'Skipping realtime.messages policy because the migration role is not the managed table owner';
    END;
  END IF;
END;
$block$;

CREATE TRIGGER id_business_v2_options_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_options
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change(
  'options',
  'options-page',
  'options-reference',
  'accounts-options',
  'customers-options',
  'balances-options',
  'balance-record-options',
  'orders-options',
  'order-entry-options',
  'renewals-options',
  'accounts',
  'customers',
  'orders',
  'renewals',
  'order-entry-matching',
  'order-entry-manual-candidates'
);

CREATE TRIGGER id_business_v2_customers_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_customers
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change(
  'customers',
  'orders',
  'renewals',
  'renewal-warning-summary',
  'order-entry-options'
);

CREATE TRIGGER id_business_v2_customer_tags_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_customer_tags
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change(
  'customers',
  'orders',
  'renewals',
  'order-entry-options'
);

CREATE TRIGGER id_business_v2_customer_services_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_customer_services
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change(
  'customers',
  'orders',
  'renewals',
  'order-entry-options'
);

CREATE TRIGGER id_business_v2_accounts_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_accounts
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change(
  'accounts',
  'balances',
  'balance-records',
  'orders',
  'renewals',
  'order-entry-matching',
  'order-entry-manual-candidates'
);

CREATE TRIGGER id_business_v2_gift_cards_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_gift_cards
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change(
  'accounts',
  'balances',
  'balance-records',
  'orders',
  'renewals',
  'order-entry-matching',
  'order-entry-manual-candidates'
);

CREATE TRIGGER id_business_v2_balance_ledger_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_balance_ledger
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change(
  'accounts',
  'balances',
  'balance-records',
  'orders',
  'renewals',
  'order-entry-matching',
  'order-entry-manual-candidates'
);

CREATE TRIGGER id_business_v2_orders_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_orders
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change(
  'orders',
  'activations',
  'renewals',
  'balances',
  'balance-records',
  'order-entry-matching',
  'order-entry-manual-candidates'
);

CREATE TRIGGER id_business_v2_account_locks_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_account_locks
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change(
  'orders',
  'activations',
  'renewals',
  'renewal-warning-summary',
  'balances',
  'balance-records',
  'order-entry-matching',
  'order-entry-manual-candidates'
);

CREATE TRIGGER id_business_v2_activations_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_activations
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change(
  'activations',
  'orders',
  'renewals',
  'renewal-warning-summary',
  'balances',
  'balance-records',
  'order-entry-matching',
  'order-entry-manual-candidates'
);

CREATE TRIGGER id_business_v2_renewal_warning_settings_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_renewal_warning_settings
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change(
  'renewals',
  'renewal-warning-settings',
  'renewal-warning-summary'
);

CREATE TRIGGER id_business_v2_exchange_rate_runs_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_exchange_rate_runs
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change('exchange-rates');

CREATE TRIGGER id_business_v2_exchange_rate_entries_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_exchange_rate_entries
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change('exchange-rates');

CREATE TRIGGER id_business_v2_exchange_rate_snapshots_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_exchange_rate_snapshots
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change('exchange-rates');

CREATE TRIGGER id_business_v2_exchange_rate_settings_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_exchange_rate_settings
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change('exchange-rates');

CREATE TRIGGER id_business_v2_exchange_rate_provider_snapshots_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_exchange_rate_provider_snapshots
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change('exchange-rates');

CREATE TRIGGER id_business_v2_exchange_rate_quote_samples_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_exchange_rate_quote_samples
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change('exchange-rates');

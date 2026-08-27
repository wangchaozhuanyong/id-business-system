-- Application commands now declare the exact primary scopes they change. Remove the
-- legacy table-wide dependency triggers so one write cannot publish duplicate or
-- over-broad invalidations. Client-side V2_SCOPE_DEPENDENCIES remains responsible for
-- expanding a primary scope to the views that actually depend on it.
DO $block$
DECLARE
  legacy_trigger record;
BEGIN
  FOR legacy_trigger IN
    SELECT trigger_namespace.nspname AS schema_name,
           trigger_table.relname AS table_name,
           trigger_definition.tgname AS trigger_name
    FROM pg_trigger AS trigger_definition
    INNER JOIN pg_class AS trigger_table
      ON trigger_table.oid = trigger_definition.tgrelid
    INNER JOIN pg_namespace AS trigger_namespace
      ON trigger_namespace.oid = trigger_table.relnamespace
    WHERE trigger_definition.tgisinternal = false
      AND trigger_namespace.nspname = 'public'
      AND trigger_definition.tgfoid =
        'public.id_business_v2_publish_change()'::regprocedure
  LOOP
    EXECUTE format(
      'DROP TRIGGER %I ON %I.%I',
      legacy_trigger.trigger_name,
      legacy_trigger.schema_name,
      legacy_trigger.table_name
    );
  END LOOP;
END;
$block$;

CREATE OR REPLACE FUNCTION public.id_business_v2_publish_scope_version_change()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = ''
AS $function$
DECLARE
  change_scopes jsonb;
  change_payload jsonb;
BEGIN
  SELECT COALESCE(
    jsonb_agg(
      jsonb_build_object(
        'scope', changed_scope.scope,
        'version', changed_scope.version::text
      )
      ORDER BY changed_scope.scope
    ),
    '[]'::jsonb
  )
  INTO change_scopes
  FROM changed_scope_versions AS changed_scope;

  IF jsonb_array_length(change_scopes) = 0 THEN
    RETURN NULL;
  END IF;

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

REVOKE ALL ON FUNCTION public.id_business_v2_publish_scope_version_change() FROM PUBLIC;

DROP TRIGGER IF EXISTS id_business_v2_scope_versions_broadcast
ON public.id_business_v2_scope_versions;

CREATE TRIGGER id_business_v2_scope_versions_broadcast
AFTER UPDATE ON public.id_business_v2_scope_versions
REFERENCING NEW TABLE AS changed_scope_versions
FOR EACH STATEMENT
EXECUTE FUNCTION public.id_business_v2_publish_scope_version_change();

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'id_business_v2_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON TABLE public.id_business_v2_user_table_preferences
      TO id_business_v2_runtime;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'id_business_v2_user_table_preferences'
        AND policyname = 'id_business_v2_runtime_access'
    ) THEN
      CREATE POLICY id_business_v2_runtime_access
        ON public.id_business_v2_user_table_preferences
        FOR ALL
        TO id_business_v2_runtime
        USING (true)
        WITH CHECK (true);
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'id_business_v2_audit') THEN
    GRANT SELECT
      ON TABLE public.id_business_v2_user_table_preferences
      TO id_business_v2_audit;

    IF NOT EXISTS (
      SELECT 1 FROM pg_policies
      WHERE schemaname = 'public'
        AND tablename = 'id_business_v2_user_table_preferences'
        AND policyname = 'id_business_v2_audit_read'
    ) THEN
      CREATE POLICY id_business_v2_audit_read
        ON public.id_business_v2_user_table_preferences
        FOR SELECT
        TO id_business_v2_audit
        USING (true);
    END IF;
  END IF;
END
$$;

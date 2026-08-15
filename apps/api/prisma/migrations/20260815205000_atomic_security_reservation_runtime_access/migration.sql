DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'id_business_v2_runtime') THEN
    GRANT UPDATE (mailbox_id, outcome)
      ON TABLE public.id_business_v2_mail_query_attempts
      TO id_business_v2_runtime;
  END IF;
END
$$;

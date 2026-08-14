DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'id_business_v2_runtime') THEN
    GRANT DELETE ON TABLE public.id_business_v2_customer_tags
    TO id_business_v2_runtime;
  END IF;
END
$$;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'id_business_v2_runtime') THEN
    GRANT SELECT, INSERT, UPDATE
      ON TABLE public.id_business_v2_order_balance_returns
      TO id_business_v2_runtime;
    REVOKE DELETE
      ON TABLE public.id_business_v2_order_balance_returns
      FROM id_business_v2_runtime;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'id_business_v2_audit') THEN
    GRANT SELECT
      ON TABLE public.id_business_v2_order_balance_returns
      TO id_business_v2_audit;
  END IF;
END
$$;

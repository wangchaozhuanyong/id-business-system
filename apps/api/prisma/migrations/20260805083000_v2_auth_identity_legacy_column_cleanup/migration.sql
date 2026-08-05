-- Remove the obsolete auth identity relation left by legacy production restores.
-- Refuse the migration if the legacy relation does not match the current user relation.
DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM information_schema.columns
    WHERE table_schema = 'public'
      AND table_name = 'v2_auth_identities'
      AND column_name = 'legacy_user_id'
  ) THEN
    IF NOT EXISTS (
      SELECT 1
      FROM information_schema.columns
      WHERE table_schema = 'public'
        AND table_name = 'v2_auth_identities'
        AND column_name = 'user_id'
    ) THEN
      RAISE EXCEPTION 'v2_auth_identities.user_id is missing; refusing legacy cleanup';
    END IF;

    IF EXISTS (
      SELECT 1
      FROM public.v2_auth_identities
      WHERE legacy_user_id IS DISTINCT FROM user_id
    ) THEN
      RAISE EXCEPTION 'v2_auth_identities legacy_user_id differs from user_id; refusing cleanup';
    END IF;

    ALTER TABLE public.v2_auth_identities
      DROP CONSTRAINT IF EXISTS v2_auth_identities_legacy_user_id_fkey;

    DROP INDEX IF EXISTS public.v2_auth_identities_legacy_user_id_key;

    ALTER TABLE public.v2_auth_identities
      DROP COLUMN IF EXISTS legacy_user_id;
  END IF;
END
$$;

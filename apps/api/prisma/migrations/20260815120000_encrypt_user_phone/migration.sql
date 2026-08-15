ALTER TABLE public.users
ADD COLUMN phone_encrypted TEXT,
ADD COLUMN phone_masked VARCHAR(80);

UPDATE public.users
SET phone_masked = CASE
  WHEN phone = '' THEN NULL
  WHEN length(regexp_replace(phone, '\s+', '', 'g')) <= 4 THEN '***'
  ELSE '***' || right(regexp_replace(phone, '\s+', '', 'g'), 4)
END
WHERE phone IS NOT NULL;

-- Existing rows are encrypted and the constraint is validated by the fixed backfill command.
-- NOT VALID still rejects every new or updated row that attempts to retain plaintext.
ALTER TABLE public.users
ADD CONSTRAINT users_phone_plaintext_forbidden
CHECK (phone IS NULL) NOT VALID;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM public.users WHERE phone IS NOT NULL) THEN
    ALTER TABLE public.users VALIDATE CONSTRAINT users_phone_plaintext_forbidden;
  END IF;
END
$$;

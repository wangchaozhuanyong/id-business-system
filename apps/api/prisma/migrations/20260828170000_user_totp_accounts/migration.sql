CREATE TYPE "IdBusinessV2TotpAlgorithm" AS ENUM ('sha1', 'sha256', 'sha512');

CREATE TABLE "id_business_v2_totp_accounts" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "name" VARCHAR(60) NOT NULL,
  "issuer" VARCHAR(120),
  "secret_encrypted" TEXT NOT NULL,
  "secret_hash" VARCHAR(64) NOT NULL,
  "algorithm" "IdBusinessV2TotpAlgorithm" NOT NULL DEFAULT 'sha1',
  "digits" INTEGER NOT NULL DEFAULT 6,
  "period" INTEGER NOT NULL DEFAULT 30,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "id_business_v2_totp_accounts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "id_business_v2_totp_accounts_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "id_business_v2_totp_accounts_digits_check"
    CHECK ("digits" BETWEEN 6 AND 8),
  CONSTRAINT "id_business_v2_totp_accounts_period_check"
    CHECK ("period" BETWEEN 15 AND 300)
);

CREATE UNIQUE INDEX "id_business_v2_totp_accounts_user_id_name_key"
ON "id_business_v2_totp_accounts"("user_id", "name");

CREATE UNIQUE INDEX "id_business_v2_totp_accounts_user_id_secret_hash_key"
ON "id_business_v2_totp_accounts"("user_id", "secret_hash");

CREATE INDEX "id_business_v2_totp_accounts_user_id_updated_at_idx"
ON "id_business_v2_totp_accounts"("user_id", "updated_at");

CREATE TRIGGER id_business_v2_totp_accounts_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_totp_accounts
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change('workspace');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'id_business_v2_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON TABLE public.id_business_v2_totp_accounts
      TO id_business_v2_runtime;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'id_business_v2_audit') THEN
    GRANT SELECT
      ON TABLE public.id_business_v2_totp_accounts
      TO id_business_v2_audit;
  END IF;
END
$$;

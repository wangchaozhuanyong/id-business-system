CREATE TYPE "IdBusinessV2MailProvider" AS ENUM ('gmail', 'icloud');
CREATE TYPE "IdBusinessV2ManagedMailboxStatus" AS ENUM ('active', 'disabled', 'auth_failed');
CREATE TYPE "IdBusinessV2MailQueryOutcome" AS ENUM ('success', 'invalid', 'rate_limited', 'provider_error');

CREATE TABLE "id_business_v2_managed_mailboxes" (
  "id" UUID NOT NULL,
  "email" VARCHAR(254) NOT NULL,
  "label" VARCHAR(60),
  "provider" "IdBusinessV2MailProvider" NOT NULL,
  "provider_credential_encrypted" TEXT NOT NULL,
  "query_code_hash" VARCHAR(64) NOT NULL,
  "query_code_hint" VARCHAR(4) NOT NULL,
  "status" "IdBusinessV2ManagedMailboxStatus" NOT NULL DEFAULT 'active',
  "last_verified_at" TIMESTAMPTZ(6),
  "last_queried_at" TIMESTAMPTZ(6),
  "last_error_code" VARCHAR(80),
  "created_by_user_id" UUID NOT NULL,
  "updated_by_user_id" UUID NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "id_business_v2_managed_mailboxes_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "id_business_v2_mail_query_attempts" (
  "id" UUID NOT NULL,
  "mailbox_id" UUID,
  "email_hash" VARCHAR(64) NOT NULL,
  "ip_hash" VARCHAR(64),
  "outcome" "IdBusinessV2MailQueryOutcome" NOT NULL,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "id_business_v2_mail_query_attempts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "id_business_v2_managed_mailboxes_email_key"
  ON "id_business_v2_managed_mailboxes"("email");
CREATE INDEX "id_business_v2_managed_mailboxes_status_updated_at_idx"
  ON "id_business_v2_managed_mailboxes"("status", "updated_at");
CREATE INDEX "id_business_v2_managed_mailboxes_created_by_user_id_idx"
  ON "id_business_v2_managed_mailboxes"("created_by_user_id");
CREATE INDEX "id_business_v2_managed_mailboxes_updated_by_user_id_idx"
  ON "id_business_v2_managed_mailboxes"("updated_by_user_id");
CREATE INDEX "id_business_v2_mail_query_attempts_email_hash_created_at_idx"
  ON "id_business_v2_mail_query_attempts"("email_hash", "created_at");
CREATE INDEX "id_business_v2_mail_query_attempts_ip_hash_created_at_idx"
  ON "id_business_v2_mail_query_attempts"("ip_hash", "created_at");
CREATE INDEX "id_business_v2_mail_query_attempts_mailbox_id_created_at_idx"
  ON "id_business_v2_mail_query_attempts"("mailbox_id", "created_at");

ALTER TABLE "id_business_v2_managed_mailboxes"
  ADD CONSTRAINT "id_business_v2_managed_mailboxes_created_by_user_id_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "id_business_v2_managed_mailboxes"
  ADD CONSTRAINT "id_business_v2_managed_mailboxes_updated_by_user_id_fkey"
  FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "id_business_v2_mail_query_attempts"
  ADD CONSTRAINT "id_business_v2_mail_query_attempts_mailbox_id_fkey"
  FOREIGN KEY ("mailbox_id") REFERENCES "id_business_v2_managed_mailboxes"("id") ON DELETE SET NULL ON UPDATE CASCADE;

CREATE TRIGGER id_business_v2_managed_mailboxes_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_managed_mailboxes
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change('workspace');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'id_business_v2_runtime') THEN
    GRANT SELECT, INSERT, UPDATE
      ON TABLE public.id_business_v2_managed_mailboxes
      TO id_business_v2_runtime;
    GRANT SELECT, INSERT
      ON TABLE public.id_business_v2_mail_query_attempts
      TO id_business_v2_runtime;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'id_business_v2_audit') THEN
    GRANT SELECT
      ON TABLE public.id_business_v2_managed_mailboxes, public.id_business_v2_mail_query_attempts
      TO id_business_v2_audit;
  END IF;
END
$$;

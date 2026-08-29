ALTER TYPE "IdBusinessV2MailProvider" ADD VALUE IF NOT EXISTS 'microsoft';

ALTER TABLE "id_business_v2_managed_mailboxes"
  ADD COLUMN "query_code_encrypted" TEXT;

CREATE TYPE "IdBusinessV2MailboxOAuthStatus" AS ENUM ('pending', 'succeeded', 'failed');

CREATE TABLE "id_business_v2_mailbox_oauth_states" (
  "id" UUID NOT NULL,
  "state_hash" VARCHAR(64) NOT NULL,
  "email" VARCHAR(254) NOT NULL,
  "label" VARCHAR(60),
  "status" "IdBusinessV2MailboxOAuthStatus" NOT NULL DEFAULT 'pending',
  "failure_code" VARCHAR(80),
  "mailbox_id" UUID,
  "created_by_user_id" UUID NOT NULL,
  "expires_at" TIMESTAMPTZ(6) NOT NULL,
  "completed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "id_business_v2_mailbox_oauth_states_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "id_business_v2_mailbox_oauth_states_state_hash_key"
  ON "id_business_v2_mailbox_oauth_states"("state_hash");
CREATE INDEX "idbiz_mail_oauth_states_creator_created_idx"
  ON "id_business_v2_mailbox_oauth_states"("created_by_user_id", "created_at");
CREATE INDEX "idbiz_mail_oauth_states_status_expiry_idx"
  ON "id_business_v2_mailbox_oauth_states"("status", "expires_at");
CREATE INDEX "idbiz_mail_oauth_states_mailbox_idx"
  ON "id_business_v2_mailbox_oauth_states"("mailbox_id");

ALTER TABLE "id_business_v2_mailbox_oauth_states"
  ADD CONSTRAINT "idbiz_mail_oauth_states_mailbox_fkey"
  FOREIGN KEY ("mailbox_id") REFERENCES "id_business_v2_managed_mailboxes"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "id_business_v2_mailbox_oauth_states"
  ADD CONSTRAINT "idbiz_mail_oauth_states_created_by_fkey"
  FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

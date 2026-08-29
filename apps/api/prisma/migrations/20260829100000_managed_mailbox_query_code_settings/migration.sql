CREATE TABLE "id_business_v2_managed_mailbox_settings" (
  "id" UUID NOT NULL,
  "scope" VARCHAR(32) NOT NULL DEFAULT 'global',
  "query_code_validity_days" INTEGER NOT NULL DEFAULT 30,
  "updated_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "id_business_v2_managed_mailbox_settings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "id_business_v2_managed_mailbox_settings_scope_key"
  ON "id_business_v2_managed_mailbox_settings"("scope");

CREATE INDEX "idv2_mailbox_settings_updated_by_user_id_idx"
  ON "id_business_v2_managed_mailbox_settings"("updated_by_user_id");

ALTER TABLE "id_business_v2_managed_mailbox_settings"
  ADD CONSTRAINT "idv2_mailbox_settings_updated_by_user_id_fkey"
  FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id")
  ON DELETE SET NULL ON UPDATE CASCADE;

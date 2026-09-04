CREATE TABLE "id_business_v2_google_sheets_sync" (
  "id" INTEGER NOT NULL DEFAULT 1,
  "enabled" BOOLEAN NOT NULL DEFAULT false,
  "google_oauth_client_id" VARCHAR(255),
  "client_secret_encrypted" TEXT,
  "refresh_token_encrypted" TEXT,
  "spreadsheet_id_encrypted" TEXT,
  "oauth_state_hash" VARCHAR(64),
  "oauth_verifier_encrypted" TEXT,
  "oauth_state_expires_at" TIMESTAMPTZ(6),
  "source_versions" JSONB NOT NULL DEFAULT '{}',
  "last_attempt_at" TIMESTAMPTZ(6),
  "last_succeeded_at" TIMESTAMPTZ(6),
  "last_error_code" VARCHAR(80),
  "last_error_message" VARCHAR(500),
  "run_lease_id" UUID,
  "run_lease_expires_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "id_business_v2_google_sheets_sync_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "idbiz_google_sheets_singleton_check" CHECK ("id" = 1)
);

CREATE UNIQUE INDEX "id_business_v2_google_sheets_sync_oauth_state_hash_key"
  ON "id_business_v2_google_sheets_sync"("oauth_state_hash");
CREATE INDEX "idbiz_google_sheets_enabled_attempt_idx"
  ON "id_business_v2_google_sheets_sync"("enabled", "last_attempt_at");
CREATE INDEX "idbiz_google_sheets_oauth_expiry_idx"
  ON "id_business_v2_google_sheets_sync"("oauth_state_expires_at");
CREATE INDEX "idbiz_google_sheets_lease_expiry_idx"
  ON "id_business_v2_google_sheets_sync"("run_lease_expires_at");

CREATE TYPE "IdBusinessV2RelayJobStatus" AS ENUM (
  'draft',
  'running',
  'action_required',
  'completed',
  'failed'
);

CREATE TABLE "id_business_v2_relay_connections" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "google_oauth_client_id" VARCHAR(255),
  "google_oauth_client_secret_encrypted" TEXT,
  "google_oauth_token_encrypted" TEXT,
  "google_email" VARCHAR(254),
  "google_oauth_state_hash" VARCHAR(64),
  "google_oauth_verifier_encrypted" TEXT,
  "google_oauth_state_expires_at" TIMESTAMPTZ(6),
  "cloud_bridge_session_encrypted" TEXT,
  "cloud_bridge_email" VARCHAR(254),
  "cloud_bridge_connected_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "id_business_v2_relay_connections_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "id_business_v2_relay_connections_user_id_key"
  ON "id_business_v2_relay_connections"("user_id");
CREATE UNIQUE INDEX "id_business_v2_relay_connections_google_oauth_state_hash_key"
  ON "id_business_v2_relay_connections"("google_oauth_state_hash");
CREATE INDEX "idbiz_relay_connections_google_expiry_idx"
  ON "id_business_v2_relay_connections"("google_oauth_state_expires_at");
ALTER TABLE "id_business_v2_relay_connections"
  ADD CONSTRAINT "idbiz_relay_connections_user_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "id_business_v2_relay_jobs" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "status" "IdBusinessV2RelayJobStatus" NOT NULL DEFAULT 'draft',
  "account_label" VARCHAR(80) NOT NULL,
  "project_id" VARCHAR(30) NOT NULL,
  "project_display_name" VARCHAR(80) NOT NULL,
  "billing_account" VARCHAR(80) NOT NULL,
  "location" VARCHAR(40) NOT NULL DEFAULT 'global',
  "target_group_id" INTEGER NOT NULL,
  "proxy_id" INTEGER,
  "reference_account_id" INTEGER NOT NULL,
  "credit_expires_at" TIMESTAMPTZ(6),
  "model_mapping" JSONB NOT NULL DEFAULT '{}',
  "progress" JSONB NOT NULL DEFAULT '{}',
  "completed_steps" JSONB NOT NULL DEFAULT '[]',
  "service_account_key_encrypted" TEXT,
  "cloud_bridge_account_id" INTEGER,
  "run_lease_id" UUID,
  "run_lease_expires_at" TIMESTAMPTZ(6),
  "last_error_code" VARCHAR(80),
  "last_error_message" VARCHAR(500),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL,
  CONSTRAINT "id_business_v2_relay_jobs_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "id_business_v2_relay_jobs_user_id_project_id_key"
  ON "id_business_v2_relay_jobs"("user_id", "project_id");
CREATE INDEX "idbiz_relay_jobs_user_updated_idx"
  ON "id_business_v2_relay_jobs"("user_id", "updated_at");
CREATE INDEX "idbiz_relay_jobs_status_updated_idx"
  ON "id_business_v2_relay_jobs"("status", "updated_at");
CREATE INDEX "idbiz_relay_jobs_run_lease_expiry_idx"
  ON "id_business_v2_relay_jobs"("run_lease_expires_at");
ALTER TABLE "id_business_v2_relay_jobs"
  ADD CONSTRAINT "idbiz_relay_jobs_user_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

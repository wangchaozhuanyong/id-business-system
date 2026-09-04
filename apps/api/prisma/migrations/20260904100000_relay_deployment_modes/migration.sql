CREATE TYPE "IdBusinessV2RelayDeploymentMode" AS ENUM (
  'antigravity_subscription',
  'gemini_api',
  'vertex'
);

ALTER TABLE "id_business_v2_relay_jobs"
  ADD COLUMN "mode" "IdBusinessV2RelayDeploymentMode" NOT NULL DEFAULT 'vertex',
  ADD COLUMN "deployment_key" VARCHAR(80),
  ADD COLUMN "google_email" VARCHAR(254),
  ADD COLUMN "settings" JSONB,
  ADD COLUMN "mode_secret_encrypted" TEXT,
  ALTER COLUMN "project_id" DROP NOT NULL,
  ALTER COLUMN "project_display_name" DROP NOT NULL,
  ALTER COLUMN "billing_account" DROP NOT NULL,
  ALTER COLUMN "location" DROP NOT NULL,
  ALTER COLUMN "reference_account_id" DROP NOT NULL;

UPDATE "id_business_v2_relay_jobs"
SET "deployment_key" = "project_id", "settings" = '{}'::jsonb
WHERE "deployment_key" IS NULL OR "settings" IS NULL;

ALTER TABLE "id_business_v2_relay_jobs"
  ALTER COLUMN "deployment_key" SET NOT NULL,
  ALTER COLUMN "settings" SET NOT NULL,
  ALTER COLUMN "settings" SET DEFAULT '{}';

DROP INDEX "id_business_v2_relay_jobs_user_id_project_id_key";
CREATE UNIQUE INDEX "id_business_v2_relay_jobs_user_id_deployment_key_key"
  ON "id_business_v2_relay_jobs"("user_id", "deployment_key");

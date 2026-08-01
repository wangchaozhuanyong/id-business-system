ALTER TABLE "id_business_v2_governance_jobs"
ALTER COLUMN "updated_at" DROP DEFAULT;

ALTER TABLE "id_business_v2_governance_job_items"
ALTER COLUMN "updated_at" DROP DEFAULT;

ALTER TABLE "id_business_v2_governance_checkpoints"
ALTER COLUMN "updated_at" DROP DEFAULT;

CREATE TYPE "IdBusinessV2GovernanceJobType" AS ENUM (
  'recycle_restore',
  'exchange_rate_cleanup'
);

CREATE TYPE "IdBusinessV2GovernanceJobStatus" AS ENUM (
  'pending_approval',
  'approved',
  'running',
  'succeeded',
  'partially_succeeded',
  'failed',
  'rejected',
  'cancelled'
);

CREATE TYPE "IdBusinessV2GovernanceEntityType" AS ENUM (
  'account',
  'customer',
  'option',
  'order',
  'exchange_rate_run'
);

CREATE TYPE "IdBusinessV2GovernanceItemStatus" AS ENUM (
  'pending',
  'processing',
  'succeeded',
  'skipped',
  'failed'
);

CREATE TYPE "IdBusinessV2GovernanceApprovalDecision" AS ENUM ('approved', 'rejected');
CREATE TYPE "IdBusinessV2GovernanceCheckpointStatus" AS ENUM ('running', 'completed', 'failed');

CREATE TABLE "id_business_v2_governance_jobs" (
  "id" UUID NOT NULL,
  "job_no" VARCHAR(48) NOT NULL,
  "type" "IdBusinessV2GovernanceJobType" NOT NULL,
  "status" "IdBusinessV2GovernanceJobStatus" NOT NULL DEFAULT 'pending_approval',
  "reason" TEXT NOT NULL,
  "backup_evidence" TEXT NOT NULL,
  "preview_hash" VARCHAR(64) NOT NULL,
  "preview_summary" JSONB NOT NULL,
  "requested_by_user_id" UUID NOT NULL,
  "executed_by_user_id" UUID,
  "total_items" INTEGER NOT NULL DEFAULT 0,
  "succeeded_items" INTEGER NOT NULL DEFAULT 0,
  "skipped_items" INTEGER NOT NULL DEFAULT 0,
  "failed_items" INTEGER NOT NULL DEFAULT 0,
  "idempotency_key" VARCHAR(160) NOT NULL,
  "approved_at" TIMESTAMPTZ(6),
  "started_at" TIMESTAMPTZ(6),
  "completed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "id_business_v2_governance_jobs_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "id_business_v2_governance_jobs_counts_check" CHECK (
    "total_items" >= 0
    AND "succeeded_items" >= 0
    AND "skipped_items" >= 0
    AND "failed_items" >= 0
    AND "succeeded_items" + "skipped_items" + "failed_items" <= "total_items"
  )
);

CREATE TABLE "id_business_v2_governance_job_items" (
  "id" UUID NOT NULL,
  "job_id" UUID NOT NULL,
  "sequence" INTEGER NOT NULL,
  "entity_type" "IdBusinessV2GovernanceEntityType" NOT NULL,
  "entity_id" UUID NOT NULL,
  "safe_label" VARCHAR(255) NOT NULL,
  "source_deleted_at" TIMESTAMPTZ(6),
  "eligibility" JSONB NOT NULL,
  "status" "IdBusinessV2GovernanceItemStatus" NOT NULL DEFAULT 'pending',
  "result_code" VARCHAR(120),
  "result_message" TEXT,
  "processed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "id_business_v2_governance_job_items_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "id_business_v2_governance_job_items_sequence_check" CHECK ("sequence" > 0)
);

CREATE TABLE "id_business_v2_governance_approvals" (
  "id" UUID NOT NULL,
  "job_id" UUID NOT NULL,
  "approver_user_id" UUID NOT NULL,
  "decision" "IdBusinessV2GovernanceApprovalDecision" NOT NULL,
  "reason" TEXT NOT NULL,
  "preview_hash" VARCHAR(64) NOT NULL,
  "decided_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "id_business_v2_governance_approvals_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "id_business_v2_governance_checkpoints" (
  "id" UUID NOT NULL,
  "job_id" UUID NOT NULL,
  "batch_no" INTEGER NOT NULL,
  "idempotency_key" VARCHAR(160) NOT NULL,
  "status" "IdBusinessV2GovernanceCheckpointStatus" NOT NULL DEFAULT 'running',
  "cursor_sequence" INTEGER NOT NULL,
  "attempted_items" INTEGER NOT NULL DEFAULT 0,
  "succeeded_items" INTEGER NOT NULL DEFAULT 0,
  "skipped_items" INTEGER NOT NULL DEFAULT 0,
  "failed_items" INTEGER NOT NULL DEFAULT 0,
  "error_code" VARCHAR(120),
  "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMPTZ(6),
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "id_business_v2_governance_checkpoints_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "id_business_v2_governance_checkpoints_counts_check" CHECK (
    "batch_no" > 0
    AND "cursor_sequence" >= 0
    AND "attempted_items" >= 0
    AND "succeeded_items" >= 0
    AND "skipped_items" >= 0
    AND "failed_items" >= 0
    AND "succeeded_items" + "skipped_items" + "failed_items" <= "attempted_items"
  )
);

CREATE UNIQUE INDEX "id_business_v2_governance_jobs_job_no_key"
ON "id_business_v2_governance_jobs"("job_no");
CREATE UNIQUE INDEX "id_business_v2_governance_jobs_idempotency_key_key"
ON "id_business_v2_governance_jobs"("idempotency_key");
CREATE INDEX "id_business_v2_governance_jobs_status_created_at_idx"
ON "id_business_v2_governance_jobs"("status", "created_at");
CREATE INDEX "id_business_v2_governance_jobs_type_created_at_idx"
ON "id_business_v2_governance_jobs"("type", "created_at");
CREATE INDEX "id_business_v2_governance_jobs_requested_by_user_id_created_idx"
ON "id_business_v2_governance_jobs"("requested_by_user_id", "created_at");
CREATE INDEX "id_business_v2_governance_jobs_executed_by_user_id_idx"
ON "id_business_v2_governance_jobs"("executed_by_user_id");

CREATE UNIQUE INDEX "id_business_v2_governance_job_items_job_id_sequence_key"
ON "id_business_v2_governance_job_items"("job_id", "sequence");
CREATE UNIQUE INDEX "id_business_v2_governance_job_items_job_id_entity_type_enti_key"
ON "id_business_v2_governance_job_items"("job_id", "entity_type", "entity_id");
CREATE INDEX "id_business_v2_governance_job_items_job_id_status_sequence_idx"
ON "id_business_v2_governance_job_items"("job_id", "status", "sequence");
CREATE INDEX "id_business_v2_governance_job_items_entity_type_entity_id_idx"
ON "id_business_v2_governance_job_items"("entity_type", "entity_id");

CREATE UNIQUE INDEX "id_business_v2_governance_approvals_job_id_key"
ON "id_business_v2_governance_approvals"("job_id");
CREATE INDEX "id_business_v2_governance_approvals_approver_user_id_decide_idx"
ON "id_business_v2_governance_approvals"("approver_user_id", "decided_at");
CREATE INDEX "id_business_v2_governance_approvals_decision_decided_at_idx"
ON "id_business_v2_governance_approvals"("decision", "decided_at");

CREATE UNIQUE INDEX "id_business_v2_governance_checkpoints_idempotency_key_key"
ON "id_business_v2_governance_checkpoints"("idempotency_key");
CREATE UNIQUE INDEX "id_business_v2_governance_checkpoints_job_id_batch_no_key"
ON "id_business_v2_governance_checkpoints"("job_id", "batch_no");
CREATE INDEX "id_business_v2_governance_checkpoints_job_id_status_idx"
ON "id_business_v2_governance_checkpoints"("job_id", "status");
CREATE INDEX "id_business_v2_governance_checkpoints_created_at_idx"
ON "id_business_v2_governance_checkpoints"("created_at");

ALTER TABLE "id_business_v2_governance_jobs"
ADD CONSTRAINT "id_business_v2_governance_jobs_requested_by_user_id_fkey"
FOREIGN KEY ("requested_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "id_business_v2_governance_jobs"
ADD CONSTRAINT "id_business_v2_governance_jobs_executed_by_user_id_fkey"
FOREIGN KEY ("executed_by_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "id_business_v2_governance_job_items"
ADD CONSTRAINT "id_business_v2_governance_job_items_job_id_fkey"
FOREIGN KEY ("job_id") REFERENCES "id_business_v2_governance_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "id_business_v2_governance_approvals"
ADD CONSTRAINT "id_business_v2_governance_approvals_job_id_fkey"
FOREIGN KEY ("job_id") REFERENCES "id_business_v2_governance_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "id_business_v2_governance_approvals"
ADD CONSTRAINT "id_business_v2_governance_approvals_approver_user_id_fkey"
FOREIGN KEY ("approver_user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "id_business_v2_governance_checkpoints"
ADD CONSTRAINT "id_business_v2_governance_checkpoints_job_id_fkey"
FOREIGN KEY ("job_id") REFERENCES "id_business_v2_governance_jobs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION public.id_business_v2_governance_approval_guard()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = 'public', 'pg_temp'
AS $function$
DECLARE
  governance_job public.id_business_v2_governance_jobs%ROWTYPE;
BEGIN
  SELECT * INTO governance_job
  FROM public.id_business_v2_governance_jobs
  WHERE id = NEW.job_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'governance job does not exist';
  END IF;
  IF governance_job.status <> 'pending_approval' THEN
    RAISE EXCEPTION 'governance job is not awaiting approval';
  END IF;
  IF governance_job.requested_by_user_id = NEW.approver_user_id THEN
    RAISE EXCEPTION 'governance requester cannot approve own job';
  END IF;
  IF governance_job.preview_hash <> NEW.preview_hash THEN
    RAISE EXCEPTION 'governance approval preview hash mismatch';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER id_business_v2_governance_approval_guard
BEFORE INSERT ON public.id_business_v2_governance_approvals
FOR EACH ROW EXECUTE FUNCTION public.id_business_v2_governance_approval_guard();

CREATE OR REPLACE FUNCTION public.id_business_v2_governance_approval_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  RAISE EXCEPTION 'governance approval records are immutable';
END;
$function$;

CREATE TRIGGER id_business_v2_governance_approval_immutable
BEFORE UPDATE OR DELETE ON public.id_business_v2_governance_approvals
FOR EACH ROW EXECUTE FUNCTION public.id_business_v2_governance_approval_immutable();

INSERT INTO "id_business_v2_scope_versions" ("scope", "version")
VALUES ('data-governance', 0)
ON CONFLICT ("scope") DO NOTHING;

CREATE TRIGGER id_business_v2_governance_jobs_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_governance_jobs
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change('data-governance');
CREATE TRIGGER id_business_v2_governance_job_items_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_governance_job_items
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change('data-governance');
CREATE TRIGGER id_business_v2_governance_approvals_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_governance_approvals
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change('data-governance');
CREATE TRIGGER id_business_v2_governance_checkpoints_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_governance_checkpoints
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change('data-governance');

CREATE TRIGGER id_business_v2_options_governance_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_options
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change('data-governance');
CREATE TRIGGER id_business_v2_customers_governance_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_customers
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change('data-governance');
CREATE TRIGGER id_business_v2_accounts_governance_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_accounts
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change('data-governance');
CREATE TRIGGER id_business_v2_orders_governance_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_orders
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change('data-governance');

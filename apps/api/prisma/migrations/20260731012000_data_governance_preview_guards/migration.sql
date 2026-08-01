ALTER TABLE "id_business_v2_governance_job_items"
ADD COLUMN "result_audit_log_id" UUID;

CREATE INDEX "id_business_v2_governance_job_items_result_audit_log_id_idx"
ON "id_business_v2_governance_job_items"("result_audit_log_id");

ALTER TABLE "id_business_v2_governance_job_items"
ADD CONSTRAINT "id_business_v2_governance_job_items_result_audit_log_id_fkey"
FOREIGN KEY ("result_audit_log_id") REFERENCES "audit_logs"("id")
ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE OR REPLACE FUNCTION public.id_business_v2_governance_job_preview_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF ROW(
    OLD.job_no,
    OLD.type,
    OLD.reason,
    OLD.backup_evidence,
    OLD.preview_hash,
    OLD.preview_summary,
    OLD.requested_by_user_id,
    OLD.total_items,
    OLD.idempotency_key,
    OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.job_no,
    NEW.type,
    NEW.reason,
    NEW.backup_evidence,
    NEW.preview_hash,
    NEW.preview_summary,
    NEW.requested_by_user_id,
    NEW.total_items,
    NEW.idempotency_key,
    NEW.created_at
  ) THEN
    RAISE EXCEPTION 'governance job preview fields are immutable';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER id_business_v2_governance_job_preview_immutable
BEFORE UPDATE ON public.id_business_v2_governance_jobs
FOR EACH ROW EXECUTE FUNCTION public.id_business_v2_governance_job_preview_immutable();

CREATE OR REPLACE FUNCTION public.id_business_v2_governance_item_identity_immutable()
RETURNS trigger
LANGUAGE plpgsql
SET search_path = ''
AS $function$
BEGIN
  IF ROW(
    OLD.job_id,
    OLD.sequence,
    OLD.entity_type,
    OLD.entity_id,
    OLD.safe_label,
    OLD.source_deleted_at,
    OLD.eligibility,
    OLD.created_at
  ) IS DISTINCT FROM ROW(
    NEW.job_id,
    NEW.sequence,
    NEW.entity_type,
    NEW.entity_id,
    NEW.safe_label,
    NEW.source_deleted_at,
    NEW.eligibility,
    NEW.created_at
  ) THEN
    RAISE EXCEPTION 'governance job item identity is immutable';
  END IF;
  RETURN NEW;
END;
$function$;

CREATE TRIGGER id_business_v2_governance_item_identity_immutable
BEFORE UPDATE ON public.id_business_v2_governance_job_items
FOR EACH ROW EXECUTE FUNCTION public.id_business_v2_governance_item_identity_immutable();

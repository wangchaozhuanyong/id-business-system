ALTER TABLE "role_permissions"
ADD COLUMN "sensitive_approval_required" BOOLEAN NOT NULL DEFAULT false;

CREATE INDEX "role_permissions_sensitive_approval_required_idx"
ON "role_permissions"("sensitive_approval_required");

CREATE INDEX "sensitive_access_approvals_pending_request_lookup_idx"
ON "sensitive_access_approvals" (
  "requester_id",
  "module",
  "field_name",
  "object_type",
  COALESCE("object_id", '00000000-0000-0000-0000-000000000000'::uuid)
)
WHERE "status" = 'pending';

INSERT INTO "id_business_v2_scope_versions" ("scope", "version")
VALUES ('security', 0)
ON CONFLICT ("scope") DO NOTHING;

CREATE TRIGGER id_business_v2_sensitive_approvals_security_change
AFTER INSERT OR UPDATE OR DELETE ON public.sensitive_access_approvals
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change('security');

CREATE TRIGGER id_business_v2_sensitive_access_logs_security_change
AFTER INSERT OR UPDATE OR DELETE ON public.sensitive_access_logs
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change('security');

CREATE TRIGGER id_business_v2_role_permissions_security_change
AFTER INSERT OR UPDATE OR DELETE ON public.role_permissions
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change('security', 'employees');

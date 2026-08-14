CREATE TYPE "IdBusinessV2SensitiveDisplayContext" AS ENUM (
  'account_management',
  'customer_management',
  'order_workbench',
  'topup_workbench',
  'renewal_workbench',
  'business_records',
  'dashboard_notifications',
  'export',
  'audit'
);

CREATE TYPE "IdBusinessV2SensitiveDisplayMode" AS ENUM (
  'hidden',
  'masked',
  'reveal_direct',
  'reveal_approval',
  'full'
);

CREATE TABLE "id_business_v2_sensitive_display_policies" (
  "id" UUID NOT NULL,
  "role_id" UUID NOT NULL,
  "field_key" VARCHAR(80) NOT NULL,
  "context" "IdBusinessV2SensitiveDisplayContext" NOT NULL,
  "mode" "IdBusinessV2SensitiveDisplayMode" NOT NULL,
  "created_by_user_id" UUID,
  "updated_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "id_business_v2_sensitive_display_policies_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "id_business_v2_sensitive_display_policies_role_id_fkey"
    FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT "id_business_v2_sensitive_display_policies_created_by_user_id_fkey"
    FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT "id_business_v2_sensitive_display_policies_updated_by_user_id_fkey"
    FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "id_business_v2_sensitive_display_policies_role_id_field_key_context_key"
ON "id_business_v2_sensitive_display_policies"("role_id", "field_key", "context");

CREATE INDEX "id_business_v2_sensitive_display_policies_role_id_context_idx"
ON "id_business_v2_sensitive_display_policies"("role_id", "context");

CREATE INDEX "id_business_v2_sensitive_display_policies_field_key_context_mode_idx"
ON "id_business_v2_sensitive_display_policies"("field_key", "context", "mode");

CREATE INDEX "id_business_v2_sensitive_display_policies_created_by_user_id_idx"
ON "id_business_v2_sensitive_display_policies"("created_by_user_id");

CREATE INDEX "id_business_v2_sensitive_display_policies_updated_by_user_id_idx"
ON "id_business_v2_sensitive_display_policies"("updated_by_user_id");

INSERT INTO "permissions" ("id", "name", "code", "module", "action")
VALUES (
  gen_random_uuid(),
  '查看完整网站账号',
  'apple.order.view_website_account',
  'apple.order',
  'view_website_account'
)
ON CONFLICT ("code") DO UPDATE SET
  "name" = EXCLUDED."name",
  "module" = EXCLUDED."module",
  "action" = EXCLUDED."action";

UPDATE "permissions"
SET "name" = '查看客户联系方式'
WHERE "code" = 'customer.view_phone';

INSERT INTO "role_permissions" ("role_id", "permission_id")
SELECT role."id", permission."id"
FROM "roles" role
JOIN "permissions" permission
  ON permission."code" = 'apple.order.view_website_account'
WHERE role."code" = 'admin'
ON CONFLICT DO NOTHING;

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'id_business_v2_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON TABLE public.id_business_v2_sensitive_display_policies
      TO id_business_v2_runtime;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'id_business_v2_audit') THEN
    GRANT SELECT
      ON TABLE public.id_business_v2_sensitive_display_policies
      TO id_business_v2_audit;
  END IF;
END
$$;

CREATE TABLE "id_business_v2_workspace_shortcuts" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "name" VARCHAR(60) NOT NULL,
  "url" VARCHAR(2048) NOT NULL,
  "sort_order" INTEGER NOT NULL DEFAULT 0,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "id_business_v2_workspace_shortcuts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "id_business_v2_workspace_shortcuts_user_id_url_key"
  ON "id_business_v2_workspace_shortcuts"("user_id", "url");

CREATE INDEX "id_business_v2_workspace_shortcuts_user_id_sort_order_idx"
  ON "id_business_v2_workspace_shortcuts"("user_id", "sort_order");

ALTER TABLE "id_business_v2_workspace_shortcuts"
  ADD CONSTRAINT "id_business_v2_workspace_shortcuts_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

INSERT INTO "id_business_v2_scope_versions" ("scope", "version")
VALUES ('workspace', 0)
ON CONFLICT ("scope") DO NOTHING;

CREATE TRIGGER id_business_v2_workspace_shortcuts_change
AFTER INSERT OR UPDATE OR DELETE ON public.id_business_v2_workspace_shortcuts
FOR EACH STATEMENT EXECUTE FUNCTION public.id_business_v2_publish_change('workspace');

DO $$
BEGIN
  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'id_business_v2_runtime') THEN
    GRANT SELECT, INSERT, UPDATE, DELETE
      ON TABLE public.id_business_v2_workspace_shortcuts
      TO id_business_v2_runtime;
  END IF;

  IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'id_business_v2_audit') THEN
    GRANT SELECT
      ON TABLE public.id_business_v2_workspace_shortcuts
      TO id_business_v2_audit;
  END IF;
END
$$;

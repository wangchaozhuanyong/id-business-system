ALTER TABLE "id_business_v2_managed_mailboxes"
  ADD COLUMN "query_code_expires_at" TIMESTAMPTZ(6);

UPDATE "id_business_v2_managed_mailboxes"
SET "query_code_expires_at" = CURRENT_TIMESTAMP + INTERVAL '30 days'
WHERE "query_code_expires_at" IS NULL;

ALTER TABLE "id_business_v2_managed_mailboxes"
  ALTER COLUMN "query_code_expires_at" SET NOT NULL;

CREATE INDEX "idv2_mailboxes_status_query_code_expires_at_idx"
  ON "id_business_v2_managed_mailboxes"("status", "query_code_expires_at");

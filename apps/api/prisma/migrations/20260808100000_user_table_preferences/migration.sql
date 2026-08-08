CREATE TABLE "id_business_v2_user_table_preferences" (
  "id" UUID NOT NULL,
  "user_id" UUID NOT NULL,
  "table_id" VARCHAR(120) NOT NULL,
  "hidden_column_keys" JSONB NOT NULL DEFAULT '[]'::jsonb,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "id_business_v2_user_table_preferences_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "id_business_v2_user_table_preferences_user_id_table_id_key"
  ON "id_business_v2_user_table_preferences"("user_id", "table_id");

CREATE INDEX "id_business_v2_user_table_preferences_user_id_idx"
  ON "id_business_v2_user_table_preferences"("user_id");

ALTER TABLE "id_business_v2_user_table_preferences"
  ADD CONSTRAINT "id_business_v2_user_table_preferences_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

CREATE TABLE "id_business_v2_website_visits" (
  "id" VARCHAR(36) NOT NULL,
  "host" VARCHAR(253) NOT NULL,
  "occurred_at" TIMESTAMPTZ(3) NOT NULL,
  "received_at" TIMESTAMPTZ(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "path" VARCHAR(1024) NOT NULL,
  "ip_encrypted" TEXT NOT NULL,
  "ip_hash" CHAR(64) NOT NULL,
  CONSTRAINT "id_business_v2_website_visits_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "idbiz_website_visit_host_check" CHECK ("host" IN ('flashcast.com.my', 'www.flashcast.com.my'))
);

CREATE INDEX "idbiz_website_visit_time_idx"
  ON "id_business_v2_website_visits"("occurred_at", "id");
CREATE INDEX "idbiz_website_visit_ip_time_idx"
  ON "id_business_v2_website_visits"("ip_hash", "occurred_at");

CREATE TABLE "id_business_v2_branding_settings" (
  "id" INTEGER NOT NULL DEFAULT 1,
  "app_name" VARCHAR(80) NOT NULL DEFAULT 'ID 业务管理',
  "logo_text" VARCHAR(12) NOT NULL DEFAULT 'ID',
  "app_subtitle" VARCHAR(120) NOT NULL DEFAULT 'Apple ID 订阅运营',
  "login_hero_title" VARCHAR(160) NOT NULL DEFAULT E'把订单、余额与续费\n收进一条安全动线',
  "login_note" VARCHAR(180) NOT NULL DEFAULT '内部后台仅限授权人员访问，登录后继续处理订单与财务任务。',
  "footer_text" VARCHAR(160) NOT NULL DEFAULT '© 2026 Apple 内部系统 · 仅限授权人员访问',
  "document_title_suffix" VARCHAR(80) NOT NULL DEFAULT 'ID 业务管理',
  "updated_by_user_id" UUID,
  "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "id_business_v2_branding_settings_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "id_business_v2_branding_settings_updated_by_user_id_idx"
  ON "id_business_v2_branding_settings"("updated_by_user_id");

ALTER TABLE "id_business_v2_branding_settings"
  ADD CONSTRAINT "id_business_v2_branding_settings_updated_by_user_id_fkey"
  FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

INSERT INTO "id_business_v2_branding_settings" (
  "id",
  "app_name",
  "logo_text",
  "app_subtitle",
  "login_hero_title",
  "login_note",
  "footer_text",
  "document_title_suffix"
)
VALUES (
  1,
  'ID 业务管理',
  'ID',
  'Apple ID 订阅运营',
  E'把订单、余额与续费\n收进一条安全动线',
  '内部后台仅限授权人员访问，登录后继续处理订单与财务任务。',
  '© 2026 Apple 内部系统 · 仅限授权人员访问',
  'ID 业务管理'
)
ON CONFLICT ("id") DO NOTHING;

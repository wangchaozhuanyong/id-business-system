ALTER TABLE "id_business_v2_finance_settings"
ALTER COLUMN "timezone" SET DEFAULT 'Asia/Shanghai';

UPDATE "id_business_v2_finance_settings"
SET "timezone" = 'Asia/Shanghai'
WHERE "timezone" = 'Asia/Kuala_Lumpur';

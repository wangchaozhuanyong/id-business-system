-- Keep historical registration countries unknown; do not infer them from login networks.
ALTER TABLE `id_business_v2_chatgpt_accounts`
  ADD COLUMN `registration_country_code` CHAR(2) NULL;

ALTER TABLE `id_business_v2_registration_jobs`
  ADD COLUMN `registration_country_code` CHAR(2) NULL;

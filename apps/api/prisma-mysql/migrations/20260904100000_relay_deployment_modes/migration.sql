ALTER TABLE `id_business_v2_relay_jobs`
  ADD COLUMN `mode` ENUM('antigravity_subscription', 'gemini_api', 'vertex') NOT NULL DEFAULT 'vertex' AFTER `status`,
  ADD COLUMN `deployment_key` VARCHAR(80) NULL AFTER `mode`,
  ADD COLUMN `google_email` VARCHAR(254) NULL AFTER `account_label`,
  ADD COLUMN `settings` JSON NULL AFTER `model_mapping`,
  ADD COLUMN `mode_secret_encrypted` TEXT NULL AFTER `service_account_key_encrypted`,
  MODIFY `project_id` VARCHAR(30) NULL,
  MODIFY `project_display_name` VARCHAR(80) NULL,
  MODIFY `billing_account` VARCHAR(80) NULL,
  MODIFY `location` VARCHAR(40) NULL DEFAULT 'global',
  MODIFY `reference_account_id` INTEGER NULL;

UPDATE `id_business_v2_relay_jobs`
SET `deployment_key` = `project_id`, `settings` = JSON_OBJECT()
WHERE `deployment_key` IS NULL OR `settings` IS NULL;

ALTER TABLE `id_business_v2_relay_jobs`
  MODIFY `deployment_key` VARCHAR(80) NOT NULL,
  MODIFY `settings` JSON NOT NULL,
  DROP INDEX `id_business_v2_relay_jobs_user_id_project_id_key`,
  ADD UNIQUE INDEX `id_business_v2_relay_jobs_user_id_deployment_key_key`(`user_id`, `deployment_key`);

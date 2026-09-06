CREATE TABLE `id_business_v2_recharge_jobs` (
  `id` VARCHAR(36) NOT NULL, `owner_id` VARCHAR(191) NOT NULL,
  `account_key` CHAR(64) NULL, `plan` VARCHAR(16) NOT NULL,
  `action` VARCHAR(16) NOT NULL, `state` VARCHAR(32) NOT NULL,
  `result` JSON NOT NULL, `nonce_hash` CHAR(64) NULL,
  `lease_until` DATETIME(6) NOT NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `id_business_v2_recharge_jobs_owner_id_created_at_idx` (`owner_id`, `created_at`),
  INDEX `id_business_v2_recharge_jobs_state_lease_until_idx` (`state`, `lease_until`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE `id_business_v2_recharge_records` (
  `account_key` CHAR(64) NOT NULL, `file_key` VARCHAR(100) NOT NULL,
  `owner_id` VARCHAR(191) NOT NULL, `revision` INTEGER NOT NULL,
  `document` JSON NOT NULL, `updated_at` DATETIME(6) NOT NULL,
  PRIMARY KEY (`account_key`, `file_key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `id_business_v2_scope_versions` (`scope`, `version`, `updated_at`) VALUES ('auto-recharge', 0, CURRENT_TIMESTAMP(6));

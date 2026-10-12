-- Existing connection settings remain the default profile without rewriting credentials.
CREATE TABLE `id_business_v2_recharge_connection_profiles` (
  `id` CHAR(36) NOT NULL,
  `owner_id` VARCHAR(191) NOT NULL,
  `name` VARCHAR(80) NOT NULL,
  `configuration` JSON NOT NULL,
  `created_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `updated_at` DATETIME(3) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `id_business_v2_recharge_connection_profiles_owner_id_name_key` (`owner_id`, `name`),
  INDEX `id_business_v2_recharge_connection_profiles_owner_id_created_idx` (`owner_id`, `created_at`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

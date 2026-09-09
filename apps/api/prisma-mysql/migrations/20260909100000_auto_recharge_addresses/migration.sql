CREATE TABLE `id_business_v2_recharge_addresses` (
  `id` CHAR(36) NOT NULL,
  `owner_id` VARCHAR(191) NOT NULL,
  `line1` VARCHAR(180) NOT NULL,
  `country` CHAR(2) NOT NULL DEFAULT 'US',
  `city` VARCHAR(120) NOT NULL DEFAULT 'Portland',
  `state` VARCHAR(120) NOT NULL DEFAULT 'OR',
  `postal_code` VARCHAR(20) NOT NULL DEFAULT '97204',
  `status` VARCHAR(16) NOT NULL DEFAULT 'unused',
  `used_at` DATETIME(6) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `id_business_v2_recharge_addresses_owner_id_line1_key` (`owner_id`, `line1`),
  INDEX `id_business_v2_recharge_addresses_owner_id_status_created_at_idx` (`owner_id`, `status`, `created_at`),
  CONSTRAINT `id_business_v2_recharge_addresses_fixed_location_chk`
    CHECK (`country` = 'US' AND `city` = 'Portland' AND `state` = 'OR' AND `postal_code` = '97204'),
  CONSTRAINT `id_business_v2_recharge_addresses_status_chk`
    CHECK (`status` IN ('unused', 'used', 'disabled')),
  CONSTRAINT `id_business_v2_recharge_addresses_used_at_chk`
    CHECK ((`status` = 'used' AND `used_at` IS NOT NULL) OR (`status` <> 'used' AND `used_at` IS NULL))
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

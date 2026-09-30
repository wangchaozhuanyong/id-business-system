ALTER TABLE `id_business_v2_recharge_jobs`
  ADD COLUMN `card_id` CHAR(36) NULL,
  ADD COLUMN `billing_name_encrypted` TEXT NULL;

ALTER TABLE `id_business_v2_bank_recharge_cards`
  ADD COLUMN `billing_name_encrypted` TEXT NULL,
  ADD COLUMN `billing_address_id` CHAR(36) NULL;

ALTER TABLE `id_business_v2_recharge_addresses`
  ADD COLUMN `line2` VARCHAR(180) NULL;

CREATE INDEX `id_business_v2_recharge_jobs_card_id_idx`
  ON `id_business_v2_recharge_jobs`(`card_id`);

CREATE INDEX `id_business_v2_bank_recharge_cards_billing_address_id_idx`
  ON `id_business_v2_bank_recharge_cards`(`billing_address_id`);

ALTER TABLE `id_business_v2_recharge_jobs`
  ADD CONSTRAINT `id_business_v2_recharge_jobs_card_id_fkey`
  FOREIGN KEY (`card_id`) REFERENCES `id_business_v2_bank_recharge_cards`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `id_business_v2_bank_recharge_cards`
  ADD CONSTRAINT `id_business_v2_bank_recharge_cards_billing_address_id_fkey`
  FOREIGN KEY (`billing_address_id`) REFERENCES `id_business_v2_recharge_addresses`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE `id_business_v2_recharge_address_uses` (
  `id` CHAR(36) NOT NULL,
  `job_id` VARCHAR(36) NOT NULL,
  `address_id` CHAR(36) NOT NULL,
  `owner_id` VARCHAR(191) NOT NULL,
  `used_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  UNIQUE INDEX `id_business_v2_recharge_address_uses_job_id_key` (`job_id`),
  INDEX `id_business_v2_recharge_address_uses_address_id_used_at_idx` (`address_id`, `used_at`),
  PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `id_business_v2_recharge_address_uses`
  ADD CONSTRAINT `id_business_v2_recharge_address_uses_job_id_fkey`
  FOREIGN KEY (`job_id`) REFERENCES `id_business_v2_recharge_jobs`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE `id_business_v2_recharge_address_uses`
  ADD CONSTRAINT `id_business_v2_recharge_address_uses_address_id_fkey`
  FOREIGN KEY (`address_id`) REFERENCES `id_business_v2_recharge_addresses`(`id`)
  ON DELETE RESTRICT ON UPDATE CASCADE;

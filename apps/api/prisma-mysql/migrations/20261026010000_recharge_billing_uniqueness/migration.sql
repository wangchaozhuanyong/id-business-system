-- 新增永久排重记录，不删除任何已有业务数据；内容清理由应用在安全条件满足时执行。
CREATE TABLE `id_business_v2_recharge_billing_allocations` (
 `id` CHAR(36) NOT NULL, `request_key` VARCHAR(160) NULL, `owner_id` VARCHAR(191) NOT NULL,
 `card_hash` CHAR(64) NULL, `name_hash` CHAR(64) NULL, `address_hash` CHAR(64) NULL,
 `name_encrypted` TEXT NULL, `address_id` CHAR(36) NULL, `job_id` CHAR(36) NULL,
 `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
 UNIQUE INDEX `id_business_v2_recharge_billing_allocations_request_key_key` (`request_key`),
 UNIQUE INDEX `id_business_v2_recharge_billing_allocations_name_hash_key` (`name_hash`),
 UNIQUE INDEX `id_business_v2_recharge_billing_allocations_address_hash_key` (`address_hash`),
 UNIQUE INDEX `id_business_v2_recharge_billing_allocations_job_id_key` (`job_id`),
 INDEX `id_business_v2_recharge_billing_allocations_address_id_idx` (`address_id`),
 PRIMARY KEY (`id`),
 CONSTRAINT `recharge_billing_allocation_address_fkey` FOREIGN KEY (`address_id`)
 REFERENCES `id_business_v2_recharge_addresses` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE `id_business_v2_recharge_address_uses`
 ADD COLUMN `address_reference` CHAR(36) NULL;
UPDATE `id_business_v2_recharge_address_uses` SET `address_reference` = `address_id`;
ALTER TABLE `id_business_v2_recharge_address_uses`
 DROP FOREIGN KEY `id_business_v2_recharge_address_uses_address_id_fkey`,
 MODIFY `address_id` CHAR(36) NULL,
 ADD CONSTRAINT `recharge_address_use_nullable_fkey` FOREIGN KEY (`address_id`)
 REFERENCES `id_business_v2_recharge_addresses` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `id_business_v2_bank_recharge_cards`
 DROP FOREIGN KEY `id_business_v2_bank_recharge_cards_billing_address_id_fkey`,
 ADD CONSTRAINT `recharge_card_billing_address_nullable_fkey` FOREIGN KEY (`billing_address_id`)
 REFERENCES `id_business_v2_recharge_addresses` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;

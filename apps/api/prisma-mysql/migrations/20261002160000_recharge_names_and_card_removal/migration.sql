-- 新增姓名库与完整卡号盲索引，不改当前系统基线。
CREATE TABLE `id_business_v2_recharge_names` (
  `id` CHAR(36) NOT NULL,
  `sequence` INTEGER NOT NULL AUTO_INCREMENT,
  `name_encrypted` TEXT NOT NULL,
  `name_hash` CHAR(64) NOT NULL,
  `active` BOOLEAN NOT NULL DEFAULT true,
  `match_count` INTEGER NOT NULL DEFAULT 0,
  `last_matched_at` DATETIME(6) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `id_business_v2_recharge_names_sequence_key` (`sequence`),
  UNIQUE INDEX `id_business_v2_recharge_names_name_hash_key` (`name_hash`),
  INDEX `id_business_v2_recharge_names_rotation_idx` (`active`, `match_count`, `sequence`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
CREATE TABLE `id_business_v2_recharge_card_names` (
  `number_hash` CHAR(64) NOT NULL,
  `name_id` CHAR(36) NULL,
  `name_encrypted` TEXT NOT NULL,
  `confirmed` BOOLEAN NOT NULL DEFAULT false,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL,
  PRIMARY KEY (`number_hash`), INDEX `recharge_card_names_name_id_idx` (`name_id`),
  CONSTRAINT `recharge_card_names_name_id_fkey` FOREIGN KEY (`name_id`)
    REFERENCES `id_business_v2_recharge_names` (`id`) ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
ALTER TABLE `id_business_v2_bank_recharge_orders` ADD COLUMN `card_label_snapshot` VARCHAR(80) NULL;
-- 不批量改写历史订单；查询从关联卡补读，删除卡资料前由事务写入历史快照。
ALTER TABLE `id_business_v2_bank_recharge_orders`
 DROP FOREIGN KEY `id_business_v2_bank_recharge_orders_card_id_fkey`;
ALTER TABLE `id_business_v2_bank_recharge_orders`
 ADD CONSTRAINT `id_business_v2_bank_recharge_orders_card_id_fkey` FOREIGN KEY (`card_id`)
 REFERENCES `id_business_v2_bank_recharge_cards` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE `id_business_v2_recharge_jobs`
 DROP FOREIGN KEY `id_business_v2_recharge_jobs_card_id_fkey`;
ALTER TABLE `id_business_v2_recharge_jobs`
 ADD CONSTRAINT `id_business_v2_recharge_jobs_card_id_fkey` FOREIGN KEY (`card_id`)
 REFERENCES `id_business_v2_bank_recharge_cards` (`id`) ON DELETE SET NULL ON UPDATE CASCADE;

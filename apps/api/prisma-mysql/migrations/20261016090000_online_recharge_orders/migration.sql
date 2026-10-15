-- AlterTable
ALTER TABLE `id_business_v2_bank_recharge_orders` ADD COLUMN `channel` ENUM('bitbrowser', 'online') NOT NULL DEFAULT 'bitbrowser',
    ADD COLUMN `online_recharge_card_id` CHAR(36) NULL,
    ADD COLUMN `online_recharge_task_id` CHAR(36) NULL,
    ADD COLUMN `online_source_snapshot` JSON NULL,
    MODIFY `charge_amount` DECIMAL(18, 4) NULL,
    MODIFY `charge_currency_code` CHAR(3) NULL;

-- CreateTable
CREATE TABLE `online_recharge_order_sync` (
    `task_id` CHAR(36) NOT NULL,
    `status` ENUM('pending', 'synced', 'needs_review') NOT NULL DEFAULT 'pending',
    `attempts` INTEGER NOT NULL DEFAULT 0,
    `next_attempt_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `last_error_code` VARCHAR(80) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `online_recharge_order_sync_status_next_attempt_at_idx`(`status`, `next_attempt_at`),
    PRIMARY KEY (`task_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE UNIQUE INDEX `id_business_v2_bank_recharge_orders_online_recharge_task_id_key` ON `id_business_v2_bank_recharge_orders`(`online_recharge_task_id`);

-- CreateIndex
CREATE INDEX `recharge_orders_channel_deleted_created_idx` ON `id_business_v2_bank_recharge_orders`(`channel`, `deleted_at`, `created_at`);

-- CreateIndex
CREATE INDEX `recharge_orders_online_card_created_idx` ON `id_business_v2_bank_recharge_orders`(`online_recharge_card_id`, `created_at`);

-- AddForeignKey
ALTER TABLE `online_recharge_order_sync` ADD CONSTRAINT `online_recharge_order_sync_task_id_fkey` FOREIGN KEY (`task_id`) REFERENCES `online_recharge_tasks`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_bank_recharge_orders` ADD CONSTRAINT `id_business_v2_bank_recharge_orders_online_recharge_task_id_fkey` FOREIGN KEY (`online_recharge_task_id`) REFERENCES `online_recharge_tasks`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_bank_recharge_orders` ADD CONSTRAINT `id_business_v2_bank_recharge_orders_online_recharge_card_id_fkey` FOREIGN KEY (`online_recharge_card_id`) REFERENCES `online_recharge_cards`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- Nullable payment fields are reserved for online orders awaiting actual evidence.
ALTER TABLE `id_business_v2_bank_recharge_orders`
  ADD CONSTRAINT `recharge_orders_bit_payment_required`
  CHECK (`channel` = 'online' OR (`charge_amount` IS NOT NULL AND `charge_currency_code` IS NOT NULL));

-- MySQL CHECK constraints cannot reference columns with cascading foreign-key actions.
-- Keep the same source-channel rule in write guards, preserving ON DELETE SET NULL.
CREATE TRIGGER `idv2_recharge_orders_channel_insert`
BEFORE INSERT ON `id_business_v2_bank_recharge_orders`
FOR EACH ROW
BEGIN
  IF NOT (
    (NEW.`channel` = 'bitbrowser' AND NEW.`online_recharge_task_id` IS NULL AND NEW.`online_recharge_card_id` IS NULL)
    OR (NEW.`channel` = 'online' AND NEW.`recharge_job_id` IS NULL AND NEW.`card_id` IS NULL)
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Recharge order source channel mismatch';
  END IF;
END;

CREATE TRIGGER `idv2_recharge_orders_channel_update`
BEFORE UPDATE ON `id_business_v2_bank_recharge_orders`
FOR EACH ROW
BEGIN
  IF NOT (
    (NEW.`channel` = 'bitbrowser' AND NEW.`online_recharge_task_id` IS NULL AND NEW.`online_recharge_card_id` IS NULL)
    OR (NEW.`channel` = 'online' AND NEW.`recharge_job_id` IS NULL AND NEW.`card_id` IS NULL)
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Recharge order source channel mismatch';
  END IF;
END;

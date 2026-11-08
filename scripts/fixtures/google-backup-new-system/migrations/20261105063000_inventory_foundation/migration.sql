-- Google mailbox inventory foundation; additive DDL only.
-- CreateTable
CREATE TABLE `id_business_v2_inventory_options` (
    `id` VARCHAR(32) NOT NULL,
    `scope` VARCHAR(32) NOT NULL,
    `kind` ENUM('country', 'source', 'city', 'category') NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `normalized_name` VARCHAR(160) NOT NULL,
    `parent_id` VARCHAR(32) NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_by_user_id` CHAR(36) NULL,
    `updated_by_user_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `inventory_option_parent_idx`(`parent_id`),
    INDEX `inventory_option_list_idx`(`scope`, `kind`, `active`),
    UNIQUE INDEX `inventory_option_name_uq`(`scope`, `kind`, `normalized_name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_google_mailboxes` (
    `id` VARCHAR(32) NOT NULL,
    `email_encrypted` TEXT NOT NULL,
    `email_hash` CHAR(64) NOT NULL,
    `email_search_tokens` JSON NOT NULL DEFAULT (JSON_ARRAY()),
    `password_encrypted` TEXT NOT NULL,
    `totp_secret_encrypted` TEXT NULL,
    `recovery_email_encrypted` TEXT NULL,
    `phone_encrypted` TEXT NULL,
    `phone_unbound_confirmed` BOOLEAN NOT NULL DEFAULT false,
    `country_option_id` VARCHAR(32) NULL,
    `source_option_id` VARCHAR(32) NOT NULL,
    `app_password_encrypted` TEXT NULL,
    `health` ENUM('normal', 'frozen', 'restricted', 'dead', 'unsealing') NOT NULL DEFAULT 'normal',
    `registered_at` DATETIME(6) NULL,
    `login_device` VARCHAR(160) NULL,
    `remark1` TEXT NULL,
    `remark2` TEXT NULL,
    `managed_mailbox_id` CHAR(36) NULL,
    `undo_snapshot_encrypted` TEXT NULL,
    `undo_stock_version` INTEGER NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `created_by_user_id` CHAR(36) NULL,
    `updated_by_user_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    UNIQUE INDEX `inventory_google_email_uq`(`email_hash`),
    UNIQUE INDEX `inventory_google_managed_uq`(`managed_mailbox_id`),
    INDEX `inventory_google_health_idx`(`health`, `created_at`, `id`),
    INDEX `inventory_google_country_idx`(`country_option_id`),
    INDEX `inventory_google_source_idx`(`source_option_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_inventory_entries` (
    `id` VARCHAR(32) NOT NULL,
    `kind` ENUM('google_mailbox', 'apple_id', 'gpt_account', 'claude_account') NOT NULL,
    `google_mailbox_id` VARCHAR(32) NOT NULL,
    `state` ENUM('available', 'extracted', 'used') NOT NULL DEFAULT 'available',
    `version` INTEGER NOT NULL DEFAULT 1,
    `current_extraction_item_id` VARCHAR(32) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    UNIQUE INDEX `inventory_entry_google_uq`(`google_mailbox_id`),
    UNIQUE INDEX `inventory_entry_current_uq`(`current_extraction_item_id`),
    INDEX `inventory_entry_allocate_idx`(`kind`, `state`, `created_at`, `id`),
    UNIQUE INDEX `inventory_entry_current_owner_uq`(`id`, `current_extraction_item_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_extraction_batches` (
    `id` VARCHAR(32) NOT NULL,
    `kind` ENUM('google_mailbox', 'apple_id', 'gpt_account', 'claude_account') NOT NULL,
    `purpose` VARCHAR(200) NOT NULL,
    `remark` VARCHAR(1000) NULL,
    `quantity` INTEGER NOT NULL,
    `created_by_user_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    INDEX `inventory_batch_creator_idx`(`created_by_user_id`, `created_at`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_extraction_items` (
    `id` VARCHAR(32) NOT NULL,
    `batch_id` VARCHAR(32) NOT NULL,
    `stock_id` VARCHAR(32) NOT NULL,
    `state` ENUM('pending', 'used', 'returned') NOT NULL DEFAULT 'pending',
    `version` INTEGER NOT NULL DEFAULT 1,
    `used_at` DATETIME(6) NULL,
    `used_by_user_id` CHAR(36) NULL,
    `returned_at` DATETIME(6) NULL,
    `returned_by_user_id` CHAR(36) NULL,
    `return_reason` VARCHAR(200) NULL,
    `return_remark` VARCHAR(1000) NULL,
    `use_reason` VARCHAR(500) NULL,
    `use_remark` VARCHAR(1000) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `inventory_item_stock_state_idx`(`stock_id`, `state`),
    UNIQUE INDEX `inventory_item_stock_id_uq`(`stock_id`, `id`),
    UNIQUE INDEX `inventory_item_batch_stock_uq`(`batch_id`, `stock_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_inventory_events` (
    `id` VARCHAR(32) NOT NULL,
    `action` VARCHAR(64) NOT NULL,
    `stock_id` VARCHAR(32) NULL,
    `batch_id` VARCHAR(32) NULL,
    `item_id` VARCHAR(32) NULL,
    `from_version` INTEGER NULL,
    `to_version` INTEGER NULL,
    `note` VARCHAR(1000) NULL,
    `operator_user_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    INDEX `inventory_event_stock_idx`(`stock_id`, `created_at`, `id`),
    INDEX `inventory_event_batch_idx`(`batch_id`, `created_at`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_inventory_command_receipts` (
    `id` VARCHAR(32) NOT NULL,
    `operator_user_id` CHAR(36) NULL,
    `action` VARCHAR(64) NOT NULL,
    `idempotency_key` VARCHAR(128) NOT NULL,
    `request_hash` CHAR(64) NOT NULL,
    `result` JSON NOT NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    UNIQUE INDEX `inventory_receipt_command_uq`(`operator_user_id`, `action`, `idempotency_key`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_inventory_import_batches` (
    `id` VARCHAR(32) NOT NULL,
    `kind` ENUM('google_mailbox', 'apple_id', 'gpt_account', 'claude_account') NOT NULL,
    `template_version` INTEGER NOT NULL DEFAULT 1,
    `total` INTEGER NOT NULL,
    `mailbox_ids` JSON NOT NULL,
    `row_results` JSON NOT NULL,
    `created_by_user_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    INDEX `inventory_import_list_idx`(`kind`, `created_at`, `id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `id_business_v2_inventory_options` ADD CONSTRAINT `inventory_option_parent_fk` FOREIGN KEY (`parent_id`) REFERENCES `id_business_v2_inventory_options`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `id_business_v2_inventory_options` ADD CONSTRAINT `inventory_option_creator_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `id_business_v2_inventory_options` ADD CONSTRAINT `inventory_option_editor_fk` FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `id_business_v2_google_mailboxes` ADD CONSTRAINT `inventory_google_country_fk` FOREIGN KEY (`country_option_id`) REFERENCES `id_business_v2_inventory_options`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `id_business_v2_google_mailboxes` ADD CONSTRAINT `inventory_google_source_fk` FOREIGN KEY (`source_option_id`) REFERENCES `id_business_v2_inventory_options`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `id_business_v2_google_mailboxes` ADD CONSTRAINT `inventory_google_managed_fk` FOREIGN KEY (`managed_mailbox_id`) REFERENCES `id_business_v2_managed_mailboxes`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `id_business_v2_google_mailboxes` ADD CONSTRAINT `inventory_google_creator_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `id_business_v2_google_mailboxes` ADD CONSTRAINT `inventory_google_editor_fk` FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `id_business_v2_inventory_entries` ADD CONSTRAINT `inventory_entry_google_fk` FOREIGN KEY (`google_mailbox_id`) REFERENCES `id_business_v2_google_mailboxes`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `id_business_v2_inventory_entries` ADD CONSTRAINT `inventory_entry_current_fk` FOREIGN KEY (`id`, `current_extraction_item_id`) REFERENCES `id_business_v2_extraction_items`(`stock_id`, `id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `id_business_v2_extraction_batches` ADD CONSTRAINT `inventory_batch_creator_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `id_business_v2_extraction_items` ADD CONSTRAINT `inventory_item_batch_fk` FOREIGN KEY (`batch_id`) REFERENCES `id_business_v2_extraction_batches`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `id_business_v2_extraction_items` ADD CONSTRAINT `inventory_item_stock_fk` FOREIGN KEY (`stock_id`) REFERENCES `id_business_v2_inventory_entries`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `id_business_v2_extraction_items` ADD CONSTRAINT `inventory_item_used_by_fk` FOREIGN KEY (`used_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `id_business_v2_extraction_items` ADD CONSTRAINT `inventory_item_returned_by_fk` FOREIGN KEY (`returned_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `id_business_v2_inventory_events` ADD CONSTRAINT `inventory_event_stock_fk` FOREIGN KEY (`stock_id`) REFERENCES `id_business_v2_inventory_entries`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `id_business_v2_inventory_events` ADD CONSTRAINT `inventory_event_batch_fk` FOREIGN KEY (`batch_id`) REFERENCES `id_business_v2_extraction_batches`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `id_business_v2_inventory_events` ADD CONSTRAINT `inventory_event_item_fk` FOREIGN KEY (`item_id`) REFERENCES `id_business_v2_extraction_items`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `id_business_v2_inventory_events` ADD CONSTRAINT `inventory_event_operator_fk` FOREIGN KEY (`operator_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `id_business_v2_inventory_command_receipts` ADD CONSTRAINT `inventory_receipt_operator_fk` FOREIGN KEY (`operator_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;

-- AddForeignKey
ALTER TABLE `id_business_v2_inventory_import_batches` ADD CONSTRAINT `inventory_import_creator_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT;


-- This release only allocates Google mailbox assets. Other asset types get their own migration
-- when their commands and compatibility checks are connected. No legacy inventory is backfilled.
ALTER TABLE `id_business_v2_inventory_options`
  ADD CONSTRAINT `inventory_option_scope_kind_chk` CHECK (
    (`scope` = 'google_mailbox' AND `kind` IN ('country', 'source'))
    OR (`scope` = 'mail_category' AND `kind` = 'category')
  ),
  ADD CONSTRAINT `inventory_option_no_parent_chk` CHECK (`parent_id` IS NULL),
  ADD CONSTRAINT `inventory_option_version_chk` CHECK (`version` >= 1);

ALTER TABLE `id_business_v2_google_mailboxes`
  ADD CONSTRAINT `inventory_google_phone_choice_chk` CHECK (
    (`phone_encrypted` IS NOT NULL AND `phone_unbound_confirmed` = FALSE)
    OR (`phone_encrypted` IS NULL AND `phone_unbound_confirmed` = TRUE)
  ),
  ADD CONSTRAINT `inventory_google_undo_pair_chk` CHECK (
    (`undo_snapshot_encrypted` IS NULL AND `undo_stock_version` IS NULL)
    OR (`undo_snapshot_encrypted` IS NOT NULL AND `undo_stock_version` IS NOT NULL AND `undo_stock_version` >= 1)
  ),
  ADD CONSTRAINT `inventory_google_version_chk` CHECK (`version` >= 1);

-- The composite FK above also ensures the current item actually belongs to this stock row.
-- Restrict updates/deletes on that FK because MySQL disallows modifying referential actions
-- on columns used in CHECK expressions (MySQL WL#929, section K).
ALTER TABLE `id_business_v2_inventory_entries`
  ADD CONSTRAINT `inventory_entry_kind_chk` CHECK (`kind` = 'google_mailbox'),
  ADD CONSTRAINT `inventory_entry_current_state_chk` CHECK (
    (`state` = 'extracted' AND `current_extraction_item_id` IS NOT NULL)
    OR (`state` IN ('available', 'used') AND `current_extraction_item_id` IS NULL)
  ),
  ADD CONSTRAINT `inventory_entry_version_chk` CHECK (`version` >= 1);

ALTER TABLE `id_business_v2_extraction_batches`
  ADD CONSTRAINT `inventory_batch_kind_chk` CHECK (`kind` = 'google_mailbox'),
  ADD CONSTRAINT `inventory_batch_quantity_chk` CHECK (`quantity` BETWEEN 1 AND 200);

ALTER TABLE `id_business_v2_extraction_items`
  ADD CONSTRAINT `inventory_item_status_time_chk` CHECK (
    (`state` = 'pending' AND `used_at` IS NULL AND `returned_at` IS NULL)
    OR (`state` = 'used' AND `used_at` IS NOT NULL AND `returned_at` IS NULL)
    OR (`state` = 'returned' AND `used_at` IS NULL AND `returned_at` IS NOT NULL)
  ),
  ADD CONSTRAINT `inventory_item_version_chk` CHECK (`version` >= 1);

ALTER TABLE `id_business_v2_inventory_import_batches`
  ADD CONSTRAINT `inventory_import_kind_chk` CHECK (`kind` = 'google_mailbox'),
  ADD CONSTRAINT `inventory_import_size_chk` CHECK (
    `total` BETWEEN 1 AND 200 AND `template_version` >= 1
    AND JSON_TYPE(`mailbox_ids`) = 'ARRAY' AND JSON_LENGTH(`mailbox_ids`) = `total`
    AND JSON_TYPE(`row_results`) = 'ARRAY' AND JSON_LENGTH(`row_results`) = `total`
  );

CREATE TRIGGER `inventory_event_immutable_update`
BEFORE UPDATE ON `id_business_v2_inventory_events`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Inventory events are append-only';

CREATE TRIGGER `inventory_event_immutable_delete`
BEFORE DELETE ON `id_business_v2_inventory_events`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Inventory events are append-only';

CREATE TRIGGER `inventory_receipt_immutable_update`
BEFORE UPDATE ON `id_business_v2_inventory_command_receipts`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Inventory command receipts are append-only';

CREATE TRIGGER `inventory_receipt_immutable_delete`
BEFORE DELETE ON `id_business_v2_inventory_command_receipts`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Inventory command receipts are append-only';

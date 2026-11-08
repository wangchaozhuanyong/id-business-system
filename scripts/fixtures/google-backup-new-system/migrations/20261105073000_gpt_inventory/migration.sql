-- Extend the existing GPT master without copying credentials or enrolling historical accounts.
ALTER TABLE `id_business_v2_chatgpt_accounts`
  ADD COLUMN `mail_category_option_id` VARCHAR(32) NULL,
  ADD COLUMN `inventory_country_option_id` VARCHAR(32) NULL,
  ADD COLUMN `inventory_source_option_id` VARCHAR(32) NULL,
  ADD COLUMN `inventory_health` ENUM('normal', 'frozen', 'restricted', 'dead', 'unsealing') NULL,
  ADD COLUMN `inventory_login_device` VARCHAR(160) NULL,
  ADD COLUMN `inventory_remark_1` TEXT NULL,
  ADD COLUMN `inventory_remark_2` TEXT NULL,
  ADD COLUMN `inventory_version` INTEGER NOT NULL DEFAULT 1,
  ADD CONSTRAINT `inventory_gpt_version_chk` CHECK (`inventory_version` >= 1);

ALTER TABLE `id_business_v2_chatgpt_accounts`
  ADD INDEX `inventory_gpt_mail_category_idx` (`mail_category_option_id`),
  ADD INDEX `inventory_gpt_country_idx` (`inventory_country_option_id`),
  ADD INDEX `inventory_gpt_source_idx` (`inventory_source_option_id`),
  ADD CONSTRAINT `inventory_gpt_mail_category_fk` FOREIGN KEY (`mail_category_option_id`)
    REFERENCES `id_business_v2_inventory_options` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT `inventory_gpt_country_fk` FOREIGN KEY (`inventory_country_option_id`)
    REFERENCES `id_business_v2_inventory_options` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT `inventory_gpt_source_fk` FOREIGN KEY (`inventory_source_option_id`)
    REFERENCES `id_business_v2_inventory_options` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

-- Keep foreign-key validation enabled while changing the Google reference to optional.
-- The old kind check continues to restrict the table to Google until both references exist.
ALTER TABLE `id_business_v2_inventory_entries`
  DROP FOREIGN KEY `inventory_entry_google_fk`;

ALTER TABLE `id_business_v2_inventory_entries`
  MODIFY COLUMN `google_mailbox_id` VARCHAR(32) NULL,
  ADD COLUMN `chatgpt_account_id` CHAR(36) NULL,
  ADD UNIQUE INDEX `inventory_entry_gpt_uq` (`chatgpt_account_id`);

ALTER TABLE `id_business_v2_inventory_entries`
  ADD CONSTRAINT `inventory_entry_google_fk` FOREIGN KEY (`google_mailbox_id`)
    REFERENCES `id_business_v2_google_mailboxes` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT `inventory_entry_gpt_fk` FOREIGN KEY (`chatgpt_account_id`)
    REFERENCES `id_business_v2_chatgpt_accounts` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  DROP CHECK `inventory_entry_kind_chk`,
  ADD CONSTRAINT `inventory_entry_kind_ref_chk` CHECK (
    (`kind` = 'google_mailbox' AND `google_mailbox_id` IS NOT NULL AND `chatgpt_account_id` IS NULL)
    OR (`kind` = 'gpt_account' AND `google_mailbox_id` IS NULL AND `chatgpt_account_id` IS NOT NULL)
  );

ALTER TABLE `id_business_v2_inventory_options`
  DROP CHECK `inventory_option_scope_kind_chk`,
  ADD CONSTRAINT `inventory_option_google_gpt_scope_chk` CHECK (
    (`scope` IN ('google_mailbox', 'gpt_account') AND `kind` IN ('country', 'source'))
    OR (`scope` = 'mail_category' AND `kind` = 'category')
  );

ALTER TABLE `id_business_v2_extraction_batches`
  DROP CHECK `inventory_batch_kind_chk`,
  ADD CONSTRAINT `inventory_batch_google_gpt_kind_chk` CHECK (
    `kind` IN ('google_mailbox', 'gpt_account')
  );

ALTER TABLE `id_business_v2_inventory_import_batches`
  DROP CHECK `inventory_import_kind_chk`,
  ADD CONSTRAINT `inventory_import_google_gpt_kind_chk` CHECK (
    `kind` IN ('google_mailbox', 'gpt_account')
  );

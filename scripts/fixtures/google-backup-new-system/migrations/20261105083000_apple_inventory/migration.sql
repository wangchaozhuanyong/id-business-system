-- Keep the original Apple ID and its financial facts. NULL inventory health identifies existing records.
ALTER TABLE `id_business_v2_accounts`
  ADD COLUMN `inventory_country_option_id` VARCHAR(32) NULL,
  ADD COLUMN `inventory_source_option_id` VARCHAR(32) NULL,
  ADD COLUMN `inventory_health` ENUM('normal', 'frozen', 'restricted', 'dead', 'unsealing') NULL,
  ADD COLUMN `inventory_version` INTEGER NOT NULL DEFAULT 1,
  ADD COLUMN `phone_unbound_confirmed` BOOLEAN NULL,
  ADD COLUMN `security_1_encrypted` TEXT NULL,
  ADD COLUMN `security_2_encrypted` TEXT NULL,
  ADD COLUMN `security_3_encrypted` TEXT NULL,
  ADD COLUMN `birthday_encrypted` TEXT NULL,
  ADD COLUMN `app_password_encrypted` TEXT NULL,
  ADD COLUMN `registered_at` DATETIME(6) NULL,
  ADD COLUMN `inventory_login_device` VARCHAR(160) NULL,
  ADD COLUMN `inventory_remark_1` TEXT NULL,
  ADD COLUMN `inventory_remark_2` TEXT NULL,
  ADD CONSTRAINT `inventory_apple_version_chk` CHECK (`inventory_version` >= 1),
  ADD CONSTRAINT `inventory_apple_registration_chk` CHECK (
    `inventory_health` IS NULL OR (
      `inventory_country_option_id` IS NOT NULL AND `inventory_source_option_id` IS NOT NULL
      AND `password_encrypted` IS NOT NULL AND `phone_unbound_confirmed` IS NOT NULL
      AND (
        (`phone_encrypted` IS NOT NULL AND `phone_unbound_confirmed` = FALSE)
        OR (`phone_encrypted` IS NULL AND `phone_unbound_confirmed` = TRUE)
      )
    )
  );

ALTER TABLE `id_business_v2_inventory_options`
  ADD COLUMN `legacy_country_option_id` CHAR(36) NULL,
  ADD INDEX `inventory_option_apple_legacy_country_idx` (`legacy_country_option_id`);

ALTER TABLE `id_business_v2_inventory_options`
  ADD CONSTRAINT `inventory_option_apple_legacy_country_fk` FOREIGN KEY (`legacy_country_option_id`)
    REFERENCES `id_business_v2_options` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  DROP CHECK `inventory_option_google_gpt_scope_chk`,
  ADD CONSTRAINT `inventory_option_google_gpt_apple_scope_chk` CHECK (
    (`scope` IN ('google_mailbox', 'gpt_account') AND `kind` IN ('country', 'source')
      AND `legacy_country_option_id` IS NULL)
    OR (`scope` = 'mail_category' AND `kind` = 'category' AND `legacy_country_option_id` IS NULL)
    OR (`scope` = 'apple_id' AND `kind` = 'source' AND `legacy_country_option_id` IS NULL)
    OR (`scope` = 'apple_id' AND `kind` = 'country' AND `legacy_country_option_id` IS NOT NULL)
  );

ALTER TABLE `id_business_v2_accounts`
  ADD INDEX `inventory_apple_country_idx` (`inventory_country_option_id`),
  ADD INDEX `inventory_apple_source_idx` (`inventory_source_option_id`),
  ADD CONSTRAINT `inventory_apple_country_fk` FOREIGN KEY (`inventory_country_option_id`)
    REFERENCES `id_business_v2_inventory_options` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT `inventory_apple_source_fk` FOREIGN KEY (`inventory_source_option_id`)
    REFERENCES `id_business_v2_inventory_options` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE `id_business_v2_inventory_entries`
  ADD COLUMN `apple_account_id` CHAR(36) NULL,
  ADD UNIQUE INDEX `inventory_entry_apple_uq` (`apple_account_id`);

ALTER TABLE `id_business_v2_inventory_entries`
  ADD CONSTRAINT `inventory_entry_apple_fk` FOREIGN KEY (`apple_account_id`)
    REFERENCES `id_business_v2_accounts` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  DROP CHECK `inventory_entry_kind_ref_chk`,
  ADD CONSTRAINT `inventory_entry_kind_ref_apple_chk` CHECK (
    (`kind` = 'google_mailbox' AND `google_mailbox_id` IS NOT NULL
      AND `chatgpt_account_id` IS NULL AND `apple_account_id` IS NULL)
    OR (`kind` = 'gpt_account' AND `google_mailbox_id` IS NULL
      AND `chatgpt_account_id` IS NOT NULL AND `apple_account_id` IS NULL)
    OR (`kind` = 'apple_id' AND `google_mailbox_id` IS NULL
      AND `chatgpt_account_id` IS NULL AND `apple_account_id` IS NOT NULL)
  );

ALTER TABLE `id_business_v2_extraction_batches`
  DROP CHECK `inventory_batch_google_gpt_kind_chk`,
  ADD CONSTRAINT `inventory_batch_google_gpt_apple_kind_chk` CHECK (
    `kind` IN ('google_mailbox', 'gpt_account', 'apple_id')
  );

ALTER TABLE `id_business_v2_inventory_import_batches`
  DROP CHECK `inventory_import_google_gpt_kind_chk`,
  ADD CONSTRAINT `inventory_import_google_gpt_apple_kind_chk` CHECK (
    `kind` IN ('google_mailbox', 'gpt_account', 'apple_id')
  );

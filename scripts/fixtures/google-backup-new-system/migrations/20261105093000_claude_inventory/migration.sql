-- Root options retain the empty namespace. Each Claude city uses its country ID as the namespace.
ALTER TABLE `id_business_v2_inventory_options`
  ADD COLUMN `parent_key` VARCHAR(32) NOT NULL DEFAULT '',
  ADD UNIQUE INDEX `inventory_option_city_country_uq` (`id`, `parent_id`);

ALTER TABLE `id_business_v2_inventory_options`
  DROP INDEX `inventory_option_name_uq`,
  ADD UNIQUE INDEX `inventory_option_parent_name_uq` (`scope`, `kind`, `parent_key`, `normalized_name`),
  DROP CHECK `inventory_option_google_gpt_apple_scope_chk`,
  DROP CHECK `inventory_option_no_parent_chk`,
  ADD CONSTRAINT `inventory_option_scope_chk` CHECK (
    (`scope` IN ('google_mailbox', 'gpt_account') AND `kind` IN ('country', 'source')
      AND `legacy_country_option_id` IS NULL)
    OR (`scope` = 'mail_category' AND `kind` = 'category' AND `legacy_country_option_id` IS NULL)
    OR (`scope` = 'apple_id' AND `kind` = 'source' AND `legacy_country_option_id` IS NULL)
    OR (`scope` = 'apple_id' AND `kind` = 'country' AND `legacy_country_option_id` IS NOT NULL)
    OR (`scope` = 'claude_account' AND `kind` IN ('country', 'city')
      AND `legacy_country_option_id` IS NULL)
  ),
  ADD CONSTRAINT `inventory_option_parent_scope_chk` CHECK (
    (`scope` = 'claude_account' AND `kind` = 'city'
      AND `parent_id` IS NOT NULL AND `parent_id` <> `id` AND `parent_key` = `parent_id`)
    OR (`kind` <> 'city' AND `parent_id` IS NULL AND `parent_key` = '')
  );

CREATE TABLE `id_business_v2_claude_accounts` (
  `id` VARCHAR(32) NOT NULL,
  `email_encrypted` TEXT NOT NULL,
  `email_hash` CHAR(64) NOT NULL,
  `email_search_tokens` JSON NOT NULL DEFAULT (JSON_ARRAY()),
  `password_encrypted` TEXT NULL,
  `mail_category_option_id` VARCHAR(32) NOT NULL,
  `country_option_id` VARCHAR(32) NOT NULL,
  `city_option_id` VARCHAR(32) NOT NULL,
  `registration_ip_link_encrypted` TEXT NULL,
  `proxy_kind` ENUM('dynamic_residential', 'static_residential', 'mobile') NULL,
  `proxy_protocol` ENUM('http', 'https', 'socks5') NULL,
  `proxy_host_encrypted` TEXT NULL,
  `proxy_port` INTEGER NULL,
  `proxy_username_encrypted` TEXT NULL,
  `proxy_password_encrypted` TEXT NULL,
  `registered_at` DATETIME(6) NULL,
  `kyc_status` ENUM('unknown', 'verified', 'unverified') NOT NULL DEFAULT 'unknown',
  `kyc_source` VARCHAR(160) NULL,
  `health` ENUM('normal', 'frozen', 'restricted', 'dead', 'unsealing') NOT NULL DEFAULT 'normal',
  `remark1` TEXT NULL,
  `remark2` TEXT NULL,
  `version` INTEGER NOT NULL DEFAULT 1,
  `created_by_user_id` CHAR(36) NULL,
  `updated_by_user_id` CHAR(36) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `inventory_claude_email_uq` (`email_hash`),
  INDEX `inventory_claude_aging_idx` (`health`, `registered_at`, `id`),
  INDEX `inventory_claude_mail_category_idx` (`mail_category_option_id`),
  INDEX `inventory_claude_country_idx` (`country_option_id`),
  INDEX `inventory_claude_city_country_idx` (`city_option_id`, `country_option_id`),
  CONSTRAINT `inventory_claude_mail_category_fk` FOREIGN KEY (`mail_category_option_id`)
    REFERENCES `id_business_v2_inventory_options` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `inventory_claude_country_fk` FOREIGN KEY (`country_option_id`)
    REFERENCES `id_business_v2_inventory_options` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `inventory_claude_city_country_fk` FOREIGN KEY (`city_option_id`, `country_option_id`)
    REFERENCES `id_business_v2_inventory_options` (`id`, `parent_id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `inventory_claude_creator_fk` FOREIGN KEY (`created_by_user_id`)
    REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE RESTRICT,
  CONSTRAINT `inventory_claude_editor_fk` FOREIGN KEY (`updated_by_user_id`)
    REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE RESTRICT,
  CONSTRAINT `inventory_claude_proxy_port_chk` CHECK (
    `proxy_port` IS NULL OR `proxy_port` BETWEEN 1 AND 65535
  ),
  CONSTRAINT `inventory_claude_kyc_source_chk` CHECK (
    `kyc_status` = 'unknown' OR (
      `kyc_status` IN ('verified', 'unverified')
      AND `kyc_source` IS NOT NULL AND CHAR_LENGTH(TRIM(`kyc_source`)) > 0
    )
  ),
  CONSTRAINT `inventory_claude_version_chk` CHECK (`version` >= 1)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `id_business_v2_claude_inventory_policies` (
  `id` VARCHAR(16) NOT NULL DEFAULT 'claude',
  `aging_hours` INTEGER NOT NULL DEFAULT 72,
  `version` INTEGER NOT NULL DEFAULT 1,
  `updated_by_user_id` CHAR(36) NULL,
  `updated_at` DATETIME(6) NOT NULL,
  PRIMARY KEY (`id`),
  CONSTRAINT `inventory_claude_policy_editor_fk` FOREIGN KEY (`updated_by_user_id`)
    REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE RESTRICT,
  CONSTRAINT `inventory_claude_policy_singleton_chk` CHECK (`id` = 'claude'),
  CONSTRAINT `inventory_claude_policy_hours_chk` CHECK (`aging_hours` BETWEEN 0 AND 8760),
  CONSTRAINT `inventory_claude_policy_version_chk` CHECK (`version` >= 1)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `id_business_v2_claude_inventory_policies` (`id`, `aging_hours`, `version`, `updated_at`)
VALUES ('claude', 72, 1, UTC_TIMESTAMP(6));

ALTER TABLE `id_business_v2_inventory_entries`
  ADD COLUMN `claude_account_id` VARCHAR(32) NULL,
  ADD UNIQUE INDEX `inventory_entry_claude_uq` (`claude_account_id`);

ALTER TABLE `id_business_v2_inventory_entries`
  ADD CONSTRAINT `inventory_entry_claude_fk` FOREIGN KEY (`claude_account_id`)
    REFERENCES `id_business_v2_claude_accounts` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  DROP CHECK `inventory_entry_kind_ref_apple_chk`,
  ADD CONSTRAINT `inventory_entry_kind_ref_chk` CHECK (
    (`kind` = 'google_mailbox' AND `google_mailbox_id` IS NOT NULL
      AND `chatgpt_account_id` IS NULL AND `apple_account_id` IS NULL AND `claude_account_id` IS NULL)
    OR (`kind` = 'gpt_account' AND `google_mailbox_id` IS NULL
      AND `chatgpt_account_id` IS NOT NULL AND `apple_account_id` IS NULL AND `claude_account_id` IS NULL)
    OR (`kind` = 'apple_id' AND `google_mailbox_id` IS NULL
      AND `chatgpt_account_id` IS NULL AND `apple_account_id` IS NOT NULL AND `claude_account_id` IS NULL)
    OR (`kind` = 'claude_account' AND `google_mailbox_id` IS NULL
      AND `chatgpt_account_id` IS NULL AND `apple_account_id` IS NULL AND `claude_account_id` IS NOT NULL)
  );

ALTER TABLE `id_business_v2_extraction_batches`
  DROP CHECK `inventory_batch_google_gpt_apple_kind_chk`,
  ADD CONSTRAINT `inventory_batch_kind_chk` CHECK (
    `kind` IN ('google_mailbox', 'gpt_account', 'apple_id', 'claude_account')
  );

ALTER TABLE `id_business_v2_inventory_import_batches`
  DROP CHECK `inventory_import_google_gpt_apple_kind_chk`,
  ADD CONSTRAINT `inventory_import_kind_chk` CHECK (
    `kind` IN ('google_mailbox', 'gpt_account', 'apple_id', 'claude_account')
  );

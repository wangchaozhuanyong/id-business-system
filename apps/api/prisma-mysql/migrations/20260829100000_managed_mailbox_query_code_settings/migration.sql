CREATE TABLE `id_business_v2_managed_mailbox_settings` (
  `id` CHAR(36) NOT NULL,
  `scope` VARCHAR(32) NOT NULL DEFAULT 'global',
  `query_code_validity_days` INTEGER NOT NULL DEFAULT 30,
  `updated_by_user_id` CHAR(36) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6) ON UPDATE CURRENT_TIMESTAMP(6),

  UNIQUE INDEX `id_business_v2_managed_mailbox_settings_scope_key` (`scope`),
  INDEX `idv2_mailbox_settings_updated_by_user_id_idx` (`updated_by_user_id`),
  PRIMARY KEY (`id`),
  CONSTRAINT `idv2_mailbox_settings_updated_by_user_id_fkey`
    FOREIGN KEY (`updated_by_user_id`) REFERENCES `users` (`id`)
    ON DELETE SET NULL ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

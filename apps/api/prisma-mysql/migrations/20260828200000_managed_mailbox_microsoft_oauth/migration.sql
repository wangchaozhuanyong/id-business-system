ALTER TABLE `id_business_v2_managed_mailboxes`
  ADD COLUMN `query_code_encrypted` TEXT NULL,
  MODIFY COLUMN `provider` ENUM('gmail', 'icloud', 'microsoft') NOT NULL;

CREATE TABLE `id_business_v2_mailbox_oauth_states` (
  `id` CHAR(36) NOT NULL,
  `state_hash` VARCHAR(64) NOT NULL,
  `email` VARCHAR(254) NOT NULL,
  `label` VARCHAR(60) NULL,
  `status` ENUM('pending', 'succeeded', 'failed') NOT NULL DEFAULT 'pending',
  `failure_code` VARCHAR(80) NULL,
  `mailbox_id` CHAR(36) NULL,
  `created_by_user_id` CHAR(36) NOT NULL,
  `expires_at` DATETIME(6) NOT NULL,
  `completed_at` DATETIME(6) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `id_business_v2_mailbox_oauth_states_state_hash_key`(`state_hash`),
  INDEX `idbiz_mail_oauth_states_creator_created_idx`(`created_by_user_id`, `created_at`),
  INDEX `idbiz_mail_oauth_states_status_expiry_idx`(`status`, `expires_at`),
  INDEX `idbiz_mail_oauth_states_mailbox_idx`(`mailbox_id`),
  CONSTRAINT `idbiz_mail_oauth_states_mailbox_fkey`
    FOREIGN KEY (`mailbox_id`) REFERENCES `id_business_v2_managed_mailboxes`(`id`)
    ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `idbiz_mail_oauth_states_created_by_fkey`
    FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

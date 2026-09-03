CREATE TABLE `id_business_v2_relay_connections` (
  `id` CHAR(36) NOT NULL,
  `user_id` CHAR(36) NOT NULL,
  `google_oauth_client_id` VARCHAR(255) NULL,
  `google_oauth_client_secret_encrypted` TEXT NULL,
  `google_oauth_token_encrypted` TEXT NULL,
  `google_email` VARCHAR(254) NULL,
  `google_oauth_state_hash` VARCHAR(64) NULL,
  `google_oauth_verifier_encrypted` TEXT NULL,
  `google_oauth_state_expires_at` DATETIME(6) NULL,
  `cloud_bridge_session_encrypted` TEXT NULL,
  `cloud_bridge_email` VARCHAR(254) NULL,
  `cloud_bridge_connected_at` DATETIME(6) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `id_business_v2_relay_connections_user_id_key`(`user_id`),
  UNIQUE INDEX `id_business_v2_relay_connections_google_oauth_state_hash_key`(`google_oauth_state_hash`),
  INDEX `idbiz_relay_connections_google_expiry_idx`(`google_oauth_state_expires_at`),
  CONSTRAINT `idbiz_relay_connections_user_fkey`
    FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `id_business_v2_relay_jobs` (
  `id` CHAR(36) NOT NULL,
  `user_id` CHAR(36) NOT NULL,
  `status` ENUM('draft', 'running', 'action_required', 'completed', 'failed') NOT NULL DEFAULT 'draft',
  `account_label` VARCHAR(80) NOT NULL,
  `project_id` VARCHAR(30) NOT NULL,
  `project_display_name` VARCHAR(80) NOT NULL,
  `billing_account` VARCHAR(80) NOT NULL,
  `location` VARCHAR(40) NOT NULL DEFAULT 'global',
  `target_group_id` INTEGER NOT NULL,
  `proxy_id` INTEGER NULL,
  `reference_account_id` INTEGER NOT NULL,
  `credit_expires_at` DATETIME(6) NULL,
  `model_mapping` JSON NOT NULL,
  `progress` JSON NOT NULL,
  `completed_steps` JSON NOT NULL,
  `service_account_key_encrypted` TEXT NULL,
  `cloud_bridge_account_id` INTEGER NULL,
  `run_lease_id` CHAR(36) NULL,
  `run_lease_expires_at` DATETIME(6) NULL,
  `last_error_code` VARCHAR(80) NULL,
  `last_error_message` VARCHAR(500) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `id_business_v2_relay_jobs_user_id_project_id_key`(`user_id`, `project_id`),
  INDEX `idbiz_relay_jobs_user_updated_idx`(`user_id`, `updated_at`),
  INDEX `idbiz_relay_jobs_status_updated_idx`(`status`, `updated_at`),
  INDEX `idbiz_relay_jobs_run_lease_expiry_idx`(`run_lease_expires_at`),
  CONSTRAINT `idbiz_relay_jobs_user_fkey`
    FOREIGN KEY (`user_id`) REFERENCES `users`(`id`)
    ON DELETE CASCADE ON UPDATE CASCADE
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

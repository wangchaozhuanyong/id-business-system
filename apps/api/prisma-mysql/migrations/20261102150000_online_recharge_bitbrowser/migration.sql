ALTER TABLE `online_recharge_tasks` MODIFY `provider` ENUM('local', 'third_party', 'bitbrowser') NOT NULL DEFAULT 'local';

CREATE TABLE `online_recharge_bitbrowser_devices` (
  `id` CHAR(36) NOT NULL,
  `slot` VARCHAR(16) NOT NULL DEFAULT 'primary',
  `name` VARCHAR(80) NOT NULL,
  `token_hash` CHAR(64) NULL,
  `pairing_hash` CHAR(64) NULL,
  `pairing_expires_at` DATETIME(6) NULL,
  `enabled` BOOLEAN NOT NULL DEFAULT false,
  `protocol` INTEGER NOT NULL DEFAULT 0,
  `ready` BOOLEAN NOT NULL DEFAULT false,
  `busy` BOOLEAN NOT NULL DEFAULT false,
  `last_seen_at` DATETIME(6) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `online_recharge_bitbrowser_devices_slot_key` (`slot`),
  UNIQUE INDEX `online_recharge_bitbrowser_devices_pairing_hash_key` (`pairing_hash`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `online_recharge_bitbrowser_states` (
  `lease_version` INTEGER NOT NULL DEFAULT 0,
  `task_id` CHAR(36) NOT NULL,
  `device_id` CHAR(36) NOT NULL,
  `account_key` CHAR(64) NULL,
  `quote` JSON NULL,
  `quote_digest` CHAR(64) NULL,
  `quote_expires_at` DATETIME(6) NULL,
  `authorized_digest` CHAR(64) NULL,
  `authorized_by_user_id` CHAR(36) NULL,
  `authorized_at` DATETIME(6) NULL,
  `payment_consumed` BOOLEAN NOT NULL DEFAULT false,
  `ledger_encrypted` LONGTEXT NULL,
  `version` INTEGER NOT NULL DEFAULT 0,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`task_id`),
  INDEX `online_recharge_bitbrowser_states_device_id_idx` (`device_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

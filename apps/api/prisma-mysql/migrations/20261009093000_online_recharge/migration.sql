-- CreateTable
CREATE TABLE `online_recharge_config` (
    `id` VARCHAR(32) NOT NULL,
    `settings` JSON NOT NULL,
    `secrets_encrypted` LONGTEXT NULL,
    `version` INTEGER NOT NULL DEFAULT 1,
    `updated_at` DATETIME(6) NOT NULL,

    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `online_recharge_cards` (
    `id` CHAR(36) NOT NULL,
    `number_encrypted` TEXT NOT NULL,
    `number_hash` CHAR(64) NOT NULL,
    `last4` CHAR(4) NOT NULL,
    `expiry_month` INTEGER NOT NULL,
    `expiry_year` INTEGER NOT NULL,
    `holder_name` VARCHAR(120) NOT NULL DEFAULT '',
    `payment_name` VARCHAR(120) NULL,
    `address_id` CHAR(36) NULL,
    `status` ENUM('active', 'disabled', 'exhausted', 'retired') NOT NULL DEFAULT 'active',
    `success_count` INTEGER NOT NULL DEFAULT 0,
    `decline_count` INTEGER NOT NULL DEFAULT 0,
    `lease_owner` CHAR(36) NULL,
    `lease_id` CHAR(36) NULL,
    `lease_version` INTEGER NOT NULL DEFAULT 0,
    `lease_expires_at` DATETIME(6) NULL,
    `last_used_at` DATETIME(6) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    UNIQUE INDEX `online_recharge_cards_number_hash_key`(`number_hash`),
    INDEX `online_recharge_cards_status_success_count_last_used_at_idx`(`status`, `success_count`, `last_used_at`),
    INDEX `online_recharge_cards_lease_owner_idx`(`lease_owner`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `online_recharge_proxies` (
    `id` CHAR(36) NOT NULL,
    `connection_encrypted` TEXT NOT NULL,
    `connection_hash` CHAR(64) NOT NULL,
    `display_host` VARCHAR(255) NOT NULL,
    `protocol` VARCHAR(16) NOT NULL,
    `status` ENUM('active', 'disabled', 'exhausted', 'retired') NOT NULL DEFAULT 'active',
    `exit_ip` VARCHAR(100) NULL,
    `latency_ms` INTEGER NULL,
    `test_message` TEXT NULL,
    `tested_at` DATETIME(6) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    UNIQUE INDEX `online_recharge_proxies_connection_hash_key`(`connection_hash`),
    INDEX `online_recharge_proxies_status_idx`(`status`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `online_recharge_addresses` (
    `id` CHAR(36) NOT NULL,
    `first_name` VARCHAR(80) NOT NULL DEFAULT '',
    `last_name` VARCHAR(80) NOT NULL DEFAULT '',
    `region` CHAR(2) NOT NULL DEFAULT 'US',
    `country` CHAR(2) NOT NULL DEFAULT 'US',
    `street` VARCHAR(255) NOT NULL,
    `city` VARCHAR(120) NOT NULL,
    `state` VARCHAR(100) NOT NULL,
    `postal_code` VARCHAR(20) NOT NULL,
    `success_count` INTEGER NOT NULL DEFAULT 0,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `online_recharge_addresses_success_count_idx`(`success_count`),
    INDEX `online_recharge_addresses_region_active_success_count_idx`(`region`, `active`, `success_count`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `online_recharge_codes` (
    `id` CHAR(36) NOT NULL,
    `code_encrypted` TEXT NOT NULL,
    `code_hash` CHAR(64) NOT NULL,
    `code_last4` VARCHAR(4) NOT NULL,
    `plan` ENUM('plus', 'pro_5x', 'pro_20x') NOT NULL,
    `status` ENUM('available', 'reserved', 'used', 'disabled') NOT NULL DEFAULT 'available',
    `dispatched` BOOLEAN NOT NULL DEFAULT false,
    `task_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,
    `deleted_at` DATETIME(6) NULL,

    UNIQUE INDEX `online_recharge_codes_code_hash_key`(`code_hash`),
    INDEX `online_recharge_codes_status_plan_dispatched_idx`(`status`, `plan`, `dispatched`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `online_recharge_tasks` (
    `id` CHAR(36) NOT NULL,
    `operation` ENUM('recharge', 'debug', 'subscription', 'renewal', 'proxy_test', 'config_test', 'browser_manage', 'notification') NOT NULL DEFAULT 'recharge',
    `status` ENUM('queued', 'running', 'awaiting_credentials', 'awaiting_review', 'succeeded', 'failed') NOT NULL DEFAULT 'queued',
    `plan` ENUM('plus', 'pro_5x', 'pro_20x') NOT NULL DEFAULT 'plus',
    `provider` ENUM('local', 'third_party') NOT NULL DEFAULT 'local',
    `code_id` CHAR(36) NULL,
    `operator_id` CHAR(36) NULL,
    `session_encrypted` LONGTEXT NULL,
    `session_identity_hash` CHAR(64) NULL,
    `email_encrypted` TEXT NULL,
    `public_token_hash` CHAR(64) NULL,
    `public_token_encrypted` TEXT NULL,
    `payload` JSON NULL,
    `result` JSON NULL,
    `progress` INTEGER NOT NULL DEFAULT 0,
    `stage` VARCHAR(100) NOT NULL DEFAULT 'queued',
    `message` TEXT NOT NULL,
    `card_id` CHAR(36) NULL,
    `card_last4` CHAR(4) NULL,
    `provider_order_id` VARCHAR(128) NULL,
    `provider_task_id` VARCHAR(128) NULL,
    `payment_started` BOOLEAN NOT NULL DEFAULT false,
    `confirmed_paid` BOOLEAN NOT NULL DEFAULT false,
    `lease_owner` VARCHAR(100) NULL,
    `lease_id` CHAR(36) NULL,
    `lease_version` INTEGER NOT NULL DEFAULT 0,
    `lease_expires_at` DATETIME(6) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,
    `deleted_at` DATETIME(6) NULL,

    INDEX `online_recharge_tasks_status_created_at_idx`(`status`, `created_at`),
    INDEX `online_recharge_tasks_code_id_idx`(`code_id`),
    INDEX `online_recharge_tasks_session_identity_hash_idx`(`session_identity_hash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `online_recharge_events` (
    `id` CHAR(36) NOT NULL,
    `task_id` CHAR(36) NULL,
    `level` VARCHAR(12) NOT NULL DEFAULT 'info',
    `stage` VARCHAR(100) NULL,
    `message` TEXT NOT NULL,
    `metadata` JSON NULL,
    `dedupe_key` VARCHAR(190) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    UNIQUE INDEX `online_recharge_events_dedupe_key_key`(`dedupe_key`),
    INDEX `online_recharge_events_task_id_created_at_idx`(`task_id`, `created_at`),
    INDEX `online_recharge_events_created_at_idx`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `online_recharge_bills` (
    `id` CHAR(36) NOT NULL,
    `task_id` CHAR(36) NOT NULL,
    `card_id` CHAR(36) NULL,
    `card_last4` CHAR(4) NULL,
    `plan` ENUM('plus', 'pro_5x', 'pro_20x') NOT NULL,
    `status` VARCHAR(16) NOT NULL,
    `amount` DECIMAL(18, 4) NULL,
    `estimated_amount` DECIMAL(18, 4) NULL,
    `currency` VARCHAR(8) NOT NULL,
    `checkout_id` VARCHAR(255) NULL,
    `idempotency_key` VARCHAR(190) NOT NULL,
    `error_code` VARCHAR(100) NULL,
    `message` TEXT NOT NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    UNIQUE INDEX `online_recharge_bills_idempotency_key_key`(`idempotency_key`),
    INDEX `online_recharge_bills_task_id_idx`(`task_id`),
    INDEX `online_recharge_bills_card_last4_created_at_idx`(`card_last4`, `created_at`),
    INDEX `online_recharge_bills_status_created_at_idx`(`status`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `online_recharge_webhook_receipts` (
    `id` CHAR(36) NOT NULL,
    `event_id` VARCHAR(190) NOT NULL,
    `payload_hash` CHAR(64) NOT NULL,
    `card_count` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    UNIQUE INDEX `online_recharge_webhook_receipts_event_id_key`(`event_id`),
    UNIQUE INDEX `online_recharge_webhook_receipts_payload_hash_key`(`payload_hash`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- 仅登记本模块权限；普通员工和现有业务角色不会自动得到新权限。
INSERT INTO `permissions` (`id`, `name`, `code`, `module`, `action`) VALUES
('9c965f64-b3b5-4f06-bc0b-7612366d1001', '查看线上代充', 'id_business_v2.online_recharge.read', 'id_business_v2.online_recharge', 'read'),
('9c965f64-b3b5-4f06-bc0b-7612366d1002', '管理线上代充', 'id_business_v2.online_recharge.manage', 'id_business_v2.online_recharge', 'manage'),
('9c965f64-b3b5-4f06-bc0b-7612366d1003', '查看线上代充敏感资料', 'id_business_v2.online_recharge.sensitive', 'id_business_v2.online_recharge', 'sensitive')
ON DUPLICATE KEY UPDATE `name`=VALUES(`name`), `module`=VALUES(`module`), `action`=VALUES(`action`);

INSERT IGNORE INTO `role_permissions` (`role_id`, `permission_id`, `sensitive_approval_required`)
SELECT r.`id`, p.`id`, false FROM `roles` r JOIN `permissions` p
ON p.`code` IN ('id_business_v2.online_recharge.read', 'id_business_v2.online_recharge.manage', 'id_business_v2.online_recharge.sensitive')
WHERE r.`code`='admin';

INSERT IGNORE INTO `id_business_v2_scope_versions` (`scope`, `version`, `updated_at`)
VALUES ('online-recharge', 0, CURRENT_TIMESTAMP(6));

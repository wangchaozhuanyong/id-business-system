-- AlterTable
ALTER TABLE `id_business_v2_chatgpt_accounts` ADD COLUMN `offer_observed_at` DATETIME(6) NULL,
    ADD COLUMN `offer_source` ENUM('automatic', 'manual') NULL,
    ADD COLUMN `offer_status` ENUM('unknown', 'free_trial', 'half_price', 'full_price', 'other') NOT NULL DEFAULT 'unknown';

-- CreateTable
CREATE TABLE `id_business_v2_registration_names` (
    `id` CHAR(36) NOT NULL,
    `display_name` VARCHAR(120) NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `usage_count` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    UNIQUE INDEX `id_business_v2_registration_names_display_name_key`(`display_name`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_registration_jobs` (
    `id` CHAR(36) NOT NULL,
    `owner_id` CHAR(36) NOT NULL,
    `mailbox_alias_id` VARCHAR(191) NOT NULL,
    `proxy_id` CHAR(36) NOT NULL,
    `name_id` CHAR(36) NOT NULL,
    `display_name` VARCHAR(120) NOT NULL,
    `email_encrypted` TEXT NOT NULL,
    `email_hash` CHAR(64) NOT NULL,
    `email_masked` VARCHAR(255) NOT NULL,
    `birth_date_encrypted` TEXT NOT NULL,
    `password_encrypted` TEXT NOT NULL,
    `pending_totp_encrypted` TEXT NULL,
    `nonce_hash` CHAR(64) NULL,
    `lease_until` DATETIME(6) NULL,
    `attempt` INTEGER NOT NULL DEFAULT 0,
    `state` ENUM('queued', 'running', 'awaiting_email', 'awaiting_user', 'partial', 'completed', 'cancelled') NOT NULL DEFAULT 'queued',
    `step` ENUM('queued', 'email', 'email_code', 'profile', 'registered', 'password', 'password_verified', 'mfa', 'mfa_verified', 'offer', 'completed') NOT NULL DEFAULT 'queued',
    `registered` BOOLEAN NOT NULL DEFAULT false,
    `password_verified` BOOLEAN NOT NULL DEFAULT false,
    `mfa_verified` BOOLEAN NOT NULL DEFAULT false,
    `offer_status` ENUM('unknown', 'free_trial', 'half_price', 'full_price', 'other') NOT NULL DEFAULT 'unknown',
    `offer_summary` VARCHAR(500) NULL,
    `reason` VARCHAR(80) NULL,
    `browser_profile_id` VARCHAR(100) NULL,
    `account_id` CHAR(36) NULL,
    `code_requested_at` DATETIME(6) NULL,
    `last_mail_id` VARCHAR(191) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `id_business_v2_registration_jobs_owner_id_state_created_at_idx`(`owner_id`, `state`, `created_at`),
    INDEX `id_business_v2_registration_jobs_email_hash_state_idx`(`email_hash`, `state`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `id_business_v2_registration_jobs` ADD CONSTRAINT `id_business_v2_registration_jobs_owner_id_fkey` FOREIGN KEY (`owner_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_registration_jobs` ADD CONSTRAINT `id_business_v2_registration_jobs_name_id_fkey` FOREIGN KEY (`name_id`) REFERENCES `id_business_v2_registration_names`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_registration_jobs` ADD CONSTRAINT `id_business_v2_registration_jobs_proxy_id_fkey` FOREIGN KEY (`proxy_id`) REFERENCES `id_business_v2_recharge_proxies`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_registration_jobs` ADD CONSTRAINT `id_business_v2_registration_jobs_account_id_fkey` FOREIGN KEY (`account_id`) REFERENCES `id_business_v2_chatgpt_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

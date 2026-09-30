CREATE TABLE `id_business_v2_recharge_login_networks` (
    `email_hash` CHAR(64) NOT NULL,
    `official_account_key` CHAR(64) NULL,
    `first_ip_encrypted` TEXT NOT NULL,
    `first_country_code` CHAR(2) NOT NULL,
    `first_login_at` DATETIME(6) NOT NULL,
    `last_ip_encrypted` TEXT NOT NULL,
    `last_country_code` CHAR(2) NOT NULL,
    `last_login_at` DATETIME(6) NOT NULL,
    `last_job_id` VARCHAR(36) NOT NULL,
    `login_count` INTEGER NOT NULL DEFAULT 1,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    UNIQUE INDEX `id_business_v2_recharge_login_networks_official_account_key_key`(`official_account_key`),
    UNIQUE INDEX `id_business_v2_recharge_login_networks_last_job_id_key`(`last_job_id`),
    INDEX `id_business_v2_recharge_login_networks_first_country_code_la_idx`(`first_country_code`, `last_login_at`),
    PRIMARY KEY (`email_hash`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

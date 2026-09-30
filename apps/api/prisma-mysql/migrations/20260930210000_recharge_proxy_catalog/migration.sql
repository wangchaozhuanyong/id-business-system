CREATE TABLE `id_business_v2_recharge_proxies` (
    `id` CHAR(36) NOT NULL,
    `country_code` CHAR(2) NOT NULL,
    `kind` ENUM('dynamic_residential', 'static_residential', 'mobile') NOT NULL,
    `connection_mode` ENUM('extraction', 'direct') NOT NULL,
    `protocol` VARCHAR(8) NOT NULL,
    `url_encrypted` TEXT NOT NULL,
    `url_hash` CHAR(64) NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `remark1` VARCHAR(500) NULL,
    `remark2` VARCHAR(500) NULL,
    `created_by_user_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,
    UNIQUE INDEX `id_business_v2_recharge_proxies_url_hash_key`(`url_hash`),
    INDEX `id_business_v2_recharge_proxies_country_code_active_kind_idx`(`country_code`, `active`, `kind`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `id_business_v2_recharge_jobs`
    ADD COLUMN `proxy_id` CHAR(36) NULL;

CREATE INDEX `id_business_v2_recharge_jobs_proxy_id_idx`
    ON `id_business_v2_recharge_jobs`(`proxy_id`);

ALTER TABLE `id_business_v2_recharge_jobs`
    ADD CONSTRAINT `id_business_v2_recharge_jobs_proxy_id_fkey`
    FOREIGN KEY (`proxy_id`) REFERENCES `id_business_v2_recharge_proxies`(`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE;

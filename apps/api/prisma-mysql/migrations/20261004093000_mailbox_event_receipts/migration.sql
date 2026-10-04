CREATE TABLE `id_business_v2_mailbox_events` (
    `id` CHAR(36) NOT NULL,
    `payload_hash` CHAR(64) NOT NULL,
    `primary_account_id` VARCHAR(64) NOT NULL,
    `virtual_email_id` VARCHAR(64) NULL,
    `received_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `processed_at` DATETIME(6) NULL,
    PRIMARY KEY (`id`),
    INDEX `id_business_v2_mailbox_events_processed_at_received_at_idx` (`processed_at`, `received_at`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT IGNORE INTO `id_business_v2_scope_versions` (`scope`) VALUES ('vendure-mailbox');

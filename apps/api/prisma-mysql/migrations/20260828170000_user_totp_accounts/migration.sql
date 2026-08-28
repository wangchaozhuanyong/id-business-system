CREATE TABLE `id_business_v2_totp_accounts` (
  `id` CHAR(36) NOT NULL,
  `user_id` CHAR(36) NOT NULL,
  `name` VARCHAR(60) NOT NULL,
  `issuer` VARCHAR(120) NULL,
  `secret_encrypted` TEXT NOT NULL,
  `secret_hash` VARCHAR(64) NOT NULL,
  `algorithm` ENUM('sha1', 'sha256', 'sha512') NOT NULL DEFAULT 'sha1',
  `digits` INTEGER NOT NULL DEFAULT 6,
  `period` INTEGER NOT NULL DEFAULT 30,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL,

  UNIQUE INDEX `id_business_v2_totp_accounts_user_id_name_key` (`user_id`, `name`),
  UNIQUE INDEX `id_business_v2_totp_accounts_user_id_secret_hash_key` (`user_id`, `secret_hash`),
  INDEX `id_business_v2_totp_accounts_user_id_updated_at_idx` (`user_id`, `updated_at`),
  PRIMARY KEY (`id`),
  CONSTRAINT `id_business_v2_totp_accounts_user_id_fkey`
    FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE ON UPDATE CASCADE,
  CONSTRAINT `id_business_v2_totp_accounts_digits_check`
    CHECK (`digits` BETWEEN 6 AND 8),
  CONSTRAINT `id_business_v2_totp_accounts_period_check`
    CHECK (`period` BETWEEN 15 AND 300)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

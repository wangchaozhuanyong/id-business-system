-- Additive Pro-only fields. Existing GPT payment and financial facts are preserved.
ALTER TABLE `id_business_v2_subscription_orders`
  ADD COLUMN `product` ENUM('gpt', 'claude') NOT NULL DEFAULT 'gpt',
  MODIFY COLUMN `plan` ENUM('go', 'plus', 'pro_5x', 'pro_20x', 'pro_50x', 'claude_pro') NOT NULL,
  ADD COLUMN `claude_pro_mode` ENUM('manual_card', 'people') NULL,
  ADD COLUMN `claude_pro_manual_card_encrypted` TEXT NULL,
  ADD COLUMN `claude_pro_people_encrypted` TEXT NULL,
  ADD COLUMN `claude_pro_card_serial_hash` CHAR(64) NULL,
  ADD COLUMN `claude_pro_renewal_source_id` CHAR(36) NULL,
  ADD UNIQUE INDEX `claude_pro_renewal_source_uq` (`claude_pro_renewal_source_id`),
  ADD INDEX `subscription_order_product_opened_idx` (`product`, `opened_at`, `id`),
  ADD INDEX `subscription_order_product_email_idx` (`product`, `account_email_hash`, `opened_at`),
  ADD INDEX `claude_pro_card_serial_idx` (`claude_pro_card_serial_hash`),
  ADD CONSTRAINT `claude_pro_renewal_source_fk` FOREIGN KEY (`claude_pro_renewal_source_id`)
    REFERENCES `id_business_v2_subscription_orders` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  DROP CHECK `subscription_order_payment_source_chk`,
  ADD CONSTRAINT `subscription_order_product_plan_chk` CHECK (
    (`product` = 'gpt' AND `plan` IN ('go', 'plus', 'pro_5x', 'pro_20x', 'pro_50x'))
    OR (`product` = 'claude' AND `plan` = 'claude_pro')
  ),
  ADD CONSTRAINT `subscription_order_payment_source_chk` CHECK (
    (`product` = 'gpt' AND (
      (`payment_method` = 'bank_card' AND `card_id` IS NOT NULL AND `card_last6` IS NOT NULL
        AND `apple_account_id` IS NULL AND `apple_account_snapshot_encrypted` IS NULL)
      OR (`payment_method` = 'apple_in_app' AND `card_id` IS NULL AND `card_last6` IS NULL
        AND `apple_account_id` IS NOT NULL AND `apple_account_snapshot_encrypted` IS NOT NULL)
    ))
    OR (`product` = 'claude' AND `payment_method` = 'bank_card' AND `card_id` IS NULL
      AND `apple_account_id` IS NULL AND `apple_account_snapshot_encrypted` IS NULL)
  ),
  ADD CONSTRAINT `claude_pro_materials_mode_chk` CHECK (
    (`product` = 'gpt' AND `claude_pro_mode` IS NULL
      AND `claude_pro_manual_card_encrypted` IS NULL AND `claude_pro_people_encrypted` IS NULL
      AND `claude_pro_card_serial_hash` IS NULL AND `claude_pro_renewal_source_id` IS NULL)
    OR (`product` = 'claude' AND `claude_pro_mode` IS NOT NULL AND (
      (`claude_pro_mode` = 'manual_card' AND `claude_pro_manual_card_encrypted` IS NOT NULL
        AND `claude_pro_people_encrypted` IS NULL AND `claude_pro_card_serial_hash` IS NOT NULL
        AND `card_last6` IS NOT NULL)
      OR (`claude_pro_mode` = 'people' AND `claude_pro_people_encrypted` IS NOT NULL
        AND `claude_pro_manual_card_encrypted` IS NULL AND `claude_pro_card_serial_hash` IS NULL
        AND `card_last6` IS NULL)
    ))
  );

CREATE TABLE `id_business_v2_claude_pro_people` (
  `id` CHAR(36) NOT NULL,
  `kind` ENUM('tenant', 'owner') NOT NULL,
  `name` VARCHAR(120) NOT NULL,
  `phone_encrypted` TEXT NOT NULL,
  `phone_hash` CHAR(64) NOT NULL,
  `version` INTEGER NOT NULL DEFAULT 1,
  `request_hash` CHAR(64) NOT NULL,
  `idempotency_key` VARCHAR(100) NOT NULL,
  `created_by_user_id` CHAR(36) NOT NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `claude_pro_person_actor_key_uq` (`created_by_user_id`, `idempotency_key`),
  INDEX `claude_pro_person_kind_name_idx` (`kind`, `name`, `id`),
  INDEX `claude_pro_person_phone_idx` (`phone_hash`),
  CONSTRAINT `claude_pro_person_creator_fk` FOREIGN KEY (`created_by_user_id`)
    REFERENCES `users` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `claude_pro_person_version_chk` CHECK (`version` >= 1)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `id_business_v2_claude_pro_order_revisions` (
  `id` CHAR(36) NOT NULL,
  `order_id` CHAR(36) NOT NULL,
  `from_version` INTEGER NOT NULL,
  `to_version` INTEGER NOT NULL,
  `before_encrypted` LONGTEXT NOT NULL,
  `after_encrypted` LONGTEXT NOT NULL,
  `reason_encrypted` TEXT NOT NULL,
  `idempotency_key` VARCHAR(100) NOT NULL,
  `request_hash` CHAR(64) NOT NULL,
  `operator_user_id` CHAR(36) NOT NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `claude_pro_revision_actor_key_uq` (`operator_user_id`, `idempotency_key`),
  UNIQUE INDEX `claude_pro_revision_version_uq` (`order_id`, `to_version`),
  INDEX `claude_pro_revision_history_idx` (`order_id`, `created_at`),
  CONSTRAINT `claude_pro_revision_order_fk` FOREIGN KEY (`order_id`)
    REFERENCES `id_business_v2_subscription_orders` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `claude_pro_revision_operator_fk` FOREIGN KEY (`operator_user_id`)
    REFERENCES `users` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `claude_pro_revision_version_chk` CHECK (`from_version` >= 1 AND `to_version` = `from_version` + 1)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

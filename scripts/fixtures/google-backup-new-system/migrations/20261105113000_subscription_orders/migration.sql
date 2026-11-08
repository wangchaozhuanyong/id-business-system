CREATE TABLE `id_business_v2_subscription_orders` (
  `id` CHAR(36) NOT NULL,
  `order_no` VARCHAR(40) NOT NULL,
  `plan` ENUM('go', 'plus', 'pro_5x', 'pro_20x', 'pro_50x') NOT NULL,
  `business_type` ENUM('renewal', 'finished_delivery') NOT NULL,
  `customer_id` CHAR(36) NOT NULL,
  `customer_snapshot_encrypted` TEXT NOT NULL,
  `account_email_encrypted` TEXT NOT NULL,
  `account_email_hash` CHAR(64) NOT NULL,
  `account_email_search_tokens` JSON NOT NULL,
  `stock_id` VARCHAR(32) NULL,
  `card_id` CHAR(36) NOT NULL,
  `card_last6` CHAR(6) NOT NULL,
  `paid_amount` DECIMAL(18, 4) NOT NULL,
  `paid_currency` ENUM('CNY', 'MYR', 'USD', 'PHP', 'IDR', 'CLP', 'JPY', 'KRW', 'TWD', 'HKD', 'SGD', 'EUR', 'GBP', 'AUD', 'CAD', 'CHF', 'NZD', 'THB', 'VND', 'INR', 'AED', 'SAR', 'BRL', 'MXN', 'ZAR', 'USDT') NOT NULL,
  `sale_amount` DECIMAL(18, 4) NOT NULL,
  `sale_currency` ENUM('CNY', 'MYR', 'USD', 'PHP', 'IDR', 'CLP', 'JPY', 'KRW', 'TWD', 'HKD', 'SGD', 'EUR', 'GBP', 'AUD', 'CAD', 'CHF', 'NZD', 'THB', 'VND', 'INR', 'AED', 'SAR', 'BRL', 'MXN', 'ZAR', 'USDT') NOT NULL,
  `opened_at` DATETIME(6) NOT NULL,
  `due_at` DATETIME(6) NOT NULL,
  `paid_confirmed` BOOLEAN NOT NULL,
  `receipt_confirmed` BOOLEAN NOT NULL,
  `cost_confirmed` BOOLEAN NOT NULL,
  `financial_snapshot` JSON NOT NULL,
  `remark` TEXT NULL,
  `request_hash` CHAR(64) NOT NULL,
  `idempotency_key` VARCHAR(100) NOT NULL,
  `version` INTEGER NOT NULL DEFAULT 1,
  `created_by_user_id` CHAR(36) NOT NULL,
  `updated_by_user_id` CHAR(36) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL,
  PRIMARY KEY (`id`),
  UNIQUE INDEX `subscription_order_no_uq` (`order_no`),
  UNIQUE INDEX `subscription_order_stock_uq` (`stock_id`),
  UNIQUE INDEX `subscription_order_actor_key_uq` (`created_by_user_id`, `idempotency_key`),
  INDEX `subscription_order_opened_idx` (`opened_at`, `id`),
  INDEX `subscription_order_customer_idx` (`customer_id`, `opened_at`, `id`),
  INDEX `subscription_order_email_idx` (`account_email_hash`, `opened_at`, `id`),
  INDEX `subscription_order_editor_idx` (`updated_by_user_id`),
  CONSTRAINT `subscription_order_customer_fk` FOREIGN KEY (`customer_id`)
    REFERENCES `id_business_v2_customers` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `subscription_order_stock_fk` FOREIGN KEY (`stock_id`)
    REFERENCES `id_business_v2_inventory_entries` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `subscription_order_creator_fk` FOREIGN KEY (`created_by_user_id`)
    REFERENCES `users` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `subscription_order_editor_fk` FOREIGN KEY (`updated_by_user_id`)
    REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE RESTRICT,
  CONSTRAINT `subscription_order_amounts_chk` CHECK (`paid_amount` > 0 AND `sale_amount` > 0),
  CONSTRAINT `subscription_order_currencies_chk` CHECK (
    `paid_currency` IN ('CNY', 'MYR', 'USD', 'PHP', 'IDR', 'CLP')
    AND `sale_currency` IN ('CNY', 'MYR')
  ),
  CONSTRAINT `subscription_order_period_chk` CHECK (`due_at` > `opened_at`),
  CONSTRAINT `subscription_order_stock_use_chk` CHECK (
    (`business_type` = 'renewal' AND `stock_id` IS NULL)
    OR (`business_type` = 'finished_delivery' AND `stock_id` IS NOT NULL)
  ),
  CONSTRAINT `subscription_order_version_chk` CHECK (`version` >= 1)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `id_business_v2_subscription_fee_rules` (
  `version` INTEGER NOT NULL,
  `payment_fee_rate` DECIMAL(18, 8) NOT NULL,
  `fixed_fee_usd` DECIMAL(18, 4) NOT NULL,
  `card_opening_fee_usd` DECIMAL(18, 4) NOT NULL,
  `created_by_user_id` CHAR(36) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`version`),
  INDEX `subscription_fee_rule_creator_idx` (`created_by_user_id`),
  CONSTRAINT `subscription_fee_rule_creator_fk` FOREIGN KEY (`created_by_user_id`)
    REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE RESTRICT,
  CONSTRAINT `subscription_fee_rule_values_chk` CHECK (
    `version` >= 1 AND `payment_fee_rate` >= 0 AND `fixed_fee_usd` >= 0 AND `card_opening_fee_usd` >= 0
  )
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

CREATE TABLE `id_business_v2_subscription_card_opening_claims` (
  `id` CHAR(36) NOT NULL,
  `order_id` CHAR(36) NOT NULL,
  `card_id` CHAR(36) NOT NULL,
  `number_hash` CHAR(64) NOT NULL,
  `amount_usd` DECIMAL(18, 4) NOT NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE INDEX `subscription_opening_claim_order_uq` (`order_id`),
  UNIQUE INDEX `subscription_opening_claim_card_uq` (`card_id`),
  UNIQUE INDEX `subscription_opening_claim_number_uq` (`number_hash`),
  CONSTRAINT `subscription_opening_claim_order_fk` FOREIGN KEY (`order_id`)
    REFERENCES `id_business_v2_subscription_orders` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `subscription_opening_claim_amount_chk` CHECK (`amount_usd` >= 0)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

INSERT INTO `id_business_v2_subscription_fee_rules`
  (`version`, `payment_fee_rate`, `fixed_fee_usd`, `card_opening_fee_usd`, `created_at`)
VALUES (1, 0.00800000, 0.3000, 0.5000, UTC_TIMESTAMP(6));

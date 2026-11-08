-- Existing rows adopt bank_card and keep their original payment references.
ALTER TABLE `id_business_v2_subscription_orders`
  ADD COLUMN `payment_method` ENUM('bank_card', 'apple_in_app') NOT NULL DEFAULT 'bank_card',
  ADD COLUMN `apple_account_id` CHAR(36) NULL,
  ADD COLUMN `apple_account_snapshot_encrypted` TEXT NULL,
  MODIFY COLUMN `card_id` CHAR(36) NULL,
  MODIFY COLUMN `card_last6` CHAR(6) NULL,
  ADD INDEX `subscription_order_apple_account_idx` (`apple_account_id`),
  ADD CONSTRAINT `subscription_order_apple_account_fk` FOREIGN KEY (`apple_account_id`)
    REFERENCES `id_business_v2_accounts` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  DROP CHECK `subscription_order_currencies_chk`,
  ADD CONSTRAINT `subscription_order_payment_source_chk` CHECK (
    (
      `payment_method` = 'bank_card' AND `card_id` IS NOT NULL AND `card_last6` IS NOT NULL
      AND `apple_account_id` IS NULL AND `apple_account_snapshot_encrypted` IS NULL
    )
    OR (
      `payment_method` = 'apple_in_app' AND `card_id` IS NULL AND `card_last6` IS NULL
      AND `apple_account_id` IS NOT NULL AND `apple_account_snapshot_encrypted` IS NOT NULL
    )
  ),
  ADD CONSTRAINT `subscription_order_payment_currencies_chk` CHECK (
    (
      `payment_method` = 'bank_card' AND `paid_currency` IN ('CNY', 'MYR', 'USD', 'PHP', 'IDR', 'CLP')
      AND `sale_currency` IN ('CNY', 'MYR')
    )
    OR (
      `payment_method` = 'apple_in_app' AND `paid_currency` = 'USD'
      AND `sale_currency` IN ('CNY', 'MYR', 'USD')
    )
  );

-- Keep the legacy reference enforced while changing its update action to RESTRICT.
-- MySQL requires checked FK columns to be protected from cascading updates.
ALTER TABLE `id_business_v2_balance_ledger`
  ADD COLUMN `subscription_order_id` CHAR(36) NULL,
  MODIFY COLUMN `entry_type` ENUM(
    'gift_card_credit', 'gift_card_redeemed', 'gift_card_withdrawal', 'order_consumption',
    'order_consumption_reversal', 'order_upgrade_balance_return', 'order_upgrade_balance_return_reversal',
    'opening_balance', 'manual_adjustment', 'account_loss',
    'subscription_apple_funding', 'subscription_apple_charge', 'subscription_apple_return',
    'subscription_apple_return_reversal', 'subscription_apple_charge_correction',
    'subscription_apple_charge_correction_reversal'
  ) NOT NULL,
  ADD INDEX `subscription_balance_order_type_idx` (`subscription_order_id`, `entry_type`),
  ADD CONSTRAINT `subscription_legacy_balance_order_fk` FOREIGN KEY (`order_id`)
    REFERENCES `id_business_v2_orders` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  ADD CONSTRAINT `subscription_balance_order_fk` FOREIGN KEY (`subscription_order_id`)
    REFERENCES `id_business_v2_subscription_orders` (`id`) ON DELETE RESTRICT ON UPDATE RESTRICT;

ALTER TABLE `id_business_v2_balance_ledger`
  DROP FOREIGN KEY `id_business_v2_balance_ledger_order_id_fkey`;

ALTER TABLE `id_business_v2_balance_ledger`
  ADD CONSTRAINT `subscription_balance_order_type_chk` CHECK (
    (CASE
      WHEN `entry_type` = 'subscription_apple_funding' THEN
        `order_id` IS NULL AND `subscription_order_id` IS NULL AND `direction` = 'credit'
      WHEN `entry_type` = 'subscription_apple_return' THEN
        `order_id` IS NULL AND `subscription_order_id` IS NOT NULL AND `direction` = 'credit'
      WHEN `entry_type` IN ('subscription_apple_charge', 'subscription_apple_return_reversal') THEN
        `order_id` IS NULL AND `subscription_order_id` IS NOT NULL AND `direction` = 'debit'
      WHEN `entry_type` IN ('subscription_apple_charge_correction', 'subscription_apple_charge_correction_reversal') THEN
        `order_id` IS NULL AND `subscription_order_id` IS NOT NULL AND `direction` IN ('credit', 'debit')
      ELSE `subscription_order_id` IS NULL
    END) = 1
  );

CREATE TABLE `id_business_v2_subscription_refunds` (
  `id` CHAR(36) NOT NULL,
  `order_id` CHAR(36) NOT NULL,
  `apple_account_id` CHAR(36) NOT NULL,
  `customer_refund_amount` DECIMAL(18, 4) NOT NULL,
  `customer_refund_currency` ENUM('CNY', 'MYR', 'USD', 'PHP', 'IDR', 'CLP', 'JPY', 'KRW', 'TWD', 'HKD', 'SGD', 'EUR', 'GBP', 'AUD', 'CAD', 'CHF', 'NZD', 'THB', 'VND', 'INR', 'AED', 'SAR', 'BRL', 'MXN', 'ZAR', 'USDT') NOT NULL,
  `customer_refunded_at` DATETIME(6) NOT NULL,
  `reason` TEXT NOT NULL,
  `expected_apple_return_usd` DECIMAL(18, 4) NOT NULL,
  `return_status` ENUM('not_required', 'pending', 'received', 'reversed') NOT NULL,
  `received_ledger_entry_id` CHAR(36) NULL,
  `received_at` DATETIME(6) NULL,
  `received_by_user_id` CHAR(36) NULL,
  `reversal_ledger_entry_id` CHAR(36) NULL,
  `reversed_at` DATETIME(6) NULL,
  `reversed_by_user_id` CHAR(36) NULL,
  `version` INTEGER NOT NULL DEFAULT 1,
  `created_by_user_id` CHAR(36) NOT NULL,
  `updated_by_user_id` CHAR(36) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL,
  `idempotency_key` VARCHAR(100) NOT NULL,
  `request_hash` CHAR(64) NOT NULL,

  UNIQUE INDEX `subscription_refund_receipt_uq`(`received_ledger_entry_id`),
  UNIQUE INDEX `subscription_refund_reversal_uq`(`reversal_ledger_entry_id`),
  INDEX `subscription_refund_order_status_idx`(`order_id`, `return_status`),
  INDEX `subscription_refund_account_idx`(`apple_account_id`),
  INDEX `subscription_refund_receiver_idx`(`received_by_user_id`),
  INDEX `subscription_refund_reverser_idx`(`reversed_by_user_id`),
  INDEX `subscription_refund_editor_idx`(`updated_by_user_id`),
  UNIQUE INDEX `subscription_refund_actor_key_uq`(`created_by_user_id`, `idempotency_key`),
  PRIMARY KEY (`id`),
  CONSTRAINT `subscription_refund_order_fk` FOREIGN KEY (`order_id`) REFERENCES `id_business_v2_subscription_orders`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `subscription_refund_account_fk` FOREIGN KEY (`apple_account_id`) REFERENCES `id_business_v2_accounts`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `subscription_refund_receipt_fk` FOREIGN KEY (`received_ledger_entry_id`) REFERENCES `id_business_v2_balance_ledger`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `subscription_refund_reversal_fk` FOREIGN KEY (`reversal_ledger_entry_id`) REFERENCES `id_business_v2_balance_ledger`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `subscription_refund_receiver_fk` FOREIGN KEY (`received_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT,
  CONSTRAINT `subscription_refund_reverser_fk` FOREIGN KEY (`reversed_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT,
  CONSTRAINT `subscription_refund_creator_fk` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT `subscription_refund_editor_fk` FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE RESTRICT,
  CONSTRAINT `subscription_refund_amounts_chk` CHECK (
  `customer_refund_amount` > 0 AND `expected_apple_return_usd` >= 0
    AND `customer_refund_currency` IN ('CNY', 'MYR', 'USD')
    AND `version` >= 1
  ),
  CONSTRAINT `subscription_refund_return_status_chk` CHECK (
    (
      (
        (`return_status` = 'not_required' AND `expected_apple_return_usd` = 0)
        OR (`return_status` = 'pending' AND `expected_apple_return_usd` > 0)
      )
      AND `received_ledger_entry_id` IS NULL AND `received_at` IS NULL
      AND `reversal_ledger_entry_id` IS NULL AND `reversed_at` IS NULL
    )
    OR (
      `return_status` = 'received' AND `expected_apple_return_usd` > 0
      AND `received_ledger_entry_id` IS NOT NULL AND `received_at` IS NOT NULL
      AND `reversal_ledger_entry_id` IS NULL AND `reversed_at` IS NULL
    )
    OR (
      `return_status` = 'reversed' AND `expected_apple_return_usd` > 0
      AND `received_ledger_entry_id` IS NOT NULL AND `received_at` IS NOT NULL
      AND `reversal_ledger_entry_id` IS NOT NULL AND `reversed_at` IS NOT NULL
      AND `reversal_ledger_entry_id` <> `received_ledger_entry_id`
      AND `reversed_at` >= `received_at`
    )
  )
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

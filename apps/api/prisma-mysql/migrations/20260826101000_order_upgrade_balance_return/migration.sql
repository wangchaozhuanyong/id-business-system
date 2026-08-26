ALTER TABLE `id_business_v2_orders`
ADD COLUMN `balance_currency_code` VARCHAR(3) NULL;

UPDATE `id_business_v2_orders` AS target
INNER JOIN `id_business_v2_accounts` AS account
  ON account.`id` = target.`account_id`
INNER JOIN `id_business_v2_options` AS country
  ON country.`id` = account.`country_option_id`
SET target.`balance_currency_code` = UPPER(country.`currency_code`)
WHERE country.`currency_code` IS NOT NULL;

CREATE TABLE `id_business_v2_order_balance_returns` (
  `id` CHAR(36) NOT NULL,
  `order_id` CHAR(36) NOT NULL,
  `account_id` CHAR(36) NOT NULL,
  `active_key` VARCHAR(80) NULL,
  `status` ENUM('active', 'reversed') NOT NULL DEFAULT 'active',
  `currency_code` VARCHAR(3) NOT NULL,
  `returned_balance_amount` DECIMAL(18, 4) NOT NULL,
  `restored_balance_cost_amount` DECIMAL(18, 4) NOT NULL,
  `restored_applied_balance_cost_amount` DECIMAL(18, 4) NOT NULL,
  `original_profit_amount` DECIMAL(18, 4) NOT NULL,
  `adjusted_profit_amount` DECIMAL(18, 4) NOT NULL,
  `balance_ledger_entry_id` CHAR(36) NOT NULL,
  `finance_journal_id` CHAR(36) NULL,
  `idempotency_key` VARCHAR(160) NOT NULL,
  `reason` TEXT NOT NULL,
  `created_by_user_id` CHAR(36) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `reversal_balance_ledger_entry_id` CHAR(36) NULL,
  `reversal_finance_journal_id` CHAR(36) NULL,
  `reversal_idempotency_key` VARCHAR(160) NULL,
  `reversal_reason` TEXT NULL,
  `reversed_by_user_id` CHAR(36) NULL,
  `reversed_at` DATETIME(6) NULL,

  PRIMARY KEY (`id`),
  UNIQUE INDEX `id_business_v2_order_balance_returns_active_key_key`(`active_key`),
  UNIQUE INDEX `id_business_v2_order_balance_returns_balance_ledger_entry_id_key`(`balance_ledger_entry_id`),
  UNIQUE INDEX `id_business_v2_order_balance_returns_finance_journal_id_key`(`finance_journal_id`),
  UNIQUE INDEX `id_business_v2_order_balance_returns_idempotency_key_key`(`idempotency_key`),
  UNIQUE INDEX `id_business_v2_order_balance_returns_reversal_balance_ledger_entry_id_key`(`reversal_balance_ledger_entry_id`),
  UNIQUE INDEX `id_business_v2_order_balance_returns_reversal_finance_journal_id_key`(`reversal_finance_journal_id`),
  UNIQUE INDEX `id_business_v2_order_balance_returns_reversal_idempotency_key_key`(`reversal_idempotency_key`),
  INDEX `id_business_v2_order_balance_returns_order_id_created_at_idx`(`order_id`, `created_at`),
  INDEX `id_business_v2_order_balance_returns_account_id_created_at_idx`(`account_id`, `created_at`),
  INDEX `id_business_v2_order_balance_returns_status_created_at_idx`(`status`, `created_at`),
  INDEX `id_business_v2_order_balance_returns_created_by_user_id_idx`(`created_by_user_id`),
  INDEX `id_business_v2_order_balance_returns_reversed_by_user_id_idx`(`reversed_by_user_id`),
  CONSTRAINT `id_business_v2_order_balance_returns_order_id_fkey`
    FOREIGN KEY (`order_id`) REFERENCES `id_business_v2_orders`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `id_business_v2_order_balance_returns_account_id_fkey`
    FOREIGN KEY (`account_id`) REFERENCES `id_business_v2_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `id_business_v2_order_balance_returns_created_by_user_id_fkey`
    FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `id_business_v2_order_balance_returns_reversed_by_user_id_fkey`
    FOREIGN KEY (`reversed_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `id_business_v2_order_balance_returns_amount_check`
    CHECK (
      `returned_balance_amount` > 0
      AND `restored_balance_cost_amount` >= 0
      AND `restored_applied_balance_cost_amount` >= 0
      AND `restored_applied_balance_cost_amount` <= `restored_balance_cost_amount`
    ),
  CONSTRAINT `id_business_v2_order_balance_returns_state_check`
    CHECK (
      (
        `status` = 'active'
        AND `active_key` IS NOT NULL
        AND `reversal_balance_ledger_entry_id` IS NULL
        AND `reversal_finance_journal_id` IS NULL
        AND `reversal_idempotency_key` IS NULL
        AND `reversal_reason` IS NULL
        AND `reversed_by_user_id` IS NULL
        AND `reversed_at` IS NULL
      )
      OR (
        `status` = 'reversed'
        AND `active_key` IS NULL
        AND `reversal_balance_ledger_entry_id` IS NOT NULL
        AND `reversal_idempotency_key` IS NOT NULL
        AND `reversal_reason` IS NOT NULL
        AND `reversed_at` IS NOT NULL
      )
    )
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `id_business_v2_balance_ledger`
DROP INDEX `id_business_v2_balance_ledger_order_id_entry_type_key`,
ADD INDEX `id_business_v2_balance_ledger_order_id_entry_type_idx`(`order_id`, `entry_type`);

ALTER TABLE `id_business_v2_balance_ledger`
ADD COLUMN `order_singleton_key` VARCHAR(90)
GENERATED ALWAYS AS (
  CASE
    WHEN `entry_type` IN ('order_consumption', 'order_consumption_reversal')
      THEN CONCAT(`order_id`, ':', `entry_type`)
    ELSE NULL
  END
) STORED,
ADD UNIQUE INDEX `id_business_v2_balance_ledger_single_order_entry_key`(`order_singleton_key`);

CREATE TRIGGER `idv2_order_balance_return_update_guard`
BEFORE UPDATE ON `id_business_v2_order_balance_returns`
FOR EACH ROW
BEGIN
  IF NOT (
    OLD.`status` = 'active'
    AND NEW.`status` = 'reversed'
    AND NEW.`active_key` IS NULL
    AND NEW.`reversal_balance_ledger_entry_id` IS NOT NULL
    AND NEW.`reversal_idempotency_key` IS NOT NULL
    AND NEW.`reversal_reason` IS NOT NULL
    AND NEW.`reversed_at` IS NOT NULL
    AND NEW.`id` <=> OLD.`id`
    AND NEW.`order_id` <=> OLD.`order_id`
    AND NEW.`account_id` <=> OLD.`account_id`
    AND NEW.`currency_code` <=> OLD.`currency_code`
    AND NEW.`returned_balance_amount` <=> OLD.`returned_balance_amount`
    AND NEW.`restored_balance_cost_amount` <=> OLD.`restored_balance_cost_amount`
    AND NEW.`restored_applied_balance_cost_amount` <=> OLD.`restored_applied_balance_cost_amount`
    AND NEW.`original_profit_amount` <=> OLD.`original_profit_amount`
    AND NEW.`adjusted_profit_amount` <=> OLD.`adjusted_profit_amount`
    AND NEW.`balance_ledger_entry_id` <=> OLD.`balance_ledger_entry_id`
    AND NEW.`finance_journal_id` <=> OLD.`finance_journal_id`
    AND NEW.`idempotency_key` <=> OLD.`idempotency_key`
    AND NEW.`reason` <=> OLD.`reason`
    AND NEW.`created_by_user_id` <=> OLD.`created_by_user_id`
    AND NEW.`created_at` <=> OLD.`created_at`
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Upgrade balance return snapshots are immutable';
  END IF;
END;

CREATE TRIGGER `idv2_order_balance_return_no_delete`
BEFORE DELETE ON `id_business_v2_order_balance_returns`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Upgrade balance return records cannot be deleted';

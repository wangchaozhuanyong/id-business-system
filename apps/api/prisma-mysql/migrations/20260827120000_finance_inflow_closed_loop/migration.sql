ALTER TABLE `id_business_v2_options`
  MODIFY COLUMN `type` ENUM(
    'id_status', 'id_region', 'customer_source', 'customer_tag', 'country',
    'business_category', 'service', 'id_supplier', 'topup_supplier',
    'gift_card_name', 'settlement_platform', 'expense_category', 'income_category'
  ) NOT NULL;

ALTER TABLE `id_business_v2_finance_journals`
  MODIFY COLUMN `journal_type` ENUM(
    'supplier_deposit', 'supplier_refund', 'supplier_adjustment', 'gift_card_purchase',
    'gift_card_redemption_loss', 'gift_card_withdrawal_pending', 'gift_card_refund_received',
    'gift_card_refund_write_off', 'account_purchase', 'order_completed', 'order_refund',
    'order_cancel', 'order_recovery', 'order_upgrade_balance_return', 'account_loss', 'expense',
    'manual_operating_income', 'capital_contribution', 'borrowed_funds_received',
    'opening_balance', 'fx_gain_loss', 'manual_adjustment', 'historical_backfill', 'reversal'
  ) NOT NULL,
  MODIFY COLUMN `source_type` ENUM(
    'supplier_wallet', 'supplier_payment', 'gift_card', 'account', 'account_loss',
    'order', 'expense', 'inflow', 'opening_balance', 'historical_backfill', 'manual'
  ) NOT NULL;

ALTER TABLE `id_business_v2_finance_journal_lines`
  MODIFY COLUMN `account_code` ENUM(
    'cash', 'supplier_prepayment', 'supplier_refund_receivable', 'gift_card_inventory',
    'id_inventory', 'sales_revenue', 'other_operating_revenue', 'contributed_capital',
    'borrowed_funds_payable', 'platform_fee', 'gift_card_cost', 'id_cost',
    'customer_owned_balance_cost', 'refund_loss', 'gift_card_redemption_loss',
    'balance_loss', 'id_purchase_loss', 'operating_expense', 'realized_fx_gain_loss',
    'opening_equity', 'manual_adjustment'
  ) NOT NULL;

CREATE TABLE `id_business_v2_finance_inflows` (
  `id` CHAR(36) NOT NULL,
  `journal_id` CHAR(36) NOT NULL,
  `nature` ENUM('operating_income', 'capital_contribution', 'borrowed_funds') NOT NULL,
  `category_option_id` CHAR(36) NULL,
  `category_name_snapshot` VARCHAR(160) NULL,
  `finance_account_id` CHAR(36) NOT NULL,
  `finance_account_name_snapshot` VARCHAR(160) NOT NULL,
  `fx_rate_snapshot_id` CHAR(36) NULL,
  `currency` ENUM('CNY', 'MYR', 'USD', 'USDT') NOT NULL,
  `amount_original` DECIMAL(18, 4) NOT NULL,
  `fx_rate_to_cny` DECIMAL(18, 8) NOT NULL,
  `amount_cny` DECIMAL(18, 4) NOT NULL,
  `occurred_at` DATETIME(6) NOT NULL,
  `payer` VARCHAR(200) NULL,
  `external_reference` VARCHAR(200) NOT NULL,
  `receipt_attachment_id` CHAR(36) NOT NULL,
  `remark` TEXT NULL,
  `idempotency_key` VARCHAR(180) NOT NULL,
  `created_by_user_id` CHAR(36) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`id`),
  UNIQUE KEY `id_business_v2_finance_inflows_journal_id_key` (`journal_id`),
  UNIQUE KEY `id_business_v2_finance_inflows_idempotency_key_key` (`idempotency_key`),
  KEY `id_business_v2_finance_inflows_nature_occurred_at_idx` (`nature`, `occurred_at`),
  KEY `id_business_v2_finance_inflows_category_occurred_at_idx` (`category_option_id`, `occurred_at`),
  KEY `id_business_v2_finance_inflows_account_occurred_at_idx` (`finance_account_id`, `occurred_at`),
  KEY `id_business_v2_finance_inflows_currency_occurred_at_idx` (`currency`, `occurred_at`),
  KEY `id_business_v2_finance_inflows_external_reference_idx` (`external_reference`),
  KEY `id_business_v2_finance_inflows_fx_rate_snapshot_id_idx` (`fx_rate_snapshot_id`),
  KEY `id_business_v2_finance_inflows_receipt_attachment_id_idx` (`receipt_attachment_id`),
  KEY `id_business_v2_finance_inflows_created_by_user_id_idx` (`created_by_user_id`),
  CONSTRAINT `id_business_v2_finance_inflows_journal_id_fkey`
    FOREIGN KEY (`journal_id`) REFERENCES `id_business_v2_finance_journals` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `id_business_v2_finance_inflows_category_option_id_fkey`
    FOREIGN KEY (`category_option_id`) REFERENCES `id_business_v2_options` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `id_business_v2_finance_inflows_finance_account_id_fkey`
    FOREIGN KEY (`finance_account_id`) REFERENCES `id_business_v2_finance_accounts` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `id_business_v2_finance_inflows_fx_rate_snapshot_id_fkey`
    FOREIGN KEY (`fx_rate_snapshot_id`) REFERENCES `id_business_v2_finance_fx_rate_snapshots` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `id_business_v2_finance_inflows_receipt_attachment_id_fkey`
    FOREIGN KEY (`receipt_attachment_id`) REFERENCES `attachments` (`id`) ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `id_business_v2_finance_inflows_created_by_user_id_fkey`
    FOREIGN KEY (`created_by_user_id`) REFERENCES `users` (`id`) ON DELETE SET NULL ON UPDATE CASCADE,
  CONSTRAINT `id_business_v2_finance_inflows_amount_check`
    CHECK (`amount_original` > 0 AND `fx_rate_to_cny` > 0 AND `amount_cny` > 0)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO `id_business_v2_options` (
  `id`, `type`, `code`, `name`, `unique_key`, `sort_order`, `status`, `is_system`, `created_at`, `updated_at`
)
VALUES
  (UUID(), 'income_category', 'extra_service', '额外服务收入', 'income_category:root:额外服务收入', 10, 'active', false, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6)),
  (UUID(), 'income_category', 'commission', '佣金收入', 'income_category:root:佣金收入', 20, 'active', false, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6)),
  (UUID(), 'income_category', 'rebate', '返利收入', 'income_category:root:返利收入', 30, 'active', false, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6)),
  (UUID(), 'income_category', 'fee_income', '手续费收入', 'income_category:root:手续费收入', 40, 'active', false, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6)),
  (UUID(), 'income_category', 'other_operating', '其他经营收入', 'income_category:root:其他经营收入', 50, 'active', false, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6))
ON DUPLICATE KEY UPDATE `unique_key` = VALUES(`unique_key`);

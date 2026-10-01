-- AlterTable
ALTER TABLE `id_business_v2_accounts` MODIFY `purchase_currency` ENUM('CNY', 'MYR', 'USD', 'PHP', 'IDR', 'CLP', 'JPY', 'KRW', 'TWD', 'HKD', 'SGD', 'EUR', 'GBP', 'AUD', 'CAD', 'CHF', 'NZD', 'THB', 'VND', 'INR', 'AED', 'SAR', 'BRL', 'MXN', 'ZAR', 'USDT') NOT NULL DEFAULT 'CNY';

-- AlterTable
ALTER TABLE `id_business_v2_gift_cards` MODIFY `purchase_currency` ENUM('CNY', 'MYR', 'USD', 'PHP', 'IDR', 'CLP', 'JPY', 'KRW', 'TWD', 'HKD', 'SGD', 'EUR', 'GBP', 'AUD', 'CAD', 'CHF', 'NZD', 'THB', 'VND', 'INR', 'AED', 'SAR', 'BRL', 'MXN', 'ZAR', 'USDT') NOT NULL DEFAULT 'CNY';

-- AlterTable
ALTER TABLE `id_business_v2_topup_supplier_accounts` MODIFY `currency` ENUM('CNY', 'MYR', 'USD', 'PHP', 'IDR', 'CLP', 'JPY', 'KRW', 'TWD', 'HKD', 'SGD', 'EUR', 'GBP', 'AUD', 'CAD', 'CHF', 'NZD', 'THB', 'VND', 'INR', 'AED', 'SAR', 'BRL', 'MXN', 'ZAR', 'USDT') NOT NULL DEFAULT 'CNY';

-- AlterTable
ALTER TABLE `id_business_v2_topup_supplier_payments` MODIFY `paid_currency` ENUM('CNY', 'MYR', 'USD', 'PHP', 'IDR', 'CLP', 'JPY', 'KRW', 'TWD', 'HKD', 'SGD', 'EUR', 'GBP', 'AUD', 'CAD', 'CHF', 'NZD', 'THB', 'VND', 'INR', 'AED', 'SAR', 'BRL', 'MXN', 'ZAR', 'USDT') NOT NULL DEFAULT 'USDT';

-- AlterTable
ALTER TABLE `id_business_v2_topup_supplier_ledger` MODIFY `currency` ENUM('CNY', 'MYR', 'USD', 'PHP', 'IDR', 'CLP', 'JPY', 'KRW', 'TWD', 'HKD', 'SGD', 'EUR', 'GBP', 'AUD', 'CAD', 'CHF', 'NZD', 'THB', 'VND', 'INR', 'AED', 'SAR', 'BRL', 'MXN', 'ZAR', 'USDT') NOT NULL DEFAULT 'CNY';

-- AlterTable
ALTER TABLE `id_business_v2_finance_settings` MODIFY `base_currency` ENUM('CNY', 'MYR', 'USD', 'PHP', 'IDR', 'CLP', 'JPY', 'KRW', 'TWD', 'HKD', 'SGD', 'EUR', 'GBP', 'AUD', 'CAD', 'CHF', 'NZD', 'THB', 'VND', 'INR', 'AED', 'SAR', 'BRL', 'MXN', 'ZAR', 'USDT') NOT NULL DEFAULT 'CNY';

-- AlterTable
ALTER TABLE `id_business_v2_finance_accounts` MODIFY `currency` ENUM('CNY', 'MYR', 'USD', 'PHP', 'IDR', 'CLP', 'JPY', 'KRW', 'TWD', 'HKD', 'SGD', 'EUR', 'GBP', 'AUD', 'CAD', 'CHF', 'NZD', 'THB', 'VND', 'INR', 'AED', 'SAR', 'BRL', 'MXN', 'ZAR', 'USDT') NOT NULL;

-- AlterTable
ALTER TABLE `id_business_v2_finance_fx_rate_snapshots` MODIFY `currency` ENUM('CNY', 'MYR', 'USD', 'PHP', 'IDR', 'CLP', 'JPY', 'KRW', 'TWD', 'HKD', 'SGD', 'EUR', 'GBP', 'AUD', 'CAD', 'CHF', 'NZD', 'THB', 'VND', 'INR', 'AED', 'SAR', 'BRL', 'MXN', 'ZAR', 'USDT') NOT NULL,
    MODIFY `source` ENUM('exchange_rate_api', 'cny_fixed', 'combined_p2p', 'binance', 'okx', 'ecb_cross', 'manual', 'legacy_assumed_cny', 'opening_balance') NOT NULL;

-- AlterTable
ALTER TABLE `id_business_v2_finance_journals` MODIFY `journal_type` ENUM('supplier_deposit', 'supplier_refund', 'supplier_adjustment', 'gift_card_purchase', 'gift_card_redemption_loss', 'gift_card_withdrawal_pending', 'gift_card_refund_received', 'gift_card_refund_write_off', 'account_purchase', 'order_completed', 'bank_recharge_completed', 'order_refund', 'order_cancel', 'order_recovery', 'order_upgrade_balance_return', 'account_loss', 'expense', 'manual_operating_income', 'capital_contribution', 'borrowed_funds_received', 'opening_balance', 'fx_gain_loss', 'manual_adjustment', 'historical_backfill', 'reversal', 'fx_exchange') NOT NULL,
    MODIFY `source_type` ENUM('supplier_wallet', 'supplier_payment', 'gift_card', 'account', 'account_loss', 'order', 'bank_recharge', 'expense', 'inflow', 'opening_balance', 'historical_backfill', 'manual', 'fx_exchange') NOT NULL;

-- AlterTable
ALTER TABLE `id_business_v2_finance_journal_lines` MODIFY `account_code` ENUM('cash', 'supplier_prepayment', 'supplier_refund_receivable', 'gift_card_inventory', 'id_inventory', 'sales_revenue', 'bank_recharge_revenue', 'bank_recharge_service_fee', 'bank_recharge_cost', 'bank_recharge_bank_fee', 'other_operating_revenue', 'contributed_capital', 'borrowed_funds_payable', 'platform_fee', 'gift_card_cost', 'id_cost', 'customer_owned_balance_cost', 'refund_loss', 'gift_card_redemption_loss', 'balance_loss', 'id_purchase_loss', 'operating_expense', 'realized_fx_gain_loss', 'opening_equity', 'manual_adjustment', 'fx_exchange_fee', 'bank_recharge_usdt_fee', 'bank_recharge_shopping_fee') NOT NULL,
    MODIFY `currency` ENUM('CNY', 'MYR', 'USD', 'PHP', 'IDR', 'CLP', 'JPY', 'KRW', 'TWD', 'HKD', 'SGD', 'EUR', 'GBP', 'AUD', 'CAD', 'CHF', 'NZD', 'THB', 'VND', 'INR', 'AED', 'SAR', 'BRL', 'MXN', 'ZAR', 'USDT') NOT NULL;

-- AlterTable
ALTER TABLE `id_business_v2_finance_expenses` MODIFY `currency` ENUM('CNY', 'MYR', 'USD', 'PHP', 'IDR', 'CLP', 'JPY', 'KRW', 'TWD', 'HKD', 'SGD', 'EUR', 'GBP', 'AUD', 'CAD', 'CHF', 'NZD', 'THB', 'VND', 'INR', 'AED', 'SAR', 'BRL', 'MXN', 'ZAR', 'USDT') NOT NULL;

-- AlterTable
ALTER TABLE `id_business_v2_finance_inflows` MODIFY `currency` ENUM('CNY', 'MYR', 'USD', 'PHP', 'IDR', 'CLP', 'JPY', 'KRW', 'TWD', 'HKD', 'SGD', 'EUR', 'GBP', 'AUD', 'CAD', 'CHF', 'NZD', 'THB', 'VND', 'INR', 'AED', 'SAR', 'BRL', 'MXN', 'ZAR', 'USDT') NOT NULL;

-- AlterTable
ALTER TABLE `id_business_v2_orders` MODIFY `received_currency` ENUM('CNY', 'MYR', 'USD', 'PHP', 'IDR', 'CLP', 'JPY', 'KRW', 'TWD', 'HKD', 'SGD', 'EUR', 'GBP', 'AUD', 'CAD', 'CHF', 'NZD', 'THB', 'VND', 'INR', 'AED', 'SAR', 'BRL', 'MXN', 'ZAR', 'USDT') NOT NULL DEFAULT 'CNY';

-- AlterTable
ALTER TABLE `id_business_v2_bank_recharge_orders` ADD COLUMN `accounting_version` ENUM('legacy', 'subscription_cost_v2') NOT NULL DEFAULT 'legacy',
    ADD COLUMN `shopping_fee_amount` DECIMAL(18, 4) NULL,
    ADD COLUMN `shopping_fee_amount_cny` DECIMAL(18, 4) NULL,
    ADD COLUMN `shopping_fee_currency_code` ENUM('CNY', 'MYR', 'USD', 'PHP', 'IDR', 'CLP', 'JPY', 'KRW', 'TWD', 'HKD', 'SGD', 'EUR', 'GBP', 'AUD', 'CAD', 'CHF', 'NZD', 'THB', 'VND', 'INR', 'AED', 'SAR', 'BRL', 'MXN', 'ZAR', 'USDT') NULL,
    ADD COLUMN `shopping_fee_finance_account_id` CHAR(36) NULL,
    ADD COLUMN `shopping_fee_fx_rate_to_cny` DECIMAL(18, 8) NULL,
    ADD COLUMN `shopping_fee_fx_snapshot_id` CHAR(36) NULL,
    ADD COLUMN `usdt_fee_amount` DECIMAL(18, 4) NULL,
    ADD COLUMN `usdt_fee_amount_cny` DECIMAL(18, 4) NULL,
    ADD COLUMN `usdt_fee_currency_code` ENUM('CNY', 'MYR', 'USD', 'PHP', 'IDR', 'CLP', 'JPY', 'KRW', 'TWD', 'HKD', 'SGD', 'EUR', 'GBP', 'AUD', 'CAD', 'CHF', 'NZD', 'THB', 'VND', 'INR', 'AED', 'SAR', 'BRL', 'MXN', 'ZAR', 'USDT') NULL,
    ADD COLUMN `usdt_fee_finance_account_id` CHAR(36) NULL,
    ADD COLUMN `usdt_fee_fx_rate_to_cny` DECIMAL(18, 8) NULL,
    ADD COLUMN `usdt_fee_fx_snapshot_id` CHAR(36) NULL;

-- CreateTable
CREATE TABLE `id_business_v2_finance_exchanges` (
    `id` CHAR(36) NOT NULL,
    `journal_id` CHAR(36) NOT NULL,
    `source_account_id` CHAR(36) NOT NULL,
    `target_account_id` CHAR(36) NOT NULL,
    `source_account_name` VARCHAR(160) NOT NULL,
    `target_account_name` VARCHAR(160) NOT NULL,
    `source_currency` ENUM('CNY', 'MYR', 'USD', 'PHP', 'IDR', 'CLP', 'JPY', 'KRW', 'TWD', 'HKD', 'SGD', 'EUR', 'GBP', 'AUD', 'CAD', 'CHF', 'NZD', 'THB', 'VND', 'INR', 'AED', 'SAR', 'BRL', 'MXN', 'ZAR', 'USDT') NOT NULL,
    `target_currency` ENUM('CNY', 'MYR', 'USD', 'PHP', 'IDR', 'CLP', 'JPY', 'KRW', 'TWD', 'HKD', 'SGD', 'EUR', 'GBP', 'AUD', 'CAD', 'CHF', 'NZD', 'THB', 'VND', 'INR', 'AED', 'SAR', 'BRL', 'MXN', 'ZAR', 'USDT') NOT NULL,
    `source_amount` DECIMAL(18, 4) NOT NULL,
    `target_amount` DECIMAL(18, 4) NOT NULL,
    `fee_mode` ENUM('source_extra', 'target_deducted') NOT NULL,
    `fee_amount` DECIMAL(18, 4) NOT NULL,
    `total_debit` DECIMAL(18, 4) NOT NULL,
    `gross_target_amount` DECIMAL(18, 4) NOT NULL,
    `fee_percent` DECIMAL(28, 8) NOT NULL,
    `exchange_rate` DECIMAL(28, 8) NOT NULL,
    `effective_rate` DECIMAL(28, 8) NOT NULL,
    `source_fx_rate_to_cny` DECIMAL(18, 8) NOT NULL,
    `target_fx_rate_to_cny` DECIMAL(18, 8) NOT NULL,
    `source_fx_snapshot_id` CHAR(36) NULL,
    `target_fx_snapshot_id` CHAR(36) NULL,
    `fee_amount_cny` DECIMAL(18, 4) NOT NULL,
    `fx_gain_loss_cny` DECIMAL(18, 4) NOT NULL,
    `occurred_at` DATETIME(6) NOT NULL,
    `channel` VARCHAR(200) NULL,
    `remark` TEXT NULL,
    `correction_of_id` CHAR(36) NULL,
    `idempotency_key` VARCHAR(180) NOT NULL,
    `request_fingerprint` CHAR(64) NOT NULL,
    `created_by_user_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    UNIQUE INDEX `id_business_v2_finance_exchanges_journal_id_key`(`journal_id`),
    UNIQUE INDEX `id_business_v2_finance_exchanges_correction_of_id_key`(`correction_of_id`),
    UNIQUE INDEX `id_business_v2_finance_exchanges_idempotency_key_key`(`idempotency_key`),
    INDEX `id_business_v2_finance_exchanges_occurred_at_id_idx`(`occurred_at`, `id`),
    INDEX `id_business_v2_finance_exchanges_source_currency_occurred_at_idx`(`source_currency`, `occurred_at`),
    INDEX `id_business_v2_finance_exchanges_target_currency_occurred_at_idx`(`target_currency`, `occurred_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `id_business_v2_finance_exchanges` ADD CONSTRAINT `id_business_v2_finance_exchanges_journal_id_fkey` FOREIGN KEY (`journal_id`) REFERENCES `id_business_v2_finance_journals`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_finance_exchanges` ADD CONSTRAINT `id_business_v2_finance_exchanges_source_account_id_fkey` FOREIGN KEY (`source_account_id`) REFERENCES `id_business_v2_finance_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_finance_exchanges` ADD CONSTRAINT `id_business_v2_finance_exchanges_target_account_id_fkey` FOREIGN KEY (`target_account_id`) REFERENCES `id_business_v2_finance_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_finance_exchanges` ADD CONSTRAINT `id_business_v2_finance_exchanges_correction_of_id_fkey` FOREIGN KEY (`correction_of_id`) REFERENCES `id_business_v2_finance_exchanges`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;


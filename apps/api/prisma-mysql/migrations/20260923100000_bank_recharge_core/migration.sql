-- AlterTable
ALTER TABLE `id_business_v2_finance_journals` MODIFY `journal_type` ENUM('supplier_deposit', 'supplier_refund', 'supplier_adjustment', 'gift_card_purchase', 'gift_card_redemption_loss', 'gift_card_withdrawal_pending', 'gift_card_refund_received', 'gift_card_refund_write_off', 'account_purchase', 'order_completed', 'bank_recharge_completed', 'order_refund', 'order_cancel', 'order_recovery', 'order_upgrade_balance_return', 'account_loss', 'expense', 'manual_operating_income', 'capital_contribution', 'borrowed_funds_received', 'opening_balance', 'fx_gain_loss', 'manual_adjustment', 'historical_backfill', 'reversal') NOT NULL,
    MODIFY `source_type` ENUM('supplier_wallet', 'supplier_payment', 'gift_card', 'account', 'account_loss', 'order', 'bank_recharge', 'expense', 'inflow', 'opening_balance', 'historical_backfill', 'manual') NOT NULL;

-- AlterTable
ALTER TABLE `id_business_v2_finance_journal_lines` MODIFY `account_code` ENUM('cash', 'supplier_prepayment', 'supplier_refund_receivable', 'gift_card_inventory', 'id_inventory', 'sales_revenue', 'bank_recharge_revenue', 'bank_recharge_service_fee', 'bank_recharge_cost', 'bank_recharge_bank_fee', 'other_operating_revenue', 'contributed_capital', 'borrowed_funds_payable', 'platform_fee', 'gift_card_cost', 'id_cost', 'customer_owned_balance_cost', 'refund_loss', 'gift_card_redemption_loss', 'balance_loss', 'id_purchase_loss', 'operating_expense', 'realized_fx_gain_loss', 'opening_equity', 'manual_adjustment') NOT NULL;

-- AlterTable
ALTER TABLE `id_business_v2_recharge_jobs` ADD COLUMN `chatgpt_account_id` CHAR(36) NULL,
    ADD COLUMN `expected_email_encrypted` TEXT NULL;

-- CreateTable
CREATE TABLE `id_business_v2_chatgpt_accounts` (
    `id` CHAR(36) NOT NULL,
    `email_encrypted` TEXT NOT NULL,
    `email_hash` CHAR(64) NOT NULL,
    `email_masked` VARCHAR(255) NOT NULL,
    `official_account_key` CHAR(64) NULL,
    `password_encrypted` TEXT NULL,
    `totp_secret_encrypted` TEXT NULL,
    `totp_algorithm` ENUM('sha1', 'sha256', 'sha512') NOT NULL DEFAULT 'sha1',
    `totp_digits` INTEGER NOT NULL DEFAULT 6,
    `totp_period` INTEGER NOT NULL DEFAULT 30,
    `status` ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
    `remark` VARCHAR(500) NULL,
    `created_by_user_id` CHAR(36) NULL,
    `updated_by_user_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    UNIQUE INDEX `id_business_v2_chatgpt_accounts_email_hash_key`(`email_hash`),
    UNIQUE INDEX `id_business_v2_chatgpt_accounts_official_account_key_key`(`official_account_key`),
    INDEX `id_business_v2_chatgpt_accounts_status_updated_at_idx`(`status`, `updated_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_bank_recharge_currencies` (
    `code` CHAR(3) NOT NULL,
    `name` VARCHAR(80) NOT NULL,
    `minor_units` INTEGER NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `created_by_user_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `id_business_v2_bank_recharge_currencies_active_code_idx`(`active`, `code`),
    PRIMARY KEY (`code`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_bank_recharge_cards` (
    `id` CHAR(36) NOT NULL,
    `label` VARCHAR(80) NOT NULL,
    `last4` CHAR(4) NOT NULL,
    `currency_code` CHAR(3) NOT NULL,
    `active` BOOLEAN NOT NULL DEFAULT true,
    `created_by_user_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `id_business_v2_bank_recharge_cards_active_label_idx`(`active`, `label`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_bank_recharge_orders` (
    `id` CHAR(36) NOT NULL,
    `order_no` VARCHAR(40) NOT NULL,
    `source` ENUM('automatic', 'manual') NOT NULL,
    `recharge_job_id` VARCHAR(36) NULL,
    `checkout_identifier` VARCHAR(220) NULL,
    `payment_evidence_id` VARCHAR(220) NULL,
    `manual_evidence_ref` VARCHAR(220) NULL,
    `account_id` CHAR(36) NULL,
    `customer_id` CHAR(36) NULL,
    `card_id` CHAR(36) NULL,
    `card_last4` CHAR(4) NULL,
    `plan` VARCHAR(16) NOT NULL,
    `charge_amount` DECIMAL(18, 4) NOT NULL,
    `charge_currency_code` CHAR(3) NOT NULL,
    `customer_fee_rate` DECIMAL(9, 4) NOT NULL DEFAULT 0,
    `customer_fee_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `customer_fee_overridden` BOOLEAN NOT NULL DEFAULT false,
    `bank_fee_amount` DECIMAL(18, 4) NULL,
    `bank_fee_currency_code` CHAR(3) NULL,
    `received_amount` DECIMAL(18, 4) NULL,
    `received_currency_code` CHAR(3) NULL,
    `funding_finance_account_id` CHAR(36) NULL,
    `received_finance_account_id` CHAR(36) NULL,
    `charge_fx_rate_to_cny` DECIMAL(18, 8) NULL,
    `bank_fee_fx_rate_to_cny` DECIMAL(18, 8) NULL,
    `received_fx_rate_to_cny` DECIMAL(18, 8) NULL,
    `profit_amount_cny` DECIMAL(18, 4) NULL,
    `status` ENUM('pending_details', 'pending_finance', 'pending_receipt', 'completed', 'refunded', 'cancelled') NOT NULL DEFAULT 'pending_details',
    `finance_status` ENUM('unposted', 'partial', 'posted', 'reversed') NOT NULL DEFAULT 'unposted',
    `opened_at` DATETIME(6) NULL,
    `due_at` DATETIME(6) NULL,
    `verified_at` DATETIME(6) NULL,
    `renewed_from_order_id` CHAR(36) NULL,
    `remark` TEXT NULL,
    `created_by_user_id` CHAR(36) NULL,
    `updated_by_user_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    UNIQUE INDEX `id_business_v2_bank_recharge_orders_order_no_key`(`order_no`),
    UNIQUE INDEX `id_business_v2_bank_recharge_orders_recharge_job_id_key`(`recharge_job_id`),
    UNIQUE INDEX `id_business_v2_bank_recharge_orders_checkout_identifier_key`(`checkout_identifier`),
    UNIQUE INDEX `id_business_v2_bank_recharge_orders_payment_evidence_id_key`(`payment_evidence_id`),
    UNIQUE INDEX `id_business_v2_bank_recharge_orders_manual_evidence_ref_key`(`manual_evidence_ref`),
    UNIQUE INDEX `id_business_v2_bank_recharge_orders_renewed_from_order_id_key`(`renewed_from_order_id`),
    INDEX `id_business_v2_bank_recharge_orders_customer_id_created_at_idx`(`customer_id`, `created_at`),
    INDEX `id_business_v2_bank_recharge_orders_account_id_created_at_idx`(`account_id`, `created_at`),
    INDEX `id_business_v2_bank_recharge_orders_status_due_at_idx`(`status`, `due_at`),
    INDEX `id_business_v2_bank_recharge_orders_card_id_created_at_idx`(`card_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_bank_recharge_subscriptions` (
    `id` CHAR(36) NOT NULL,
    `account_id` CHAR(36) NOT NULL,
    `current_order_id` CHAR(36) NOT NULL,
    `customer_id` CHAR(36) NULL,
    `plan` VARCHAR(16) NOT NULL,
    `status` ENUM('active', 'expired', 'cancelled') NOT NULL DEFAULT 'active',
    `opened_at` DATETIME(6) NOT NULL,
    `due_at` DATETIME(6) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    UNIQUE INDEX `id_business_v2_bank_recharge_subscriptions_account_id_key`(`account_id`),
    UNIQUE INDEX `id_business_v2_bank_recharge_subscriptions_current_order_id_key`(`current_order_id`),
    INDEX `id_business_v2_bank_recharge_subscriptions_status_due_at_idx`(`status`, `due_at`),
    INDEX `id_business_v2_bank_recharge_subscriptions_customer_id_due_a_idx`(`customer_id`, `due_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateIndex
CREATE INDEX `id_business_v2_recharge_jobs_chatgpt_account_id_idx` ON `id_business_v2_recharge_jobs`(`chatgpt_account_id`);

-- AddForeignKey
ALTER TABLE `id_business_v2_recharge_jobs` ADD CONSTRAINT `id_business_v2_recharge_jobs_chatgpt_account_id_fkey` FOREIGN KEY (`chatgpt_account_id`) REFERENCES `id_business_v2_chatgpt_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_bank_recharge_cards` ADD CONSTRAINT `id_business_v2_bank_recharge_cards_currency_code_fkey` FOREIGN KEY (`currency_code`) REFERENCES `id_business_v2_bank_recharge_currencies`(`code`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_bank_recharge_orders` ADD CONSTRAINT `id_business_v2_bank_recharge_orders_recharge_job_id_fkey` FOREIGN KEY (`recharge_job_id`) REFERENCES `id_business_v2_recharge_jobs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_bank_recharge_orders` ADD CONSTRAINT `id_business_v2_bank_recharge_orders_account_id_fkey` FOREIGN KEY (`account_id`) REFERENCES `id_business_v2_chatgpt_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_bank_recharge_orders` ADD CONSTRAINT `id_business_v2_bank_recharge_orders_customer_id_fkey` FOREIGN KEY (`customer_id`) REFERENCES `id_business_v2_customers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_bank_recharge_orders` ADD CONSTRAINT `id_business_v2_bank_recharge_orders_card_id_fkey` FOREIGN KEY (`card_id`) REFERENCES `id_business_v2_bank_recharge_cards`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_bank_recharge_orders` ADD CONSTRAINT `id_business_v2_bank_recharge_orders_renewed_from_order_id_fkey` FOREIGN KEY (`renewed_from_order_id`) REFERENCES `id_business_v2_bank_recharge_orders`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_bank_recharge_subscriptions` ADD CONSTRAINT `id_business_v2_bank_recharge_subscriptions_account_id_fkey` FOREIGN KEY (`account_id`) REFERENCES `id_business_v2_chatgpt_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_bank_recharge_subscriptions` ADD CONSTRAINT `id_business_v2_bank_recharge_subscriptions_current_order_id_fkey` FOREIGN KEY (`current_order_id`) REFERENCES `id_business_v2_bank_recharge_orders`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_bank_recharge_subscriptions` ADD CONSTRAINT `id_business_v2_bank_recharge_subscriptions_customer_id_fkey` FOREIGN KEY (`customer_id`) REFERENCES `id_business_v2_customers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- 保留原自动充值支持的全部币种；以后从银充订单页面按执行器支持范围添加。
INSERT INTO `id_business_v2_bank_recharge_currencies`
  (`code`, `name`, `minor_units`, `active`, `created_at`, `updated_at`)
VALUES
  ('PHP', '菲律宾比索', 2, true, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6)),
  ('IDR', '印尼盾', 2, true, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6)),
  ('CLP', '智利比索', 0, true, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6)),
  ('USD', '美元', 2, true, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6)),
  ('MYR', '马来西亚令吉', 2, true, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6)),
  ('EUR', '欧元', 2, true, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6)),
  ('GBP', '英镑', 2, true, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6)),
  ('AUD', '澳大利亚元', 2, true, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6)),
  ('CAD', '加拿大元', 2, true, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6)),
  ('JPY', '日元', 0, true, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6)),
  ('KRW', '韩元', 0, true, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6)),
  ('SGD', '新加坡元', 2, true, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6)),
  ('INR', '印度卢比', 2, true, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6)),
  ('THB', '泰铢', 2, true, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6)),
  ('VND', '越南盾', 0, true, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6)),
  ('TWD', '新台币', 2, true, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6)),
  ('HKD', '港元', 2, true, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6)),
  ('BRL', '巴西雷亚尔', 2, true, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6)),
  ('MXN', '墨西哥比索', 2, true, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6)),
  ('AED', '阿联酋迪拉姆', 2, true, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6)),
  ('SAR', '沙特里亚尔', 2, true, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6)),
  ('ZAR', '南非兰特', 2, true, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6)),
  ('NZD', '新西兰元', 2, true, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6)),
  ('CHF', '瑞士法郎', 2, true, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6)),
  ('SEK', '瑞典克朗', 2, true, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6)),
  ('NOK', '挪威克朗', 2, true, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6)),
  ('DKK', '丹麦克朗', 2, true, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6)),
  ('PLN', '波兰兹罗提', 2, true, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6)),
  ('TRY', '土耳其里拉', 2, true, CURRENT_TIMESTAMP(6), CURRENT_TIMESTAMP(6));

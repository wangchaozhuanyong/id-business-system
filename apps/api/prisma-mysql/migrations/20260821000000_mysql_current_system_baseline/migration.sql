-- CreateTable
CREATE TABLE `mysql_transaction_locks` (
    `lock_key` VARCHAR(64) NOT NULL,
    `updated_at` DATETIME(6) NOT NULL,

    PRIMARY KEY (`lock_key`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `users` (
    `id` CHAR(36) NOT NULL,
    `username` VARCHAR(100) NOT NULL,
    `password_hash` VARCHAR(255) NOT NULL,
    `display_name` VARCHAR(100) NOT NULL,
    `phone_encrypted` TEXT NULL,
    `phone_masked` VARCHAR(80) NULL,
    `email` VARCHAR(255) NULL,
    `status` ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
    `last_login_at` DATETIME(6) NULL,
    `created_by_user_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,
    `deleted_at` DATETIME(6) NULL,

    UNIQUE INDEX `users_username_key`(`username`),
    INDEX `users_status_idx`(`status`),
    INDEX `users_created_by_user_id_idx`(`created_by_user_id`),
    INDEX `users_deleted_at_idx`(`deleted_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `login_logs` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NULL,
    `username` VARCHAR(100) NOT NULL,
    `status` ENUM('success', 'failed', 'blocked') NOT NULL,
    `failure_reason` TEXT NULL,
    `ip` VARCHAR(100) NULL,
    `user_agent` TEXT NULL,
    `location` VARCHAR(120) NULL,
    `abnormal` BOOLEAN NOT NULL DEFAULT false,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    INDEX `login_logs_user_id_idx`(`user_id`),
    INDEX `login_logs_username_idx`(`username`),
    INDEX `login_logs_ip_idx`(`ip`),
    INDEX `login_logs_abnormal_idx`(`abnormal`),
    INDEX `login_logs_created_at_idx`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `active_sessions` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `token_hash` VARCHAR(128) NOT NULL,
    `ip` VARCHAR(100) NULL,
    `user_agent` TEXT NULL,
    `last_active_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `expires_at` DATETIME(6) NOT NULL,
    `revoked_at` DATETIME(6) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    UNIQUE INDEX `active_sessions_token_hash_key`(`token_hash`),
    INDEX `active_sessions_user_id_idx`(`user_id`),
    INDEX `active_sessions_expires_at_idx`(`expires_at`),
    INDEX `active_sessions_revoked_at_idx`(`revoked_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `security_settings` (
    `id` CHAR(36) NOT NULL,
    `key` VARCHAR(120) NOT NULL,
    `value` JSON NOT NULL,
    `remark` TEXT NULL,
    `updated_by_user_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    UNIQUE INDEX `security_settings_key_key`(`key`),
    INDEX `security_settings_updated_by_user_id_idx`(`updated_by_user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `ip_whitelists` (
    `id` CHAR(36) NOT NULL,
    `ip_or_cidr` VARCHAR(100) NOT NULL,
    `scope` ENUM('admin', 'api') NOT NULL DEFAULT 'admin',
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `remark` TEXT NULL,
    `created_by_user_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `ip_whitelists_scope_enabled_idx`(`scope`, `enabled`),
    INDEX `ip_whitelists_created_by_user_id_idx`(`created_by_user_id`),
    UNIQUE INDEX `ip_whitelists_ip_or_cidr_scope_key`(`ip_or_cidr`, `scope`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sensitive_access_logs` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NULL,
    `module` VARCHAR(100) NOT NULL,
    `field_name` VARCHAR(120) NOT NULL,
    `object_type` VARCHAR(120) NOT NULL,
    `object_id` CHAR(36) NULL,
    `access_reason` TEXT NULL,
    `approved` BOOLEAN NOT NULL DEFAULT false,
    `ip` VARCHAR(100) NULL,
    `user_agent` TEXT NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    INDEX `sensitive_access_logs_user_id_idx`(`user_id`),
    INDEX `sensitive_access_logs_module_field_name_idx`(`module`, `field_name`),
    INDEX `sensitive_access_logs_object_type_object_id_idx`(`object_type`, `object_id`),
    INDEX `sensitive_access_logs_approved_idx`(`approved`),
    INDEX `sensitive_access_logs_created_at_idx`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `sensitive_access_approvals` (
    `id` CHAR(36) NOT NULL,
    `requester_id` CHAR(36) NOT NULL,
    `approver_id` CHAR(36) NULL,
    `module` VARCHAR(100) NOT NULL,
    `field_name` VARCHAR(120) NOT NULL,
    `object_type` VARCHAR(120) NOT NULL,
    `object_id` CHAR(36) NULL,
    `reason` TEXT NOT NULL,
    `status` ENUM('pending', 'approved', 'rejected', 'expired') NOT NULL DEFAULT 'pending',
    `decision_note` TEXT NULL,
    `approved_at` DATETIME(6) NULL,
    `expires_at` DATETIME(6) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `sensitive_access_approvals_requester_id_idx`(`requester_id`),
    INDEX `sensitive_access_approvals_approver_id_idx`(`approver_id`),
    INDEX `sensitive_access_approvals_module_field_name_idx`(`module`, `field_name`),
    INDEX `sensitive_access_approvals_status_idx`(`status`),
    INDEX `sensitive_access_approvals_expires_at_idx`(`expires_at`),
    INDEX `sensitive_access_approvals_created_at_idx`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_options` (
    `id` CHAR(36) NOT NULL,
    `type` ENUM('id_status', 'id_region', 'customer_source', 'customer_tag', 'country', 'business_category', 'service', 'id_supplier', 'topup_supplier', 'gift_card_name', 'settlement_platform', 'expense_category') NOT NULL,
    `code` VARCHAR(120) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `unique_key` VARCHAR(360) NOT NULL,
    `parent_id` CHAR(36) NULL,
    `country_option_id` CHAR(36) NULL,
    `business_amount` DECIMAL(18, 4) NULL,
    `currency_code` VARCHAR(3) NULL,
    `fixed_fee` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `percentage_fee` DECIMAL(9, 4) NOT NULL DEFAULT 0,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `status` ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
    `status_before_deletion` ENUM('active', 'disabled') NULL,
    `deleted_by_parent_option_id` CHAR(36) NULL,
    `is_system` BOOLEAN NOT NULL DEFAULT false,
    `remark` TEXT NULL,
    `created_by_user_id` CHAR(36) NULL,
    `updated_by_user_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,
    `deleted_at` DATETIME(6) NULL,

    UNIQUE INDEX `id_business_v2_options_unique_key_key`(`unique_key`),
    INDEX `id_business_v2_options_type_status_sort_order_idx`(`type`, `status`, `sort_order`),
    INDEX `id_business_v2_options_parent_id_idx`(`parent_id`),
    INDEX `id_business_v2_options_country_option_id_idx`(`country_option_id`),
    INDEX `id_business_v2_options_deleted_at_idx`(`deleted_at`),
    INDEX `id_business_v2_options_deleted_by_parent_option_id_idx`(`deleted_by_parent_option_id`),
    UNIQUE INDEX `id_business_v2_options_type_code_key`(`type`, `code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_customers` (
    `id` CHAR(36) NOT NULL,
    `name` VARCHAR(120) NOT NULL,
    `phone_encrypted` TEXT NULL,
    `phone_hash` VARCHAR(64) NULL,
    `phone_masked` VARCHAR(80) NULL,
    `phone_tail` VARCHAR(8) NULL,
    `phone_search_tokens` JSON NOT NULL,
    `wechat` VARCHAR(120) NULL,
    `wechat_encrypted` TEXT NULL,
    `wechat_hash` VARCHAR(64) NULL,
    `wechat_masked` VARCHAR(120) NULL,
    `wechat_search_tokens` JSON NOT NULL,
    `qq` VARCHAR(120) NULL,
    `qq_encrypted` TEXT NULL,
    `qq_hash` VARCHAR(64) NULL,
    `qq_masked` VARCHAR(120) NULL,
    `qq_search_tokens` JSON NOT NULL,
    `whatsapp_encrypted` TEXT NULL,
    `whatsapp_hash` VARCHAR(64) NULL,
    `whatsapp_masked` VARCHAR(80) NULL,
    `whatsapp_tail` VARCHAR(8) NULL,
    `whatsapp_search_tokens` JSON NOT NULL,
    `source_option_id` CHAR(36) NULL,
    `record_status` ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
    `remark` TEXT NULL,
    `created_by_user_id` CHAR(36) NULL,
    `updated_by_user_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,
    `deleted_at` DATETIME(6) NULL,

    INDEX `id_business_v2_customers_name_idx`(`name`),
    INDEX `id_business_v2_customers_phone_hash_idx`(`phone_hash`),
    INDEX `id_business_v2_customers_phone_tail_idx`(`phone_tail`),
    INDEX `id_business_v2_customers_wechat_hash_idx`(`wechat_hash`),
    INDEX `id_business_v2_customers_qq_hash_idx`(`qq_hash`),
    INDEX `id_business_v2_customers_whatsapp_hash_idx`(`whatsapp_hash`),
    INDEX `id_business_v2_customers_whatsapp_tail_idx`(`whatsapp_tail`),
    INDEX `id_business_v2_customers_source_option_id_idx`(`source_option_id`),
    INDEX `id_business_v2_customers_record_status_updated_at_idx`(`record_status`, `updated_at`),
    INDEX `id_business_v2_customers_deleted_at_idx`(`deleted_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_customer_tags` (
    `customer_id` CHAR(36) NOT NULL,
    `option_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    INDEX `id_business_v2_customer_tags_option_id_idx`(`option_id`),
    PRIMARY KEY (`customer_id`, `option_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_customer_services` (
    `customer_id` CHAR(36) NOT NULL,
    `option_id` CHAR(36) NOT NULL,
    `source` ENUM('manual_legacy', 'activation') NOT NULL DEFAULT 'manual_legacy',
    `first_opened_at` DATETIME(6) NULL,
    `last_opened_at` DATETIME(6) NULL,
    `activation_count` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    INDEX `id_business_v2_customer_services_option_id_idx`(`option_id`),
    INDEX `id_business_v2_customer_services_source_option_id_idx`(`source`, `option_id`),
    INDEX `id_business_v2_customer_services_customer_id_source_last_opened`(`customer_id`, `source`, `last_opened_at`),
    PRIMARY KEY (`customer_id`, `option_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_accounts` (
    `id` CHAR(36) NOT NULL,
    `apple_id_encrypted` TEXT NOT NULL,
    `apple_id_hash` VARCHAR(64) NOT NULL,
    `apple_id_masked` VARCHAR(255) NOT NULL,
    `apple_id_search_tokens` JSON NOT NULL,
    `password_encrypted` TEXT NULL,
    `phone_encrypted` TEXT NULL,
    `phone_hash` VARCHAR(64) NULL,
    `phone_masked` VARCHAR(80) NULL,
    `phone_tail` VARCHAR(8) NULL,
    `phone_search_tokens` JSON NOT NULL,
    `security_info_encrypted` TEXT NULL,
    `country_option_id` CHAR(36) NOT NULL,
    `status_option_id` CHAR(36) NOT NULL,
    `supplier_option_id` CHAR(36) NULL,
    `current_balance` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `balance_cost_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `purchase_cost` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `purchase_original_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `purchase_currency` ENUM('CNY', 'MYR', 'USD', 'USDT') NOT NULL DEFAULT 'CNY',
    `purchase_fx_rate_to_cny` DECIMAL(18, 8) NOT NULL DEFAULT 1,
    `purchase_fx_snapshot_id` CHAR(36) NULL,
    `purchase_finance_account_id` CHAR(36) NULL,
    `purchase_supplier_account_id` CHAR(36) NULL,
    `purchased_at` DATETIME(6) NULL,
    `sold_by_order_id` CHAR(36) NULL,
    `sold_at` DATETIME(6) NULL,
    `ownership_transferred_at` DATETIME(6) NULL,
    `loss_reported_at` DATETIME(6) NULL,
    `active_loss_record_id` CHAR(36) NULL,
    `record_status` ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
    `disabled_reason` TEXT NULL,
    `disabled_at` DATETIME(6) NULL,
    `remark` TEXT NULL,
    `created_by_user_id` CHAR(36) NULL,
    `updated_by_user_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,
    `deleted_at` DATETIME(6) NULL,

    UNIQUE INDEX `id_business_v2_accounts_apple_id_hash_key`(`apple_id_hash`),
    UNIQUE INDEX `id_business_v2_accounts_sold_by_order_id_key`(`sold_by_order_id`),
    UNIQUE INDEX `id_business_v2_accounts_active_loss_record_id_key`(`active_loss_record_id`),
    INDEX `id_business_v2_accounts_apple_id_masked_idx`(`apple_id_masked`),
    INDEX `id_business_v2_accounts_phone_hash_idx`(`phone_hash`),
    INDEX `id_business_v2_accounts_phone_tail_idx`(`phone_tail`),
    INDEX `id_business_v2_accounts_country_option_id_idx`(`country_option_id`),
    INDEX `id_business_v2_accounts_status_option_id_idx`(`status_option_id`),
    INDEX `id_business_v2_accounts_supplier_option_id_idx`(`supplier_option_id`),
    INDEX `id_business_v2_accounts_purchase_fx_snapshot_id_idx`(`purchase_fx_snapshot_id`),
    INDEX `id_business_v2_accounts_purchase_finance_account_id_idx`(`purchase_finance_account_id`),
    INDEX `id_business_v2_accounts_purchase_supplier_account_id_idx`(`purchase_supplier_account_id`),
    INDEX `id_business_v2_accounts_ownership_transferred_at_idx`(`ownership_transferred_at`),
    INDEX `id_business_v2_accounts_loss_reported_at_idx`(`loss_reported_at`),
    INDEX `id_business_v2_accounts_disabled_at_idx`(`disabled_at`),
    INDEX `id_business_v2_accounts_record_status_updated_at_idx`(`record_status`, `updated_at`),
    INDEX `id_business_v2_accounts_deleted_at_idx`(`deleted_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_gift_cards` (
    `id` CHAR(36) NOT NULL,
    `account_id` CHAR(36) NOT NULL,
    `card_name_option_id` CHAR(36) NOT NULL,
    `supplier_option_id` CHAR(36) NULL,
    `country_option_id` CHAR(36) NOT NULL,
    `card_name_snapshot` VARCHAR(160) NOT NULL,
    `country_name_snapshot` VARCHAR(160) NOT NULL,
    `currency_code_snapshot` VARCHAR(3) NULL,
    `supplier_name_snapshot` VARCHAR(160) NULL,
    `source_attachment_id` CHAR(36) NULL,
    `code_encrypted` TEXT NOT NULL,
    `code_hash` VARCHAR(64) NOT NULL,
    `code_masked` VARCHAR(80) NOT NULL,
    `code_tail` VARCHAR(8) NOT NULL,
    `code_search_tokens` JSON NOT NULL,
    `face_value` DECIMAL(18, 4) NOT NULL,
    `exchange_rate` DECIMAL(18, 8) NOT NULL,
    `exchange_rate_source` VARCHAR(40) NOT NULL DEFAULT 'manual_input',
    `exchange_rate_snapshot_id` CHAR(36) NULL,
    `exchange_rate_prefilled_value` DECIMAL(18, 8) NULL,
    `exchange_rate_was_overridden` BOOLEAN NOT NULL DEFAULT false,
    `cost_amount` DECIMAL(18, 4) NOT NULL,
    `purchase_original_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `purchase_currency` ENUM('CNY', 'MYR', 'USD', 'USDT') NOT NULL DEFAULT 'CNY',
    `purchase_fx_rate_to_cny` DECIMAL(18, 8) NOT NULL DEFAULT 1,
    `purchase_fx_snapshot_id` CHAR(36) NULL,
    `purchase_finance_account_id` CHAR(36) NULL,
    `purchase_supplier_account_id` CHAR(36) NULL,
    `paid_at` DATETIME(6) NULL,
    `supplier_refund_status` ENUM('none', 'pending', 'received', 'written_off') NOT NULL DEFAULT 'none',
    `supplier_refund_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `supplier_refund_amount_cny` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `supplier_refund_closed_at` DATETIME(6) NULL,
    `status` ENUM('credited', 'redeemed', 'withdrawn') NOT NULL,
    `status_changed_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `credited_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `remark` TEXT NULL,
    `created_by_user_id` CHAR(36) NULL,
    `updated_by_user_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    UNIQUE INDEX `id_business_v2_gift_cards_code_hash_key`(`code_hash`),
    INDEX `id_business_v2_gift_cards_account_id_created_at_idx`(`account_id`, `created_at`),
    INDEX `id_business_v2_gift_cards_account_id_credited_at_idx`(`account_id`, `credited_at`),
    INDEX `id_business_v2_gift_cards_card_name_option_id_credited_at_idx`(`card_name_option_id`, `credited_at`),
    INDEX `id_business_v2_gift_cards_supplier_option_id_idx`(`supplier_option_id`),
    INDEX `id_business_v2_gift_cards_country_option_id_created_at_idx`(`country_option_id`, `created_at`),
    INDEX `id_business_v2_gift_cards_country_option_id_credited_at_idx`(`country_option_id`, `credited_at`),
    INDEX `id_business_v2_gift_cards_source_attachment_id_idx`(`source_attachment_id`),
    INDEX `id_business_v2_gift_cards_exchange_rate_snapshot_id_idx`(`exchange_rate_snapshot_id`),
    INDEX `id_business_v2_gift_cards_purchase_fx_snapshot_id_idx`(`purchase_fx_snapshot_id`),
    INDEX `id_business_v2_gift_cards_purchase_finance_account_id_idx`(`purchase_finance_account_id`),
    INDEX `id_business_v2_gift_cards_purchase_supplier_account_id_idx`(`purchase_supplier_account_id`),
    INDEX `id_business_v2_gift_cards_supplier_refund_status_idx`(`supplier_refund_status`),
    INDEX `id_business_v2_gift_cards_status_status_changed_at_idx`(`status`, `status_changed_at`),
    INDEX `id_business_v2_gift_cards_created_by_user_id_idx`(`created_by_user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_topup_supplier_accounts` (
    `id` CHAR(36) NOT NULL,
    `supplier_option_id` CHAR(36) NOT NULL,
    `currency` ENUM('CNY', 'MYR', 'USD', 'USDT') NOT NULL DEFAULT 'CNY',
    `opening_balance` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `current_balance` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `opening_balance_cny` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `current_balance_cny` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `status` ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
    `disabled_by_option_deletion_at` DATETIME(6) NULL,
    `initialized_at` DATETIME(6) NULL,
    `initialized_by_user_id` CHAR(36) NULL,
    `updated_by_user_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `id_business_v2_topup_supplier_accounts_initialized_at_idx`(`initialized_at`),
    INDEX `id_business_v2_topup_supplier_accounts_status_idx`(`status`),
    INDEX `id_business_v2_topup_supplier_accounts_disabled_by_option_de_idx`(`disabled_by_option_deletion_at`),
    INDEX `id_business_v2_topup_supplier_accounts_current_balance_idx`(`current_balance`),
    INDEX `id_business_v2_topup_supplier_accounts_current_balance_cny_idx`(`current_balance_cny`),
    INDEX `id_business_v2_topup_supplier_accounts_updated_by_user_id_idx`(`updated_by_user_id`),
    UNIQUE INDEX `id_business_v2_topup_supplier_accounts_supplier_option_id_curre`(`supplier_option_id`, `currency`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_topup_supplier_payments` (
    `id` CHAR(36) NOT NULL,
    `supplier_account_id` CHAR(36) NOT NULL,
    `finance_account_id` CHAR(36) NULL,
    `fx_rate_snapshot_id` CHAR(36) NULL,
    `supplier_name_snapshot` VARCHAR(160) NOT NULL,
    `paid_currency` ENUM('CNY', 'MYR', 'USD', 'USDT') NOT NULL DEFAULT 'USDT',
    `paid_amount` DECIMAL(18, 4) NOT NULL,
    `network_fee_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `fx_rate_to_cny` DECIMAL(18, 8) NOT NULL,
    `credited_amount` DECIMAL(18, 4) NOT NULL,
    `credited_cny` DECIMAL(18, 4) NOT NULL,
    `received_usdt` DECIMAL(18, 4) NULL,
    `network_fee_usdt` DECIMAL(18, 4) NULL DEFAULT 0,
    `settlement_rate_cny_usdt` DECIMAL(18, 8) NULL,
    `network` VARCHAR(40) NULL,
    `transaction_hash` VARCHAR(180) NULL,
    `paid_at` DATETIME(6) NOT NULL,
    `remark` TEXT NULL,
    `idempotency_key` VARCHAR(160) NOT NULL,
    `created_by_user_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    UNIQUE INDEX `id_business_v2_topup_supplier_payments_idempotency_key_key`(`idempotency_key`),
    INDEX `id_business_v2_topup_supplier_payments_supplier_account_id_paid`(`supplier_account_id`, `paid_at`),
    INDEX `id_business_v2_topup_supplier_payments_finance_account_id_paid_`(`finance_account_id`, `paid_at`),
    INDEX `id_business_v2_topup_supplier_payments_fx_rate_snapshot_id_idx`(`fx_rate_snapshot_id`),
    INDEX `id_business_v2_topup_supplier_payments_transaction_hash_idx`(`transaction_hash`),
    INDEX `id_business_v2_topup_supplier_payments_created_by_user_id_idx`(`created_by_user_id`),
    INDEX `id_business_v2_topup_supplier_payments_created_at_idx`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_topup_supplier_ledger` (
    `id` CHAR(36) NOT NULL,
    `supplier_account_id` CHAR(36) NOT NULL,
    `payment_id` CHAR(36) NULL,
    `gift_card_id` CHAR(36) NULL,
    `entry_type` ENUM('opening_balance', 'payment_credit', 'gift_card_debit', 'id_purchase_debit', 'gift_card_withdrawal_reversal', 'supplier_refund', 'gift_card_refund_received', 'refund_write_off', 'manual_adjustment', 'payment_reversal') NOT NULL,
    `direction` ENUM('credit', 'debit', 'adjustment') NOT NULL,
    `currency` ENUM('CNY', 'MYR', 'USD', 'USDT') NOT NULL DEFAULT 'CNY',
    `amount` DECIMAL(18, 4) NOT NULL,
    `balance_before` DECIMAL(18, 4) NOT NULL,
    `balance_after` DECIMAL(18, 4) NOT NULL,
    `amount_cny` DECIMAL(18, 4) NOT NULL,
    `balance_before_cny` DECIMAL(18, 4) NOT NULL,
    `balance_after_cny` DECIMAL(18, 4) NOT NULL,
    `supplier_name_snapshot` VARCHAR(160) NOT NULL,
    `reversal_of_entry_id` CHAR(36) NULL,
    `idempotency_key` VARCHAR(160) NOT NULL,
    `reason` TEXT NULL,
    `created_by_user_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    UNIQUE INDEX `id_business_v2_topup_supplier_ledger_reversal_of_entry_id_key`(`reversal_of_entry_id`),
    UNIQUE INDEX `id_business_v2_topup_supplier_ledger_idempotency_key_key`(`idempotency_key`),
    INDEX `id_business_v2_topup_supplier_ledger_supplier_account_id_create`(`supplier_account_id`, `created_at`),
    INDEX `id_business_v2_topup_supplier_ledger_payment_id_idx`(`payment_id`),
    INDEX `id_business_v2_topup_supplier_ledger_gift_card_id_idx`(`gift_card_id`),
    INDEX `id_business_v2_topup_supplier_ledger_entry_type_created_at_idx`(`entry_type`, `created_at`),
    INDEX `id_business_v2_topup_supplier_ledger_created_by_user_id_idx`(`created_by_user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_finance_settings` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `base_currency` ENUM('CNY', 'MYR', 'USD', 'USDT') NOT NULL DEFAULT 'CNY',
    `timezone` VARCHAR(80) NOT NULL DEFAULT 'Asia/Shanghai',
    `enabled_at` DATETIME(6) NULL,
    `history_status` ENUM('not_started', 'in_progress', 'incomplete', 'completed') NOT NULL DEFAULT 'not_started',
    `history_completed_at` DATETIME(6) NULL,
    `history_note` TEXT NULL,
    `updated_by_user_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `id_business_v2_finance_settings_history_status_idx`(`history_status`),
    INDEX `id_business_v2_finance_settings_updated_by_user_id_idx`(`updated_by_user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_finance_accounts` (
    `id` CHAR(36) NOT NULL,
    `name` VARCHAR(160) NOT NULL,
    `account_type` ENUM('bank', 'cash', 'ewallet', 'usdt_wallet') NOT NULL,
    `currency` ENUM('CNY', 'MYR', 'USD', 'USDT') NOT NULL,
    `opening_balance` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `current_balance` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `opening_balance_cny` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `current_balance_cny` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `status` ENUM('active', 'disabled') NOT NULL DEFAULT 'active',
    `remark` TEXT NULL,
    `created_by_user_id` CHAR(36) NULL,
    `updated_by_user_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `id_business_v2_finance_accounts_currency_status_idx`(`currency`, `status`),
    INDEX `id_business_v2_finance_accounts_account_type_status_idx`(`account_type`, `status`),
    INDEX `id_business_v2_finance_accounts_created_by_user_id_idx`(`created_by_user_id`),
    INDEX `id_business_v2_finance_accounts_updated_by_user_id_idx`(`updated_by_user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_finance_fx_rate_snapshots` (
    `id` CHAR(36) NOT NULL,
    `currency` ENUM('CNY', 'MYR', 'USD', 'USDT') NOT NULL,
    `rate_to_cny` DECIMAL(18, 8) NOT NULL,
    `source` ENUM('cny_fixed', 'combined_p2p', 'binance', 'okx', 'ecb_cross', 'manual', 'legacy_assumed_cny', 'opening_balance') NOT NULL,
    `source_reference` VARCHAR(500) NULL,
    `source_evidence` JSON NULL,
    `business_date` DATE NOT NULL,
    `captured_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `expires_at` DATETIME(6) NULL,
    `manual_reason` TEXT NULL,
    `created_by_user_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    INDEX `id_business_v2_finance_fx_rate_snapshots_currency_business_date`(`currency`, `business_date`, `captured_at`),
    INDEX `id_business_v2_finance_fx_rate_snapshots_source_captured_at_idx`(`source`, `captured_at`),
    INDEX `id_business_v2_finance_fx_rate_snapshots_created_by_user_id_idx`(`created_by_user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_finance_journals` (
    `id` CHAR(36) NOT NULL,
    `journal_no` VARCHAR(40) NOT NULL,
    `journal_type` ENUM('supplier_deposit', 'supplier_refund', 'supplier_adjustment', 'gift_card_purchase', 'gift_card_redemption_loss', 'gift_card_withdrawal_pending', 'gift_card_refund_received', 'gift_card_refund_write_off', 'account_purchase', 'order_completed', 'order_refund', 'order_cancel', 'order_recovery', 'account_loss', 'expense', 'opening_balance', 'fx_gain_loss', 'manual_adjustment', 'historical_backfill', 'reversal') NOT NULL,
    `source_type` ENUM('supplier_wallet', 'supplier_payment', 'gift_card', 'account', 'account_loss', 'order', 'expense', 'opening_balance', 'historical_backfill', 'manual') NOT NULL,
    `source_id` VARCHAR(160) NULL,
    `source_reference` VARCHAR(200) NULL,
    `business_date` DATE NOT NULL,
    `period_month` VARCHAR(7) NOT NULL,
    `occurred_at` DATETIME(6) NOT NULL,
    `status` ENUM('posted', 'reversed') NOT NULL DEFAULT 'posted',
    `reversal_of_journal_id` CHAR(36) NULL,
    `reversed_at` DATETIME(6) NULL,
    `summary` VARCHAR(300) NOT NULL,
    `metadata` JSON NULL,
    `idempotency_key` VARCHAR(180) NOT NULL,
    `created_by_user_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    UNIQUE INDEX `id_business_v2_finance_journals_journal_no_key`(`journal_no`),
    UNIQUE INDEX `id_business_v2_finance_journals_reversal_of_journal_id_key`(`reversal_of_journal_id`),
    UNIQUE INDEX `id_business_v2_finance_journals_idempotency_key_key`(`idempotency_key`),
    INDEX `id_business_v2_finance_journals_journal_type_business_date_idx`(`journal_type`, `business_date`),
    INDEX `id_business_v2_finance_journals_source_type_source_id_idx`(`source_type`, `source_id`),
    INDEX `id_business_v2_finance_journals_period_month_status_idx`(`period_month`, `status`),
    INDEX `id_business_v2_finance_journals_status_occurred_at_idx`(`status`, `occurred_at`),
    INDEX `id_business_v2_finance_journals_created_by_user_id_idx`(`created_by_user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_finance_journal_lines` (
    `id` CHAR(36) NOT NULL,
    `journal_id` CHAR(36) NOT NULL,
    `line_no` INTEGER NOT NULL,
    `account_code` ENUM('cash', 'supplier_prepayment', 'supplier_refund_receivable', 'gift_card_inventory', 'id_inventory', 'sales_revenue', 'platform_fee', 'gift_card_cost', 'id_cost', 'customer_owned_balance_cost', 'refund_loss', 'gift_card_redemption_loss', 'balance_loss', 'id_purchase_loss', 'operating_expense', 'realized_fx_gain_loss', 'opening_equity', 'manual_adjustment') NOT NULL,
    `direction` ENUM('debit', 'credit') NOT NULL,
    `currency` ENUM('CNY', 'MYR', 'USD', 'USDT') NOT NULL,
    `amount_original` DECIMAL(18, 4) NOT NULL,
    `fx_rate_to_cny` DECIMAL(18, 8) NOT NULL,
    `amount_cny` DECIMAL(18, 4) NOT NULL,
    `finance_account_id` CHAR(36) NULL,
    `supplier_account_id` CHAR(36) NULL,
    `fx_rate_snapshot_id` CHAR(36) NULL,
    `memo` VARCHAR(300) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    INDEX `id_business_v2_finance_journal_lines_account_code_created_at_id`(`account_code`, `created_at`),
    INDEX `id_business_v2_finance_journal_lines_currency_created_at_idx`(`currency`, `created_at`),
    INDEX `id_business_v2_finance_journal_lines_finance_account_id_created`(`finance_account_id`, `created_at`),
    INDEX `id_business_v2_finance_journal_lines_supplier_account_id_create`(`supplier_account_id`, `created_at`),
    INDEX `id_business_v2_finance_journal_lines_fx_rate_snapshot_id_idx`(`fx_rate_snapshot_id`),
    UNIQUE INDEX `id_business_v2_finance_journal_lines_journal_id_line_no_key`(`journal_id`, `line_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_finance_expenses` (
    `id` CHAR(36) NOT NULL,
    `journal_id` CHAR(36) NOT NULL,
    `category_option_id` CHAR(36) NOT NULL,
    `category_name_snapshot` VARCHAR(160) NOT NULL,
    `finance_account_id` CHAR(36) NOT NULL,
    `finance_account_name_snapshot` VARCHAR(120) NOT NULL,
    `fx_rate_snapshot_id` CHAR(36) NULL,
    `currency` ENUM('CNY', 'MYR', 'USD', 'USDT') NOT NULL,
    `amount_original` DECIMAL(18, 4) NOT NULL,
    `fx_rate_to_cny` DECIMAL(18, 8) NOT NULL,
    `amount_cny` DECIMAL(18, 4) NOT NULL,
    `occurred_at` DATETIME(6) NOT NULL,
    `payee` VARCHAR(200) NULL,
    `receipt_attachment_id` CHAR(36) NULL,
    `remark` TEXT NULL,
    `idempotency_key` VARCHAR(180) NOT NULL,
    `created_by_user_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    UNIQUE INDEX `id_business_v2_finance_expenses_journal_id_key`(`journal_id`),
    UNIQUE INDEX `id_business_v2_finance_expenses_idempotency_key_key`(`idempotency_key`),
    INDEX `id_business_v2_finance_expenses_category_option_id_occurred_at_`(`category_option_id`, `occurred_at`),
    INDEX `id_business_v2_finance_expenses_finance_account_id_occurred_at_`(`finance_account_id`, `occurred_at`),
    INDEX `id_business_v2_finance_expenses_currency_occurred_at_idx`(`currency`, `occurred_at`),
    INDEX `id_business_v2_finance_expenses_fx_rate_snapshot_id_idx`(`fx_rate_snapshot_id`),
    INDEX `id_business_v2_finance_expenses_receipt_attachment_id_idx`(`receipt_attachment_id`),
    INDEX `id_business_v2_finance_expenses_created_by_user_id_idx`(`created_by_user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_finance_periods` (
    `month` VARCHAR(7) NOT NULL,
    `status` ENUM('open', 'closed', 'reopened') NOT NULL DEFAULT 'open',
    `closed_at` DATETIME(6) NULL,
    `closed_by_user_id` CHAR(36) NULL,
    `reopen_reason` TEXT NULL,
    `reopened_at` DATETIME(6) NULL,
    `reopened_by_user_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `id_business_v2_finance_periods_status_month_idx`(`status`, `month`),
    INDEX `id_business_v2_finance_periods_closed_by_user_id_idx`(`closed_by_user_id`),
    INDEX `id_business_v2_finance_periods_reopened_by_user_id_idx`(`reopened_by_user_id`),
    PRIMARY KEY (`month`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_balance_ledger` (
    `id` CHAR(36) NOT NULL,
    `account_id` CHAR(36) NOT NULL,
    `gift_card_id` CHAR(36) NULL,
    `order_id` CHAR(36) NULL,
    `entry_type` ENUM('gift_card_credit', 'gift_card_redeemed', 'gift_card_withdrawal', 'order_consumption', 'order_consumption_reversal', 'opening_balance', 'manual_adjustment', 'account_loss') NOT NULL,
    `direction` ENUM('credit', 'debit', 'adjustment') NOT NULL,
    `balance_amount` DECIMAL(18, 4) NOT NULL,
    `cost_amount` DECIMAL(18, 4) NOT NULL,
    `balance_before` DECIMAL(18, 4) NOT NULL,
    `balance_after` DECIMAL(18, 4) NOT NULL,
    `cost_before` DECIMAL(18, 4) NOT NULL,
    `cost_after` DECIMAL(18, 4) NOT NULL,
    `average_cost_before` DECIMAL(18, 8) NOT NULL,
    `average_cost_after` DECIMAL(18, 8) NOT NULL,
    `reversal_of_entry_id` CHAR(36) NULL,
    `idempotency_key` VARCHAR(160) NOT NULL,
    `remark` TEXT NULL,
    `created_by_user_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    UNIQUE INDEX `id_business_v2_balance_ledger_reversal_of_entry_id_key`(`reversal_of_entry_id`),
    UNIQUE INDEX `id_business_v2_balance_ledger_idempotency_key_key`(`idempotency_key`),
    INDEX `id_business_v2_balance_ledger_account_id_created_at_idx`(`account_id`, `created_at`),
    INDEX `id_business_v2_balance_ledger_gift_card_id_idx`(`gift_card_id`),
    INDEX `id_business_v2_balance_ledger_order_id_idx`(`order_id`),
    INDEX `id_business_v2_balance_ledger_entry_type_created_at_idx`(`entry_type`, `created_at`),
    INDEX `id_business_v2_balance_ledger_direction_created_at_idx`(`direction`, `created_at`),
    INDEX `id_business_v2_balance_ledger_created_by_user_id_idx`(`created_by_user_id`),
    UNIQUE INDEX `id_business_v2_balance_ledger_gift_card_id_entry_type_key`(`gift_card_id`, `entry_type`),
    UNIQUE INDEX `id_business_v2_balance_ledger_order_id_entry_type_key`(`order_id`, `entry_type`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_account_losses` (
    `id` CHAR(36) NOT NULL,
    `account_id` CHAR(36) NOT NULL,
    `ledger_entry_id` CHAR(36) NOT NULL,
    `status` ENUM('active', 'reversed') NOT NULL DEFAULT 'active',
    `apple_id_masked` VARCHAR(255) NOT NULL,
    `country_option_id` CHAR(36) NOT NULL,
    `country_name` VARCHAR(160) NOT NULL,
    `currency_code` VARCHAR(3) NULL,
    `supplier_option_id` CHAR(36) NULL,
    `supplier_name` VARCHAR(160) NULL,
    `sale_state` ENUM('available', 'sold') NOT NULL,
    `sold_order_id` CHAR(36) NULL,
    `sold_order_no` VARCHAR(40) NULL,
    `loss_balance` DECIMAL(18, 4) NOT NULL,
    `loss_cost_amount` DECIMAL(18, 4) NOT NULL,
    `id_purchase_cost_loss_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `reason` TEXT NOT NULL,
    `idempotency_key` VARCHAR(160) NOT NULL,
    `reported_by_user_id` CHAR(36) NULL,
    `reported_by_name` VARCHAR(160) NULL,
    `reported_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `previous_status_option_id` CHAR(36) NULL,
    `previous_status_name` VARCHAR(160) NULL,
    `previous_record_status` ENUM('active', 'disabled') NULL,
    `finance_journal_id` CHAR(36) NULL,
    `reversal_finance_journal_id` CHAR(36) NULL,
    `reversed_by_user_id` CHAR(36) NULL,
    `reversed_by_name` VARCHAR(160) NULL,
    `reversal_reason` TEXT NULL,
    `reversed_at` DATETIME(6) NULL,

    UNIQUE INDEX `id_business_v2_account_losses_ledger_entry_id_key`(`ledger_entry_id`),
    UNIQUE INDEX `id_business_v2_account_losses_idempotency_key_key`(`idempotency_key`),
    UNIQUE INDEX `id_business_v2_account_losses_finance_journal_id_key`(`finance_journal_id`),
    UNIQUE INDEX `id_business_v2_account_losses_reversal_finance_journal_id_key`(`reversal_finance_journal_id`),
    INDEX `id_business_v2_account_losses_account_id_idx`(`account_id`),
    INDEX `id_business_v2_account_losses_status_reported_at_idx`(`status`, `reported_at`),
    INDEX `id_business_v2_account_losses_reported_at_idx`(`reported_at`),
    INDEX `id_business_v2_account_losses_country_option_id_reported_at_idx`(`country_option_id`, `reported_at`),
    INDEX `id_business_v2_account_losses_country_name_idx`(`country_name`),
    INDEX `id_business_v2_account_losses_sale_state_reported_at_idx`(`sale_state`, `reported_at`),
    INDEX `id_business_v2_account_losses_sold_order_id_idx`(`sold_order_id`),
    INDEX `id_business_v2_account_losses_sold_order_no_idx`(`sold_order_no`),
    INDEX `id_business_v2_account_losses_reported_by_user_id_idx`(`reported_by_user_id`),
    INDEX `id_business_v2_account_losses_reversed_by_user_id_idx`(`reversed_by_user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_orders` (
    `id` CHAR(36) NOT NULL,
    `order_no` VARCHAR(40) NOT NULL,
    `customer_id` CHAR(36) NOT NULL,
    `service_option_id` CHAR(36) NOT NULL,
    `account_id` CHAR(36) NULL,
    `settlement_platform_option_id` CHAR(36) NULL,
    `platform_order_no` VARCHAR(160) NULL,
    `website_account_encrypted` TEXT NULL,
    `website_account_hash` VARCHAR(64) NULL,
    `website_account_masked` VARCHAR(255) NULL,
    `website_account_search_tokens` JSON NOT NULL,
    `received_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `received_original_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `received_currency` ENUM('CNY', 'MYR', 'USD', 'USDT') NOT NULL DEFAULT 'CNY',
    `received_fx_rate_to_cny` DECIMAL(18, 8) NOT NULL DEFAULT 1,
    `received_fx_snapshot_id` CHAR(36) NULL,
    `received_finance_account_id` CHAR(36) NULL,
    `received_at` DATETIME(6) NULL,
    `platform_fee_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `account_cost_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `applied_account_cost_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `account_source` ENUM('inventory', 'customer_owned') NOT NULL DEFAULT 'inventory',
    `source_sold_order_id` CHAR(36) NULL,
    `account_disposition` ENUM('retained', 'sold', 'recovered') NOT NULL DEFAULT 'retained',
    `balance_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `balance_cost_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `transferred_balance_cost_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `applied_balance_cost_amount` DECIMAL(18, 4) NOT NULL DEFAULT 0,
    `refund_cost_amount` DECIMAL(18, 4) NULL,
    `profit_amount` DECIMAL(18, 4) NULL,
    `status` ENUM('draft', 'pending', 'waiting_external', 'processing', 'completed', 'refunded', 'cancelled', 'failed') NOT NULL DEFAULT 'draft',
    `status_changed_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `opened_at` DATETIME(6) NULL,
    `due_at` DATETIME(6) NULL,
    `idempotency_key` VARCHAR(160) NOT NULL,
    `remark` TEXT NULL,
    `created_by_user_id` CHAR(36) NULL,
    `updated_by_user_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,
    `deleted_at` DATETIME(6) NULL,

    UNIQUE INDEX `id_business_v2_orders_order_no_key`(`order_no`),
    UNIQUE INDEX `id_business_v2_orders_idempotency_key_key`(`idempotency_key`),
    INDEX `id_business_v2_orders_customer_id_idx`(`customer_id`),
    INDEX `id_business_v2_orders_service_option_id_idx`(`service_option_id`),
    INDEX `id_business_v2_orders_account_id_idx`(`account_id`),
    INDEX `id_business_v2_orders_account_disposition_idx`(`account_disposition`),
    INDEX `id_business_v2_orders_account_source_status_status_changed_a_idx`(`account_source`, `status`, `status_changed_at`),
    INDEX `id_business_v2_orders_source_sold_order_id_idx`(`source_sold_order_id`),
    INDEX `id_business_v2_orders_settlement_platform_option_id_idx`(`settlement_platform_option_id`),
    INDEX `id_business_v2_orders_website_account_hash_idx`(`website_account_hash`),
    INDEX `id_business_v2_orders_received_fx_snapshot_id_idx`(`received_fx_snapshot_id`),
    INDEX `id_business_v2_orders_received_finance_account_id_idx`(`received_finance_account_id`),
    INDEX `id_business_v2_orders_status_status_changed_at_idx`(`status`, `status_changed_at`),
    INDEX `id_business_v2_orders_opened_at_idx`(`opened_at`),
    INDEX `id_business_v2_orders_due_at_idx`(`due_at`),
    INDEX `id_business_v2_orders_created_by_user_id_idx`(`created_by_user_id`),
    INDEX `id_business_v2_orders_deleted_at_idx`(`deleted_at`),
    UNIQUE INDEX `id_business_v2_orders_platform_order_key`(`settlement_platform_option_id`, `platform_order_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_order_display_snapshots` (
    `order_id` CHAR(36) NOT NULL,
    `customer_name` VARCHAR(120) NOT NULL,
    `service_name` VARCHAR(160) NOT NULL,
    `service_category_name` VARCHAR(160) NULL,
    `account_label` VARCHAR(255) NULL,
    `account_country_name` VARCHAR(160) NULL,
    `settlement_platform_name` VARCHAR(160) NULL,
    `captured_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    INDEX `id_business_v2_order_display_snapshots_captured_at_idx`(`captured_at`),
    PRIMARY KEY (`order_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_account_locks` (
    `id` CHAR(36) NOT NULL,
    `account_id` CHAR(36) NOT NULL,
    `service_option_id` CHAR(36) NULL,
    `order_id` CHAR(36) NOT NULL,
    `lock_scope` ENUM('by_service', 'global') NOT NULL DEFAULT 'by_service',
    `status` ENUM('active', 'released', 'expired') NOT NULL DEFAULT 'active',
    `lock_token` VARCHAR(64) NOT NULL,
    `reason` TEXT NULL,
    `locked_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `expires_at` DATETIME(6) NOT NULL,
    `ended_at` DATETIME(6) NULL,
    `end_reason` TEXT NULL,
    `created_by_user_id` CHAR(36) NULL,
    `ended_by_user_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    UNIQUE INDEX `id_business_v2_account_locks_lock_token_key`(`lock_token`),
    INDEX `id_business_v2_account_locks_account_id_status_idx`(`account_id`, `status`),
    INDEX `id_business_v2_account_locks_service_option_id_status_idx`(`service_option_id`, `status`),
    INDEX `id_business_v2_account_locks_order_id_status_idx`(`order_id`, `status`),
    INDEX `id_business_v2_account_locks_lock_scope_status_idx`(`lock_scope`, `status`),
    INDEX `id_business_v2_account_locks_expires_at_status_idx`(`expires_at`, `status`),
    INDEX `id_business_v2_account_locks_created_by_user_id_idx`(`created_by_user_id`),
    INDEX `id_business_v2_account_locks_ended_by_user_id_idx`(`ended_by_user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_activations` (
    `id` CHAR(36) NOT NULL,
    `order_id` CHAR(36) NOT NULL,
    `renewed_from_activation_id` CHAR(36) NULL,
    `customer_id` CHAR(36) NOT NULL,
    `account_id` CHAR(36) NOT NULL,
    `service_option_id` CHAR(36) NOT NULL,
    `opened_at` DATETIME(6) NOT NULL,
    `due_at` DATETIME(6) NULL,
    `status` ENUM('active', 'expired', 'cancelled', 'abnormal') NOT NULL DEFAULT 'active',
    `status_changed_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `auto_renewal_status` ENUM('unknown', 'enabled', 'disabled') NOT NULL DEFAULT 'unknown',
    `auto_renewal_changed_at` DATETIME(6) NULL,
    `remark` TEXT NULL,
    `created_by_user_id` CHAR(36) NULL,
    `updated_by_user_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    UNIQUE INDEX `id_business_v2_activations_order_id_key`(`order_id`),
    UNIQUE INDEX `id_business_v2_activations_renewed_from_activation_id_key`(`renewed_from_activation_id`),
    INDEX `id_business_v2_activations_customer_id_idx`(`customer_id`),
    INDEX `id_business_v2_activations_account_id_idx`(`account_id`),
    INDEX `id_business_v2_activations_service_option_id_idx`(`service_option_id`),
    INDEX `id_business_v2_activations_status_due_at_idx`(`status`, `due_at`),
    INDEX `id_business_v2_activations_opened_at_idx`(`opened_at`),
    INDEX `id_business_v2_activations_created_by_user_id_idx`(`created_by_user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_renewal_warning_settings` (
    `id` CHAR(36) NOT NULL,
    `scope` VARCHAR(32) NOT NULL DEFAULT 'global',
    `warning_days` INTEGER NOT NULL DEFAULT 3,
    `updated_by_user_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    UNIQUE INDEX `id_business_v2_renewal_warning_settings_scope_key`(`scope`),
    INDEX `id_business_v2_renewal_warning_settings_updated_by_user_id_idx`(`updated_by_user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_exchange_rate_runs` (
    `id` CHAR(36) NOT NULL,
    `status` ENUM('running', 'success', 'failed') NOT NULL DEFAULT 'running',
    `trigger_type` ENUM('manual', 'scheduled', 'system') NOT NULL,
    `asset` VARCHAR(16) NOT NULL DEFAULT 'USDT',
    `fiat` VARCHAR(16) NOT NULL DEFAULT 'CNY',
    `target_amount_rmb` DECIMAL(18, 2) NULL,
    `started_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `finished_at` DATETIME(6) NULL,
    `policy_min_completed_order_count` INTEGER NULL,
    `policy_min_completion_rate` DECIMAL(9, 8) NULL,
    `policy_max_price_deviation_rate` DECIMAL(9, 8) NULL,
    `policy_min_valid_ads_per_side` INTEGER NULL,
    `policy_decimal_places` INTEGER NULL,
    `error_code` VARCHAR(120) NULL,
    `error_message` TEXT NULL,
    `error_provider` ENUM('binance', 'okx', 'multiple', 'system') NULL,
    `error_side` ENUM('merchant_buy', 'merchant_sell') NULL,
    `error_retryable` BOOLEAN NULL,
    `error_details` JSON NULL,
    `triggered_by_user_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    INDEX `id_business_v2_exchange_rate_runs_status_started_at_idx`(`status`, `started_at`),
    INDEX `id_business_v2_exchange_rate_runs_trigger_type_started_at_idx`(`trigger_type`, `started_at`),
    INDEX `id_business_v2_exchange_rate_runs_triggered_by_user_id_idx`(`triggered_by_user_id`),
    INDEX `id_business_v2_exchange_rate_runs_created_at_idx`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_exchange_rate_entries` (
    `id` CHAR(36) NOT NULL,
    `binance_merchant_buy_rate_to_rmb` DECIMAL(18, 8) NOT NULL,
    `binance_merchant_sell_rate_to_rmb` DECIMAL(18, 8) NOT NULL,
    `okx_merchant_buy_rate_to_rmb` DECIMAL(18, 8) NOT NULL,
    `okx_merchant_sell_rate_to_rmb` DECIMAL(18, 8) NOT NULL,
    `combined_merchant_buy_average_rate_to_rmb` DECIMAL(18, 8) NOT NULL,
    `combined_merchant_sell_average_rate_to_rmb` DECIMAL(18, 8) NOT NULL,
    `mid_rate_to_rmb` DECIMAL(18, 8) NOT NULL,
    `recorded_at` DATETIME(6) NOT NULL,
    `remark` TEXT NULL,
    `created_by_user_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    INDEX `id_business_v2_exchange_rate_entries_recorded_at_idx`(`recorded_at`),
    INDEX `id_business_v2_exchange_rate_entries_created_by_user_id_idx`(`created_by_user_id`),
    INDEX `id_business_v2_exchange_rate_entries_created_at_idx`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_exchange_rate_snapshots` (
    `id` CHAR(36) NOT NULL,
    `run_id` CHAR(36) NOT NULL,
    `asset` VARCHAR(16) NOT NULL,
    `fiat` VARCHAR(16) NOT NULL,
    `averaged_at` DATETIME(6) NOT NULL,
    `combined_merchant_buy_average_rate_to_rmb` DECIMAL(18, 8) NOT NULL,
    `combined_merchant_sell_average_rate_to_rmb` DECIMAL(18, 8) NOT NULL,
    `mid_rate_to_rmb` DECIMAL(18, 8) NOT NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    UNIQUE INDEX `id_business_v2_exchange_rate_snapshots_run_id_key`(`run_id`),
    INDEX `id_business_v2_exchange_rate_snapshots_averaged_at_idx`(`averaged_at`),
    INDEX `id_business_v2_exchange_rate_snapshots_created_at_idx`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_exchange_rate_settings` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `auto_enabled` BOOLEAN NOT NULL DEFAULT true,
    `interval_minutes` INTEGER NOT NULL DEFAULT 30,
    `target_amount_rmb` DECIMAL(18, 2) NOT NULL DEFAULT 5000,
    `retention_days` INTEGER NOT NULL DEFAULT 30,
    `next_run_at` DATETIME(6) NULL,
    `updated_by_user_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `id_business_v2_exchange_rate_settings_next_run_at_idx`(`next_run_at`),
    INDEX `id_business_v2_exchange_rate_settings_updated_by_user_id_idx`(`updated_by_user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_purchase_currencies` (
    `code` VARCHAR(3) NOT NULL,
    `name_cn` VARCHAR(50) NOT NULL,
    `display_name` VARCHAR(100) NULL,
    `purchase_ratio` DECIMAL(12, 8) NOT NULL,
    `quote_unit` DECIMAL(18, 8) NOT NULL DEFAULT 1,
    `decimal_places` INTEGER NOT NULL DEFAULT 4,
    `rounding_mode` ENUM('ROUND_DOWN', 'ROUND_HALF_UP', 'ROUND_UP') NOT NULL DEFAULT 'ROUND_DOWN',
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `updated_by_user_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `id_business_v2_purchase_currencies_enabled_sort_order_idx`(`enabled`, `sort_order`),
    INDEX `id_business_v2_purchase_currencies_updated_by_user_id_idx`(`updated_by_user_id`),
    PRIMARY KEY (`code`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_purchase_rate_settings` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `auto_enabled` BOOLEAN NOT NULL DEFAULT true,
    `interval_minutes` INTEGER NOT NULL DEFAULT 60,
    `stale_minutes` INTEGER NOT NULL DEFAULT 120,
    `abnormal_change_rate` DECIMAL(9, 8) NOT NULL DEFAULT 0.1,
    `next_run_at` DATETIME(6) NULL,
    `updated_by_user_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `id_business_v2_purchase_rate_settings_next_run_at_idx`(`next_run_at`),
    INDEX `id_business_v2_purchase_rate_settings_updated_by_user_id_idx`(`updated_by_user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_purchase_rate_fetch_runs` (
    `id` CHAR(36) NOT NULL,
    `status` ENUM('running', 'success', 'failed', 'pending_review', 'rejected') NOT NULL DEFAULT 'running',
    `trigger_type` ENUM('manual', 'scheduled', 'system') NOT NULL,
    `provider` ENUM('manual', 'currencyapi') NOT NULL DEFAULT 'currencyapi',
    `base_currency` VARCHAR(3) NOT NULL DEFAULT 'CNY',
    `requested_currency_codes` JSON NOT NULL,
    `abnormal_currency_codes` JSON NOT NULL,
    `started_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `finished_at` DATETIME(6) NULL,
    `provider_updated_at` DATETIME(6) NULL,
    `published_at` DATETIME(6) NULL,
    `attempt_count` INTEGER NOT NULL DEFAULT 0,
    `source_contract` VARCHAR(120) NULL,
    `source_reference` VARCHAR(500) NULL,
    `candidate_quotes` JSON NULL,
    `maximum_change_rate` DECIMAL(26, 8) NULL,
    `error_code` VARCHAR(120) NULL,
    `error_message` TEXT NULL,
    `error_retryable` BOOLEAN NULL,
    `triggered_by_user_id` CHAR(36) NULL,
    `reviewed_by_user_id` CHAR(36) NULL,
    `reviewed_at` DATETIME(6) NULL,
    `review_remark` VARCHAR(500) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    INDEX `id_business_v2_purchase_rate_fetch_runs_status_started_at_idx`(`status`, `started_at`),
    INDEX `id_business_v2_purchase_rate_fetch_runs_trigger_type_started_idx`(`trigger_type`, `started_at`),
    INDEX `id_business_v2_purchase_rate_fetch_runs_triggered_by_user_id_idx`(`triggered_by_user_id`),
    INDEX `id_business_v2_purchase_rate_fetch_runs_reviewed_by_user_id_idx`(`reviewed_by_user_id`),
    INDEX `id_business_v2_purchase_rate_fetch_runs_created_at_idx`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_purchase_rate_snapshots` (
    `id` CHAR(36) NOT NULL,
    `currency_code` VARCHAR(3) NOT NULL,
    `market_rate_cny_per_unit` DECIMAL(18, 8) NOT NULL,
    `purchase_ratio` DECIMAL(12, 8) NOT NULL,
    `quote_unit` DECIMAL(18, 8) NOT NULL,
    `purchase_rate_raw` DECIMAL(18, 8) NOT NULL,
    `purchase_rate_display` DECIMAL(18, 8) NOT NULL,
    `decimal_places` INTEGER NOT NULL,
    `rounding_mode` ENUM('ROUND_DOWN', 'ROUND_HALF_UP', 'ROUND_UP') NOT NULL,
    `market_rate_source` ENUM('manual', 'currencyapi') NOT NULL DEFAULT 'manual',
    `market_rate_source_reference` VARCHAR(500) NULL,
    `market_rate_captured_at` DATETIME(6) NOT NULL,
    `fetch_run_id` CHAR(36) NULL,
    `change_rate` DECIMAL(26, 8) NULL,
    `validation_status` ENUM('normal', 'confirmed_abnormal') NOT NULL DEFAULT 'normal',
    `created_by_user_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    INDEX `id_business_v2_purchase_rate_snapshots_currency_code_created_idx`(`currency_code`, `created_at`),
    INDEX `id_business_v2_purchase_rate_snapshots_market_rate_captured__idx`(`market_rate_captured_at`),
    INDEX `id_business_v2_purchase_rate_snapshots_fetch_run_id_idx`(`fetch_run_id`),
    INDEX `id_business_v2_purchase_rate_snapshots_created_by_user_id_idx`(`created_by_user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_branding_settings` (
    `id` INTEGER NOT NULL DEFAULT 1,
    `app_name` VARCHAR(80) NOT NULL DEFAULT 'ID 业务管理',
    `logo_text` VARCHAR(12) NOT NULL DEFAULT 'ID',
    `logo_url` VARCHAR(2048) NOT NULL DEFAULT '/brand/default-logo.svg',
    `app_subtitle` VARCHAR(120) NOT NULL DEFAULT 'Apple ID 订阅运营',
    `login_hero_title` VARCHAR(160) NOT NULL DEFAULT '把订单、余额与续费
收进一条安全动线',
    `login_note` VARCHAR(180) NOT NULL DEFAULT '内部后台仅限授权人员访问，登录后继续处理订单与财务任务。',
    `footer_text` VARCHAR(160) NOT NULL DEFAULT '© 2026 Apple 内部系统 · 仅限授权人员访问',
    `document_title_suffix` VARCHAR(80) NOT NULL DEFAULT 'ID 业务管理',
    `updated_by_user_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `id_business_v2_branding_settings_updated_by_user_id_idx`(`updated_by_user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_user_table_preferences` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `table_id` VARCHAR(120) NOT NULL,
    `hidden_column_keys` JSON NOT NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `id_business_v2_user_table_preferences_user_id_idx`(`user_id`),
    UNIQUE INDEX `id_business_v2_user_table_preferences_user_id_table_id_key`(`user_id`, `table_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_workspace_shortcuts` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `name` VARCHAR(60) NOT NULL,
    `url` VARCHAR(700) NOT NULL,
    `sort_order` INTEGER NOT NULL DEFAULT 0,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `id_business_v2_workspace_shortcuts_user_id_sort_order_idx`(`user_id`, `sort_order`),
    UNIQUE INDEX `id_business_v2_workspace_shortcuts_user_id_url_key`(`user_id`, `url`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_managed_mailboxes` (
    `id` CHAR(36) NOT NULL,
    `email` VARCHAR(254) NOT NULL,
    `label` VARCHAR(60) NULL,
    `provider` ENUM('gmail', 'icloud') NOT NULL,
    `provider_credential_encrypted` TEXT NOT NULL,
    `query_code_hash` VARCHAR(64) NOT NULL,
    `query_code_hint` VARCHAR(4) NOT NULL,
    `status` ENUM('active', 'disabled', 'auth_failed') NOT NULL DEFAULT 'active',
    `last_verified_at` DATETIME(6) NULL,
    `last_queried_at` DATETIME(6) NULL,
    `last_error_code` VARCHAR(80) NULL,
    `created_by_user_id` CHAR(36) NOT NULL,
    `updated_by_user_id` CHAR(36) NOT NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    UNIQUE INDEX `id_business_v2_managed_mailboxes_email_key`(`email`),
    INDEX `id_business_v2_managed_mailboxes_status_updated_at_idx`(`status`, `updated_at`),
    INDEX `id_business_v2_managed_mailboxes_created_by_user_id_idx`(`created_by_user_id`),
    INDEX `id_business_v2_managed_mailboxes_updated_by_user_id_idx`(`updated_by_user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_mail_query_attempts` (
    `id` CHAR(36) NOT NULL,
    `mailbox_id` CHAR(36) NULL,
    `email_hash` VARCHAR(64) NOT NULL,
    `ip_hash` VARCHAR(64) NULL,
    `outcome` ENUM('success', 'invalid', 'rate_limited', 'provider_error') NOT NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    INDEX `id_business_v2_mail_query_attempts_email_hash_created_at_idx`(`email_hash`, `created_at`),
    INDEX `id_business_v2_mail_query_attempts_ip_hash_created_at_idx`(`ip_hash`, `created_at`),
    INDEX `id_business_v2_mail_query_attempts_mailbox_id_created_at_idx`(`mailbox_id`, `created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_exchange_rate_provider_snapshots` (
    `id` CHAR(36) NOT NULL,
    `snapshot_id` CHAR(36) NOT NULL,
    `provider` ENUM('binance', 'okx') NOT NULL,
    `side` ENUM('merchant_buy', 'merchant_sell') NOT NULL,
    `source_contract` VARCHAR(120) NOT NULL,
    `source_url` VARCHAR(2048) NOT NULL,
    `collected_at` DATETIME(6) NOT NULL,
    `received_ad_count` INTEGER NOT NULL,
    `collector_accepted_ad_count` INTEGER NOT NULL,
    `collector_rejected_ad_count` INTEGER NOT NULL,
    `valid_ad_count` INTEGER NOT NULL,
    `filtered_ad_count` INTEGER NOT NULL,
    `excluded_missing_tradable_amount` INTEGER NOT NULL,
    `excluded_non_positive_tradable` INTEGER NOT NULL,
    `excluded_missing_order_count` INTEGER NOT NULL,
    `excluded_low_order_count` INTEGER NOT NULL,
    `excluded_missing_completion_rate` INTEGER NOT NULL,
    `excluded_low_completion_rate` INTEGER NOT NULL,
    `excluded_price_outlier` INTEGER NOT NULL,
    `median_rate_to_rmb` DECIMAL(18, 8) NOT NULL,
    `lowest_valid_rate_to_rmb` DECIMAL(18, 8) NOT NULL,
    `highest_valid_rate_to_rmb` DECIMAL(18, 8) NOT NULL,
    `average_rate_to_rmb` DECIMAL(18, 8) NOT NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    INDEX `id_business_v2_exchange_rate_provider_snapshots_provider_sid_idx`(`provider`, `side`, `collected_at`),
    INDEX `id_business_v2_exchange_rate_provider_snapshots_created_at_idx`(`created_at`),
    UNIQUE INDEX `id_business_v2_exchange_rate_provider_snapshots_snapshot_id__key`(`snapshot_id`, `provider`, `side`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_exchange_rate_quote_samples` (
    `id` CHAR(36) NOT NULL,
    `provider_snapshot_id` CHAR(36) NOT NULL,
    `source_ad_id` VARCHAR(200) NOT NULL,
    `price_to_rmb` DECIMAL(18, 8) NOT NULL,
    `min_amount_rmb` DECIMAL(24, 8) NULL,
    `max_amount_rmb` DECIMAL(24, 8) NULL,
    `tradable_amount_usdt` DECIMAL(24, 8) NOT NULL,
    `payment_methods` JSON NOT NULL,
    `merchant_type` VARCHAR(80) NOT NULL,
    `completed_order_count` INTEGER NOT NULL,
    `completion_rate` DECIMAL(9, 8) NOT NULL,
    `positive_review_rate` DECIMAL(9, 8) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    INDEX `id_business_v2_exchange_rate_quote_samples_provider_snapshot_idx`(`provider_snapshot_id`, `price_to_rmb`),
    INDEX `id_business_v2_exchange_rate_quote_samples_created_at_idx`(`created_at`),
    UNIQUE INDEX `id_business_v2_exchange_rate_quote_samples_provider_snapshot_key`(`provider_snapshot_id`, `source_ad_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `roles` (
    `id` CHAR(36) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `code` VARCHAR(100) NOT NULL,
    `description` TEXT NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    UNIQUE INDEX `roles_code_key`(`code`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `permissions` (
    `id` CHAR(36) NOT NULL,
    `name` VARCHAR(100) NOT NULL,
    `code` VARCHAR(150) NOT NULL,
    `module` VARCHAR(100) NOT NULL,
    `action` VARCHAR(100) NOT NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    UNIQUE INDEX `permissions_code_key`(`code`),
    INDEX `permissions_module_action_idx`(`module`, `action`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `user_roles` (
    `user_id` CHAR(36) NOT NULL,
    `role_id` CHAR(36) NOT NULL,

    PRIMARY KEY (`user_id`, `role_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `role_permissions` (
    `role_id` CHAR(36) NOT NULL,
    `permission_id` CHAR(36) NOT NULL,
    `sensitive_approval_required` BOOLEAN NOT NULL DEFAULT false,

    INDEX `role_permissions_sensitive_approval_required_idx`(`sensitive_approval_required`),
    PRIMARY KEY (`role_id`, `permission_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_sensitive_display_policies` (
    `id` CHAR(36) NOT NULL,
    `role_id` CHAR(36) NOT NULL,
    `field_key` VARCHAR(80) NOT NULL,
    `context` ENUM('account_management', 'customer_management', 'order_workbench', 'topup_workbench', 'renewal_workbench', 'business_records', 'dashboard_notifications', 'export', 'audit') NOT NULL,
    `mode` ENUM('hidden', 'masked', 'reveal_direct', 'reveal_approval', 'full') NOT NULL,
    `created_by_user_id` CHAR(36) NULL,
    `updated_by_user_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `id_business_v2_sensitive_display_policies_role_id_context_idx`(`role_id`, `context`),
    INDEX `id_business_v2_sensitive_display_policies_field_key_context__idx`(`field_key`, `context`, `mode`),
    INDEX `id_business_v2_sensitive_display_policies_created_by_user_id_idx`(`created_by_user_id`),
    INDEX `id_business_v2_sensitive_display_policies_updated_by_user_id_idx`(`updated_by_user_id`),
    UNIQUE INDEX `id_business_v2_sensitive_display_policies_role_id_field_key__key`(`role_id`, `field_key`, `context`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `audit_logs` (
    `id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NULL,
    `module` VARCHAR(100) NOT NULL,
    `action` VARCHAR(100) NOT NULL,
    `object_type` VARCHAR(100) NULL,
    `object_id` CHAR(36) NULL,
    `before_data` JSON NULL,
    `after_data` JSON NULL,
    `ip` VARCHAR(100) NULL,
    `user_agent` TEXT NULL,
    `remark` TEXT NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    INDEX `audit_logs_user_id_idx`(`user_id`),
    INDEX `audit_logs_module_action_idx`(`module`, `action`),
    INDEX `audit_logs_object_type_object_id_idx`(`object_type`, `object_id`),
    INDEX `audit_logs_created_at_idx`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_governance_jobs` (
    `id` CHAR(36) NOT NULL,
    `job_no` VARCHAR(48) NOT NULL,
    `type` ENUM('recycle_restore', 'exchange_rate_cleanup') NOT NULL,
    `status` ENUM('pending_approval', 'approved', 'running', 'succeeded', 'partially_succeeded', 'failed', 'rejected', 'cancelled') NOT NULL DEFAULT 'pending_approval',
    `reason` TEXT NOT NULL,
    `backup_evidence` TEXT NOT NULL,
    `preview_hash` VARCHAR(64) NOT NULL,
    `preview_summary` JSON NOT NULL,
    `requested_by_user_id` CHAR(36) NOT NULL,
    `executed_by_user_id` CHAR(36) NULL,
    `total_items` INTEGER NOT NULL DEFAULT 0,
    `succeeded_items` INTEGER NOT NULL DEFAULT 0,
    `skipped_items` INTEGER NOT NULL DEFAULT 0,
    `failed_items` INTEGER NOT NULL DEFAULT 0,
    `idempotency_key` VARCHAR(160) NOT NULL,
    `approved_at` DATETIME(6) NULL,
    `started_at` DATETIME(6) NULL,
    `completed_at` DATETIME(6) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    UNIQUE INDEX `id_business_v2_governance_jobs_job_no_key`(`job_no`),
    UNIQUE INDEX `id_business_v2_governance_jobs_idempotency_key_key`(`idempotency_key`),
    INDEX `id_business_v2_governance_jobs_status_created_at_idx`(`status`, `created_at`),
    INDEX `id_business_v2_governance_jobs_type_created_at_idx`(`type`, `created_at`),
    INDEX `id_business_v2_governance_jobs_requested_by_user_id_created__idx`(`requested_by_user_id`, `created_at`),
    INDEX `id_business_v2_governance_jobs_executed_by_user_id_idx`(`executed_by_user_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_governance_job_items` (
    `id` CHAR(36) NOT NULL,
    `job_id` CHAR(36) NOT NULL,
    `sequence` INTEGER NOT NULL,
    `entity_type` ENUM('account', 'customer', 'option', 'order', 'exchange_rate_run') NOT NULL,
    `entity_id` CHAR(36) NOT NULL,
    `safe_label` VARCHAR(255) NOT NULL,
    `source_deleted_at` DATETIME(6) NULL,
    `eligibility` JSON NOT NULL,
    `status` ENUM('pending', 'processing', 'succeeded', 'skipped', 'failed') NOT NULL DEFAULT 'pending',
    `result_code` VARCHAR(120) NULL,
    `result_message` TEXT NULL,
    `result_audit_log_id` CHAR(36) NULL,
    `processed_at` DATETIME(6) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    INDEX `id_business_v2_governance_job_items_job_id_status_sequence_idx`(`job_id`, `status`, `sequence`),
    INDEX `id_business_v2_governance_job_items_entity_type_entity_id_idx`(`entity_type`, `entity_id`),
    INDEX `id_business_v2_governance_job_items_result_audit_log_id_idx`(`result_audit_log_id`),
    UNIQUE INDEX `id_business_v2_governance_job_items_job_id_sequence_key`(`job_id`, `sequence`),
    UNIQUE INDEX `id_business_v2_governance_job_items_job_id_entity_type_entit_key`(`job_id`, `entity_type`, `entity_id`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_governance_approvals` (
    `id` CHAR(36) NOT NULL,
    `job_id` CHAR(36) NOT NULL,
    `approver_user_id` CHAR(36) NOT NULL,
    `decision` ENUM('approved', 'rejected') NOT NULL,
    `reason` TEXT NOT NULL,
    `preview_hash` VARCHAR(64) NOT NULL,
    `decided_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    UNIQUE INDEX `id_business_v2_governance_approvals_job_id_key`(`job_id`),
    INDEX `id_business_v2_governance_approvals_approver_user_id_decided_idx`(`approver_user_id`, `decided_at`),
    INDEX `id_business_v2_governance_approvals_decision_decided_at_idx`(`decision`, `decided_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_governance_checkpoints` (
    `id` CHAR(36) NOT NULL,
    `job_id` CHAR(36) NOT NULL,
    `batch_no` INTEGER NOT NULL,
    `idempotency_key` VARCHAR(160) NOT NULL,
    `status` ENUM('running', 'completed', 'failed') NOT NULL DEFAULT 'running',
    `cursor_sequence` INTEGER NOT NULL,
    `attempted_items` INTEGER NOT NULL DEFAULT 0,
    `succeeded_items` INTEGER NOT NULL DEFAULT 0,
    `skipped_items` INTEGER NOT NULL DEFAULT 0,
    `failed_items` INTEGER NOT NULL DEFAULT 0,
    `error_code` VARCHAR(120) NULL,
    `started_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `completed_at` DATETIME(6) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    UNIQUE INDEX `id_business_v2_governance_checkpoints_idempotency_key_key`(`idempotency_key`),
    INDEX `id_business_v2_governance_checkpoints_job_id_status_idx`(`job_id`, `status`),
    INDEX `id_business_v2_governance_checkpoints_created_at_idx`(`created_at`),
    UNIQUE INDEX `id_business_v2_governance_checkpoints_job_id_batch_no_key`(`job_id`, `batch_no`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `v2_auth_identities` (
    `id` CHAR(36) NOT NULL,
    `auth_user_id` CHAR(36) NOT NULL,
    `user_id` CHAR(36) NOT NULL,
    `username_normalized` VARCHAR(100) NOT NULL,
    `auth_email` VARCHAR(255) NOT NULL,
    `enabled` BOOLEAN NOT NULL DEFAULT true,
    `must_reset_password` BOOLEAN NOT NULL DEFAULT true,
    `last_authenticated_at` DATETIME(6) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
    `updated_at` DATETIME(6) NOT NULL,

    UNIQUE INDEX `v2_auth_identities_auth_user_id_key`(`auth_user_id`),
    UNIQUE INDEX `v2_auth_identities_user_id_key`(`user_id`),
    UNIQUE INDEX `v2_auth_identities_username_normalized_key`(`username_normalized`),
    UNIQUE INDEX `v2_auth_identities_auth_email_key`(`auth_email`),
    INDEX `v2_auth_identities_enabled_idx`(`enabled`),
    INDEX `v2_auth_identities_created_at_idx`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `id_business_v2_scope_versions` (
    `scope` VARCHAR(80) NOT NULL,
    `version` BIGINT NOT NULL DEFAULT 0,
    `updated_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    PRIMARY KEY (`scope`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- CreateTable
CREATE TABLE `attachments` (
    `id` CHAR(36) NOT NULL,
    `original_name` VARCHAR(255) NOT NULL,
    `storage_key` VARCHAR(500) NOT NULL,
    `mime_type` VARCHAR(150) NOT NULL,
    `size_bytes` BIGINT NOT NULL,
    `business_module` VARCHAR(80) NULL,
    `object_type` VARCHAR(120) NULL,
    `object_id` CHAR(36) NULL,
    `purpose` VARCHAR(120) NULL,
    `remark` TEXT NULL,
    `created_by_user_id` CHAR(36) NULL,
    `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),

    UNIQUE INDEX `attachments_storage_key_key`(`storage_key`),
    INDEX `attachments_created_by_user_id_idx`(`created_by_user_id`),
    INDEX `attachments_business_module_object_type_idx`(`business_module`, `object_type`),
    INDEX `attachments_object_id_idx`(`object_id`),
    INDEX `attachments_purpose_idx`(`purpose`),
    INDEX `attachments_created_at_idx`(`created_at`),
    PRIMARY KEY (`id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

-- AddForeignKey
ALTER TABLE `users` ADD CONSTRAINT `users_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `login_logs` ADD CONSTRAINT `login_logs_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `active_sessions` ADD CONSTRAINT `active_sessions_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `security_settings` ADD CONSTRAINT `security_settings_updated_by_user_id_fkey` FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `ip_whitelists` ADD CONSTRAINT `ip_whitelists_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sensitive_access_logs` ADD CONSTRAINT `sensitive_access_logs_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sensitive_access_approvals` ADD CONSTRAINT `sensitive_access_approvals_requester_id_fkey` FOREIGN KEY (`requester_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `sensitive_access_approvals` ADD CONSTRAINT `sensitive_access_approvals_approver_id_fkey` FOREIGN KEY (`approver_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_options` ADD CONSTRAINT `id_business_v2_options_parent_id_fkey` FOREIGN KEY (`parent_id`) REFERENCES `id_business_v2_options`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_options` ADD CONSTRAINT `id_business_v2_options_country_option_id_fkey` FOREIGN KEY (`country_option_id`) REFERENCES `id_business_v2_options`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_options` ADD CONSTRAINT `id_business_v2_options_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_options` ADD CONSTRAINT `id_business_v2_options_updated_by_user_id_fkey` FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_customers` ADD CONSTRAINT `id_business_v2_customers_source_option_id_fkey` FOREIGN KEY (`source_option_id`) REFERENCES `id_business_v2_options`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_customers` ADD CONSTRAINT `id_business_v2_customers_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_customers` ADD CONSTRAINT `id_business_v2_customers_updated_by_user_id_fkey` FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_customer_tags` ADD CONSTRAINT `id_business_v2_customer_tags_customer_id_fkey` FOREIGN KEY (`customer_id`) REFERENCES `id_business_v2_customers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_customer_tags` ADD CONSTRAINT `id_business_v2_customer_tags_option_id_fkey` FOREIGN KEY (`option_id`) REFERENCES `id_business_v2_options`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_customer_services` ADD CONSTRAINT `id_business_v2_customer_services_customer_id_fkey` FOREIGN KEY (`customer_id`) REFERENCES `id_business_v2_customers`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_customer_services` ADD CONSTRAINT `id_business_v2_customer_services_option_id_fkey` FOREIGN KEY (`option_id`) REFERENCES `id_business_v2_options`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_accounts` ADD CONSTRAINT `id_business_v2_accounts_country_option_id_fkey` FOREIGN KEY (`country_option_id`) REFERENCES `id_business_v2_options`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_accounts` ADD CONSTRAINT `id_business_v2_accounts_status_option_id_fkey` FOREIGN KEY (`status_option_id`) REFERENCES `id_business_v2_options`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_accounts` ADD CONSTRAINT `id_business_v2_accounts_supplier_option_id_fkey` FOREIGN KEY (`supplier_option_id`) REFERENCES `id_business_v2_options`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_accounts` ADD CONSTRAINT `id_business_v2_accounts_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_accounts` ADD CONSTRAINT `id_business_v2_accounts_updated_by_user_id_fkey` FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_accounts` ADD CONSTRAINT `id_business_v2_accounts_sold_by_order_id_fkey` FOREIGN KEY (`sold_by_order_id`) REFERENCES `id_business_v2_orders`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_accounts` ADD CONSTRAINT `id_business_v2_accounts_active_loss_record_id_fkey` FOREIGN KEY (`active_loss_record_id`) REFERENCES `id_business_v2_account_losses`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_accounts` ADD CONSTRAINT `id_business_v2_accounts_purchase_fx_snapshot_id_fkey` FOREIGN KEY (`purchase_fx_snapshot_id`) REFERENCES `id_business_v2_finance_fx_rate_snapshots`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_accounts` ADD CONSTRAINT `id_business_v2_accounts_purchase_finance_account_id_fkey` FOREIGN KEY (`purchase_finance_account_id`) REFERENCES `id_business_v2_finance_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_accounts` ADD CONSTRAINT `id_business_v2_accounts_purchase_supplier_account_id_fkey` FOREIGN KEY (`purchase_supplier_account_id`) REFERENCES `id_business_v2_topup_supplier_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_gift_cards` ADD CONSTRAINT `id_business_v2_gift_cards_account_id_fkey` FOREIGN KEY (`account_id`) REFERENCES `id_business_v2_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_gift_cards` ADD CONSTRAINT `id_business_v2_gift_cards_card_name_option_id_fkey` FOREIGN KEY (`card_name_option_id`) REFERENCES `id_business_v2_options`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_gift_cards` ADD CONSTRAINT `id_business_v2_gift_cards_supplier_option_id_fkey` FOREIGN KEY (`supplier_option_id`) REFERENCES `id_business_v2_options`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_gift_cards` ADD CONSTRAINT `id_business_v2_gift_cards_country_option_id_fkey` FOREIGN KEY (`country_option_id`) REFERENCES `id_business_v2_options`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_gift_cards` ADD CONSTRAINT `id_business_v2_gift_cards_source_attachment_id_fkey` FOREIGN KEY (`source_attachment_id`) REFERENCES `attachments`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_gift_cards` ADD CONSTRAINT `id_business_v2_gift_cards_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_gift_cards` ADD CONSTRAINT `id_business_v2_gift_cards_updated_by_user_id_fkey` FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_gift_cards` ADD CONSTRAINT `id_business_v2_gift_cards_exchange_rate_snapshot_id_fkey` FOREIGN KEY (`exchange_rate_snapshot_id`) REFERENCES `id_business_v2_exchange_rate_snapshots`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_gift_cards` ADD CONSTRAINT `id_business_v2_gift_cards_purchase_fx_snapshot_id_fkey` FOREIGN KEY (`purchase_fx_snapshot_id`) REFERENCES `id_business_v2_finance_fx_rate_snapshots`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_gift_cards` ADD CONSTRAINT `id_business_v2_gift_cards_purchase_finance_account_id_fkey` FOREIGN KEY (`purchase_finance_account_id`) REFERENCES `id_business_v2_finance_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_gift_cards` ADD CONSTRAINT `id_business_v2_gift_cards_purchase_supplier_account_id_fkey` FOREIGN KEY (`purchase_supplier_account_id`) REFERENCES `id_business_v2_topup_supplier_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_topup_supplier_accounts` ADD CONSTRAINT `id_business_v2_topup_supplier_accounts_supplier_option_id_fkey` FOREIGN KEY (`supplier_option_id`) REFERENCES `id_business_v2_options`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_topup_supplier_accounts` ADD CONSTRAINT `id_business_v2_topup_supplier_accounts_initialized_by_user_id_f` FOREIGN KEY (`initialized_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_topup_supplier_accounts` ADD CONSTRAINT `id_business_v2_topup_supplier_accounts_updated_by_user_id_fkey` FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_topup_supplier_payments` ADD CONSTRAINT `id_business_v2_topup_supplier_payments_supplier_account_id_fkey` FOREIGN KEY (`supplier_account_id`) REFERENCES `id_business_v2_topup_supplier_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_topup_supplier_payments` ADD CONSTRAINT `id_business_v2_topup_supplier_payments_finance_account_id_fkey` FOREIGN KEY (`finance_account_id`) REFERENCES `id_business_v2_finance_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_topup_supplier_payments` ADD CONSTRAINT `id_business_v2_topup_supplier_payments_fx_rate_snapshot_id_fkey` FOREIGN KEY (`fx_rate_snapshot_id`) REFERENCES `id_business_v2_finance_fx_rate_snapshots`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_topup_supplier_payments` ADD CONSTRAINT `id_business_v2_topup_supplier_payments_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_topup_supplier_ledger` ADD CONSTRAINT `id_business_v2_topup_supplier_ledger_supplier_account_id_fkey` FOREIGN KEY (`supplier_account_id`) REFERENCES `id_business_v2_topup_supplier_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_topup_supplier_ledger` ADD CONSTRAINT `id_business_v2_topup_supplier_ledger_payment_id_fkey` FOREIGN KEY (`payment_id`) REFERENCES `id_business_v2_topup_supplier_payments`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_topup_supplier_ledger` ADD CONSTRAINT `id_business_v2_topup_supplier_ledger_gift_card_id_fkey` FOREIGN KEY (`gift_card_id`) REFERENCES `id_business_v2_gift_cards`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_topup_supplier_ledger` ADD CONSTRAINT `id_business_v2_topup_supplier_ledger_reversal_of_entry_id_fkey` FOREIGN KEY (`reversal_of_entry_id`) REFERENCES `id_business_v2_topup_supplier_ledger`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_topup_supplier_ledger` ADD CONSTRAINT `id_business_v2_topup_supplier_ledger_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_finance_settings` ADD CONSTRAINT `id_business_v2_finance_settings_updated_by_user_id_fkey` FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_finance_accounts` ADD CONSTRAINT `id_business_v2_finance_accounts_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_finance_accounts` ADD CONSTRAINT `id_business_v2_finance_accounts_updated_by_user_id_fkey` FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_finance_fx_rate_snapshots` ADD CONSTRAINT `id_business_v2_finance_fx_rate_snapshots_created_by_user_id_fke` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_finance_journals` ADD CONSTRAINT `id_business_v2_finance_journals_reversal_of_journal_id_fkey` FOREIGN KEY (`reversal_of_journal_id`) REFERENCES `id_business_v2_finance_journals`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_finance_journals` ADD CONSTRAINT `id_business_v2_finance_journals_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_finance_journal_lines` ADD CONSTRAINT `id_business_v2_finance_journal_lines_journal_id_fkey` FOREIGN KEY (`journal_id`) REFERENCES `id_business_v2_finance_journals`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_finance_journal_lines` ADD CONSTRAINT `id_business_v2_finance_journal_lines_finance_account_id_fkey` FOREIGN KEY (`finance_account_id`) REFERENCES `id_business_v2_finance_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_finance_journal_lines` ADD CONSTRAINT `id_business_v2_finance_journal_lines_supplier_account_id_fkey` FOREIGN KEY (`supplier_account_id`) REFERENCES `id_business_v2_topup_supplier_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_finance_journal_lines` ADD CONSTRAINT `id_business_v2_finance_journal_lines_fx_rate_snapshot_id_fkey` FOREIGN KEY (`fx_rate_snapshot_id`) REFERENCES `id_business_v2_finance_fx_rate_snapshots`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_finance_expenses` ADD CONSTRAINT `id_business_v2_finance_expenses_journal_id_fkey` FOREIGN KEY (`journal_id`) REFERENCES `id_business_v2_finance_journals`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_finance_expenses` ADD CONSTRAINT `id_business_v2_finance_expenses_category_option_id_fkey` FOREIGN KEY (`category_option_id`) REFERENCES `id_business_v2_options`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_finance_expenses` ADD CONSTRAINT `id_business_v2_finance_expenses_finance_account_id_fkey` FOREIGN KEY (`finance_account_id`) REFERENCES `id_business_v2_finance_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_finance_expenses` ADD CONSTRAINT `id_business_v2_finance_expenses_fx_rate_snapshot_id_fkey` FOREIGN KEY (`fx_rate_snapshot_id`) REFERENCES `id_business_v2_finance_fx_rate_snapshots`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_finance_expenses` ADD CONSTRAINT `id_business_v2_finance_expenses_receipt_attachment_id_fkey` FOREIGN KEY (`receipt_attachment_id`) REFERENCES `attachments`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_finance_expenses` ADD CONSTRAINT `id_business_v2_finance_expenses_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_finance_periods` ADD CONSTRAINT `id_business_v2_finance_periods_closed_by_user_id_fkey` FOREIGN KEY (`closed_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_finance_periods` ADD CONSTRAINT `id_business_v2_finance_periods_reopened_by_user_id_fkey` FOREIGN KEY (`reopened_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_balance_ledger` ADD CONSTRAINT `id_business_v2_balance_ledger_account_id_fkey` FOREIGN KEY (`account_id`) REFERENCES `id_business_v2_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_balance_ledger` ADD CONSTRAINT `id_business_v2_balance_ledger_gift_card_id_fkey` FOREIGN KEY (`gift_card_id`) REFERENCES `id_business_v2_gift_cards`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_balance_ledger` ADD CONSTRAINT `id_business_v2_balance_ledger_order_id_fkey` FOREIGN KEY (`order_id`) REFERENCES `id_business_v2_orders`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_balance_ledger` ADD CONSTRAINT `id_business_v2_balance_ledger_reversal_of_entry_id_fkey` FOREIGN KEY (`reversal_of_entry_id`) REFERENCES `id_business_v2_balance_ledger`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_balance_ledger` ADD CONSTRAINT `id_business_v2_balance_ledger_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_account_losses` ADD CONSTRAINT `id_business_v2_account_losses_account_id_fkey` FOREIGN KEY (`account_id`) REFERENCES `id_business_v2_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_account_losses` ADD CONSTRAINT `id_business_v2_account_losses_ledger_entry_id_fkey` FOREIGN KEY (`ledger_entry_id`) REFERENCES `id_business_v2_balance_ledger`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_account_losses` ADD CONSTRAINT `id_business_v2_account_losses_reported_by_user_id_fkey` FOREIGN KEY (`reported_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_account_losses` ADD CONSTRAINT `id_business_v2_account_losses_reversed_by_user_id_fkey` FOREIGN KEY (`reversed_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_orders` ADD CONSTRAINT `id_business_v2_orders_customer_id_fkey` FOREIGN KEY (`customer_id`) REFERENCES `id_business_v2_customers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_orders` ADD CONSTRAINT `id_business_v2_orders_service_option_id_fkey` FOREIGN KEY (`service_option_id`) REFERENCES `id_business_v2_options`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_orders` ADD CONSTRAINT `id_business_v2_orders_account_id_fkey` FOREIGN KEY (`account_id`) REFERENCES `id_business_v2_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_orders` ADD CONSTRAINT `id_business_v2_orders_source_sold_order_id_fkey` FOREIGN KEY (`source_sold_order_id`) REFERENCES `id_business_v2_orders`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_orders` ADD CONSTRAINT `id_business_v2_orders_settlement_platform_option_id_fkey` FOREIGN KEY (`settlement_platform_option_id`) REFERENCES `id_business_v2_options`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_orders` ADD CONSTRAINT `id_business_v2_orders_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_orders` ADD CONSTRAINT `id_business_v2_orders_updated_by_user_id_fkey` FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_orders` ADD CONSTRAINT `id_business_v2_orders_received_fx_snapshot_id_fkey` FOREIGN KEY (`received_fx_snapshot_id`) REFERENCES `id_business_v2_finance_fx_rate_snapshots`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_orders` ADD CONSTRAINT `id_business_v2_orders_received_finance_account_id_fkey` FOREIGN KEY (`received_finance_account_id`) REFERENCES `id_business_v2_finance_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_order_display_snapshots` ADD CONSTRAINT `id_business_v2_order_display_snapshots_order_id_fkey` FOREIGN KEY (`order_id`) REFERENCES `id_business_v2_orders`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_account_locks` ADD CONSTRAINT `id_business_v2_account_locks_account_id_fkey` FOREIGN KEY (`account_id`) REFERENCES `id_business_v2_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_account_locks` ADD CONSTRAINT `id_business_v2_account_locks_service_option_id_fkey` FOREIGN KEY (`service_option_id`) REFERENCES `id_business_v2_options`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_account_locks` ADD CONSTRAINT `id_business_v2_account_locks_order_id_fkey` FOREIGN KEY (`order_id`) REFERENCES `id_business_v2_orders`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_account_locks` ADD CONSTRAINT `id_business_v2_account_locks_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_account_locks` ADD CONSTRAINT `id_business_v2_account_locks_ended_by_user_id_fkey` FOREIGN KEY (`ended_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_activations` ADD CONSTRAINT `id_business_v2_activations_order_id_fkey` FOREIGN KEY (`order_id`) REFERENCES `id_business_v2_orders`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_activations` ADD CONSTRAINT `id_business_v2_activations_renewed_from_activation_id_fkey` FOREIGN KEY (`renewed_from_activation_id`) REFERENCES `id_business_v2_activations`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_activations` ADD CONSTRAINT `id_business_v2_activations_customer_id_fkey` FOREIGN KEY (`customer_id`) REFERENCES `id_business_v2_customers`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_activations` ADD CONSTRAINT `id_business_v2_activations_account_id_fkey` FOREIGN KEY (`account_id`) REFERENCES `id_business_v2_accounts`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_activations` ADD CONSTRAINT `id_business_v2_activations_service_option_id_fkey` FOREIGN KEY (`service_option_id`) REFERENCES `id_business_v2_options`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_activations` ADD CONSTRAINT `id_business_v2_activations_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_activations` ADD CONSTRAINT `id_business_v2_activations_updated_by_user_id_fkey` FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_renewal_warning_settings` ADD CONSTRAINT `id_business_v2_renewal_warning_settings_updated_by_user_id_fkey` FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_exchange_rate_runs` ADD CONSTRAINT `id_business_v2_exchange_rate_runs_triggered_by_user_id_fkey` FOREIGN KEY (`triggered_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_exchange_rate_entries` ADD CONSTRAINT `id_business_v2_exchange_rate_entries_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_exchange_rate_snapshots` ADD CONSTRAINT `id_business_v2_exchange_rate_snapshots_run_id_fkey` FOREIGN KEY (`run_id`) REFERENCES `id_business_v2_exchange_rate_runs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_exchange_rate_settings` ADD CONSTRAINT `id_business_v2_exchange_rate_settings_updated_by_user_id_fkey` FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_purchase_currencies` ADD CONSTRAINT `id_business_v2_purchase_currencies_updated_by_user_id_fkey` FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_purchase_rate_settings` ADD CONSTRAINT `id_business_v2_purchase_rate_settings_updated_by_user_id_fkey` FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_purchase_rate_fetch_runs` ADD CONSTRAINT `id_business_v2_purchase_rate_fetch_runs_triggered_by_user_i_fkey` FOREIGN KEY (`triggered_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_purchase_rate_fetch_runs` ADD CONSTRAINT `id_business_v2_purchase_rate_fetch_runs_reviewed_by_user_id_fkey` FOREIGN KEY (`reviewed_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_purchase_rate_snapshots` ADD CONSTRAINT `id_business_v2_purchase_rate_snapshots_currency_code_fkey` FOREIGN KEY (`currency_code`) REFERENCES `id_business_v2_purchase_currencies`(`code`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_purchase_rate_snapshots` ADD CONSTRAINT `id_business_v2_purchase_rate_snapshots_fetch_run_id_fkey` FOREIGN KEY (`fetch_run_id`) REFERENCES `id_business_v2_purchase_rate_fetch_runs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_purchase_rate_snapshots` ADD CONSTRAINT `id_business_v2_purchase_rate_snapshots_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_branding_settings` ADD CONSTRAINT `id_business_v2_branding_settings_updated_by_user_id_fkey` FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_user_table_preferences` ADD CONSTRAINT `id_business_v2_user_table_preferences_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_workspace_shortcuts` ADD CONSTRAINT `id_business_v2_workspace_shortcuts_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_managed_mailboxes` ADD CONSTRAINT `id_business_v2_managed_mailboxes_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_managed_mailboxes` ADD CONSTRAINT `id_business_v2_managed_mailboxes_updated_by_user_id_fkey` FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_mail_query_attempts` ADD CONSTRAINT `id_business_v2_mail_query_attempts_mailbox_id_fkey` FOREIGN KEY (`mailbox_id`) REFERENCES `id_business_v2_managed_mailboxes`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_exchange_rate_provider_snapshots` ADD CONSTRAINT `id_business_v2_exchange_rate_provider_snapshots_snapshot_id_fkey` FOREIGN KEY (`snapshot_id`) REFERENCES `id_business_v2_exchange_rate_snapshots`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_exchange_rate_quote_samples` ADD CONSTRAINT `id_business_v2_exchange_rate_quote_samples_provider_snapsho_fkey` FOREIGN KEY (`provider_snapshot_id`) REFERENCES `id_business_v2_exchange_rate_provider_snapshots`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_roles` ADD CONSTRAINT `user_roles_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `user_roles` ADD CONSTRAINT `user_roles_role_id_fkey` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `role_permissions` ADD CONSTRAINT `role_permissions_role_id_fkey` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `role_permissions` ADD CONSTRAINT `role_permissions_permission_id_fkey` FOREIGN KEY (`permission_id`) REFERENCES `permissions`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_sensitive_display_policies` ADD CONSTRAINT `id_business_v2_sensitive_display_policies_role_id_fkey` FOREIGN KEY (`role_id`) REFERENCES `roles`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_sensitive_display_policies` ADD CONSTRAINT `id_business_v2_sensitive_display_policies_created_by_user_i_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_sensitive_display_policies` ADD CONSTRAINT `id_business_v2_sensitive_display_policies_updated_by_user_i_fkey` FOREIGN KEY (`updated_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `audit_logs` ADD CONSTRAINT `audit_logs_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_governance_jobs` ADD CONSTRAINT `id_business_v2_governance_jobs_requested_by_user_id_fkey` FOREIGN KEY (`requested_by_user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_governance_jobs` ADD CONSTRAINT `id_business_v2_governance_jobs_executed_by_user_id_fkey` FOREIGN KEY (`executed_by_user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_governance_job_items` ADD CONSTRAINT `id_business_v2_governance_job_items_job_id_fkey` FOREIGN KEY (`job_id`) REFERENCES `id_business_v2_governance_jobs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_governance_job_items` ADD CONSTRAINT `id_business_v2_governance_job_items_result_audit_log_id_fkey` FOREIGN KEY (`result_audit_log_id`) REFERENCES `audit_logs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_governance_approvals` ADD CONSTRAINT `id_business_v2_governance_approvals_job_id_fkey` FOREIGN KEY (`job_id`) REFERENCES `id_business_v2_governance_jobs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_governance_approvals` ADD CONSTRAINT `id_business_v2_governance_approvals_approver_user_id_fkey` FOREIGN KEY (`approver_user_id`) REFERENCES `users`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `id_business_v2_governance_checkpoints` ADD CONSTRAINT `id_business_v2_governance_checkpoints_job_id_fkey` FOREIGN KEY (`job_id`) REFERENCES `id_business_v2_governance_jobs`(`id`) ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `v2_auth_identities` ADD CONSTRAINT `v2_auth_identities_user_id_fkey` FOREIGN KEY (`user_id`) REFERENCES `users`(`id`) ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE `attachments` ADD CONSTRAINT `attachments_created_by_user_id_fkey` FOREIGN KEY (`created_by_user_id`) REFERENCES `users`(`id`) ON DELETE SET NULL ON UPDATE CASCADE;

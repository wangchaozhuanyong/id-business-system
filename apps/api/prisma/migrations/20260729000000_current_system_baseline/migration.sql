-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "UserStatus" AS ENUM ('active', 'disabled');

-- CreateEnum
CREATE TYPE "LoginLogStatus" AS ENUM ('success', 'failed', 'blocked');

-- CreateEnum
CREATE TYPE "IpWhitelistScope" AS ENUM ('admin', 'api');

-- CreateEnum
CREATE TYPE "SensitiveAccessApprovalStatus" AS ENUM ('pending', 'approved', 'rejected', 'expired');

-- CreateEnum
CREATE TYPE "IdBusinessV2OptionType" AS ENUM ('id_status', 'id_region', 'customer_source', 'customer_tag', 'country', 'business_category', 'service', 'id_supplier', 'topup_supplier', 'settlement_platform');

-- CreateEnum
CREATE TYPE "IdBusinessV2OptionStatus" AS ENUM ('active', 'disabled');

-- CreateEnum
CREATE TYPE "IdBusinessV2RecordStatus" AS ENUM ('active', 'disabled');

-- CreateEnum
CREATE TYPE "IdBusinessV2GiftCardStatus" AS ENUM ('credited', 'redeemed', 'withdrawn');

-- CreateEnum
CREATE TYPE "IdBusinessV2BalanceLedgerEntryType" AS ENUM ('gift_card_credit', 'gift_card_redeemed', 'gift_card_withdrawal', 'order_consumption', 'order_consumption_reversal', 'opening_balance', 'manual_adjustment');

-- CreateEnum
CREATE TYPE "IdBusinessV2BalanceDirection" AS ENUM ('credit', 'debit', 'adjustment');

-- CreateEnum
CREATE TYPE "IdBusinessV2OrderStatus" AS ENUM ('draft', 'pending', 'waiting_external', 'processing', 'completed', 'refunded', 'cancelled', 'failed');

-- CreateEnum
CREATE TYPE "IdBusinessV2AccountLockScope" AS ENUM ('by_service', 'global');

-- CreateEnum
CREATE TYPE "IdBusinessV2AccountLockStatus" AS ENUM ('active', 'released', 'expired');

-- CreateEnum
CREATE TYPE "IdBusinessV2ActivationStatus" AS ENUM ('active', 'expired', 'cancelled', 'abnormal');

-- CreateEnum
CREATE TYPE "IdBusinessV2AutoRenewalStatus" AS ENUM ('unknown', 'enabled', 'disabled');

-- CreateEnum
CREATE TYPE "IdBusinessV2ExchangeRateRunStatus" AS ENUM ('running', 'success', 'failed');

-- CreateEnum
CREATE TYPE "IdBusinessV2ExchangeRateTriggerType" AS ENUM ('manual', 'scheduled', 'system');

-- CreateEnum
CREATE TYPE "IdBusinessV2OtcProvider" AS ENUM ('binance', 'okx');

-- CreateEnum
CREATE TYPE "IdBusinessV2OtcSide" AS ENUM ('merchant_buy', 'merchant_sell');

-- CreateEnum
CREATE TYPE "IdBusinessV2ExchangeRateErrorProvider" AS ENUM ('binance', 'okx', 'multiple', 'system');

-- CreateTable
CREATE TABLE "users" (
    "id" UUID NOT NULL,
    "username" VARCHAR(100) NOT NULL,
    "password_hash" VARCHAR(255) NOT NULL,
    "display_name" VARCHAR(100) NOT NULL,
    "phone" VARCHAR(50),
    "email" VARCHAR(255),
    "status" "UserStatus" NOT NULL DEFAULT 'active',
    "last_login_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "users_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "login_logs" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "username" VARCHAR(100) NOT NULL,
    "status" "LoginLogStatus" NOT NULL,
    "failure_reason" TEXT,
    "ip" VARCHAR(100),
    "user_agent" TEXT,
    "location" VARCHAR(120),
    "abnormal" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "login_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "active_sessions" (
    "id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "token_hash" VARCHAR(128) NOT NULL,
    "ip" VARCHAR(100),
    "user_agent" TEXT,
    "last_active_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "revoked_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "active_sessions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "security_settings" (
    "id" UUID NOT NULL,
    "key" VARCHAR(120) NOT NULL,
    "value" JSONB NOT NULL DEFAULT '{}',
    "remark" TEXT,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "security_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ip_whitelists" (
    "id" UUID NOT NULL,
    "ip_or_cidr" VARCHAR(100) NOT NULL,
    "scope" "IpWhitelistScope" NOT NULL DEFAULT 'admin',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "remark" TEXT,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "ip_whitelists_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sensitive_access_logs" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "module" VARCHAR(100) NOT NULL,
    "field_name" VARCHAR(120) NOT NULL,
    "object_type" VARCHAR(120) NOT NULL,
    "object_id" UUID,
    "access_reason" TEXT,
    "approved" BOOLEAN NOT NULL DEFAULT false,
    "ip" VARCHAR(100),
    "user_agent" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "sensitive_access_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "sensitive_access_approvals" (
    "id" UUID NOT NULL,
    "requester_id" UUID NOT NULL,
    "approver_id" UUID,
    "module" VARCHAR(100) NOT NULL,
    "field_name" VARCHAR(120) NOT NULL,
    "object_type" VARCHAR(120) NOT NULL,
    "object_id" UUID,
    "reason" TEXT NOT NULL,
    "status" "SensitiveAccessApprovalStatus" NOT NULL DEFAULT 'pending',
    "decision_note" TEXT,
    "approved_at" TIMESTAMPTZ(6),
    "expires_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "sensitive_access_approvals_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "id_business_v2_options" (
    "id" UUID NOT NULL,
    "type" "IdBusinessV2OptionType" NOT NULL,
    "code" VARCHAR(120) NOT NULL,
    "name" VARCHAR(160) NOT NULL,
    "unique_key" VARCHAR(360) NOT NULL,
    "parent_id" UUID,
    "country_option_id" UUID,
    "business_amount" DECIMAL(18,4),
    "currency_code" VARCHAR(3),
    "fixed_fee" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "percentage_fee" DECIMAL(9,4) NOT NULL DEFAULT 0,
    "sort_order" INTEGER NOT NULL DEFAULT 0,
    "status" "IdBusinessV2OptionStatus" NOT NULL DEFAULT 'active',
    "is_system" BOOLEAN NOT NULL DEFAULT false,
    "remark" TEXT,
    "created_by_user_id" UUID,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "id_business_v2_options_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "id_business_v2_customers" (
    "id" UUID NOT NULL,
    "name" VARCHAR(120) NOT NULL,
    "phone_encrypted" TEXT,
    "phone_hash" VARCHAR(64),
    "phone_masked" VARCHAR(80),
    "phone_tail" VARCHAR(8),
    "wechat" VARCHAR(120),
    "source_option_id" UUID,
    "record_status" "IdBusinessV2RecordStatus" NOT NULL DEFAULT 'active',
    "remark" TEXT,
    "created_by_user_id" UUID,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "id_business_v2_customers_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "id_business_v2_customer_tags" (
    "customer_id" UUID NOT NULL,
    "option_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "id_business_v2_customer_tags_pkey" PRIMARY KEY ("customer_id","option_id")
);

-- CreateTable
CREATE TABLE "id_business_v2_customer_services" (
    "customer_id" UUID NOT NULL,
    "option_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "id_business_v2_customer_services_pkey" PRIMARY KEY ("customer_id","option_id")
);

-- CreateTable
CREATE TABLE "id_business_v2_accounts" (
    "id" UUID NOT NULL,
    "apple_id_encrypted" TEXT NOT NULL,
    "apple_id_hash" VARCHAR(64) NOT NULL,
    "apple_id_masked" VARCHAR(255) NOT NULL,
    "password_encrypted" TEXT,
    "phone_encrypted" TEXT,
    "phone_hash" VARCHAR(64),
    "phone_masked" VARCHAR(80),
    "phone_tail" VARCHAR(8),
    "security_info_encrypted" TEXT,
    "country_option_id" UUID NOT NULL,
    "status_option_id" UUID NOT NULL,
    "supplier_option_id" UUID,
    "current_balance" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "balance_cost_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "purchase_cost" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "record_status" "IdBusinessV2RecordStatus" NOT NULL DEFAULT 'active',
    "remark" TEXT,
    "created_by_user_id" UUID,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "id_business_v2_accounts_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "id_business_v2_gift_cards" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "supplier_option_id" UUID,
    "source_attachment_id" UUID,
    "code_encrypted" TEXT NOT NULL,
    "code_hash" VARCHAR(64) NOT NULL,
    "code_masked" VARCHAR(80) NOT NULL,
    "code_tail" VARCHAR(8) NOT NULL,
    "face_value" DECIMAL(18,4) NOT NULL,
    "exchange_rate" DECIMAL(18,8) NOT NULL,
    "exchange_rate_source" VARCHAR(40) NOT NULL DEFAULT 'manual_input',
    "exchange_rate_snapshot_id" UUID,
    "exchange_rate_prefilled_value" DECIMAL(18,8),
    "exchange_rate_was_overridden" BOOLEAN NOT NULL DEFAULT false,
    "cost_amount" DECIMAL(18,4) NOT NULL,
    "status" "IdBusinessV2GiftCardStatus" NOT NULL,
    "status_changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "remark" TEXT,
    "created_by_user_id" UUID,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "id_business_v2_gift_cards_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "id_business_v2_balance_ledger" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "gift_card_id" UUID,
    "order_id" UUID,
    "entry_type" "IdBusinessV2BalanceLedgerEntryType" NOT NULL,
    "direction" "IdBusinessV2BalanceDirection" NOT NULL,
    "balance_amount" DECIMAL(18,4) NOT NULL,
    "cost_amount" DECIMAL(18,4) NOT NULL,
    "balance_before" DECIMAL(18,4) NOT NULL,
    "balance_after" DECIMAL(18,4) NOT NULL,
    "cost_before" DECIMAL(18,4) NOT NULL,
    "cost_after" DECIMAL(18,4) NOT NULL,
    "average_cost_before" DECIMAL(18,8) NOT NULL,
    "average_cost_after" DECIMAL(18,8) NOT NULL,
    "reversal_of_entry_id" UUID,
    "idempotency_key" VARCHAR(160) NOT NULL,
    "remark" TEXT,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "id_business_v2_balance_ledger_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "id_business_v2_orders" (
    "id" UUID NOT NULL,
    "order_no" VARCHAR(40) NOT NULL,
    "customer_id" UUID NOT NULL,
    "service_option_id" UUID NOT NULL,
    "account_id" UUID,
    "settlement_platform_option_id" UUID,
    "platform_order_no" VARCHAR(160),
    "website_account_encrypted" TEXT,
    "website_account_hash" VARCHAR(64),
    "website_account_masked" VARCHAR(255),
    "received_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "platform_fee_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "account_cost_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "balance_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "balance_cost_amount" DECIMAL(18,4) NOT NULL DEFAULT 0,
    "refund_cost_amount" DECIMAL(18,4),
    "profit_amount" DECIMAL(18,4),
    "status" "IdBusinessV2OrderStatus" NOT NULL DEFAULT 'draft',
    "status_changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "opened_at" TIMESTAMPTZ(6),
    "due_at" TIMESTAMPTZ(6),
    "idempotency_key" VARCHAR(160) NOT NULL,
    "remark" TEXT,
    "created_by_user_id" UUID,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,
    "deleted_at" TIMESTAMPTZ(6),

    CONSTRAINT "id_business_v2_orders_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "id_business_v2_account_locks" (
    "id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "service_option_id" UUID,
    "order_id" UUID NOT NULL,
    "lock_scope" "IdBusinessV2AccountLockScope" NOT NULL DEFAULT 'by_service',
    "status" "IdBusinessV2AccountLockStatus" NOT NULL DEFAULT 'active',
    "lock_token" VARCHAR(64) NOT NULL,
    "reason" TEXT,
    "locked_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMPTZ(6) NOT NULL,
    "ended_at" TIMESTAMPTZ(6),
    "end_reason" TEXT,
    "created_by_user_id" UUID,
    "ended_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "id_business_v2_account_locks_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "id_business_v2_activations" (
    "id" UUID NOT NULL,
    "order_id" UUID NOT NULL,
    "renewed_from_activation_id" UUID,
    "customer_id" UUID NOT NULL,
    "account_id" UUID NOT NULL,
    "service_option_id" UUID NOT NULL,
    "opened_at" TIMESTAMPTZ(6) NOT NULL,
    "due_at" TIMESTAMPTZ(6),
    "status" "IdBusinessV2ActivationStatus" NOT NULL DEFAULT 'active',
    "status_changed_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "auto_renewal_status" "IdBusinessV2AutoRenewalStatus" NOT NULL DEFAULT 'unknown',
    "auto_renewal_changed_at" TIMESTAMPTZ(6),
    "remark" TEXT,
    "created_by_user_id" UUID,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "id_business_v2_activations_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "id_business_v2_renewal_warning_settings" (
    "id" UUID NOT NULL,
    "scope" VARCHAR(32) NOT NULL DEFAULT 'global',
    "warning_days" INTEGER NOT NULL DEFAULT 3,
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "id_business_v2_renewal_warning_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "id_business_v2_exchange_rate_runs" (
    "id" UUID NOT NULL,
    "status" "IdBusinessV2ExchangeRateRunStatus" NOT NULL DEFAULT 'running',
    "trigger_type" "IdBusinessV2ExchangeRateTriggerType" NOT NULL,
    "asset" VARCHAR(16) NOT NULL DEFAULT 'USDT',
    "fiat" VARCHAR(16) NOT NULL DEFAULT 'CNY',
    "target_amount_rmb" DECIMAL(18,2),
    "started_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finished_at" TIMESTAMPTZ(6),
    "policy_min_completed_order_count" INTEGER,
    "policy_min_completion_rate" DECIMAL(9,8),
    "policy_max_price_deviation_rate" DECIMAL(9,8),
    "policy_min_valid_ads_per_side" INTEGER,
    "policy_decimal_places" INTEGER,
    "error_code" VARCHAR(120),
    "error_message" TEXT,
    "error_provider" "IdBusinessV2ExchangeRateErrorProvider",
    "error_side" "IdBusinessV2OtcSide",
    "error_retryable" BOOLEAN,
    "error_details" JSONB,
    "triggered_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "id_business_v2_exchange_rate_runs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "id_business_v2_exchange_rate_entries" (
    "id" UUID NOT NULL,
    "binance_merchant_buy_rate_to_rmb" DECIMAL(18,8) NOT NULL,
    "binance_merchant_sell_rate_to_rmb" DECIMAL(18,8) NOT NULL,
    "okx_merchant_buy_rate_to_rmb" DECIMAL(18,8) NOT NULL,
    "okx_merchant_sell_rate_to_rmb" DECIMAL(18,8) NOT NULL,
    "combined_merchant_buy_average_rate_to_rmb" DECIMAL(18,8) NOT NULL,
    "combined_merchant_sell_average_rate_to_rmb" DECIMAL(18,8) NOT NULL,
    "mid_rate_to_rmb" DECIMAL(18,8) NOT NULL,
    "recorded_at" TIMESTAMPTZ(6) NOT NULL,
    "remark" TEXT,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "id_business_v2_exchange_rate_entries_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "id_business_v2_exchange_rate_snapshots" (
    "id" UUID NOT NULL,
    "run_id" UUID NOT NULL,
    "asset" VARCHAR(16) NOT NULL,
    "fiat" VARCHAR(16) NOT NULL,
    "averaged_at" TIMESTAMPTZ(6) NOT NULL,
    "combined_merchant_buy_average_rate_to_rmb" DECIMAL(18,8) NOT NULL,
    "combined_merchant_sell_average_rate_to_rmb" DECIMAL(18,8) NOT NULL,
    "mid_rate_to_rmb" DECIMAL(18,8) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "id_business_v2_exchange_rate_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "id_business_v2_exchange_rate_settings" (
    "id" INTEGER NOT NULL DEFAULT 1,
    "auto_enabled" BOOLEAN NOT NULL DEFAULT true,
    "interval_minutes" INTEGER NOT NULL DEFAULT 30,
    "target_amount_rmb" DECIMAL(18,2) NOT NULL DEFAULT 5000,
    "next_run_at" TIMESTAMPTZ(6),
    "updated_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "id_business_v2_exchange_rate_settings_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "id_business_v2_exchange_rate_provider_snapshots" (
    "id" UUID NOT NULL,
    "snapshot_id" UUID NOT NULL,
    "provider" "IdBusinessV2OtcProvider" NOT NULL,
    "side" "IdBusinessV2OtcSide" NOT NULL,
    "source_contract" VARCHAR(120) NOT NULL,
    "source_url" VARCHAR(2048) NOT NULL,
    "collected_at" TIMESTAMPTZ(6) NOT NULL,
    "received_ad_count" INTEGER NOT NULL,
    "collector_accepted_ad_count" INTEGER NOT NULL,
    "collector_rejected_ad_count" INTEGER NOT NULL,
    "valid_ad_count" INTEGER NOT NULL,
    "filtered_ad_count" INTEGER NOT NULL,
    "excluded_missing_tradable_amount" INTEGER NOT NULL,
    "excluded_non_positive_tradable" INTEGER NOT NULL,
    "excluded_missing_order_count" INTEGER NOT NULL,
    "excluded_low_order_count" INTEGER NOT NULL,
    "excluded_missing_completion_rate" INTEGER NOT NULL,
    "excluded_low_completion_rate" INTEGER NOT NULL,
    "excluded_price_outlier" INTEGER NOT NULL,
    "median_rate_to_rmb" DECIMAL(18,8) NOT NULL,
    "lowest_valid_rate_to_rmb" DECIMAL(18,8) NOT NULL,
    "highest_valid_rate_to_rmb" DECIMAL(18,8) NOT NULL,
    "average_rate_to_rmb" DECIMAL(18,8) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "id_business_v2_exchange_rate_provider_snapshots_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "id_business_v2_exchange_rate_quote_samples" (
    "id" UUID NOT NULL,
    "provider_snapshot_id" UUID NOT NULL,
    "source_ad_id" VARCHAR(200) NOT NULL,
    "price_to_rmb" DECIMAL(18,8) NOT NULL,
    "min_amount_rmb" DECIMAL(24,8),
    "max_amount_rmb" DECIMAL(24,8),
    "tradable_amount_usdt" DECIMAL(24,8) NOT NULL,
    "payment_methods" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "merchant_type" VARCHAR(80) NOT NULL,
    "completed_order_count" INTEGER NOT NULL,
    "completion_rate" DECIMAL(9,8) NOT NULL,
    "positive_review_rate" DECIMAL(9,8),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "id_business_v2_exchange_rate_quote_samples_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "roles" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "code" VARCHAR(100) NOT NULL,
    "description" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "roles_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "permissions" (
    "id" UUID NOT NULL,
    "name" VARCHAR(100) NOT NULL,
    "code" VARCHAR(150) NOT NULL,
    "module" VARCHAR(100) NOT NULL,
    "action" VARCHAR(100) NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "permissions_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "user_roles" (
    "user_id" UUID NOT NULL,
    "role_id" UUID NOT NULL,

    CONSTRAINT "user_roles_pkey" PRIMARY KEY ("user_id","role_id")
);

-- CreateTable
CREATE TABLE "role_permissions" (
    "role_id" UUID NOT NULL,
    "permission_id" UUID NOT NULL,

    CONSTRAINT "role_permissions_pkey" PRIMARY KEY ("role_id","permission_id")
);

-- CreateTable
CREATE TABLE "audit_logs" (
    "id" UUID NOT NULL,
    "user_id" UUID,
    "module" VARCHAR(100) NOT NULL,
    "action" VARCHAR(100) NOT NULL,
    "object_type" VARCHAR(100),
    "object_id" UUID,
    "before_data" JSONB,
    "after_data" JSONB,
    "ip" VARCHAR(100),
    "user_agent" TEXT,
    "remark" TEXT,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "audit_logs_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "v2_auth_identities" (
    "id" UUID NOT NULL,
    "auth_user_id" UUID NOT NULL,
    "user_id" UUID NOT NULL,
    "username_normalized" VARCHAR(100) NOT NULL,
    "auth_email" VARCHAR(255) NOT NULL,
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "must_reset_password" BOOLEAN NOT NULL DEFAULT true,
    "last_authenticated_at" TIMESTAMPTZ(6),
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "v2_auth_identities_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "attachments" (
    "id" UUID NOT NULL,
    "original_name" VARCHAR(255) NOT NULL,
    "storage_key" VARCHAR(500) NOT NULL,
    "mime_type" VARCHAR(150) NOT NULL,
    "size_bytes" BIGINT NOT NULL,
    "business_module" VARCHAR(80),
    "object_type" VARCHAR(120),
    "object_id" UUID,
    "purpose" VARCHAR(120),
    "remark" TEXT,
    "created_by_user_id" UUID,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "attachments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "users_username_key" ON "users"("username");

-- CreateIndex
CREATE INDEX "users_status_idx" ON "users"("status");

-- CreateIndex
CREATE INDEX "users_deleted_at_idx" ON "users"("deleted_at");

-- CreateIndex
CREATE INDEX "login_logs_user_id_idx" ON "login_logs"("user_id");

-- CreateIndex
CREATE INDEX "login_logs_username_idx" ON "login_logs"("username");

-- CreateIndex
CREATE INDEX "login_logs_ip_idx" ON "login_logs"("ip");

-- CreateIndex
CREATE INDEX "login_logs_abnormal_idx" ON "login_logs"("abnormal");

-- CreateIndex
CREATE INDEX "login_logs_created_at_idx" ON "login_logs"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "active_sessions_token_hash_key" ON "active_sessions"("token_hash");

-- CreateIndex
CREATE INDEX "active_sessions_user_id_idx" ON "active_sessions"("user_id");

-- CreateIndex
CREATE INDEX "active_sessions_expires_at_idx" ON "active_sessions"("expires_at");

-- CreateIndex
CREATE INDEX "active_sessions_revoked_at_idx" ON "active_sessions"("revoked_at");

-- CreateIndex
CREATE UNIQUE INDEX "security_settings_key_key" ON "security_settings"("key");

-- CreateIndex
CREATE INDEX "security_settings_updated_by_user_id_idx" ON "security_settings"("updated_by_user_id");

-- CreateIndex
CREATE INDEX "ip_whitelists_scope_enabled_idx" ON "ip_whitelists"("scope", "enabled");

-- CreateIndex
CREATE INDEX "ip_whitelists_created_by_user_id_idx" ON "ip_whitelists"("created_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "ip_whitelists_ip_or_cidr_scope_key" ON "ip_whitelists"("ip_or_cidr", "scope");

-- CreateIndex
CREATE INDEX "sensitive_access_logs_user_id_idx" ON "sensitive_access_logs"("user_id");

-- CreateIndex
CREATE INDEX "sensitive_access_logs_module_field_name_idx" ON "sensitive_access_logs"("module", "field_name");

-- CreateIndex
CREATE INDEX "sensitive_access_logs_object_type_object_id_idx" ON "sensitive_access_logs"("object_type", "object_id");

-- CreateIndex
CREATE INDEX "sensitive_access_logs_approved_idx" ON "sensitive_access_logs"("approved");

-- CreateIndex
CREATE INDEX "sensitive_access_logs_created_at_idx" ON "sensitive_access_logs"("created_at");

-- CreateIndex
CREATE INDEX "sensitive_access_approvals_requester_id_idx" ON "sensitive_access_approvals"("requester_id");

-- CreateIndex
CREATE INDEX "sensitive_access_approvals_approver_id_idx" ON "sensitive_access_approvals"("approver_id");

-- CreateIndex
CREATE INDEX "sensitive_access_approvals_module_field_name_idx" ON "sensitive_access_approvals"("module", "field_name");

-- CreateIndex
CREATE INDEX "sensitive_access_approvals_status_idx" ON "sensitive_access_approvals"("status");

-- CreateIndex
CREATE INDEX "sensitive_access_approvals_expires_at_idx" ON "sensitive_access_approvals"("expires_at");

-- CreateIndex
CREATE INDEX "sensitive_access_approvals_created_at_idx" ON "sensitive_access_approvals"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "id_business_v2_options_unique_key_key" ON "id_business_v2_options"("unique_key");

-- CreateIndex
CREATE INDEX "id_business_v2_options_type_status_sort_order_idx" ON "id_business_v2_options"("type", "status", "sort_order");

-- CreateIndex
CREATE INDEX "id_business_v2_options_parent_id_idx" ON "id_business_v2_options"("parent_id");

-- CreateIndex
CREATE INDEX "id_business_v2_options_country_option_id_idx" ON "id_business_v2_options"("country_option_id");

-- CreateIndex
CREATE INDEX "id_business_v2_options_deleted_at_idx" ON "id_business_v2_options"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "id_business_v2_options_type_code_key" ON "id_business_v2_options"("type", "code");

-- CreateIndex
CREATE INDEX "id_business_v2_customers_name_idx" ON "id_business_v2_customers"("name");

-- CreateIndex
CREATE INDEX "id_business_v2_customers_phone_hash_idx" ON "id_business_v2_customers"("phone_hash");

-- CreateIndex
CREATE INDEX "id_business_v2_customers_phone_tail_idx" ON "id_business_v2_customers"("phone_tail");

-- CreateIndex
CREATE INDEX "id_business_v2_customers_source_option_id_idx" ON "id_business_v2_customers"("source_option_id");

-- CreateIndex
CREATE INDEX "id_business_v2_customers_record_status_updated_at_idx" ON "id_business_v2_customers"("record_status", "updated_at");

-- CreateIndex
CREATE INDEX "id_business_v2_customers_deleted_at_idx" ON "id_business_v2_customers"("deleted_at");

-- CreateIndex
CREATE INDEX "id_business_v2_customer_tags_option_id_idx" ON "id_business_v2_customer_tags"("option_id");

-- CreateIndex
CREATE INDEX "id_business_v2_customer_services_option_id_idx" ON "id_business_v2_customer_services"("option_id");

-- CreateIndex
CREATE UNIQUE INDEX "id_business_v2_accounts_apple_id_hash_key" ON "id_business_v2_accounts"("apple_id_hash");

-- CreateIndex
CREATE INDEX "id_business_v2_accounts_apple_id_masked_idx" ON "id_business_v2_accounts"("apple_id_masked");

-- CreateIndex
CREATE INDEX "id_business_v2_accounts_phone_hash_idx" ON "id_business_v2_accounts"("phone_hash");

-- CreateIndex
CREATE INDEX "id_business_v2_accounts_phone_tail_idx" ON "id_business_v2_accounts"("phone_tail");

-- CreateIndex
CREATE INDEX "id_business_v2_accounts_country_option_id_idx" ON "id_business_v2_accounts"("country_option_id");

-- CreateIndex
CREATE INDEX "id_business_v2_accounts_status_option_id_idx" ON "id_business_v2_accounts"("status_option_id");

-- CreateIndex
CREATE INDEX "id_business_v2_accounts_supplier_option_id_idx" ON "id_business_v2_accounts"("supplier_option_id");

-- CreateIndex
CREATE INDEX "id_business_v2_accounts_record_status_updated_at_idx" ON "id_business_v2_accounts"("record_status", "updated_at");

-- CreateIndex
CREATE INDEX "id_business_v2_accounts_deleted_at_idx" ON "id_business_v2_accounts"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "id_business_v2_gift_cards_code_hash_key" ON "id_business_v2_gift_cards"("code_hash");

-- CreateIndex
CREATE INDEX "id_business_v2_gift_cards_account_id_created_at_idx" ON "id_business_v2_gift_cards"("account_id", "created_at");

-- CreateIndex
CREATE INDEX "id_business_v2_gift_cards_supplier_option_id_idx" ON "id_business_v2_gift_cards"("supplier_option_id");

-- CreateIndex
CREATE INDEX "id_business_v2_gift_cards_source_attachment_id_idx" ON "id_business_v2_gift_cards"("source_attachment_id");

-- CreateIndex
CREATE INDEX "id_business_v2_gift_cards_exchange_rate_snapshot_id_idx" ON "id_business_v2_gift_cards"("exchange_rate_snapshot_id");

-- CreateIndex
CREATE INDEX "id_business_v2_gift_cards_status_status_changed_at_idx" ON "id_business_v2_gift_cards"("status", "status_changed_at");

-- CreateIndex
CREATE INDEX "id_business_v2_gift_cards_created_by_user_id_idx" ON "id_business_v2_gift_cards"("created_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "id_business_v2_balance_ledger_reversal_of_entry_id_key" ON "id_business_v2_balance_ledger"("reversal_of_entry_id");

-- CreateIndex
CREATE UNIQUE INDEX "id_business_v2_balance_ledger_idempotency_key_key" ON "id_business_v2_balance_ledger"("idempotency_key");

-- CreateIndex
CREATE INDEX "id_business_v2_balance_ledger_account_id_created_at_idx" ON "id_business_v2_balance_ledger"("account_id", "created_at");

-- CreateIndex
CREATE INDEX "id_business_v2_balance_ledger_gift_card_id_idx" ON "id_business_v2_balance_ledger"("gift_card_id");

-- CreateIndex
CREATE INDEX "id_business_v2_balance_ledger_order_id_idx" ON "id_business_v2_balance_ledger"("order_id");

-- CreateIndex
CREATE INDEX "id_business_v2_balance_ledger_entry_type_created_at_idx" ON "id_business_v2_balance_ledger"("entry_type", "created_at");

-- CreateIndex
CREATE INDEX "id_business_v2_balance_ledger_direction_created_at_idx" ON "id_business_v2_balance_ledger"("direction", "created_at");

-- CreateIndex
CREATE INDEX "id_business_v2_balance_ledger_created_by_user_id_idx" ON "id_business_v2_balance_ledger"("created_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "id_business_v2_balance_ledger_gift_card_id_entry_type_key" ON "id_business_v2_balance_ledger"("gift_card_id", "entry_type");

-- CreateIndex
CREATE UNIQUE INDEX "id_business_v2_balance_ledger_order_id_entry_type_key" ON "id_business_v2_balance_ledger"("order_id", "entry_type");

-- CreateIndex
CREATE UNIQUE INDEX "id_business_v2_orders_order_no_key" ON "id_business_v2_orders"("order_no");

-- CreateIndex
CREATE UNIQUE INDEX "id_business_v2_orders_idempotency_key_key" ON "id_business_v2_orders"("idempotency_key");

-- CreateIndex
CREATE INDEX "id_business_v2_orders_customer_id_idx" ON "id_business_v2_orders"("customer_id");

-- CreateIndex
CREATE INDEX "id_business_v2_orders_service_option_id_idx" ON "id_business_v2_orders"("service_option_id");

-- CreateIndex
CREATE INDEX "id_business_v2_orders_account_id_idx" ON "id_business_v2_orders"("account_id");

-- CreateIndex
CREATE INDEX "id_business_v2_orders_settlement_platform_option_id_idx" ON "id_business_v2_orders"("settlement_platform_option_id");

-- CreateIndex
CREATE INDEX "id_business_v2_orders_website_account_hash_idx" ON "id_business_v2_orders"("website_account_hash");

-- CreateIndex
CREATE INDEX "id_business_v2_orders_status_status_changed_at_idx" ON "id_business_v2_orders"("status", "status_changed_at");

-- CreateIndex
CREATE INDEX "id_business_v2_orders_opened_at_idx" ON "id_business_v2_orders"("opened_at");

-- CreateIndex
CREATE INDEX "id_business_v2_orders_due_at_idx" ON "id_business_v2_orders"("due_at");

-- CreateIndex
CREATE INDEX "id_business_v2_orders_created_by_user_id_idx" ON "id_business_v2_orders"("created_by_user_id");

-- CreateIndex
CREATE INDEX "id_business_v2_orders_deleted_at_idx" ON "id_business_v2_orders"("deleted_at");

-- CreateIndex
CREATE UNIQUE INDEX "id_business_v2_orders_platform_order_key" ON "id_business_v2_orders"("settlement_platform_option_id", "platform_order_no");

-- CreateIndex
CREATE UNIQUE INDEX "id_business_v2_account_locks_lock_token_key" ON "id_business_v2_account_locks"("lock_token");

-- CreateIndex
CREATE INDEX "id_business_v2_account_locks_account_id_status_idx" ON "id_business_v2_account_locks"("account_id", "status");

-- CreateIndex
CREATE INDEX "id_business_v2_account_locks_service_option_id_status_idx" ON "id_business_v2_account_locks"("service_option_id", "status");

-- CreateIndex
CREATE INDEX "id_business_v2_account_locks_order_id_status_idx" ON "id_business_v2_account_locks"("order_id", "status");

-- CreateIndex
CREATE INDEX "id_business_v2_account_locks_lock_scope_status_idx" ON "id_business_v2_account_locks"("lock_scope", "status");

-- CreateIndex
CREATE INDEX "id_business_v2_account_locks_expires_at_status_idx" ON "id_business_v2_account_locks"("expires_at", "status");

-- CreateIndex
CREATE INDEX "id_business_v2_account_locks_created_by_user_id_idx" ON "id_business_v2_account_locks"("created_by_user_id");

-- CreateIndex
CREATE INDEX "id_business_v2_account_locks_ended_by_user_id_idx" ON "id_business_v2_account_locks"("ended_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "id_business_v2_activations_order_id_key" ON "id_business_v2_activations"("order_id");

-- CreateIndex
CREATE UNIQUE INDEX "id_business_v2_activations_renewed_from_activation_id_key" ON "id_business_v2_activations"("renewed_from_activation_id");

-- CreateIndex
CREATE INDEX "id_business_v2_activations_customer_id_idx" ON "id_business_v2_activations"("customer_id");

-- CreateIndex
CREATE INDEX "id_business_v2_activations_account_id_idx" ON "id_business_v2_activations"("account_id");

-- CreateIndex
CREATE INDEX "id_business_v2_activations_service_option_id_idx" ON "id_business_v2_activations"("service_option_id");

-- CreateIndex
CREATE INDEX "id_business_v2_activations_status_due_at_idx" ON "id_business_v2_activations"("status", "due_at");

-- CreateIndex
CREATE INDEX "id_business_v2_activations_opened_at_idx" ON "id_business_v2_activations"("opened_at");

-- CreateIndex
CREATE INDEX "id_business_v2_activations_created_by_user_id_idx" ON "id_business_v2_activations"("created_by_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "id_business_v2_renewal_warning_settings_scope_key" ON "id_business_v2_renewal_warning_settings"("scope");

-- CreateIndex
CREATE INDEX "id_business_v2_renewal_warning_settings_updated_by_user_id_idx" ON "id_business_v2_renewal_warning_settings"("updated_by_user_id");

-- CreateIndex
CREATE INDEX "id_business_v2_exchange_rate_runs_status_started_at_idx" ON "id_business_v2_exchange_rate_runs"("status", "started_at");

-- CreateIndex
CREATE INDEX "id_business_v2_exchange_rate_runs_trigger_type_started_at_idx" ON "id_business_v2_exchange_rate_runs"("trigger_type", "started_at");

-- CreateIndex
CREATE INDEX "id_business_v2_exchange_rate_runs_triggered_by_user_id_idx" ON "id_business_v2_exchange_rate_runs"("triggered_by_user_id");

-- CreateIndex
CREATE INDEX "id_business_v2_exchange_rate_runs_created_at_idx" ON "id_business_v2_exchange_rate_runs"("created_at");

-- CreateIndex
CREATE INDEX "id_business_v2_exchange_rate_entries_recorded_at_idx" ON "id_business_v2_exchange_rate_entries"("recorded_at");

-- CreateIndex
CREATE INDEX "id_business_v2_exchange_rate_entries_created_by_user_id_idx" ON "id_business_v2_exchange_rate_entries"("created_by_user_id");

-- CreateIndex
CREATE INDEX "id_business_v2_exchange_rate_entries_created_at_idx" ON "id_business_v2_exchange_rate_entries"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "id_business_v2_exchange_rate_snapshots_run_id_key" ON "id_business_v2_exchange_rate_snapshots"("run_id");

-- CreateIndex
CREATE INDEX "id_business_v2_exchange_rate_snapshots_averaged_at_idx" ON "id_business_v2_exchange_rate_snapshots"("averaged_at");

-- CreateIndex
CREATE INDEX "id_business_v2_exchange_rate_snapshots_created_at_idx" ON "id_business_v2_exchange_rate_snapshots"("created_at");

-- CreateIndex
CREATE INDEX "id_business_v2_exchange_rate_settings_next_run_at_idx" ON "id_business_v2_exchange_rate_settings"("next_run_at");

-- CreateIndex
CREATE INDEX "id_business_v2_exchange_rate_settings_updated_by_user_id_idx" ON "id_business_v2_exchange_rate_settings"("updated_by_user_id");

-- CreateIndex
CREATE INDEX "id_business_v2_exchange_rate_provider_snapshots_provider_si_idx" ON "id_business_v2_exchange_rate_provider_snapshots"("provider", "side", "collected_at");

-- CreateIndex
CREATE INDEX "id_business_v2_exchange_rate_provider_snapshots_created_at_idx" ON "id_business_v2_exchange_rate_provider_snapshots"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "id_business_v2_exchange_rate_provider_snapshots_snapshot_id_key" ON "id_business_v2_exchange_rate_provider_snapshots"("snapshot_id", "provider", "side");

-- CreateIndex
CREATE INDEX "id_business_v2_exchange_rate_quote_samples_provider_snapsho_idx" ON "id_business_v2_exchange_rate_quote_samples"("provider_snapshot_id", "price_to_rmb");

-- CreateIndex
CREATE INDEX "id_business_v2_exchange_rate_quote_samples_created_at_idx" ON "id_business_v2_exchange_rate_quote_samples"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "id_business_v2_exchange_rate_quote_samples_provider_snapsho_key" ON "id_business_v2_exchange_rate_quote_samples"("provider_snapshot_id", "source_ad_id");

-- CreateIndex
CREATE UNIQUE INDEX "roles_code_key" ON "roles"("code");

-- CreateIndex
CREATE UNIQUE INDEX "permissions_code_key" ON "permissions"("code");

-- CreateIndex
CREATE INDEX "permissions_module_action_idx" ON "permissions"("module", "action");

-- CreateIndex
CREATE INDEX "audit_logs_user_id_idx" ON "audit_logs"("user_id");

-- CreateIndex
CREATE INDEX "audit_logs_module_action_idx" ON "audit_logs"("module", "action");

-- CreateIndex
CREATE INDEX "audit_logs_object_type_object_id_idx" ON "audit_logs"("object_type", "object_id");

-- CreateIndex
CREATE INDEX "audit_logs_created_at_idx" ON "audit_logs"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "v2_auth_identities_auth_user_id_key" ON "v2_auth_identities"("auth_user_id");

-- CreateIndex
CREATE UNIQUE INDEX "v2_auth_identities_user_id_key" ON "v2_auth_identities"("user_id");

-- CreateIndex
CREATE UNIQUE INDEX "v2_auth_identities_username_normalized_key" ON "v2_auth_identities"("username_normalized");

-- CreateIndex
CREATE UNIQUE INDEX "v2_auth_identities_auth_email_key" ON "v2_auth_identities"("auth_email");

-- CreateIndex
CREATE INDEX "v2_auth_identities_enabled_idx" ON "v2_auth_identities"("enabled");

-- CreateIndex
CREATE INDEX "v2_auth_identities_created_at_idx" ON "v2_auth_identities"("created_at");

-- CreateIndex
CREATE UNIQUE INDEX "attachments_storage_key_key" ON "attachments"("storage_key");

-- CreateIndex
CREATE INDEX "attachments_created_by_user_id_idx" ON "attachments"("created_by_user_id");

-- CreateIndex
CREATE INDEX "attachments_business_module_object_type_idx" ON "attachments"("business_module", "object_type");

-- CreateIndex
CREATE INDEX "attachments_object_id_idx" ON "attachments"("object_id");

-- CreateIndex
CREATE INDEX "attachments_purpose_idx" ON "attachments"("purpose");

-- CreateIndex
CREATE INDEX "attachments_created_at_idx" ON "attachments"("created_at");

-- AddForeignKey
ALTER TABLE "login_logs" ADD CONSTRAINT "login_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "active_sessions" ADD CONSTRAINT "active_sessions_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "security_settings" ADD CONSTRAINT "security_settings_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ip_whitelists" ADD CONSTRAINT "ip_whitelists_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sensitive_access_logs" ADD CONSTRAINT "sensitive_access_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sensitive_access_approvals" ADD CONSTRAINT "sensitive_access_approvals_requester_id_fkey" FOREIGN KEY ("requester_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "sensitive_access_approvals" ADD CONSTRAINT "sensitive_access_approvals_approver_id_fkey" FOREIGN KEY ("approver_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_options" ADD CONSTRAINT "id_business_v2_options_parent_id_fkey" FOREIGN KEY ("parent_id") REFERENCES "id_business_v2_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_options" ADD CONSTRAINT "id_business_v2_options_country_option_id_fkey" FOREIGN KEY ("country_option_id") REFERENCES "id_business_v2_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_options" ADD CONSTRAINT "id_business_v2_options_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_options" ADD CONSTRAINT "id_business_v2_options_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_customers" ADD CONSTRAINT "id_business_v2_customers_source_option_id_fkey" FOREIGN KEY ("source_option_id") REFERENCES "id_business_v2_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_customers" ADD CONSTRAINT "id_business_v2_customers_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_customers" ADD CONSTRAINT "id_business_v2_customers_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_customer_tags" ADD CONSTRAINT "id_business_v2_customer_tags_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "id_business_v2_customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_customer_tags" ADD CONSTRAINT "id_business_v2_customer_tags_option_id_fkey" FOREIGN KEY ("option_id") REFERENCES "id_business_v2_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_customer_services" ADD CONSTRAINT "id_business_v2_customer_services_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "id_business_v2_customers"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_customer_services" ADD CONSTRAINT "id_business_v2_customer_services_option_id_fkey" FOREIGN KEY ("option_id") REFERENCES "id_business_v2_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_accounts" ADD CONSTRAINT "id_business_v2_accounts_country_option_id_fkey" FOREIGN KEY ("country_option_id") REFERENCES "id_business_v2_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_accounts" ADD CONSTRAINT "id_business_v2_accounts_status_option_id_fkey" FOREIGN KEY ("status_option_id") REFERENCES "id_business_v2_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_accounts" ADD CONSTRAINT "id_business_v2_accounts_supplier_option_id_fkey" FOREIGN KEY ("supplier_option_id") REFERENCES "id_business_v2_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_accounts" ADD CONSTRAINT "id_business_v2_accounts_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_accounts" ADD CONSTRAINT "id_business_v2_accounts_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_gift_cards" ADD CONSTRAINT "id_business_v2_gift_cards_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "id_business_v2_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_gift_cards" ADD CONSTRAINT "id_business_v2_gift_cards_supplier_option_id_fkey" FOREIGN KEY ("supplier_option_id") REFERENCES "id_business_v2_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_gift_cards" ADD CONSTRAINT "id_business_v2_gift_cards_source_attachment_id_fkey" FOREIGN KEY ("source_attachment_id") REFERENCES "attachments"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_gift_cards" ADD CONSTRAINT "id_business_v2_gift_cards_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_gift_cards" ADD CONSTRAINT "id_business_v2_gift_cards_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_gift_cards" ADD CONSTRAINT "id_business_v2_gift_cards_exchange_rate_snapshot_id_fkey" FOREIGN KEY ("exchange_rate_snapshot_id") REFERENCES "id_business_v2_exchange_rate_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_balance_ledger" ADD CONSTRAINT "id_business_v2_balance_ledger_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "id_business_v2_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_balance_ledger" ADD CONSTRAINT "id_business_v2_balance_ledger_gift_card_id_fkey" FOREIGN KEY ("gift_card_id") REFERENCES "id_business_v2_gift_cards"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_balance_ledger" ADD CONSTRAINT "id_business_v2_balance_ledger_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "id_business_v2_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_balance_ledger" ADD CONSTRAINT "id_business_v2_balance_ledger_reversal_of_entry_id_fkey" FOREIGN KEY ("reversal_of_entry_id") REFERENCES "id_business_v2_balance_ledger"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_balance_ledger" ADD CONSTRAINT "id_business_v2_balance_ledger_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_orders" ADD CONSTRAINT "id_business_v2_orders_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "id_business_v2_customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_orders" ADD CONSTRAINT "id_business_v2_orders_service_option_id_fkey" FOREIGN KEY ("service_option_id") REFERENCES "id_business_v2_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_orders" ADD CONSTRAINT "id_business_v2_orders_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "id_business_v2_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_orders" ADD CONSTRAINT "id_business_v2_orders_settlement_platform_option_id_fkey" FOREIGN KEY ("settlement_platform_option_id") REFERENCES "id_business_v2_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_orders" ADD CONSTRAINT "id_business_v2_orders_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_orders" ADD CONSTRAINT "id_business_v2_orders_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_account_locks" ADD CONSTRAINT "id_business_v2_account_locks_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "id_business_v2_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_account_locks" ADD CONSTRAINT "id_business_v2_account_locks_service_option_id_fkey" FOREIGN KEY ("service_option_id") REFERENCES "id_business_v2_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_account_locks" ADD CONSTRAINT "id_business_v2_account_locks_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "id_business_v2_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_account_locks" ADD CONSTRAINT "id_business_v2_account_locks_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_account_locks" ADD CONSTRAINT "id_business_v2_account_locks_ended_by_user_id_fkey" FOREIGN KEY ("ended_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_activations" ADD CONSTRAINT "id_business_v2_activations_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "id_business_v2_orders"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_activations" ADD CONSTRAINT "id_business_v2_activations_renewed_from_activation_id_fkey" FOREIGN KEY ("renewed_from_activation_id") REFERENCES "id_business_v2_activations"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_activations" ADD CONSTRAINT "id_business_v2_activations_customer_id_fkey" FOREIGN KEY ("customer_id") REFERENCES "id_business_v2_customers"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_activations" ADD CONSTRAINT "id_business_v2_activations_account_id_fkey" FOREIGN KEY ("account_id") REFERENCES "id_business_v2_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_activations" ADD CONSTRAINT "id_business_v2_activations_service_option_id_fkey" FOREIGN KEY ("service_option_id") REFERENCES "id_business_v2_options"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_activations" ADD CONSTRAINT "id_business_v2_activations_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_activations" ADD CONSTRAINT "id_business_v2_activations_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_renewal_warning_settings" ADD CONSTRAINT "id_business_v2_renewal_warning_settings_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_exchange_rate_runs" ADD CONSTRAINT "id_business_v2_exchange_rate_runs_triggered_by_user_id_fkey" FOREIGN KEY ("triggered_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_exchange_rate_entries" ADD CONSTRAINT "id_business_v2_exchange_rate_entries_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_exchange_rate_snapshots" ADD CONSTRAINT "id_business_v2_exchange_rate_snapshots_run_id_fkey" FOREIGN KEY ("run_id") REFERENCES "id_business_v2_exchange_rate_runs"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_exchange_rate_settings" ADD CONSTRAINT "id_business_v2_exchange_rate_settings_updated_by_user_id_fkey" FOREIGN KEY ("updated_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_exchange_rate_provider_snapshots" ADD CONSTRAINT "id_business_v2_exchange_rate_provider_snapshots_snapshot_i_fkey" FOREIGN KEY ("snapshot_id") REFERENCES "id_business_v2_exchange_rate_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "id_business_v2_exchange_rate_quote_samples" ADD CONSTRAINT "id_business_v2_exchange_rate_quote_samples_provider_snapsh_fkey" FOREIGN KEY ("provider_snapshot_id") REFERENCES "id_business_v2_exchange_rate_provider_snapshots"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "user_roles" ADD CONSTRAINT "user_roles_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_role_id_fkey" FOREIGN KEY ("role_id") REFERENCES "roles"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "role_permissions" ADD CONSTRAINT "role_permissions_permission_id_fkey" FOREIGN KEY ("permission_id") REFERENCES "permissions"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "audit_logs" ADD CONSTRAINT "audit_logs_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "v2_auth_identities" ADD CONSTRAINT "v2_auth_identities_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_created_by_user_id_fkey" FOREIGN KEY ("created_by_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- Current-system database invariants

ALTER TABLE "public"."id_business_v2_account_locks"
ADD CONSTRAINT "id_business_v2_account_locks_expiry_check" CHECK (expires_at > locked_at);

ALTER TABLE "public"."id_business_v2_account_locks"
ADD CONSTRAINT "id_business_v2_account_locks_lifecycle_check" CHECK (status = 'active'::"IdBusinessV2AccountLockStatus" AND ended_at IS NULL AND ended_by_user_id IS NULL OR (status = ANY (ARRAY['released'::"IdBusinessV2AccountLockStatus", 'expired'::"IdBusinessV2AccountLockStatus"])) AND ended_at IS NOT NULL);

ALTER TABLE "public"."id_business_v2_account_locks"
ADD CONSTRAINT "id_business_v2_account_locks_scope_check" CHECK (lock_scope = 'by_service'::"IdBusinessV2AccountLockScope" AND service_option_id IS NOT NULL OR lock_scope = 'global'::"IdBusinessV2AccountLockScope" AND service_option_id IS NULL);

ALTER TABLE "public"."id_business_v2_accounts"
ADD CONSTRAINT "id_business_v2_accounts_balance_cost_amount_check" CHECK (balance_cost_amount >= 0::numeric);

ALTER TABLE "public"."id_business_v2_accounts"
ADD CONSTRAINT "id_business_v2_accounts_current_balance_check" CHECK (current_balance >= 0::numeric);

ALTER TABLE "public"."id_business_v2_accounts"
ADD CONSTRAINT "id_business_v2_accounts_purchase_cost_check" CHECK (purchase_cost >= 0::numeric);

ALTER TABLE "public"."id_business_v2_activations"
ADD CONSTRAINT "id_business_v2_activations_auto_renewal_check" CHECK (auto_renewal_status = 'unknown'::"IdBusinessV2AutoRenewalStatus" AND auto_renewal_changed_at IS NULL OR (auto_renewal_status = ANY (ARRAY['enabled'::"IdBusinessV2AutoRenewalStatus", 'disabled'::"IdBusinessV2AutoRenewalStatus"])) AND auto_renewal_changed_at IS NOT NULL);

ALTER TABLE "public"."id_business_v2_activations"
ADD CONSTRAINT "id_business_v2_activations_due_at_check" CHECK (due_at IS NULL OR due_at > opened_at);

ALTER TABLE "public"."id_business_v2_balance_ledger"
ADD CONSTRAINT "id_business_v2_balance_ledger_average_cost_after_check" CHECK (average_cost_after >= 0::numeric);

ALTER TABLE "public"."id_business_v2_balance_ledger"
ADD CONSTRAINT "id_business_v2_balance_ledger_average_cost_before_check" CHECK (average_cost_before >= 0::numeric);

ALTER TABLE "public"."id_business_v2_balance_ledger"
ADD CONSTRAINT "id_business_v2_balance_ledger_balance_after_check" CHECK (balance_after >= 0::numeric);

ALTER TABLE "public"."id_business_v2_balance_ledger"
ADD CONSTRAINT "id_business_v2_balance_ledger_balance_amount_check" CHECK (balance_amount >= 0::numeric);

ALTER TABLE "public"."id_business_v2_balance_ledger"
ADD CONSTRAINT "id_business_v2_balance_ledger_balance_before_check" CHECK (balance_before >= 0::numeric);

ALTER TABLE "public"."id_business_v2_balance_ledger"
ADD CONSTRAINT "id_business_v2_balance_ledger_business_reference_check" CHECK (entry_type = 'gift_card_credit'::"IdBusinessV2BalanceLedgerEntryType" AND direction = 'credit'::"IdBusinessV2BalanceDirection" AND gift_card_id IS NOT NULL AND order_id IS NULL AND reversal_of_entry_id IS NULL OR (entry_type = ANY (ARRAY['gift_card_redeemed'::"IdBusinessV2BalanceLedgerEntryType", 'gift_card_withdrawal'::"IdBusinessV2BalanceLedgerEntryType"])) AND direction = 'debit'::"IdBusinessV2BalanceDirection" AND gift_card_id IS NOT NULL AND order_id IS NULL AND reversal_of_entry_id IS NOT NULL OR entry_type = 'order_consumption'::"IdBusinessV2BalanceLedgerEntryType" AND direction = 'debit'::"IdBusinessV2BalanceDirection" AND gift_card_id IS NULL AND order_id IS NOT NULL AND reversal_of_entry_id IS NULL OR entry_type = 'order_consumption_reversal'::"IdBusinessV2BalanceLedgerEntryType" AND direction = 'credit'::"IdBusinessV2BalanceDirection" AND gift_card_id IS NULL AND order_id IS NOT NULL AND reversal_of_entry_id IS NOT NULL OR entry_type = 'opening_balance'::"IdBusinessV2BalanceLedgerEntryType" AND direction = 'credit'::"IdBusinessV2BalanceDirection" AND gift_card_id IS NULL AND order_id IS NULL AND reversal_of_entry_id IS NULL OR entry_type = 'manual_adjustment'::"IdBusinessV2BalanceLedgerEntryType" AND direction = 'adjustment'::"IdBusinessV2BalanceDirection" AND gift_card_id IS NULL AND order_id IS NULL AND reversal_of_entry_id IS NULL);

ALTER TABLE "public"."id_business_v2_balance_ledger"
ADD CONSTRAINT "id_business_v2_balance_ledger_cost_after_check" CHECK (cost_after >= 0::numeric);

ALTER TABLE "public"."id_business_v2_balance_ledger"
ADD CONSTRAINT "id_business_v2_balance_ledger_cost_amount_check" CHECK (cost_amount >= 0::numeric);

ALTER TABLE "public"."id_business_v2_balance_ledger"
ADD CONSTRAINT "id_business_v2_balance_ledger_cost_before_check" CHECK (cost_before >= 0::numeric);

ALTER TABLE "public"."id_business_v2_balance_ledger"
ADD CONSTRAINT "id_business_v2_balance_ledger_movement_amount_check" CHECK (balance_amount > 0::numeric OR cost_amount > 0::numeric);

ALTER TABLE "public"."id_business_v2_exchange_rate_entries"
ADD CONSTRAINT "id_business_v2_exchange_rate_entries_rates_check" CHECK (binance_merchant_buy_rate_to_rmb > 0::numeric AND binance_merchant_sell_rate_to_rmb > 0::numeric AND okx_merchant_buy_rate_to_rmb > 0::numeric AND okx_merchant_sell_rate_to_rmb > 0::numeric AND combined_merchant_buy_average_rate_to_rmb = round((binance_merchant_buy_rate_to_rmb + okx_merchant_buy_rate_to_rmb) / 2::numeric, 8) AND combined_merchant_sell_average_rate_to_rmb = round((binance_merchant_sell_rate_to_rmb + okx_merchant_sell_rate_to_rmb) / 2::numeric, 8) AND mid_rate_to_rmb = round((combined_merchant_buy_average_rate_to_rmb + combined_merchant_sell_average_rate_to_rmb) / 2::numeric, 8));

ALTER TABLE "public"."id_business_v2_exchange_rate_entries"
ADD CONSTRAINT "id_business_v2_exchange_rate_entries_remark_check" CHECK (remark IS NULL OR char_length(remark) >= 1 AND char_length(remark) <= 2000);

ALTER TABLE "public"."id_business_v2_exchange_rate_provider_snapshots"
ADD CONSTRAINT "id_business_v2_exchange_rate_provider_counts_check" CHECK (received_ad_count >= 0 AND collector_accepted_ad_count >= 0 AND collector_rejected_ad_count >= 0 AND valid_ad_count >= 3 AND filtered_ad_count >= 0 AND received_ad_count = (collector_accepted_ad_count + collector_rejected_ad_count) AND collector_accepted_ad_count = (valid_ad_count + filtered_ad_count) AND filtered_ad_count = (excluded_missing_tradable_amount + excluded_non_positive_tradable + excluded_missing_order_count + excluded_low_order_count + excluded_missing_completion_rate + excluded_low_completion_rate + excluded_price_outlier) AND excluded_missing_tradable_amount >= 0 AND excluded_non_positive_tradable >= 0 AND excluded_missing_order_count >= 0 AND excluded_low_order_count >= 0 AND excluded_missing_completion_rate >= 0 AND excluded_low_completion_rate >= 0 AND excluded_price_outlier >= 0);

ALTER TABLE "public"."id_business_v2_exchange_rate_provider_snapshots"
ADD CONSTRAINT "id_business_v2_exchange_rate_provider_rates_check" CHECK (median_rate_to_rmb > 0::numeric AND lowest_valid_rate_to_rmb > 0::numeric AND highest_valid_rate_to_rmb >= lowest_valid_rate_to_rmb AND average_rate_to_rmb >= lowest_valid_rate_to_rmb AND average_rate_to_rmb <= highest_valid_rate_to_rmb AND median_rate_to_rmb >= lowest_valid_rate_to_rmb AND median_rate_to_rmb <= highest_valid_rate_to_rmb);

ALTER TABLE "public"."id_business_v2_exchange_rate_provider_snapshots"
ADD CONSTRAINT "id_business_v2_exchange_rate_provider_source_check" CHECK (provider = 'binance'::"IdBusinessV2OtcProvider" AND (source_contract::text = 'binance-public-agent-ad-list-v1'::text AND source_url::text ~ '^https://www\.binance\.com/'::text OR source_contract::text = 'binance-p2p-friendly-adv-search-v2'::text AND source_url::text ~ '^https://p2p\.binance\.com/'::text) OR provider = 'okx'::"IdBusinessV2OtcProvider" AND source_contract::text = 'okx-public-trading-orders-books-v3'::text AND source_url::text ~ '^https://www\.okx\.com/'::text);

ALTER TABLE "public"."id_business_v2_exchange_rate_quote_samples"
ADD CONSTRAINT "id_business_v2_exchange_rate_quote_samples_amount_check" CHECK (price_to_rmb > 0::numeric AND tradable_amount_usdt > 0::numeric AND (min_amount_rmb IS NULL OR min_amount_rmb > 0::numeric) AND (max_amount_rmb IS NULL OR max_amount_rmb > 0::numeric) AND (min_amount_rmb IS NULL OR max_amount_rmb IS NULL OR max_amount_rmb >= min_amount_rmb));

ALTER TABLE "public"."id_business_v2_exchange_rate_quote_samples"
ADD CONSTRAINT "id_business_v2_exchange_rate_quote_samples_quality_check" CHECK (completed_order_count >= 10 AND completion_rate >= 0.90000000 AND completion_rate <= 1::numeric AND (positive_review_rate IS NULL OR positive_review_rate >= 0::numeric AND positive_review_rate <= 1::numeric));

ALTER TABLE "public"."id_business_v2_exchange_rate_quote_samples"
ADD CONSTRAINT "id_business_v2_exchange_rate_quote_samples_source_check" CHECK (char_length(btrim(source_ad_id::text)) >= 1 AND char_length(btrim(source_ad_id::text)) <= 200 AND char_length(btrim(merchant_type::text)) >= 1 AND char_length(btrim(merchant_type::text)) <= 80);

ALTER TABLE "public"."id_business_v2_exchange_rate_runs"
ADD CONSTRAINT "id_business_v2_exchange_rate_runs_error_details_check" CHECK (error_details IS NULL OR jsonb_typeof(error_details) = 'object'::text);

ALTER TABLE "public"."id_business_v2_exchange_rate_runs"
ADD CONSTRAINT "id_business_v2_exchange_rate_runs_pair_check" CHECK (asset::text = 'USDT'::text AND fiat::text = 'CNY'::text);

ALTER TABLE "public"."id_business_v2_exchange_rate_runs"
ADD CONSTRAINT "id_business_v2_exchange_rate_runs_policy_check" CHECK (policy_min_completed_order_count IS NULL AND policy_min_completion_rate IS NULL AND policy_max_price_deviation_rate IS NULL AND policy_min_valid_ads_per_side IS NULL AND policy_decimal_places IS NULL OR policy_min_completed_order_count = 10 AND policy_min_completion_rate = 0.90000000 AND policy_max_price_deviation_rate = 0.03000000 AND policy_min_valid_ads_per_side = 3 AND policy_decimal_places = 8);

ALTER TABLE "public"."id_business_v2_exchange_rate_runs"
ADD CONSTRAINT "id_business_v2_exchange_rate_runs_state_check" CHECK (status = 'running'::"IdBusinessV2ExchangeRateRunStatus" AND finished_at IS NULL AND policy_min_completed_order_count IS NULL AND policy_min_completion_rate IS NULL AND policy_max_price_deviation_rate IS NULL AND policy_min_valid_ads_per_side IS NULL AND policy_decimal_places IS NULL AND error_code IS NULL AND error_message IS NULL AND error_provider IS NULL AND error_side IS NULL AND error_retryable IS NULL AND error_details IS NULL OR status = 'success'::"IdBusinessV2ExchangeRateRunStatus" AND finished_at IS NOT NULL AND policy_min_completed_order_count IS NOT NULL AND policy_min_completion_rate IS NOT NULL AND policy_max_price_deviation_rate IS NOT NULL AND policy_min_valid_ads_per_side IS NOT NULL AND policy_decimal_places IS NOT NULL AND error_code IS NULL AND error_message IS NULL AND error_provider IS NULL AND error_side IS NULL AND error_retryable IS NULL AND error_details IS NULL OR status = 'failed'::"IdBusinessV2ExchangeRateRunStatus" AND finished_at IS NOT NULL AND error_code IS NOT NULL AND char_length(btrim(error_code::text)) >= 1 AND char_length(btrim(error_code::text)) <= 120 AND error_message IS NOT NULL AND char_length(btrim(error_message)) >= 1 AND char_length(btrim(error_message)) <= 1000 AND error_provider IS NOT NULL AND error_retryable IS NOT NULL AND error_details IS NOT NULL);

ALTER TABLE "public"."id_business_v2_exchange_rate_runs"
ADD CONSTRAINT "id_business_v2_exchange_rate_runs_target_amount_check" CHECK (target_amount_rmb IS NULL OR target_amount_rmb > 0::numeric);

ALTER TABLE "public"."id_business_v2_exchange_rate_runs"
ADD CONSTRAINT "id_business_v2_exchange_rate_runs_time_check" CHECK (finished_at IS NULL OR finished_at >= started_at);

ALTER TABLE "public"."id_business_v2_exchange_rate_settings"
ADD CONSTRAINT "id_business_v2_exchange_rate_settings_interval_check" CHECK (interval_minutes = ANY (ARRAY[5, 15, 30, 60, 180, 360, 720, 1440]));

ALTER TABLE "public"."id_business_v2_exchange_rate_settings"
ADD CONSTRAINT "id_business_v2_exchange_rate_settings_schedule_check" CHECK (auto_enabled = true AND next_run_at IS NOT NULL OR auto_enabled = false AND next_run_at IS NULL);

ALTER TABLE "public"."id_business_v2_exchange_rate_settings"
ADD CONSTRAINT "id_business_v2_exchange_rate_settings_singleton_check" CHECK (id = 1);

ALTER TABLE "public"."id_business_v2_exchange_rate_settings"
ADD CONSTRAINT "id_business_v2_exchange_rate_settings_target_check" CHECK (target_amount_rmb > 0::numeric AND target_amount_rmb <= 1000000::numeric);

ALTER TABLE "public"."id_business_v2_exchange_rate_snapshots"
ADD CONSTRAINT "id_business_v2_exchange_rate_snapshots_pair_check" CHECK (asset::text = 'USDT'::text AND fiat::text = 'CNY'::text);

ALTER TABLE "public"."id_business_v2_exchange_rate_snapshots"
ADD CONSTRAINT "id_business_v2_exchange_rate_snapshots_rate_check" CHECK (combined_merchant_buy_average_rate_to_rmb > 0::numeric AND combined_merchant_sell_average_rate_to_rmb > 0::numeric AND mid_rate_to_rmb > 0::numeric AND mid_rate_to_rmb = round((combined_merchant_buy_average_rate_to_rmb + combined_merchant_sell_average_rate_to_rmb) / 2::numeric, 8));

ALTER TABLE "public"."id_business_v2_gift_cards"
ADD CONSTRAINT "id_business_v2_gift_cards_cost_amount_check" CHECK (cost_amount > 0::numeric);

ALTER TABLE "public"."id_business_v2_gift_cards"
ADD CONSTRAINT "id_business_v2_gift_cards_exchange_rate_check" CHECK (exchange_rate > 0::numeric);

ALTER TABLE "public"."id_business_v2_gift_cards"
ADD CONSTRAINT "id_business_v2_gift_cards_exchange_rate_source_check" CHECK (exchange_rate_source::text = 'manual_input'::text AND exchange_rate_snapshot_id IS NULL AND exchange_rate_prefilled_value IS NULL AND exchange_rate_was_overridden = false OR exchange_rate_source::text = 'automatic_snapshot'::text AND exchange_rate_snapshot_id IS NOT NULL AND exchange_rate_prefilled_value > 0::numeric);

ALTER TABLE "public"."id_business_v2_gift_cards"
ADD CONSTRAINT "id_business_v2_gift_cards_face_value_check" CHECK (face_value > 0::numeric);

ALTER TABLE "public"."id_business_v2_options"
ADD CONSTRAINT "id_business_v2_options_business_amount_check" CHECK (business_amount IS NULL OR business_amount >= 0::numeric);

ALTER TABLE "public"."id_business_v2_options"
ADD CONSTRAINT "id_business_v2_options_currency_code_check" CHECK (currency_code IS NULL OR currency_code::text ~ '^[A-Z]{3}$'::text);

ALTER TABLE "public"."id_business_v2_options"
ADD CONSTRAINT "id_business_v2_options_service_details_check" CHECK (type = 'country'::"IdBusinessV2OptionType" AND country_option_id IS NULL AND business_amount IS NULL AND currency_code IS NOT NULL OR type = 'service'::"IdBusinessV2OptionType" AND country_option_id IS NOT NULL AND business_amount IS NOT NULL AND currency_code IS NULL OR (type <> ALL (ARRAY['country'::"IdBusinessV2OptionType", 'service'::"IdBusinessV2OptionType"])) AND country_option_id IS NULL AND business_amount IS NULL AND currency_code IS NULL);

ALTER TABLE "public"."id_business_v2_orders"
ADD CONSTRAINT "id_business_v2_orders_account_cost_amount_check" CHECK (account_cost_amount >= 0::numeric);

ALTER TABLE "public"."id_business_v2_orders"
ADD CONSTRAINT "id_business_v2_orders_balance_amount_check" CHECK (balance_amount >= 0::numeric);

ALTER TABLE "public"."id_business_v2_orders"
ADD CONSTRAINT "id_business_v2_orders_balance_cost_amount_check" CHECK (balance_cost_amount >= 0::numeric);

ALTER TABLE "public"."id_business_v2_orders"
ADD CONSTRAINT "id_business_v2_orders_completed_evidence_check" CHECK ((status <> ALL (ARRAY['completed'::"IdBusinessV2OrderStatus", 'refunded'::"IdBusinessV2OrderStatus"])) OR account_id IS NOT NULL AND opened_at IS NOT NULL AND profit_amount IS NOT NULL);

ALTER TABLE "public"."id_business_v2_orders"
ADD CONSTRAINT "id_business_v2_orders_due_at_check" CHECK (due_at IS NULL OR opened_at IS NOT NULL AND due_at > opened_at);

ALTER TABLE "public"."id_business_v2_orders"
ADD CONSTRAINT "id_business_v2_orders_platform_fee_amount_check" CHECK (platform_fee_amount >= 0::numeric);

ALTER TABLE "public"."id_business_v2_orders"
ADD CONSTRAINT "id_business_v2_orders_received_amount_check" CHECK (received_amount >= 0::numeric);

ALTER TABLE "public"."id_business_v2_orders"
ADD CONSTRAINT "id_business_v2_orders_refund_cost_amount_check" CHECK (refund_cost_amount IS NULL OR refund_cost_amount >= 0::numeric);

ALTER TABLE "public"."id_business_v2_orders"
ADD CONSTRAINT "id_business_v2_orders_refund_evidence_check" CHECK (status <> 'refunded'::"IdBusinessV2OrderStatus" OR refund_cost_amount IS NOT NULL);

ALTER TABLE "public"."id_business_v2_renewal_warning_settings"
ADD CONSTRAINT "id_business_v2_renewal_warning_settings_scope_check"
CHECK ("scope" = 'global');

ALTER TABLE "public"."id_business_v2_renewal_warning_settings"
ADD CONSTRAINT "id_business_v2_renewal_warning_settings_days_check"
CHECK ("warning_days" BETWEEN 1 AND 365);

CREATE UNIQUE INDEX id_business_v2_account_locks_active_global_key ON public.id_business_v2_account_locks USING btree (account_id) WHERE ((status = 'active'::"IdBusinessV2AccountLockStatus") AND (lock_scope = 'global'::"IdBusinessV2AccountLockScope"));

CREATE UNIQUE INDEX id_business_v2_account_locks_active_order_key ON public.id_business_v2_account_locks USING btree (order_id) WHERE (status = 'active'::"IdBusinessV2AccountLockStatus");

CREATE UNIQUE INDEX id_business_v2_account_locks_active_service_key ON public.id_business_v2_account_locks USING btree (account_id, service_option_id) WHERE ((status = 'active'::"IdBusinessV2AccountLockStatus") AND (lock_scope = 'by_service'::"IdBusinessV2AccountLockScope"));

CREATE UNIQUE INDEX id_business_v2_exchange_rate_single_running_idx ON public.id_business_v2_exchange_rate_runs USING btree (status) WHERE (status = 'running'::"IdBusinessV2ExchangeRateRunStatus");

CREATE OR REPLACE FUNCTION public.protect_id_business_v2_balance_ledger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  -- One-time acceptance databases may remove their own fixtures before the
  -- database is destroyed. Production and ordinary development databases
  -- cannot update or delete financial ledger evidence.
  IF TG_OP = 'DELETE' AND right(current_database(), 11) = '_acceptance' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'V2 balance ledger is immutable';
END;
$function$;

CREATE OR REPLACE FUNCTION public.protect_id_business_v2_exchange_rate_entry()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE' AND right(current_database(), 11) = '_acceptance' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'V2 manual exchange-rate entry is immutable';
END;
$function$;

CREATE OR REPLACE FUNCTION public.protect_id_business_v2_exchange_rate_evidence()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE'
    AND current_setting(
      'app.id_business_v2_exchange_rate_retention_cleanup',
      true
    ) = 'on' THEN
    RETURN OLD;
  END IF;

  RAISE EXCEPTION 'exchange-rate snapshot evidence is immutable';
END;
$function$;

CREATE OR REPLACE FUNCTION public.validate_id_business_v2_exchange_rate_run_trigger()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  target_run_id UUID;
BEGIN
  IF TG_TABLE_NAME = 'id_business_v2_exchange_rate_runs' THEN
    target_run_id := COALESCE(NEW."id", OLD."id");
  ELSIF TG_TABLE_NAME = 'id_business_v2_exchange_rate_snapshots' THEN
    target_run_id := COALESCE(NEW."run_id", OLD."run_id");
  ELSIF TG_TABLE_NAME = 'id_business_v2_exchange_rate_provider_snapshots' THEN
    SELECT "run_id"
    INTO target_run_id
    FROM "id_business_v2_exchange_rate_snapshots"
    WHERE "id" = COALESCE(NEW."snapshot_id", OLD."snapshot_id");
  ELSE
    SELECT snapshot."run_id"
    INTO target_run_id
    FROM "id_business_v2_exchange_rate_provider_snapshots" provider_snapshot
    JOIN "id_business_v2_exchange_rate_snapshots" snapshot
      ON snapshot."id" = provider_snapshot."snapshot_id"
    WHERE provider_snapshot."id" =
      COALESCE(NEW."provider_snapshot_id", OLD."provider_snapshot_id");
  END IF;

  IF target_run_id IS NOT NULL THEN
    PERFORM "validate_id_business_v2_exchange_rate_run"(target_run_id);
  END IF;

  RETURN COALESCE(NEW, OLD);
END;
$function$;

CREATE OR REPLACE FUNCTION public.protect_id_business_v2_exchange_rate_run()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
BEGIN
  IF TG_OP = 'DELETE'
    AND current_setting(
      'app.id_business_v2_exchange_rate_retention_cleanup',
      true
    ) = 'on' THEN
    RETURN OLD;
  END IF;

  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'exchange-rate runs are immutable';
  END IF;

  IF OLD."status" <> 'running' THEN
    RAISE EXCEPTION 'finished exchange-rate runs are immutable';
  END IF;

  IF NEW."status" = 'running'
    OR NEW."id" <> OLD."id"
    OR NEW."trigger_type" <> OLD."trigger_type"
    OR NEW."asset" <> OLD."asset"
    OR NEW."fiat" <> OLD."fiat"
    OR NEW."started_at" <> OLD."started_at"
    OR NEW."triggered_by_user_id" IS DISTINCT FROM OLD."triggered_by_user_id"
    OR NEW."created_at" <> OLD."created_at" THEN
    RAISE EXCEPTION 'exchange-rate run identity cannot be changed';
  END IF;

  RETURN NEW;
END;
$function$;

CREATE OR REPLACE FUNCTION public.cleanup_id_business_v2_exchange_rate_history()
 RETURNS jsonb
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  cutoff_at TIMESTAMPTZ := clock_timestamp() - INTERVAL '1 month';
  eligible_run_ids UUID[];
  deleted_run_count INTEGER := 0;
  deleted_snapshot_count INTEGER := 0;
  deleted_provider_snapshot_count INTEGER := 0;
  deleted_quote_sample_count INTEGER := 0;
  preserved_referenced_run_count INTEGER := 0;
BEGIN
  SELECT COALESCE(array_agg(run."id"), ARRAY[]::UUID[])
  INTO eligible_run_ids
  FROM "id_business_v2_exchange_rate_runs" run
  WHERE run."status" <> 'running'
    AND run."started_at" < cutoff_at
    AND NOT EXISTS (
      SELECT 1
      FROM "id_business_v2_exchange_rate_snapshots" snapshot
      JOIN "id_business_v2_gift_cards" gift_card
        ON gift_card."exchange_rate_snapshot_id" = snapshot."id"
      WHERE snapshot."run_id" = run."id"
    );

  SELECT COUNT(*)::INTEGER
  INTO preserved_referenced_run_count
  FROM "id_business_v2_exchange_rate_runs" run
  WHERE run."status" <> 'running'
    AND run."started_at" < cutoff_at
    AND EXISTS (
      SELECT 1
      FROM "id_business_v2_exchange_rate_snapshots" snapshot
      JOIN "id_business_v2_gift_cards" gift_card
        ON gift_card."exchange_rate_snapshot_id" = snapshot."id"
      WHERE snapshot."run_id" = run."id"
    );

  PERFORM set_config(
    'app.id_business_v2_exchange_rate_retention_cleanup',
    'on',
    true
  );

  IF cardinality(eligible_run_ids) > 0 THEN
    DELETE FROM "id_business_v2_exchange_rate_quote_samples" sample
    USING "id_business_v2_exchange_rate_provider_snapshots" provider_snapshot,
      "id_business_v2_exchange_rate_snapshots" snapshot
    WHERE sample."provider_snapshot_id" = provider_snapshot."id"
      AND provider_snapshot."snapshot_id" = snapshot."id"
      AND snapshot."run_id" = ANY(eligible_run_ids);
    GET DIAGNOSTICS deleted_quote_sample_count = ROW_COUNT;

    DELETE FROM "id_business_v2_exchange_rate_provider_snapshots" provider_snapshot
    USING "id_business_v2_exchange_rate_snapshots" snapshot
    WHERE provider_snapshot."snapshot_id" = snapshot."id"
      AND snapshot."run_id" = ANY(eligible_run_ids);
    GET DIAGNOSTICS deleted_provider_snapshot_count = ROW_COUNT;

    DELETE FROM "id_business_v2_exchange_rate_snapshots"
    WHERE "run_id" = ANY(eligible_run_ids);
    GET DIAGNOSTICS deleted_snapshot_count = ROW_COUNT;

    DELETE FROM "id_business_v2_exchange_rate_runs"
    WHERE "id" = ANY(eligible_run_ids);
    GET DIAGNOSTICS deleted_run_count = ROW_COUNT;
  END IF;

  PERFORM set_config(
    'app.id_business_v2_exchange_rate_retention_cleanup',
    'off',
    true
  );

  RETURN jsonb_build_object(
    'cutoff',
    cutoff_at,
    'deletedRuns',
    deleted_run_count,
    'deletedSnapshots',
    deleted_snapshot_count,
    'deletedProviderSnapshots',
    deleted_provider_snapshot_count,
    'deletedQuoteSamples',
    deleted_quote_sample_count,
    'preservedReferencedRuns',
    preserved_referenced_run_count
  );
END;
$function$;

CREATE OR REPLACE FUNCTION public.invoke_id_business_v2_exchange_rate_cron()
 RETURNS bigint
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO 'public', 'pg_temp'
AS $function$
DECLARE
  endpoint_url TEXT;
  cron_secret TEXT;
  request_id BIGINT;
BEGIN
  IF to_regclass('vault.decrypted_secrets') IS NULL
    OR to_regnamespace('net') IS NULL THEN
    RETURN NULL;
  END IF;

  EXECUTE $secret_query$
    SELECT "decrypted_secret"
    FROM vault.decrypted_secrets
    WHERE "name" = $1
    ORDER BY "updated_at" DESC
    LIMIT 1
  $secret_query$
  INTO endpoint_url
  USING 'id_business_v2_exchange_rate_cron_url';

  EXECUTE $secret_query$
    SELECT "decrypted_secret"
    FROM vault.decrypted_secrets
    WHERE "name" = $1
    ORDER BY "updated_at" DESC
    LIMIT 1
  $secret_query$
  INTO cron_secret
  USING 'id_business_v2_exchange_rate_cron_secret';

  IF endpoint_url IS NULL OR cron_secret IS NULL THEN
    RETURN NULL;
  END IF;
  IF endpoint_url !~ '^https://'
    OR endpoint_url !~ '/functions/v1/v2-api/api/id-business-v2/exchange-rates/cron$' THEN
    RAISE EXCEPTION 'V2 exchange-rate Cron URL is invalid';
  END IF;
  IF char_length(cron_secret) < 32 THEN
    RAISE EXCEPTION 'V2 exchange-rate Cron secret is too short';
  END IF;

  EXECUTE $http_request$
    SELECT net.http_post(
      url := $1,
      headers := jsonb_build_object(
        'Content-Type',
        'application/json',
        'Authorization',
        'Bearer ' || $2
      ),
      body := jsonb_build_object('scheduledAt', clock_timestamp()),
      timeout_milliseconds := 30000
    )
  $http_request$
  INTO request_id
  USING endpoint_url, cron_secret;

  RETURN request_id;
END;
$function$;

CREATE TRIGGER id_business_v2_balance_ledger_immutable BEFORE DELETE OR UPDATE ON id_business_v2_balance_ledger FOR EACH ROW EXECUTE FUNCTION protect_id_business_v2_balance_ledger();

CREATE TRIGGER id_business_v2_exchange_rate_entry_immutable BEFORE DELETE OR UPDATE ON id_business_v2_exchange_rate_entries FOR EACH ROW EXECUTE FUNCTION protect_id_business_v2_exchange_rate_entry();

CREATE TRIGGER id_business_v2_exchange_rate_provider_immutable BEFORE DELETE OR UPDATE ON id_business_v2_exchange_rate_provider_snapshots FOR EACH ROW EXECUTE FUNCTION protect_id_business_v2_exchange_rate_evidence();

CREATE CONSTRAINT TRIGGER id_business_v2_exchange_rate_provider_validate AFTER INSERT OR DELETE OR UPDATE ON id_business_v2_exchange_rate_provider_snapshots DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_id_business_v2_exchange_rate_run_trigger();

CREATE TRIGGER id_business_v2_exchange_rate_sample_immutable BEFORE DELETE OR UPDATE ON id_business_v2_exchange_rate_quote_samples FOR EACH ROW EXECUTE FUNCTION protect_id_business_v2_exchange_rate_evidence();

CREATE CONSTRAINT TRIGGER id_business_v2_exchange_rate_sample_validate AFTER INSERT OR DELETE OR UPDATE ON id_business_v2_exchange_rate_quote_samples DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_id_business_v2_exchange_rate_run_trigger();

CREATE TRIGGER id_business_v2_exchange_rate_run_immutable BEFORE DELETE OR UPDATE ON id_business_v2_exchange_rate_runs FOR EACH ROW EXECUTE FUNCTION protect_id_business_v2_exchange_rate_run();

CREATE CONSTRAINT TRIGGER id_business_v2_exchange_rate_run_validate AFTER INSERT OR UPDATE ON id_business_v2_exchange_rate_runs DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_id_business_v2_exchange_rate_run_trigger();

CREATE TRIGGER id_business_v2_exchange_rate_snapshot_immutable BEFORE DELETE OR UPDATE ON id_business_v2_exchange_rate_snapshots FOR EACH ROW EXECUTE FUNCTION protect_id_business_v2_exchange_rate_evidence();

CREATE CONSTRAINT TRIGGER id_business_v2_exchange_rate_snapshot_validate AFTER INSERT OR DELETE OR UPDATE ON id_business_v2_exchange_rate_snapshots DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION validate_id_business_v2_exchange_rate_run_trigger();

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_available_extensions WHERE "name" = 'pg_net'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_extension WHERE "extname" = 'pg_net'
  ) THEN
    EXECUTE 'CREATE EXTENSION pg_net';
  END IF;
EXCEPTION
  WHEN insufficient_privilege OR feature_not_supported THEN
    RAISE NOTICE 'pg_net is unavailable; enable it in the Supabase Dashboard';
END;
$$;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM pg_available_extensions WHERE "name" = 'pg_cron'
  ) AND NOT EXISTS (
    SELECT 1 FROM pg_extension WHERE "extname" = 'pg_cron'
  ) THEN
    EXECUTE 'CREATE EXTENSION pg_cron';
  END IF;
EXCEPTION
  WHEN insufficient_privilege OR feature_not_supported THEN
    RAISE NOTICE 'pg_cron is unavailable; enable it in the Supabase Dashboard';
END;
$$;

DO $$
DECLARE
  existing_job_id BIGINT;
BEGIN
  IF to_regclass('cron.job') IS NULL THEN
    RAISE NOTICE 'pg_cron is unavailable; exchange-rate Cron job was not installed';
    RETURN;
  END IF;

  FOR existing_job_id IN
    EXECUTE 'SELECT "jobid" FROM cron.job WHERE "jobname" = $1'
    USING 'id-business-v2-exchange-rate-every-30-minutes'
  LOOP
    EXECUTE 'SELECT cron.unschedule($1)' USING existing_job_id;
  END LOOP;

  EXECUTE $schedule$
    SELECT cron.schedule(
      'id-business-v2-exchange-rate-every-30-minutes',
      '*/30 * * * *',
      'SELECT public.invoke_id_business_v2_exchange_rate_cron();'
    )
  $schedule$;
END;
$$;

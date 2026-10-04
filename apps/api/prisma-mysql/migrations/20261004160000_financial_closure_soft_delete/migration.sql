-- Preserve all financial/payment references and credential unique keys. No historical deletion/backfill.
ALTER TABLE `id_business_v2_chatgpt_accounts`
  ADD COLUMN `deleted_at` DATETIME(6) NULL,
  ADD INDEX `id_business_v2_chatgpt_accounts_deleted_at_updated_at_idx` (`deleted_at`, `updated_at`);
ALTER TABLE `id_business_v2_bank_recharge_orders`
  ADD COLUMN `deleted_at` DATETIME(6) NULL,
  ADD INDEX `id_business_v2_bank_recharge_orders_deleted_at_updated_at_idx` (`deleted_at`, `updated_at`);
-- Extend current-system restore scope without changing previous migration history.
ALTER TABLE `id_business_v2_governance_job_items`
  MODIFY COLUMN `entity_type` ENUM('account','customer','option','order','exchange_rate_run','chatgpt_account','bank_recharge_order') NOT NULL;

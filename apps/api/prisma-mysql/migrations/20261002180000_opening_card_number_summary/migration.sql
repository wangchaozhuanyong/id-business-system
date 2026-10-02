ALTER TABLE `id_business_v2_bank_recharge_orders`
  ADD COLUMN `card_number_summary_encrypted` TEXT NULL,
  ADD COLUMN `card_deleted_at` DATETIME(6) NULL;

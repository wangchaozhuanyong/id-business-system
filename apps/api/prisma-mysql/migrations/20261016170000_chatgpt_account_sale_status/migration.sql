-- 出售状态为人工库存标记，历史账号统一保持未出售，不推断订单或付款结果。
ALTER TABLE `id_business_v2_chatgpt_accounts`
  ADD COLUMN `sale_status` ENUM('unsold', 'sold') NOT NULL DEFAULT 'unsold',
  ADD COLUMN `sold_at` DATETIME(6) NULL;

CREATE INDEX `chatgpt_accounts_sale_list_idx`
  ON `id_business_v2_chatgpt_accounts` (`deleted_at`, `sale_status`, `sold_at`, `id`);

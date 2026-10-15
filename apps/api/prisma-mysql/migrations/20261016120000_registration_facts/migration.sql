-- 历史资料保持未知；仅写入有依据的注册事实，不以入库时间回填。
ALTER TABLE `id_business_v2_chatgpt_accounts`
  ADD COLUMN `registration_ip_encrypted` TEXT NULL,
  ADD COLUMN `registered_at` DATETIME(6) NULL;

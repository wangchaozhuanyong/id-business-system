-- 独立记录可人工修正的注册状态；历史账号沿用原来的已注册显示，保留所有资料。
ALTER TABLE `id_business_v2_chatgpt_accounts`
  ADD COLUMN `registered` BOOLEAN NOT NULL DEFAULT true;

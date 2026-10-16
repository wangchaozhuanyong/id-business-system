ALTER TABLE `id_business_v2_chatgpt_accounts`
  ADD COLUMN `email_search_tokens` JSON NOT NULL DEFAULT (JSON_ARRAY());

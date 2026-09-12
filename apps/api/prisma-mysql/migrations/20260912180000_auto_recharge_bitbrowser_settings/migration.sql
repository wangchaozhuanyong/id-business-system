CREATE TABLE `id_business_v2_recharge_browser_settings` (
  `owner_id` VARCHAR(191) NOT NULL,
  `connector_url` VARCHAR(160) NOT NULL DEFAULT 'http://127.0.0.1:55321',
  `local_api_url` VARCHAR(160) NOT NULL DEFAULT 'http://127.0.0.1:54345',
  `local_api_token_encrypted` TEXT NULL,
  `local_api_token_mask` VARCHAR(32) NULL,
  `connector_token_encrypted` TEXT NULL,
  `connector_token_mask` VARCHAR(32) NULL,
  `group_name` VARCHAR(80) NOT NULL DEFAULT 'gpt账号注册',
  `tag_name` VARCHAR(80) NOT NULL DEFAULT '申请gpt',
  `proxy_type` VARCHAR(12) NOT NULL DEFAULT 'http',
  `dynamic_proxy_url_encrypted` TEXT NULL,
  `dynamic_proxy_url_mask` VARCHAR(120) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  `updated_at` DATETIME(6) NOT NULL,
  CONSTRAINT `id_business_v2_recharge_browser_settings_proxy_type_check`
    CHECK (`proxy_type` IN ('http', 'https', 'socks5')),
  PRIMARY KEY (`owner_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

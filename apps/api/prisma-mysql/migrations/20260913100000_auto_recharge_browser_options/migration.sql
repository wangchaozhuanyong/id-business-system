ALTER TABLE `id_business_v2_recharge_browser_settings`
  ADD COLUMN `browser_options` JSON NULL,
  ADD COLUMN `static_proxy_credentials_encrypted` TEXT NULL;

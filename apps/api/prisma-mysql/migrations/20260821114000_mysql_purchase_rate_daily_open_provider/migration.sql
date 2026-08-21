-- Keep the historical CurrencyAPI enum value so migrated audit records remain readable,
-- while making the no-key ExchangeRate-API provider the default for new runs.
ALTER TABLE `id_business_v2_purchase_rate_fetch_runs`
  MODIFY `provider` ENUM('manual', 'currencyapi', 'exchange_rate_api')
    NOT NULL DEFAULT 'exchange_rate_api';

ALTER TABLE `id_business_v2_purchase_rate_snapshots`
  MODIFY `market_rate_source` ENUM('manual', 'currencyapi', 'exchange_rate_api')
    NOT NULL DEFAULT 'manual';

ALTER TABLE `id_business_v2_purchase_rate_settings`
  MODIFY `interval_minutes` INTEGER NOT NULL DEFAULT 1440,
  MODIFY `stale_minutes` INTEGER NOT NULL DEFAULT 1800;

UPDATE `id_business_v2_purchase_rate_settings`
SET
  `interval_minutes` = 1440,
  `stale_minutes` = GREATEST(`stale_minutes`, 1800),
  `next_run_at` = CASE
    WHEN `auto_enabled` = FALSE THEN NULL
    WHEN TIMESTAMP(UTC_DATE(), '01:05:00') > UTC_TIMESTAMP(6)
      THEN TIMESTAMP(UTC_DATE(), '01:05:00')
    ELSE TIMESTAMP(UTC_DATE() + INTERVAL 1 DAY, '01:05:00')
  END,
  `updated_at` = UTC_TIMESTAMP(6)
WHERE `id` = 1;

ALTER TABLE `id_business_v2_purchase_rate_settings`
  ADD CONSTRAINT `idv2_purchase_rate_settings_interval_check`
    CHECK (`interval_minutes` = 1440),
  ADD CONSTRAINT `idv2_purchase_rate_settings_stale_check`
    CHECK (`stale_minutes` >= 1440 AND `stale_minutes` <= 4320);

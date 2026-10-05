-- Archive changes operational list visibility only. Keep all lifecycle and financial facts.
ALTER TABLE `id_business_v2_orders`
  ADD COLUMN `archived_at` DATETIME(6) NULL;

CREATE INDEX `id_business_v2_orders_archive_list_idx`
  ON `id_business_v2_orders` (`deleted_at`, `archived_at`, `created_at`, `id`);

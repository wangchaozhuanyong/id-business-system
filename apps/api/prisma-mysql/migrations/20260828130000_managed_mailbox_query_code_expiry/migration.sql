ALTER TABLE `id_business_v2_managed_mailboxes`
  ADD COLUMN `query_code_expires_at` DATETIME(6) NULL;

UPDATE `id_business_v2_managed_mailboxes`
SET `query_code_expires_at` = DATE_ADD(UTC_TIMESTAMP(6), INTERVAL 30 DAY)
WHERE `query_code_expires_at` IS NULL;

ALTER TABLE `id_business_v2_managed_mailboxes`
  MODIFY COLUMN `query_code_expires_at` DATETIME(6) NOT NULL;

CREATE INDEX `idv2_mailboxes_status_query_code_expires_at_idx`
  ON `id_business_v2_managed_mailboxes`(`status`, `query_code_expires_at`);

-- Additive migration. Existing recharge IDs and job foreign keys are preserved.
ALTER TABLE `id_business_v2_recharge_proxies`
  MODIFY `country_code` CHAR(2) NULL,
  MODIFY `kind` ENUM('dynamic_residential','static_residential','mobile') NULL,
  ADD COLUMN `remark` TEXT NULL,
  ADD COLUMN `display_host` VARCHAR(255) NULL,
  ADD COLUMN `exit_ip` VARCHAR(100) NULL,
  ADD COLUMN `latency_ms` INTEGER NULL,
  ADD COLUMN `test_message` TEXT NULL,
  ADD COLUMN `tested_at` DATETIME(6) NULL;
UPDATE `id_business_v2_recharge_proxies`
SET `remark` = NULLIF(CONCAT_WS('
', NULLIF(`remark1`, ''), NULLIF(`remark2`, '')), '');
CREATE TABLE `id_business_v2_proxy_aliases` (
  `old_id` CHAR(36) NOT NULL,
  `proxy_id` CHAR(36) NOT NULL,
  PRIMARY KEY (`old_id`), INDEX `id_business_v2_proxy_aliases_proxy_id_idx` (`proxy_id`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
-- Prefer existing recharge records on duplicate connection hashes. A rare ID collision
-- gets a new ID; every old online ID has an explicit mapping.
INSERT INTO `id_business_v2_proxy_aliases` (`old_id`, `proxy_id`)
SELECT o.`id`, COALESCE(h.`id`, IF(i.`id` IS NULL, o.`id`, UUID()))
FROM `online_recharge_proxies` o
LEFT JOIN `id_business_v2_recharge_proxies` h ON h.`url_hash` = o.`connection_hash`
LEFT JOIN `id_business_v2_recharge_proxies` i ON i.`id` = o.`id`;
INSERT INTO `id_business_v2_recharge_proxies`
(`id`, `country_code`, `kind`, `connection_mode`, `protocol`, `url_encrypted`, `url_hash`,
 `active`, `display_host`, `exit_ip`, `latency_ms`, `test_message`, `tested_at`, `created_at`, `updated_at`)
SELECT a.`proxy_id`, NULL, NULL, 'direct', o.`protocol`, o.`connection_encrypted`, o.`connection_hash`,
 o.`status` = 'active', o.`display_host`, o.`exit_ip`, o.`latency_ms`, o.`test_message`, o.`tested_at`, o.`created_at`, o.`updated_at`
FROM `online_recharge_proxies` o JOIN `id_business_v2_proxy_aliases` a ON a.`old_id` = o.`id`
LEFT JOIN `id_business_v2_recharge_proxies` p ON p.`id` = a.`proxy_id`
WHERE p.`id` IS NULL;
UPDATE `id_business_v2_recharge_proxies` p
JOIN `id_business_v2_proxy_aliases` a ON a.`proxy_id` = p.`id`
JOIN `online_recharge_proxies` o ON o.`id` = a.`old_id`
SET p.`active` = p.`active` AND o.`status` = 'active',
 p.`display_host` = COALESCE(p.`display_host`, o.`display_host`),
 p.`exit_ip` = IF(p.`tested_at` IS NULL OR o.`tested_at` > p.`tested_at`, o.`exit_ip`, p.`exit_ip`),
 p.`latency_ms` = IF(p.`tested_at` IS NULL OR o.`tested_at` > p.`tested_at`, o.`latency_ms`, p.`latency_ms`),
 p.`test_message` = IF(p.`tested_at` IS NULL OR o.`tested_at` > p.`tested_at`, o.`test_message`, p.`test_message`),
 p.`tested_at` = IF(p.`tested_at` IS NULL OR o.`tested_at` > p.`tested_at`, o.`tested_at`, p.`tested_at`);
-- online_recharge_proxies is deliberately retained as a historical snapshot.

CREATE TABLE `id_business_v2_website_visits` (
  `id` VARCHAR(36) NOT NULL,
  `host` VARCHAR(253) NOT NULL,
  `occurred_at` DATETIME(3) NOT NULL,
  `received_at` DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  `path` VARCHAR(1024) NOT NULL,
  `ip_encrypted` TEXT NOT NULL,
  `ip_hash` CHAR(64) NOT NULL,
  PRIMARY KEY (`id`),
  INDEX `idbiz_website_visit_time_idx` (`occurred_at`, `id`),
  INDEX `idbiz_website_visit_ip_time_idx` (`ip_hash`, `occurred_at`),
  CONSTRAINT `idbiz_website_visit_host_check` CHECK (`host` IN ('flashcast.com.my', 'www.flashcast.com.my'))
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `attachments`
  ADD COLUMN `content_encrypted` LONGTEXT NULL,
  ADD COLUMN `content_sha256` CHAR(64) NULL,
  ADD CONSTRAINT `attachments_encrypted_content_pair_check`
    CHECK ((`content_encrypted` IS NULL) = (`content_sha256` IS NULL));

CREATE TABLE `id_business_v2_finance_income_references` (
  `normalized_reference` VARCHAR(200) NOT NULL,
  `source_type` ENUM('inflow', 'order') NOT NULL,
  `first_inflow_id` CHAR(36) NULL,
  `order_id` CHAR(36) NULL,
  `created_at` DATETIME(6) NOT NULL DEFAULT CURRENT_TIMESTAMP(6),
  PRIMARY KEY (`normalized_reference`),
  KEY `finance_income_refs_first_inflow_idx` (`first_inflow_id`),
  KEY `finance_income_refs_order_idx` (`order_id`),
  CONSTRAINT `finance_income_references_inflow_fkey`
    FOREIGN KEY (`first_inflow_id`) REFERENCES `id_business_v2_finance_inflows` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT `finance_income_references_order_fkey`
    FOREIGN KEY (`order_id`) REFERENCES `id_business_v2_orders` (`id`)
    ON DELETE RESTRICT ON UPDATE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO `id_business_v2_finance_income_references` (
  `normalized_reference`,
  `source_type`,
  `order_id`,
  `created_at`
)
SELECT LOWER(TRIM(`order_no`)), 'order', `id`, `created_at`
FROM `id_business_v2_orders`
WHERE `deleted_at` IS NULL;

INSERT IGNORE INTO `id_business_v2_finance_income_references` (
  `normalized_reference`,
  `source_type`,
  `order_id`,
  `created_at`
)
SELECT LOWER(TRIM(`platform_order_no`)), 'order', `id`, `created_at`
FROM `id_business_v2_orders`
WHERE `deleted_at` IS NULL
  AND `platform_order_no` IS NOT NULL
  AND TRIM(`platform_order_no`) <> '';

INSERT IGNORE INTO `id_business_v2_finance_income_references` (
  `normalized_reference`,
  `source_type`,
  `first_inflow_id`,
  `created_at`
)
SELECT `normalized_reference`, 'inflow', `id`, `created_at`
FROM (
  SELECT
    LOWER(TRIM(`external_reference`)) AS `normalized_reference`,
    `id`,
    `created_at`,
    ROW_NUMBER() OVER (
      PARTITION BY LOWER(TRIM(`external_reference`))
      ORDER BY `created_at`, `id`
    ) AS `row_number`
  FROM `id_business_v2_finance_inflows`
  WHERE `external_reference` IS NOT NULL
    AND TRIM(`external_reference`) <> ''
) AS `ranked_references`
WHERE `row_number` = 1;

CREATE TRIGGER `idv2_finance_inflow_insert_guard`
BEFORE INSERT ON `id_business_v2_finance_inflows`
FOR EACH ROW
BEGIN
  IF NOT (
    (
      NEW.`nature` = 'operating_income'
      AND NEW.`category_option_id` IS NOT NULL
      AND NEW.`category_name_snapshot` IS NOT NULL
    )
    OR (
      NEW.`nature` IN ('capital_contribution', 'borrowed_funds')
      AND NEW.`category_option_id` IS NULL
      AND NEW.`category_name_snapshot` IS NULL
    )
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Finance inflow category does not match its nature';
  END IF;
END;

CREATE TRIGGER `idv2_finance_inflow_no_update`
BEFORE UPDATE ON `id_business_v2_finance_inflows`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Finance inflow records are immutable';

CREATE TRIGGER `idv2_finance_inflow_no_delete`
BEFORE DELETE ON `id_business_v2_finance_inflows`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Finance inflow records are immutable';

CREATE TRIGGER `idv2_income_reference_insert_guard`
BEFORE INSERT ON `id_business_v2_finance_income_references`
FOR EACH ROW
BEGIN
  IF NOT (
    (
      NEW.`source_type` = 'inflow'
      AND NEW.`first_inflow_id` IS NOT NULL
      AND NEW.`order_id` IS NULL
    )
    OR (
      NEW.`source_type` = 'order'
      AND NEW.`first_inflow_id` IS NULL
      AND NEW.`order_id` IS NOT NULL
    )
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Finance income reference owner is invalid';
  END IF;
END;

CREATE TRIGGER `idv2_income_reference_no_update`
BEFORE UPDATE ON `id_business_v2_finance_income_references`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Finance income references are immutable';

CREATE TRIGGER `idv2_income_reference_no_delete`
BEFORE DELETE ON `id_business_v2_finance_income_references`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Finance income references are immutable';

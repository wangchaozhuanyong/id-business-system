ALTER TABLE `id_business_v2_finance_inflows`
  MODIFY COLUMN `external_reference` VARCHAR(200) NULL,
  MODIFY COLUMN `receipt_attachment_id` CHAR(36) NULL;

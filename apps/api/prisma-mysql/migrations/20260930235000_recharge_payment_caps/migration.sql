CREATE TABLE `id_business_v2_recharge_payment_caps` (
  `plan` VARCHAR(16) NOT NULL,
  `currency_code` CHAR(3) NOT NULL,
  `max_amount` DECIMAL(18,4) NOT NULL,
  `updated_by_user_id` CHAR(36) NULL,
  `updated_at` DATETIME(6) NOT NULL,
  PRIMARY KEY (`plan`, `currency_code`)
) DEFAULT CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;

ALTER TABLE `id_business_v2_recharge_payment_caps`
  ADD CONSTRAINT `id_business_v2_recharge_payment_caps_currency_code_fkey`
  FOREIGN KEY (`currency_code`) REFERENCES `id_business_v2_bank_recharge_currencies`(`code`)
  ON DELETE RESTRICT ON UPDATE CASCADE;

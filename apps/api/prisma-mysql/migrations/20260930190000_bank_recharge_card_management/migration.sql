-- Extend the current bank recharge card table. Existing card identifiers remain valid.
-- Security codes are intentionally not stored.
ALTER TABLE `id_business_v2_bank_recharge_cards`
    ADD COLUMN `number_encrypted` TEXT NULL,
    ADD COLUMN `number_hash` CHAR(64) NULL,
    ADD COLUMN `expiry` CHAR(5) NULL,
    ADD COLUMN `remark1` VARCHAR(500) NULL,
    ADD COLUMN `remark2` VARCHAR(500) NULL;

CREATE UNIQUE INDEX `id_business_v2_bank_recharge_cards_number_hash_key`
    ON `id_business_v2_bank_recharge_cards`(`number_hash`);

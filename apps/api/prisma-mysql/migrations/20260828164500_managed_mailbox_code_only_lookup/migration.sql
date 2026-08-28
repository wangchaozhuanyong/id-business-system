-- Query codes are random 20-character secrets. A unique HMAC index lets the
-- public endpoint locate the owning mailbox without receiving its email.
CREATE UNIQUE INDEX `id_business_v2_managed_mailboxes_query_code_hash_key`
    ON `id_business_v2_managed_mailboxes`(`query_code_hash`);

-- Preserve the append-only attempt history while changing the bounded lookup
-- key from email HMAC to query-code HMAC.
ALTER TABLE `id_business_v2_mail_query_attempts`
    DROP INDEX `id_business_v2_mail_query_attempts_email_hash_created_at_idx`,
    CHANGE COLUMN `email_hash` `query_code_hash` VARCHAR(64) NOT NULL,
    ADD INDEX `idbiz_mail_query_attempts_code_created_idx`
        (`query_code_hash`, `created_at`);

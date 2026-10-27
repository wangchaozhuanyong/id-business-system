-- Existing codes and their expiration timestamps are preserved.
ALTER TABLE `id_business_v2_managed_mailboxes`
  ADD COLUMN `query_code_validity_days` INTEGER NOT NULL DEFAULT 30;

-- Recreate every current integrity trigger while connected as the dedicated
-- migration identity. MySQL checks trigger activation privileges against the
-- trigger DEFINER, so the least-privilege runtime account must never own them.
-- Trigger bodies are unchanged; only ownership is replaced by the migration
-- user that executes this forward migration.

DROP TRIGGER IF EXISTS `idv2_account_loss_no_delete`;
CREATE TRIGGER `idv2_account_loss_no_delete`
BEFORE DELETE ON `id_business_v2_account_losses`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ID account loss records cannot be deleted';

DROP TRIGGER IF EXISTS `idv2_account_loss_state_guard`;
CREATE TRIGGER `idv2_account_loss_state_guard`
BEFORE UPDATE ON `id_business_v2_accounts`
FOR EACH ROW
BEGIN
  IF OLD.`loss_reported_at` IS NOT NULL AND NEW.`loss_reported_at` IS NOT NULL THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Loss-reported ID accounts remain frozen until reversal';
  END IF;

  IF NEW.`loss_reported_at` IS NOT NULL AND (
    NEW.`record_status` <> 'disabled'
    OR NEW.`active_loss_record_id` IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM `id_business_v2_options` AS `status_option`
      WHERE `status_option`.`id` = NEW.`status_option_id`
        AND `status_option`.`type` = 'id_status'
        AND `status_option`.`code` = 'frozen'
        AND `status_option`.`status` = 'active'
        AND `status_option`.`is_system` = TRUE
        AND `status_option`.`deleted_at` IS NULL
    )
    OR NOT EXISTS (
      SELECT 1
      FROM `id_business_v2_account_losses` AS `loss_record`
      WHERE `loss_record`.`id` = NEW.`active_loss_record_id`
        AND `loss_record`.`account_id` = NEW.`id`
        AND `loss_record`.`status` = 'active'
    )
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Loss reporting must atomically freeze and link the ID account';
  END IF;

  IF OLD.`loss_reported_at` IS NOT NULL AND NEW.`loss_reported_at` IS NULL AND (
    OLD.`active_loss_record_id` IS NULL
    OR NOT EXISTS (
      SELECT 1
      FROM `id_business_v2_account_losses` AS `loss_record`
      WHERE `loss_record`.`id` = OLD.`active_loss_record_id`
        AND `loss_record`.`account_id` = OLD.`id`
        AND `loss_record`.`status` = 'reversed'
        AND `loss_record`.`reversed_at` IS NOT NULL
        AND `loss_record`.`reversal_finance_journal_id` IS NOT NULL
    )
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Loss-reported ID account can unfreeze only after reversal';
  END IF;
END;

DROP TRIGGER IF EXISTS `idv2_account_loss_update_guard`;
CREATE TRIGGER `idv2_account_loss_update_guard`
BEFORE UPDATE ON `id_business_v2_account_losses`
FOR EACH ROW
BEGIN
  IF NOT (NEW.`id` <=> OLD.`id`)
    OR NOT (NEW.`account_id` <=> OLD.`account_id`)
    OR NOT (NEW.`ledger_entry_id` <=> OLD.`ledger_entry_id`)
    OR NOT (NEW.`apple_id_masked` <=> OLD.`apple_id_masked`)
    OR NOT (NEW.`country_option_id` <=> OLD.`country_option_id`)
    OR NOT (NEW.`country_name` <=> OLD.`country_name`)
    OR NOT (NEW.`currency_code` <=> OLD.`currency_code`)
    OR NOT (NEW.`supplier_option_id` <=> OLD.`supplier_option_id`)
    OR NOT (NEW.`supplier_name` <=> OLD.`supplier_name`)
    OR NOT (NEW.`sale_state` <=> OLD.`sale_state`)
    OR NOT (NEW.`sold_order_id` <=> OLD.`sold_order_id`)
    OR NOT (NEW.`sold_order_no` <=> OLD.`sold_order_no`)
    OR NOT (NEW.`loss_balance` <=> OLD.`loss_balance`)
    OR NOT (NEW.`loss_cost_amount` <=> OLD.`loss_cost_amount`)
    OR NOT (NEW.`id_purchase_cost_loss_amount` <=> OLD.`id_purchase_cost_loss_amount`)
    OR NOT (NEW.`reason` <=> OLD.`reason`)
    OR NOT (NEW.`idempotency_key` <=> OLD.`idempotency_key`)
    OR NOT (NEW.`reported_by_user_id` <=> OLD.`reported_by_user_id`)
    OR NOT (NEW.`reported_by_name` <=> OLD.`reported_by_name`)
    OR NOT (NEW.`reported_at` <=> OLD.`reported_at`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'ID account loss snapshot fields are immutable';
  END IF;
END;

DROP TRIGGER IF EXISTS `idv2_audit_log_no_delete`;
CREATE TRIGGER `idv2_audit_log_no_delete`
BEFORE DELETE ON `audit_logs`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Audit logs are immutable';

DROP TRIGGER IF EXISTS `idv2_audit_log_no_update`;
CREATE TRIGGER `idv2_audit_log_no_update`
BEFORE UPDATE ON `audit_logs`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Audit logs are immutable';

DROP TRIGGER IF EXISTS `idv2_balance_ledger_no_delete`;
CREATE TRIGGER `idv2_balance_ledger_no_delete`
BEFORE DELETE ON `id_business_v2_balance_ledger`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'V2 balance ledger is immutable';

DROP TRIGGER IF EXISTS `idv2_balance_ledger_no_update`;
CREATE TRIGGER `idv2_balance_ledger_no_update`
BEFORE UPDATE ON `id_business_v2_balance_ledger`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'V2 balance ledger is immutable';

DROP TRIGGER IF EXISTS `idv2_balance_ledger_singleton_insert`;
CREATE TRIGGER `idv2_balance_ledger_singleton_insert`
BEFORE INSERT ON `id_business_v2_balance_ledger`
FOR EACH ROW
SET NEW.`order_singleton_key` = CASE
  WHEN NEW.`entry_type` IN ('order_consumption', 'order_consumption_reversal')
    THEN CONCAT(NEW.`order_id`, ':', NEW.`entry_type`)
  ELSE NULL
END;

DROP TRIGGER IF EXISTS `idv2_exchange_entry_no_delete`;
CREATE TRIGGER `idv2_exchange_entry_no_delete`
BEFORE DELETE ON `id_business_v2_exchange_rate_entries`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'V2 manual exchange-rate entry is immutable';

DROP TRIGGER IF EXISTS `idv2_exchange_entry_no_update`;
CREATE TRIGGER `idv2_exchange_entry_no_update`
BEFORE UPDATE ON `id_business_v2_exchange_rate_entries`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'V2 manual exchange-rate entry is immutable';

DROP TRIGGER IF EXISTS `idv2_exchange_provider_no_delete`;
CREATE TRIGGER `idv2_exchange_provider_no_delete`
BEFORE DELETE ON `id_business_v2_exchange_rate_provider_snapshots`
FOR EACH ROW
BEGIN
  IF COALESCE(@idv2_exchange_rate_retention_cleanup, 0) <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Exchange-rate provider evidence is immutable';
  END IF;
END;

DROP TRIGGER IF EXISTS `idv2_exchange_provider_no_update`;
CREATE TRIGGER `idv2_exchange_provider_no_update`
BEFORE UPDATE ON `id_business_v2_exchange_rate_provider_snapshots`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Exchange-rate provider evidence is immutable';

DROP TRIGGER IF EXISTS `idv2_exchange_run_no_delete`;
CREATE TRIGGER `idv2_exchange_run_no_delete`
BEFORE DELETE ON `id_business_v2_exchange_rate_runs`
FOR EACH ROW
BEGIN
  IF COALESCE(@idv2_exchange_rate_retention_cleanup, 0) <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Exchange-rate runs are immutable';
  END IF;
END;

DROP TRIGGER IF EXISTS `idv2_exchange_run_update_guard`;
CREATE TRIGGER `idv2_exchange_run_update_guard`
BEFORE UPDATE ON `id_business_v2_exchange_rate_runs`
FOR EACH ROW
BEGIN
  IF OLD.`status` <> 'running' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Finished exchange-rate runs are immutable';
  END IF;

  IF NEW.`status` = 'running'
    OR NOT (NEW.`id` <=> OLD.`id`)
    OR NOT (NEW.`trigger_type` <=> OLD.`trigger_type`)
    OR NOT (NEW.`asset` <=> OLD.`asset`)
    OR NOT (NEW.`fiat` <=> OLD.`fiat`)
    OR NOT (NEW.`started_at` <=> OLD.`started_at`)
    OR NOT (NEW.`triggered_by_user_id` <=> OLD.`triggered_by_user_id`)
    OR NOT (NEW.`created_at` <=> OLD.`created_at`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Exchange-rate run identity cannot be changed';
  END IF;
END;

DROP TRIGGER IF EXISTS `idv2_exchange_sample_no_delete`;
CREATE TRIGGER `idv2_exchange_sample_no_delete`
BEFORE DELETE ON `id_business_v2_exchange_rate_quote_samples`
FOR EACH ROW
BEGIN
  IF COALESCE(@idv2_exchange_rate_retention_cleanup, 0) <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Exchange-rate quote evidence is immutable';
  END IF;
END;

DROP TRIGGER IF EXISTS `idv2_exchange_sample_no_update`;
CREATE TRIGGER `idv2_exchange_sample_no_update`
BEFORE UPDATE ON `id_business_v2_exchange_rate_quote_samples`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Exchange-rate quote evidence is immutable';

DROP TRIGGER IF EXISTS `idv2_exchange_snapshot_no_delete`;
CREATE TRIGGER `idv2_exchange_snapshot_no_delete`
BEFORE DELETE ON `id_business_v2_exchange_rate_snapshots`
FOR EACH ROW
BEGIN
  IF COALESCE(@idv2_exchange_rate_retention_cleanup, 0) <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Exchange-rate snapshot evidence is immutable';
  END IF;
END;

DROP TRIGGER IF EXISTS `idv2_exchange_snapshot_no_update`;
CREATE TRIGGER `idv2_exchange_snapshot_no_update`
BEFORE UPDATE ON `id_business_v2_exchange_rate_snapshots`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Exchange-rate snapshot evidence is immutable';

DROP TRIGGER IF EXISTS `idv2_expense_snapshot_on_insert`;
CREATE TRIGGER `idv2_expense_snapshot_on_insert`
BEFORE INSERT ON `id_business_v2_finance_expenses`
FOR EACH ROW
BEGIN
  IF COALESCE(@idv2_data_migration, 0) <> 1 THEN
    SET
      NEW.`category_name_snapshot` = (
        SELECT `name` FROM `id_business_v2_options` WHERE `id` = NEW.`category_option_id`
      ),
      NEW.`finance_account_name_snapshot` = (
        SELECT `name` FROM `id_business_v2_finance_accounts` WHERE `id` = NEW.`finance_account_id`
      );
  END IF;
END;

DROP TRIGGER IF EXISTS `idv2_expense_snapshot_update_guard`;
CREATE TRIGGER `idv2_expense_snapshot_update_guard`
BEFORE UPDATE ON `id_business_v2_finance_expenses`
FOR EACH ROW
BEGIN
  IF NOT (NEW.`category_name_snapshot` <=> OLD.`category_name_snapshot`)
    OR NOT (NEW.`finance_account_name_snapshot` <=> OLD.`finance_account_name_snapshot`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Finance expense display snapshots are immutable';
  END IF;
END;

DROP TRIGGER IF EXISTS `idv2_finance_inflow_insert_guard`;
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

DROP TRIGGER IF EXISTS `idv2_finance_inflow_no_delete`;
CREATE TRIGGER `idv2_finance_inflow_no_delete`
BEFORE DELETE ON `id_business_v2_finance_inflows`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Finance inflow records are immutable';

DROP TRIGGER IF EXISTS `idv2_finance_inflow_no_update`;
CREATE TRIGGER `idv2_finance_inflow_no_update`
BEFORE UPDATE ON `id_business_v2_finance_inflows`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Finance inflow records are immutable';

DROP TRIGGER IF EXISTS `idv2_finance_journal_closed_period`;
CREATE TRIGGER `idv2_finance_journal_closed_period`
BEFORE INSERT ON `id_business_v2_finance_journals`
FOR EACH ROW
BEGIN
  IF COALESCE(@idv2_data_migration, 0) <> 1 AND EXISTS (
    SELECT 1
    FROM `id_business_v2_finance_periods` AS `period`
    WHERE `period`.`month` = NEW.`period_month`
      AND `period`.`status` = 'closed'
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Finance period is closed';
  END IF;
END;

DROP TRIGGER IF EXISTS `idv2_finance_journal_no_delete`;
CREATE TRIGGER `idv2_finance_journal_no_delete`
BEFORE DELETE ON `id_business_v2_finance_journals`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Posted finance journals cannot be deleted';

DROP TRIGGER IF EXISTS `idv2_finance_journal_update_guard`;
CREATE TRIGGER `idv2_finance_journal_update_guard`
BEFORE UPDATE ON `id_business_v2_finance_journals`
FOR EACH ROW
BEGIN
  IF NOT (
    OLD.`status` = 'posted'
    AND NEW.`status` = 'reversed'
    AND NEW.`reversed_at` IS NOT NULL
    AND NEW.`id` <=> OLD.`id`
    AND NEW.`journal_no` <=> OLD.`journal_no`
    AND NEW.`journal_type` <=> OLD.`journal_type`
    AND NEW.`source_type` <=> OLD.`source_type`
    AND NEW.`source_id` <=> OLD.`source_id`
    AND NEW.`source_reference` <=> OLD.`source_reference`
    AND NEW.`business_date` <=> OLD.`business_date`
    AND NEW.`period_month` <=> OLD.`period_month`
    AND NEW.`occurred_at` <=> OLD.`occurred_at`
    AND NEW.`reversal_of_journal_id` <=> OLD.`reversal_of_journal_id`
    AND NEW.`summary` <=> OLD.`summary`
    AND NEW.`metadata` <=> OLD.`metadata`
    AND NEW.`idempotency_key` <=> OLD.`idempotency_key`
    AND NEW.`created_by_user_id` <=> OLD.`created_by_user_id`
    AND NEW.`created_at` <=> OLD.`created_at`
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Posted finance journals can only be reversed';
  END IF;
END;

DROP TRIGGER IF EXISTS `idv2_finance_line_no_delete`;
CREATE TRIGGER `idv2_finance_line_no_delete`
BEFORE DELETE ON `id_business_v2_finance_journal_lines`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Posted finance journal lines are immutable';

DROP TRIGGER IF EXISTS `idv2_finance_line_no_update`;
CREATE TRIGGER `idv2_finance_line_no_update`
BEFORE UPDATE ON `id_business_v2_finance_journal_lines`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Posted finance journal lines are immutable';

DROP TRIGGER IF EXISTS `idv2_governance_approval_insert_guard`;
CREATE TRIGGER `idv2_governance_approval_insert_guard`
BEFORE INSERT ON `id_business_v2_governance_approvals`
FOR EACH ROW
BEGIN
  IF COALESCE(@idv2_data_migration, 0) <> 1 AND NOT EXISTS (
    SELECT 1
    FROM `id_business_v2_governance_jobs` AS `job`
    WHERE `job`.`id` = NEW.`job_id`
      AND `job`.`status` = 'pending_approval'
      AND `job`.`requested_by_user_id` <> NEW.`approver_user_id`
      AND `job`.`preview_hash` = NEW.`preview_hash`
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Governance approval does not match an eligible job';
  END IF;
END;

DROP TRIGGER IF EXISTS `idv2_governance_approval_no_delete`;
CREATE TRIGGER `idv2_governance_approval_no_delete`
BEFORE DELETE ON `id_business_v2_governance_approvals`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Governance approvals are immutable';

DROP TRIGGER IF EXISTS `idv2_governance_approval_no_update`;
CREATE TRIGGER `idv2_governance_approval_no_update`
BEFORE UPDATE ON `id_business_v2_governance_approvals`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Governance approvals are immutable';

DROP TRIGGER IF EXISTS `idv2_governance_item_identity_guard`;
CREATE TRIGGER `idv2_governance_item_identity_guard`
BEFORE UPDATE ON `id_business_v2_governance_job_items`
FOR EACH ROW
BEGIN
  IF NOT (NEW.`job_id` <=> OLD.`job_id`)
    OR NOT (NEW.`sequence` <=> OLD.`sequence`)
    OR NOT (NEW.`entity_type` <=> OLD.`entity_type`)
    OR NOT (NEW.`entity_id` <=> OLD.`entity_id`)
    OR NOT (NEW.`safe_label` <=> OLD.`safe_label`)
    OR NOT (NEW.`source_deleted_at` <=> OLD.`source_deleted_at`)
    OR NOT (NEW.`eligibility` <=> OLD.`eligibility`)
    OR NOT (NEW.`created_at` <=> OLD.`created_at`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Governance job item identity is immutable';
  END IF;
END;

DROP TRIGGER IF EXISTS `idv2_governance_job_preview_guard`;
CREATE TRIGGER `idv2_governance_job_preview_guard`
BEFORE UPDATE ON `id_business_v2_governance_jobs`
FOR EACH ROW
BEGIN
  IF NOT (NEW.`job_no` <=> OLD.`job_no`)
    OR NOT (NEW.`type` <=> OLD.`type`)
    OR NOT (NEW.`reason` <=> OLD.`reason`)
    OR NOT (NEW.`backup_evidence` <=> OLD.`backup_evidence`)
    OR NOT (NEW.`preview_hash` <=> OLD.`preview_hash`)
    OR NOT (NEW.`preview_summary` <=> OLD.`preview_summary`)
    OR NOT (NEW.`requested_by_user_id` <=> OLD.`requested_by_user_id`)
    OR NOT (NEW.`total_items` <=> OLD.`total_items`)
    OR NOT (NEW.`idempotency_key` <=> OLD.`idempotency_key`)
    OR NOT (NEW.`created_at` <=> OLD.`created_at`) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Governance job preview fields are immutable';
  END IF;
END;

DROP TRIGGER IF EXISTS `idv2_income_reference_insert_guard`;
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

DROP TRIGGER IF EXISTS `idv2_income_reference_no_delete`;
CREATE TRIGGER `idv2_income_reference_no_delete`
BEFORE DELETE ON `id_business_v2_finance_income_references`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Finance income references are immutable';

DROP TRIGGER IF EXISTS `idv2_income_reference_no_update`;
CREATE TRIGGER `idv2_income_reference_no_update`
BEFORE UPDATE ON `id_business_v2_finance_income_references`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Finance income references are immutable';

DROP TRIGGER IF EXISTS `idv2_order_balance_return_no_delete`;
CREATE TRIGGER `idv2_order_balance_return_no_delete`
BEFORE DELETE ON `id_business_v2_order_balance_returns`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Upgrade balance return records cannot be deleted';

DROP TRIGGER IF EXISTS `idv2_order_balance_return_update_guard`;
CREATE TRIGGER `idv2_order_balance_return_update_guard`
BEFORE UPDATE ON `id_business_v2_order_balance_returns`
FOR EACH ROW
BEGIN
  IF NOT (
    OLD.`status` = 'active'
    AND NEW.`status` = 'reversed'
    AND NEW.`active_key` IS NULL
    AND NEW.`reversal_balance_ledger_entry_id` IS NOT NULL
    AND NEW.`reversal_idempotency_key` IS NOT NULL
    AND NEW.`reversal_reason` IS NOT NULL
    AND NEW.`reversed_at` IS NOT NULL
    AND NEW.`id` <=> OLD.`id`
    AND NEW.`order_id` <=> OLD.`order_id`
    AND NEW.`account_id` <=> OLD.`account_id`
    AND NEW.`currency_code` <=> OLD.`currency_code`
    AND NEW.`returned_balance_amount` <=> OLD.`returned_balance_amount`
    AND NEW.`restored_balance_cost_amount` <=> OLD.`restored_balance_cost_amount`
    AND NEW.`restored_applied_balance_cost_amount` <=> OLD.`restored_applied_balance_cost_amount`
    AND NEW.`original_profit_amount` <=> OLD.`original_profit_amount`
    AND NEW.`adjusted_profit_amount` <=> OLD.`adjusted_profit_amount`
    AND NEW.`balance_ledger_entry_id` <=> OLD.`balance_ledger_entry_id`
    AND NEW.`finance_journal_id` <=> OLD.`finance_journal_id`
    AND NEW.`idempotency_key` <=> OLD.`idempotency_key`
    AND NEW.`reason` <=> OLD.`reason`
    AND NEW.`created_by_user_id` <=> OLD.`created_by_user_id`
    AND NEW.`created_at` <=> OLD.`created_at`
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Upgrade balance return snapshots are immutable';
  END IF;
END;

DROP TRIGGER IF EXISTS `idv2_order_snapshot_insert_capture`;
CREATE TRIGGER `idv2_order_snapshot_insert_capture`
AFTER INSERT ON `id_business_v2_orders`
FOR EACH ROW
BEGIN
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    SET @idv2_order_snapshot_internal = NULL;
    RESIGNAL;
  END;

  IF COALESCE(@idv2_data_migration, 0) <> 1 THEN
    SET @idv2_order_snapshot_internal = 1;
    INSERT INTO `id_business_v2_order_display_snapshots` (
      `order_id`,
      `customer_name`,
      `service_name`,
      `service_category_name`,
      `account_label`,
      `account_country_name`,
      `settlement_platform_name`,
      `captured_at`,
      `updated_at`
    )
    SELECT
      NEW.`id`,
      `customer`.`name`,
      `service`.`name`,
      `category`.`name`,
      `account`.`apple_id_masked`,
      `account_country`.`name`,
      `settlement`.`name`,
      COALESCE(NEW.`created_at`, CURRENT_TIMESTAMP(6)),
      CURRENT_TIMESTAMP(6)
    FROM `id_business_v2_customers` AS `customer`
    JOIN `id_business_v2_options` AS `service`
      ON `service`.`id` = NEW.`service_option_id`
    LEFT JOIN `id_business_v2_options` AS `category`
      ON `category`.`id` = `service`.`parent_id`
    LEFT JOIN `id_business_v2_accounts` AS `account`
      ON `account`.`id` = NEW.`account_id`
    LEFT JOIN `id_business_v2_options` AS `account_country`
      ON `account_country`.`id` = `account`.`country_option_id`
    LEFT JOIN `id_business_v2_options` AS `settlement`
      ON `settlement`.`id` = NEW.`settlement_platform_option_id`
    WHERE `customer`.`id` = NEW.`customer_id`;
    SET @idv2_order_snapshot_internal = NULL;
  END IF;
END;

DROP TRIGGER IF EXISTS `idv2_order_snapshot_no_delete`;
CREATE TRIGGER `idv2_order_snapshot_no_delete`
BEFORE DELETE ON `id_business_v2_order_display_snapshots`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Order display snapshots cannot be deleted';

DROP TRIGGER IF EXISTS `idv2_order_snapshot_update_capture`;
CREATE TRIGGER `idv2_order_snapshot_update_capture`
AFTER UPDATE ON `id_business_v2_orders`
FOR EACH ROW
BEGIN
  DECLARE EXIT HANDLER FOR SQLEXCEPTION
  BEGIN
    SET @idv2_order_snapshot_internal = NULL;
    RESIGNAL;
  END;

  IF NOT (NEW.`customer_id` <=> OLD.`customer_id`)
    OR NOT (NEW.`service_option_id` <=> OLD.`service_option_id`)
    OR NOT (NEW.`account_id` <=> OLD.`account_id`)
    OR NOT (NEW.`settlement_platform_option_id` <=> OLD.`settlement_platform_option_id`) THEN
    SET @idv2_order_snapshot_internal = 1;
    INSERT INTO `id_business_v2_order_display_snapshots` (
      `order_id`,
      `customer_name`,
      `service_name`,
      `service_category_name`,
      `account_label`,
      `account_country_name`,
      `settlement_platform_name`,
      `captured_at`,
      `updated_at`
    )
    SELECT
      NEW.`id`,
      `customer`.`name`,
      `service`.`name`,
      `category`.`name`,
      `account`.`apple_id_masked`,
      `account_country`.`name`,
      `settlement`.`name`,
      COALESCE(NEW.`created_at`, CURRENT_TIMESTAMP(6)),
      CURRENT_TIMESTAMP(6)
    FROM `id_business_v2_customers` AS `customer`
    JOIN `id_business_v2_options` AS `service`
      ON `service`.`id` = NEW.`service_option_id`
    LEFT JOIN `id_business_v2_options` AS `category`
      ON `category`.`id` = `service`.`parent_id`
    LEFT JOIN `id_business_v2_accounts` AS `account`
      ON `account`.`id` = NEW.`account_id`
    LEFT JOIN `id_business_v2_options` AS `account_country`
      ON `account_country`.`id` = `account`.`country_option_id`
    LEFT JOIN `id_business_v2_options` AS `settlement`
      ON `settlement`.`id` = NEW.`settlement_platform_option_id`
    WHERE `customer`.`id` = NEW.`customer_id`
    ON DUPLICATE KEY UPDATE
      `customer_name` = IF(
        NOT (NEW.`customer_id` <=> OLD.`customer_id`),
        VALUES(`customer_name`),
        `customer_name`
      ),
      `service_name` = IF(
        NOT (NEW.`service_option_id` <=> OLD.`service_option_id`),
        VALUES(`service_name`),
        `service_name`
      ),
      `service_category_name` = IF(
        NOT (NEW.`service_option_id` <=> OLD.`service_option_id`),
        VALUES(`service_category_name`),
        `service_category_name`
      ),
      `account_label` = IF(
        NOT (NEW.`account_id` <=> OLD.`account_id`),
        VALUES(`account_label`),
        `account_label`
      ),
      `account_country_name` = IF(
        NOT (NEW.`account_id` <=> OLD.`account_id`),
        VALUES(`account_country_name`),
        `account_country_name`
      ),
      `settlement_platform_name` = IF(
        NOT (NEW.`settlement_platform_option_id` <=> OLD.`settlement_platform_option_id`),
        VALUES(`settlement_platform_name`),
        `settlement_platform_name`
      ),
      `updated_at` = CURRENT_TIMESTAMP(6);
    SET @idv2_order_snapshot_internal = NULL;
  END IF;
END;

DROP TRIGGER IF EXISTS `idv2_order_snapshot_update_guard`;
CREATE TRIGGER `idv2_order_snapshot_update_guard`
BEFORE UPDATE ON `id_business_v2_order_display_snapshots`
FOR EACH ROW
BEGIN
  IF COALESCE(@idv2_order_snapshot_internal, 0) <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Order display snapshots cannot be directly updated';
  END IF;
END;

DROP TRIGGER IF EXISTS `idv2_purchase_snapshot_no_delete`;
CREATE TRIGGER `idv2_purchase_snapshot_no_delete`
BEFORE DELETE ON `id_business_v2_purchase_rate_snapshots`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Purchase-rate snapshots are immutable';

DROP TRIGGER IF EXISTS `idv2_purchase_snapshot_no_update`;
CREATE TRIGGER `idv2_purchase_snapshot_no_update`
BEFORE UPDATE ON `id_business_v2_purchase_rate_snapshots`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Purchase-rate snapshots are immutable';

DROP TRIGGER IF EXISTS `idv2_supplier_ledger_no_delete`;
CREATE TRIGGER `idv2_supplier_ledger_no_delete`
BEFORE DELETE ON `id_business_v2_topup_supplier_ledger`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Topup supplier financial records are immutable';

DROP TRIGGER IF EXISTS `idv2_supplier_ledger_no_update`;
CREATE TRIGGER `idv2_supplier_ledger_no_update`
BEFORE UPDATE ON `id_business_v2_topup_supplier_ledger`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Topup supplier financial records are immutable';

DROP TRIGGER IF EXISTS `idv2_supplier_payment_no_delete`;
CREATE TRIGGER `idv2_supplier_payment_no_delete`
BEFORE DELETE ON `id_business_v2_topup_supplier_payments`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Topup supplier financial records are immutable';

DROP TRIGGER IF EXISTS `idv2_supplier_payment_no_update`;
CREATE TRIGGER `idv2_supplier_payment_no_update`
BEFORE UPDATE ON `id_business_v2_topup_supplier_payments`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Topup supplier financial records are immutable';

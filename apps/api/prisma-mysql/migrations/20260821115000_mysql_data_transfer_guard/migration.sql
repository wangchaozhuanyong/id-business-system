-- The offline PostgreSQL-to-MySQL copy preserves audited snapshot columns exactly as
-- stored at the backup point. Only that dedicated transaction sets the session flag.

DROP TRIGGER `idv2_finance_journal_closed_period`;
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

DROP TRIGGER `idv2_governance_approval_insert_guard`;
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

DROP TRIGGER `idv2_expense_snapshot_on_insert`;
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

DROP TRIGGER `idv2_order_snapshot_insert_capture`;
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

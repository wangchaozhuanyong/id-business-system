-- User-approved one-time retention exception; runtime audit history stays immutable.
-- Only root maintenance connections with the exact scope can delete these old automatic records.
DROP TRIGGER IF EXISTS `idv2_audit_log_no_delete`;
CREATE TRIGGER `idv2_audit_log_no_delete`
BEFORE DELETE ON `audit_logs`
FOR EACH ROW
BEGIN
  IF NOT (
    SUBSTRING_INDEX(USER(), '@', 1) = 'root'
    AND COALESCE(@idv2_routine_audit_cleanup_scope, '') = 'audit-routine-20261002T110000Z'
    AND OLD.`module` = 'id_business_v2'
    AND OLD.`action` IN (
      'id_business_v2.website_visit.collect',
      'id_business_v2.exchange_rate.schedule.claim',
      'id_business_v2.exchange_rate.collect.started',
      'id_business_v2.exchange_rate.collect.success',
      'id_business_v2.exchange_rate.fx_snapshot.collect'
    )
    AND OLD.`user_id` IS NULL
    AND COALESCE(JSON_UNQUOTE(JSON_EXTRACT(OLD.`after_data`, '$.triggerType')), '') <> 'manual'
    AND OLD.`created_at` < '2026-10-02 11:00:00'
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'Audit logs are immutable';
  END IF;
END;

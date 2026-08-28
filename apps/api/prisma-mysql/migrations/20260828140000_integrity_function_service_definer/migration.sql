-- The function was originally created by the legacy application account. Recreate it
-- through the dedicated migration identity so restricting the runtime account cannot
-- break read-only integrity audits that execute under the function definer.
DROP FUNCTION IF EXISTS `idv2_integrity_trigger_exists`;

CREATE FUNCTION `idv2_integrity_trigger_exists`(
  expected_trigger VARCHAR(64),
  expected_table VARCHAR(64)
)
RETURNS TINYINT
NOT DETERMINISTIC
READS SQL DATA
SQL SECURITY DEFINER
RETURN EXISTS (
  SELECT 1
  FROM information_schema.triggers trigger_record
  WHERE trigger_record.trigger_schema = DATABASE()
    AND trigger_record.event_object_table = expected_table
    AND trigger_record.trigger_name = expected_trigger
);

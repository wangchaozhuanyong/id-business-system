-- Read-only audit users cannot inspect information_schema.TRIGGERS without the
-- schema-mutating TRIGGER privilege. Expose only the boolean existence check
-- through a SQL SECURITY DEFINER function, then grant EXECUTE on this function
-- to the dedicated audit identity during environment provisioning.
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

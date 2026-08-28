# MySQL 8.4 mysqldump can emit an extra semicolon before the closing version comment.
# Restrict normalization to DELIMITER trigger blocks so table data is never rewritten.
/^DELIMITER ;;$/,/^DELIMITER ;$/ {
  s#;[[:space:]]+\*/;;$# */;;#
}

DELETE FROM "role_permissions"
WHERE "permission_id" IN (
  SELECT "id"
  FROM "permissions"
  WHERE "code" = 'apple.account.delete'
);

DELETE FROM "permissions"
WHERE "code" = 'apple.account.delete';

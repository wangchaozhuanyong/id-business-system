UPDATE "id_business_v2_options"
SET
  "is_system" = false,
  "updated_at" = CURRENT_TIMESTAMP
WHERE "type" = 'expense_category'
  AND "is_system" = true;

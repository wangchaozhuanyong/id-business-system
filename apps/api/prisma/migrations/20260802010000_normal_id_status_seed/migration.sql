DO $block$
BEGIN
  UPDATE "id_business_v2_options"
  SET
    "name" = '正常',
    "status" = 'active',
    "is_system" = true,
    "deleted_at" = NULL,
    "updated_at" = CURRENT_TIMESTAMP
  WHERE "type" = 'id_status' AND "code" = 'normal';

  IF NOT FOUND THEN
    UPDATE "id_business_v2_options"
    SET
      "code" = 'normal',
      "name" = '正常',
      "status" = 'active',
      "is_system" = true,
      "deleted_at" = NULL,
      "updated_at" = CURRENT_TIMESTAMP
    WHERE "id" = (
      SELECT "id"
      FROM "id_business_v2_options"
      WHERE "type" = 'id_status' AND "name" = '正常'
      ORDER BY "created_at" ASC
      LIMIT 1
    );
  END IF;

  IF NOT FOUND THEN
    INSERT INTO "id_business_v2_options" (
      "id",
      "type",
      "code",
      "name",
      "unique_key",
      "sort_order",
      "status",
      "is_system",
      "remark",
      "created_at",
      "updated_at"
    )
    VALUES (
      gen_random_uuid(),
      'id_status',
      'normal',
      '正常',
      'id_status:root:正常',
      10,
      'active',
      true,
      '系统固定正常状态',
      CURRENT_TIMESTAMP,
      CURRENT_TIMESTAMP
    );
  END IF;
END;
$block$;

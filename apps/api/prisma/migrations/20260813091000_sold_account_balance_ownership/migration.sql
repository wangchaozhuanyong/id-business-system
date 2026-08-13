ALTER TABLE "id_business_v2_accounts"
ADD COLUMN "ownership_transferred_at" TIMESTAMPTZ(6);

ALTER TABLE "id_business_v2_orders"
ADD COLUMN "transferred_balance_cost_amount" DECIMAL(18, 4) NOT NULL DEFAULT 0,
ADD COLUMN "applied_balance_cost_amount" DECIMAL(18, 4) NOT NULL DEFAULT 0;

UPDATE "id_business_v2_accounts" account
SET "ownership_transferred_at" = COALESCE(
  sold_order."status_changed_at",
  account."sold_at",
  sold_order."updated_at"
)
FROM "id_business_v2_orders" sold_order
WHERE
  account."sold_by_order_id" = sold_order."id"
  AND sold_order."status" = 'completed'
  AND account."ownership_transferred_at" IS NULL;

WITH completed_order_cost AS (
  SELECT
    orders."id",
    orders."account_source",
    orders."account_disposition",
    orders."balance_cost_amount",
    CASE
      WHEN
        orders."account_source" = 'inventory'
        AND orders."account_disposition" = 'sold'
      THEN COALESCE(sale_consumption."cost_after", 0)
      ELSE 0
    END AS "transferred_balance_cost_amount"
  FROM "id_business_v2_orders" orders
  LEFT JOIN LATERAL (
    SELECT ledger."cost_after"
    FROM "id_business_v2_balance_ledger" ledger
    WHERE
      ledger."order_id" = orders."id"
      AND ledger."entry_type" = 'order_consumption'
    ORDER BY ledger."created_at" DESC, ledger."id" DESC
    LIMIT 1
  ) sale_consumption ON TRUE
  WHERE orders."status" = 'completed'
)
UPDATE "id_business_v2_orders" orders
SET
  "transferred_balance_cost_amount" = completed_order_cost."transferred_balance_cost_amount",
  "applied_balance_cost_amount" = CASE
    WHEN completed_order_cost."account_source" = 'customer_owned' THEN 0
    WHEN
      completed_order_cost."account_source" = 'inventory'
      AND completed_order_cost."account_disposition" = 'sold'
    THEN
      completed_order_cost."balance_cost_amount"
      + completed_order_cost."transferred_balance_cost_amount"
    ELSE completed_order_cost."balance_cost_amount"
  END
FROM completed_order_cost
WHERE orders."id" = completed_order_cost."id";

UPDATE "id_business_v2_orders"
SET "profit_amount" =
  "received_amount"
  - "platform_fee_amount"
  - "applied_account_cost_amount"
  - "applied_balance_cost_amount"
  - COALESCE("refund_cost_amount", 0)
WHERE "status" = 'completed';

ALTER TABLE "id_business_v2_orders"
ADD CONSTRAINT "id_business_v2_orders_balance_cost_ownership_check"
CHECK (
  "transferred_balance_cost_amount" >= 0
  AND "applied_balance_cost_amount" >= 0
  AND (
    "account_source" <> 'customer_owned'
    OR (
      "transferred_balance_cost_amount" = 0
    )
  )
);

CREATE INDEX "id_business_v2_accounts_ownership_transferred_at_idx"
ON "id_business_v2_accounts"("ownership_transferred_at");

INSERT INTO "id_business_v2_finance_journals" (
  "id",
  "journal_no",
  "journal_type",
  "source_type",
  "source_id",
  "source_reference",
  "business_date",
  "period_month",
  "occurred_at",
  "status",
  "summary",
  "metadata",
  "idempotency_key",
  "updated_at"
)
SELECT
  gen_random_uuid(),
  'HSB-' || left(replace(account."id"::text, '-', ''), 32),
  'historical_backfill',
  'order',
  sold_order."id"::text,
  sold_order."order_no",
  (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date,
  to_char(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM'),
  CURRENT_TIMESTAMP,
  'posted',
  '历史售出 ID 余额成本转为客户资产',
  jsonb_build_object(
    'reason', 'sold_account_balance_ownership_backfill',
    'accountId', account."id",
    'soldByOrderId', account."sold_by_order_id",
    'transferredBalanceCostAmount', sold_order."transferred_balance_cost_amount"
  ),
  'migration:sold_account_balance_ownership:' || account."id"::text,
  CURRENT_TIMESTAMP
FROM "id_business_v2_accounts" account
INNER JOIN "id_business_v2_orders" sold_order
  ON sold_order."id" = account."sold_by_order_id"
WHERE
  account."deleted_at" IS NULL
  AND account."ownership_transferred_at" IS NOT NULL
  AND sold_order."transferred_balance_cost_amount" > 0
ON CONFLICT ("idempotency_key") DO NOTHING;

INSERT INTO "id_business_v2_finance_journal_lines" (
  "id",
  "journal_id",
  "line_no",
  "account_code",
  "direction",
  "currency",
  "amount_original",
  "fx_rate_to_cny",
  "amount_cny",
  "memo"
)
SELECT
  gen_random_uuid(),
  journal."id",
  line."line_no",
  line."account_code"::"IdBusinessV2FinanceAccountCode",
  line."direction"::"IdBusinessV2FinanceLineDirection",
  'CNY',
  sold_order."transferred_balance_cost_amount",
  1,
  sold_order."transferred_balance_cost_amount",
  line."memo"
FROM "id_business_v2_finance_journals" journal
INNER JOIN "id_business_v2_accounts" account
  ON journal."idempotency_key" =
    'migration:sold_account_balance_ownership:' || account."id"::text
INNER JOIN "id_business_v2_orders" sold_order
  ON sold_order."id" = account."sold_by_order_id"
CROSS JOIN (
  VALUES
    (1, 'customer_owned_balance_cost', 'debit', '历史已售 ID 余额转为客户资产成本'),
    (2, 'gift_card_inventory', 'credit', '移出公司礼品卡余额资产')
) AS line("line_no", "account_code", "direction", "memo")
ON CONFLICT ("journal_id", "line_no") DO NOTHING;

INSERT INTO "audit_logs" (
  "id",
  "module",
  "action",
  "object_type",
  "object_id",
  "after_data",
  "remark"
)
SELECT
  gen_random_uuid(),
  'id_business_v2',
  'id_business_v2.account.balance_ownership_backfill',
  'id_business_v2_account',
  account."id",
  jsonb_build_object(
    'ownershipTransferredAt', account."ownership_transferred_at",
    'transferredBalanceCostAmount', sold_order."transferred_balance_cost_amount",
    'financeJournalId', journal."id"
  ),
  '历史已售 ID 剩余余额成本移出公司资产'
FROM "id_business_v2_accounts" account
INNER JOIN "id_business_v2_finance_journals" journal
  ON journal."idempotency_key" =
    'migration:sold_account_balance_ownership:' || account."id"::text
INNER JOIN "id_business_v2_orders" sold_order
  ON sold_order."id" = account."sold_by_order_id";

INSERT INTO "id_business_v2_finance_journals" (
  "id",
  "journal_no",
  "journal_type",
  "source_type",
  "source_id",
  "source_reference",
  "business_date",
  "period_month",
  "occurred_at",
  "status",
  "summary",
  "metadata",
  "idempotency_key",
  "updated_at"
)
WITH customer_owned_order_costs AS (
  SELECT
    orders."id",
    orders."order_no",
    SUM(
      CASE
        WHEN line."direction" = 'credit' THEN line."amount_cny"
        ELSE -line."amount_cny"
      END
    ) AS "net_inventory_reduction"
  FROM "id_business_v2_orders" orders
  INNER JOIN "id_business_v2_finance_journals" original_journal
    ON original_journal."source_type" = 'order'
    AND original_journal."source_id" = orders."id"::text
    AND original_journal."status" = 'posted'
    AND original_journal."journal_type" <> 'historical_backfill'
  INNER JOIN "id_business_v2_finance_journal_lines" line
    ON line."journal_id" = original_journal."id"
    AND line."account_code" = 'gift_card_inventory'
  WHERE orders."account_source" = 'customer_owned'
  GROUP BY orders."id", orders."order_no"
  HAVING SUM(
    CASE
      WHEN line."direction" = 'credit' THEN line."amount_cny"
      ELSE -line."amount_cny"
    END
  ) <> 0
)
SELECT
  gen_random_uuid(),
  'HCR-' || left(replace(order_cost."id"::text, '-', ''), 32),
  'historical_backfill',
  'order',
  order_cost."id"::text,
  order_cost."order_no",
  (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date,
  to_char(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM'),
  CURRENT_TIMESTAMP,
  'posted',
  '历史客户已购 ID 消费成本科目重分类',
  jsonb_build_object(
    'reason', 'customer_owned_order_cost_reclassification',
    'orderId', order_cost."id",
    'netInventoryReduction', order_cost."net_inventory_reduction"
  ),
  'migration:customer_owned_order_cost_reclassification:' || order_cost."id"::text,
  CURRENT_TIMESTAMP
FROM customer_owned_order_costs order_cost
ON CONFLICT ("idempotency_key") DO NOTHING;

INSERT INTO "id_business_v2_finance_journal_lines" (
  "id",
  "journal_id",
  "line_no",
  "account_code",
  "direction",
  "currency",
  "amount_original",
  "fx_rate_to_cny",
  "amount_cny",
  "memo"
)
WITH customer_owned_order_costs AS (
  SELECT
    orders."id",
    SUM(
      CASE
        WHEN line."direction" = 'credit' THEN line."amount_cny"
        ELSE -line."amount_cny"
      END
    ) AS "net_inventory_reduction"
  FROM "id_business_v2_orders" orders
  INNER JOIN "id_business_v2_finance_journals" original_journal
    ON original_journal."source_type" = 'order'
    AND original_journal."source_id" = orders."id"::text
    AND original_journal."status" = 'posted'
    AND original_journal."journal_type" <> 'historical_backfill'
  INNER JOIN "id_business_v2_finance_journal_lines" line
    ON line."journal_id" = original_journal."id"
    AND line."account_code" = 'gift_card_inventory'
  WHERE orders."account_source" = 'customer_owned'
  GROUP BY orders."id"
  HAVING SUM(
    CASE
      WHEN line."direction" = 'credit' THEN line."amount_cny"
      ELSE -line."amount_cny"
    END
  ) <> 0
)
SELECT
  gen_random_uuid(),
  journal."id",
  line."line_no",
  line."account_code"::"IdBusinessV2FinanceAccountCode",
  CASE
    WHEN order_cost."net_inventory_reduction" > 0
    THEN line."positive_direction"::"IdBusinessV2FinanceLineDirection"
    ELSE line."negative_direction"::"IdBusinessV2FinanceLineDirection"
  END,
  'CNY',
  abs(order_cost."net_inventory_reduction"),
  1,
  abs(order_cost."net_inventory_reduction"),
  line."memo"
FROM customer_owned_order_costs order_cost
INNER JOIN "id_business_v2_finance_journals" journal
  ON journal."idempotency_key" =
    'migration:customer_owned_order_cost_reclassification:' || order_cost."id"::text
CROSS JOIN (
  VALUES
    (
      1,
      'gift_card_inventory',
      'debit',
      'credit',
      '冲回历史客户已购 ID 订单对公司余额库存的净影响'
    ),
    (
      2,
      'gift_card_cost',
      'credit',
      'debit',
      '冲回历史客户已购 ID 订单对余额销售成本的净影响'
    )
) AS line("line_no", "account_code", "positive_direction", "negative_direction", "memo")
ON CONFLICT ("journal_id", "line_no") DO NOTHING;

WITH customer_owned_inventory_lines AS (
  SELECT
    line."id" AS "line_id",
    line."direction",
    line."amount_original",
    line."fx_rate_to_cny",
    line."amount_cny",
    journal."source_type",
    journal."source_id",
    journal."source_reference"
  FROM "id_business_v2_finance_journal_lines" line
  INNER JOIN "id_business_v2_finance_journals" journal
    ON journal."id" = line."journal_id"
    AND journal."status" = 'posted'
    AND journal."journal_type" <> 'historical_backfill'
  LEFT JOIN "id_business_v2_gift_cards" gift_card
    ON journal."source_type" = 'gift_card'
    AND journal."source_id" = gift_card."id"::text
  LEFT JOIN "id_business_v2_account_losses" account_loss
    ON journal."source_type" = 'account_loss'
    AND journal."source_id" = account_loss."id"::text
  INNER JOIN "id_business_v2_accounts" account
    ON (
      (journal."source_type" = 'gift_card' AND account."id" = gift_card."account_id")
      OR (journal."source_type" = 'account' AND journal."source_id" = account."id"::text)
      OR (journal."source_type" = 'account_loss' AND account."id" = account_loss."account_id")
    )
  WHERE
    line."account_code" = 'gift_card_inventory'
    AND line."amount_cny" > 0
    AND account."ownership_transferred_at" IS NOT NULL
    AND journal."occurred_at" >= account."ownership_transferred_at"
)
INSERT INTO "id_business_v2_finance_journals" (
  "id",
  "journal_no",
  "journal_type",
  "source_type",
  "source_id",
  "source_reference",
  "business_date",
  "period_month",
  "occurred_at",
  "status",
  "summary",
  "metadata",
  "idempotency_key",
  "updated_at"
)
SELECT
  gen_random_uuid(),
  'HCI-' || left(replace(source."line_id"::text, '-', ''), 32),
  'historical_backfill',
  source."source_type",
  source."source_id",
  source."source_reference",
  (CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai')::date,
  to_char(CURRENT_TIMESTAMP AT TIME ZONE 'Asia/Shanghai', 'YYYY-MM'),
  CURRENT_TIMESTAMP,
  'posted',
  '历史客户已购 ID 余额库存科目重分类',
  jsonb_build_object(
    'reason', 'customer_owned_inventory_line_reclassification',
    'originalLineId', source."line_id",
    'originalDirection', source."direction"
  ),
  'migration:customer_owned_inventory_line:' || source."line_id"::text,
  CURRENT_TIMESTAMP
FROM customer_owned_inventory_lines source
ON CONFLICT ("idempotency_key") DO NOTHING;

WITH customer_owned_inventory_lines AS (
  SELECT
    line."id" AS "line_id",
    line."direction",
    line."amount_original",
    line."fx_rate_to_cny",
    line."amount_cny"
  FROM "id_business_v2_finance_journal_lines" line
  INNER JOIN "id_business_v2_finance_journals" original_journal
    ON original_journal."id" = line."journal_id"
    AND original_journal."status" = 'posted'
    AND original_journal."journal_type" <> 'historical_backfill'
  LEFT JOIN "id_business_v2_gift_cards" gift_card
    ON original_journal."source_type" = 'gift_card'
    AND original_journal."source_id" = gift_card."id"::text
  LEFT JOIN "id_business_v2_account_losses" account_loss
    ON original_journal."source_type" = 'account_loss'
    AND original_journal."source_id" = account_loss."id"::text
  INNER JOIN "id_business_v2_accounts" account
    ON (
      (original_journal."source_type" = 'gift_card' AND account."id" = gift_card."account_id")
      OR (original_journal."source_type" = 'account' AND original_journal."source_id" = account."id"::text)
      OR (original_journal."source_type" = 'account_loss' AND account."id" = account_loss."account_id")
    )
  WHERE
    line."account_code" = 'gift_card_inventory'
    AND line."amount_cny" > 0
    AND account."ownership_transferred_at" IS NOT NULL
    AND original_journal."occurred_at" >= account."ownership_transferred_at"
)
INSERT INTO "id_business_v2_finance_journal_lines" (
  "id",
  "journal_id",
  "line_no",
  "account_code",
  "direction",
  "currency",
  "amount_original",
  "fx_rate_to_cny",
  "amount_cny",
  "memo"
)
SELECT
  gen_random_uuid(),
  journal."id",
  line_definition."line_no",
  line_definition."account_code"::"IdBusinessV2FinanceAccountCode",
  line_definition."direction"::"IdBusinessV2FinanceLineDirection",
  'CNY',
  source."amount_cny",
  1,
  source."amount_cny",
  line_definition."memo"
FROM customer_owned_inventory_lines source
INNER JOIN "id_business_v2_finance_journals" journal
  ON journal."idempotency_key" =
    'migration:customer_owned_inventory_line:' || source."line_id"::text
CROSS JOIN LATERAL (
  VALUES
    (
      1,
      'gift_card_inventory',
      CASE WHEN source."direction" = 'debit' THEN 'credit' ELSE 'debit' END,
      '冲回历史客户已购 ID 对公司余额库存的影响'
    ),
    (
      2,
      'customer_owned_balance_cost',
      source."direction"::text,
      '重分类至客户已购 ID 余额转移成本'
    )
) AS line_definition("line_no", "account_code", "direction", "memo")
ON CONFLICT ("journal_id", "line_no") DO NOTHING;

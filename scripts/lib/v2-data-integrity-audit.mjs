export const V2_DATA_INTEGRITY_CHECKS = Object.freeze([
  check(
    'auth_user_phone_storage_invalid',
    '员工账号手机号密文与脱敏状态不完整、密文格式错误或遗留明文列仍存在',
    `SELECT CAST(user_record.id AS CHAR) AS entity_id,
            JSON_OBJECT(
              'hasEncrypted', user_record.phone_encrypted IS NOT NULL,
              'hasMasked', user_record.phone_masked IS NOT NULL
            ) AS detail
     FROM users user_record
     WHERE (user_record.phone_encrypted IS NULL) <> (user_record.phone_masked IS NULL)
        OR (
          user_record.phone_encrypted IS NOT NULL
          AND user_record.phone_encrypted NOT REGEXP '^v1:[A-Za-z0-9_-]{16}:[A-Za-z0-9_-]{22}:[A-Za-z0-9_-]+$'
        )
     UNION ALL
     SELECT 'users_plaintext_phone_column_present' AS entity_id,
            JSON_OBJECT('column', 'phone') AS detail
     WHERE EXISTS (
       SELECT 1
       FROM information_schema.columns column_record
       WHERE column_record.table_schema = DATABASE()
         AND column_record.table_name = 'users'
         AND column_record.column_name = 'phone'
     )`
  ),
  check(
    'finance_expense_display_snapshot_missing',
    '经营开支历史分类名或资金账户名快照缺失',
    `SELECT CAST(expense.id AS CHAR) AS entity_id,
            JSON_OBJECT(
              'categoryNameSnapshot', expense.category_name_snapshot,
              'financeAccountNameSnapshot', expense.finance_account_name_snapshot
            ) AS detail
     FROM id_business_v2_finance_expenses expense
     WHERE TRIM(expense.category_name_snapshot) = ''
        OR TRIM(expense.finance_account_name_snapshot) = ''`
  ),
  check(
    'finance_expense_display_snapshot_not_protected',
    '经营开支历史展示快照缺少数据库防篡改触发器',
    `SELECT 'id_business_v2_finance_expenses' AS entity_id,
            JSON_OBJECT('trigger', 'idv2_expense_snapshot_update_guard') AS detail
     WHERE idv2_integrity_trigger_exists(
       'idv2_expense_snapshot_update_guard',
       'id_business_v2_finance_expenses'
     ) = 0`
  ),
  check(
    'pending_or_failed_migrations',
    '存在未完成且未回滚的数据库迁移',
    `SELECT migration_name AS entity_id,
            JSON_OBJECT('startedAt', started_at) AS detail
     FROM _prisma_migrations
     WHERE finished_at IS NULL AND rolled_back_at IS NULL`
  ),
  check(
    'foreign_key_enforcement_disabled',
    'MySQL 外键检查被关闭',
    `SELECT 'foreign_key_checks' AS entity_id,
            JSON_OBJECT(
              'globalEnabled', @@GLOBAL.foreign_key_checks,
              'sessionEnabled', @@SESSION.foreign_key_checks
            ) AS detail
     WHERE @@GLOBAL.foreign_key_checks <> 1 OR @@SESSION.foreign_key_checks <> 1`
  ),
  check(
    'order_display_snapshot_missing',
    '订单缺少不可变展示快照',
    `SELECT CAST(order_record.id AS CHAR) AS entity_id,
            JSON_OBJECT('orderNo', order_record.order_no) AS detail
     FROM id_business_v2_orders order_record
     LEFT JOIN id_business_v2_order_display_snapshots snapshot
       ON snapshot.order_id = order_record.id
     WHERE snapshot.order_id IS NULL`
  ),
  check(
    'deleted_option_key_not_namespaced',
    '已删除选项仍占用原唯一键',
    `SELECT CAST(option_record.id AS CHAR) AS entity_id,
            JSON_OBJECT('type', option_record.type) AS detail
     FROM id_business_v2_options option_record
     WHERE option_record.deleted_at IS NOT NULL
       AND (
         option_record.unique_key NOT LIKE CONCAT('deleted:', option_record.id, ':%')
         OR option_record.status_before_deletion IS NULL
       )`
  ),
  check(
    'live_option_has_delete_snapshot',
    '未删除选项仍保留删除前状态快照',
    `SELECT CAST(option_record.id AS CHAR) AS entity_id,
            JSON_OBJECT('type', option_record.type) AS detail
     FROM id_business_v2_options option_record
     WHERE option_record.deleted_at IS NULL
       AND option_record.status_before_deletion IS NOT NULL`
  ),
  check(
    'option_cascade_marker_mismatch',
    '选项级联删除来源标记与当前删除状态不一致',
    `SELECT CAST(option_record.id AS CHAR) AS entity_id,
            JSON_OBJECT('parentOptionId', option_record.deleted_by_parent_option_id) AS detail
     FROM id_business_v2_options option_record
     LEFT JOIN id_business_v2_options parent_option
       ON parent_option.id = option_record.deleted_by_parent_option_id
     WHERE (option_record.deleted_at IS NULL AND option_record.deleted_by_parent_option_id IS NOT NULL)
        OR (option_record.deleted_by_parent_option_id IS NOT NULL AND (
          option_record.type <> 'service'
          OR parent_option.id IS NULL
          OR NOT (parent_option.deleted_at <=> option_record.deleted_at)
          OR parent_option.id NOT IN (option_record.parent_id, option_record.country_option_id)
        ))`
  ),
  check(
    'live_service_under_inactive_master',
    '启用业务关联了已删除或停用的国家/业务分类',
    `SELECT CAST(service.id AS CHAR) AS entity_id,
            JSON_OBJECT('categoryId', category.id, 'countryId', country.id) AS detail
     FROM id_business_v2_options service
     LEFT JOIN id_business_v2_options category ON category.id = service.parent_id
     LEFT JOIN id_business_v2_options country ON country.id = service.country_option_id
     WHERE service.type = 'service'
       AND service.deleted_at IS NULL
       AND service.status = 'active'
       AND (
         category.id IS NULL OR category.deleted_at IS NOT NULL OR category.status <> 'active'
         OR country.id IS NULL OR country.deleted_at IS NOT NULL OR country.status <> 'active'
       )`
  ),
  check(
    'active_account_inactive_master',
    '启用 ID 关联了已删除或停用的主数据',
    `SELECT CAST(account.id AS CHAR) AS entity_id,
            JSON_OBJECT(
              'countryId', account.country_option_id,
              'statusId', account.status_option_id,
              'supplierId', account.supplier_option_id
            ) AS detail
     FROM id_business_v2_accounts account
     JOIN id_business_v2_options country ON country.id = account.country_option_id
     JOIN id_business_v2_options status_option ON status_option.id = account.status_option_id
     LEFT JOIN id_business_v2_options supplier ON supplier.id = account.supplier_option_id
     WHERE account.deleted_at IS NULL
       AND account.record_status = 'active'
       AND (
         country.deleted_at IS NOT NULL OR country.status <> 'active'
         OR status_option.deleted_at IS NOT NULL OR status_option.status <> 'active'
         OR (supplier.id IS NOT NULL AND (supplier.deleted_at IS NOT NULL OR supplier.status <> 'active'))
       )`
  ),
  check(
    'open_order_inactive_entity',
    '进行中订单关联了已删除或停用的业务实体',
    `SELECT CAST(order_record.id AS CHAR) AS entity_id,
            JSON_OBJECT('status', order_record.status) AS detail
     FROM id_business_v2_orders order_record
     JOIN id_business_v2_customers customer ON customer.id = order_record.customer_id
     JOIN id_business_v2_options service ON service.id = order_record.service_option_id
     LEFT JOIN id_business_v2_accounts account ON account.id = order_record.account_id
     LEFT JOIN id_business_v2_options settlement
       ON settlement.id = order_record.settlement_platform_option_id
     WHERE order_record.deleted_at IS NULL
       AND order_record.status IN ('draft', 'pending', 'waiting_external', 'processing')
       AND (
         customer.deleted_at IS NOT NULL OR customer.record_status <> 'active'
         OR service.deleted_at IS NOT NULL OR service.status <> 'active'
         OR (account.id IS NOT NULL AND (account.deleted_at IS NOT NULL OR account.record_status <> 'active'))
         OR (settlement.id IS NOT NULL AND (settlement.deleted_at IS NOT NULL OR settlement.status <> 'active'))
       )`
  ),
  check(
    'activation_order_dimension_mismatch',
    '开通记录与来源订单的客户、ID 或业务不一致',
    `SELECT CAST(activation.id AS CHAR) AS entity_id,
            JSON_OBJECT('orderId', activation.order_id) AS detail
     FROM id_business_v2_activations activation
     JOIN id_business_v2_orders order_record ON order_record.id = activation.order_id
     WHERE activation.customer_id <> order_record.customer_id
        OR NOT (activation.account_id <=> order_record.account_id)
        OR activation.service_option_id <> order_record.service_option_id`
  ),
  check(
    'customer_owned_order_source_mismatch',
    '客户已购 ID 订单与原销售订单或当前归属不一致',
    `SELECT CAST(after_sales.id AS CHAR) AS entity_id,
            JSON_OBJECT(
              'sourceSoldOrderId', after_sales.source_sold_order_id,
              'accountId', after_sales.account_id
            ) AS detail
     FROM id_business_v2_orders after_sales
     LEFT JOIN id_business_v2_orders source_order
       ON source_order.id = after_sales.source_sold_order_id
     LEFT JOIN id_business_v2_accounts account
       ON account.id = after_sales.account_id
     WHERE after_sales.account_source = 'customer_owned'
       AND (
         source_order.id IS NULL
         OR account.id IS NULL
         OR source_order.customer_id <> after_sales.customer_id
         OR NOT (source_order.account_id <=> after_sales.account_id)
         OR (
           (
             after_sales.status IN ('draft', 'pending', 'waiting_external', 'processing')
             OR EXISTS (
               SELECT 1
               FROM id_business_v2_activations activation
               WHERE activation.order_id = after_sales.id
                 AND activation.status = 'active'
                 AND NOT EXISTS (
                   SELECT 1
                   FROM id_business_v2_activations renewed_activation
                   WHERE renewed_activation.renewed_from_activation_id = activation.id
                 )
                 AND (activation.due_at IS NULL OR activation.due_at > CURRENT_TIMESTAMP)
             )
           )
           AND (
             source_order.account_disposition NOT IN ('sold', 'recovered')
             OR (
               source_order.account_disposition = 'sold'
               AND NOT (account.sold_by_order_id <=> after_sales.source_sold_order_id)
             )
             OR (
               source_order.account_disposition = 'recovered'
               AND account.sold_by_order_id IS NOT NULL
             )
           )
         )
       )`
  ),
  check(
    'sold_account_ownership_mismatch',
    '已售 ID 的归属证据与原销售订单不一致',
    `SELECT CAST(account.id AS CHAR) AS entity_id,
            JSON_OBJECT('soldByOrderId', account.sold_by_order_id) AS detail
     FROM id_business_v2_accounts account
     LEFT JOIN id_business_v2_orders sold_order
       ON sold_order.id = account.sold_by_order_id
     WHERE account.sold_by_order_id IS NOT NULL
       AND (
         sold_order.id IS NULL
         OR NOT (sold_order.account_id <=> account.id)
         OR sold_order.account_disposition <> 'sold'
       )`
  ),
  check(
    'customer_owned_order_duplicate_id_cost',
    '客户已购 ID 订单重复计入 ID 成本',
    `SELECT DISTINCT CAST(after_sales.id AS CHAR) AS entity_id,
            JSON_OBJECT(
              'accountCostAmount', after_sales.account_cost_amount,
              'appliedAccountCostAmount', after_sales.applied_account_cost_amount
            ) AS detail
     FROM id_business_v2_orders after_sales
     LEFT JOIN id_business_v2_finance_journals journal
       ON journal.source_id = after_sales.id
     LEFT JOIN id_business_v2_finance_journal_lines line
       ON line.journal_id = journal.id AND line.account_code = 'id_cost'
     WHERE after_sales.account_source = 'customer_owned'
       AND (
         after_sales.account_cost_amount <> 0
         OR after_sales.applied_account_cost_amount <> 0
         OR line.id IS NOT NULL
       )`
  ),
  check(
    'customer_service_aggregate_mismatch',
    '客户业务汇总与开通记录不一致',
    `WITH actual AS (
       SELECT customer_id, service_option_id AS option_id,
              COUNT(*) AS activation_count,
              MIN(opened_at) AS first_opened_at,
              MAX(opened_at) AS last_opened_at
       FROM id_business_v2_activations
       GROUP BY customer_id, service_option_id
     ), compared AS (
       SELECT saved.customer_id,
              saved.option_id,
              saved.activation_count AS saved_count,
              actual.activation_count AS actual_count,
              saved.first_opened_at AS saved_first,
              actual.first_opened_at AS actual_first,
              saved.last_opened_at AS saved_last,
              actual.last_opened_at AS actual_last
       FROM id_business_v2_customer_services saved
       LEFT JOIN actual
         ON actual.customer_id = saved.customer_id AND actual.option_id = saved.option_id
       WHERE saved.source = 'activation'
       UNION ALL
       SELECT actual.customer_id,
              actual.option_id,
              NULL AS saved_count,
              actual.activation_count AS actual_count,
              NULL AS saved_first,
              actual.first_opened_at AS actual_first,
              NULL AS saved_last,
              actual.last_opened_at AS actual_last
       FROM actual
       LEFT JOIN id_business_v2_customer_services saved
         ON saved.customer_id = actual.customer_id
        AND saved.option_id = actual.option_id
        AND saved.source = 'activation'
       WHERE saved.customer_id IS NULL
     )
     SELECT CONCAT(customer_id, ':', option_id) AS entity_id,
            JSON_OBJECT('savedCount', saved_count, 'actualCount', actual_count) AS detail
     FROM compared
     WHERE NOT (saved_count <=> actual_count)
        OR NOT (saved_first <=> actual_first)
        OR NOT (saved_last <=> actual_last)`
  ),
  check(
    'account_balance_latest_ledger_mismatch',
    'ID 当前余额/成本与最后一条余额流水不一致',
    `WITH ranked AS (
       SELECT account_id, balance_after, cost_after,
              ROW_NUMBER() OVER (PARTITION BY account_id ORDER BY created_at DESC, id DESC) AS rn
       FROM id_business_v2_balance_ledger
     ), latest AS (
       SELECT account_id, balance_after, cost_after FROM ranked WHERE rn = 1
     )
     SELECT CAST(account.id AS CHAR) AS entity_id,
            JSON_OBJECT(
              'currentBalance', account.current_balance,
              'ledgerBalance', latest.balance_after,
              'currentCost', account.balance_cost_amount,
              'ledgerCost', latest.cost_after
            ) AS detail
     FROM id_business_v2_accounts account
     LEFT JOIN latest ON latest.account_id = account.id
     WHERE (latest.account_id IS NOT NULL AND (
              account.current_balance <> latest.balance_after
              OR account.balance_cost_amount <> latest.cost_after
            ))
        OR (latest.account_id IS NULL AND (
              account.current_balance <> 0 OR account.balance_cost_amount <> 0
            ))`
  ),
  check(
    'balance_ledger_chain_discontinuity',
    'ID 余额流水前后不连续',
    `WITH ordered AS (
       SELECT id, account_id, balance_before, cost_before,
              LAG(balance_after) OVER (PARTITION BY account_id ORDER BY created_at, id) AS previous_balance,
              LAG(cost_after) OVER (PARTITION BY account_id ORDER BY created_at, id) AS previous_cost
       FROM id_business_v2_balance_ledger
     )
     SELECT CAST(id AS CHAR) AS entity_id,
            JSON_OBJECT('accountId', account_id) AS detail
     FROM ordered
     WHERE previous_balance IS NOT NULL
       AND (balance_before <> previous_balance OR cost_before <> previous_cost)`
  ),
  check(
    'balance_ledger_reversal_mismatch',
    'ID 余额冲销流水与原流水不匹配',
    `WITH active_balance_return AS (
       SELECT order_id,
              SUM(returned_balance_amount) AS returned_balance_amount,
              SUM(restored_balance_cost_amount) AS restored_balance_cost_amount
       FROM id_business_v2_order_balance_returns
       WHERE status = 'active'
       GROUP BY order_id
     ), compared AS (
       SELECT reversal.id AS reversal_id,
              reversal.entry_type AS reversal_entry_type,
              reversal.direction AS reversal_direction,
              reversal.account_id AS reversal_account_id,
              reversal.order_id AS reversal_order_id,
              reversal.balance_amount AS reversal_balance_amount,
              reversal.cost_amount AS reversal_cost_amount,
              original.id AS original_id,
              original.entry_type AS original_entry_type,
              original.direction AS original_direction,
              original.account_id AS original_account_id,
              original.order_id AS original_order_id,
              original.balance_amount -
                COALESCE(active_return.returned_balance_amount, 0) AS remaining_balance_amount,
              original.cost_amount -
                COALESCE(active_return.restored_balance_cost_amount, 0) AS remaining_cost_amount
       FROM id_business_v2_balance_ledger reversal
       LEFT JOIN id_business_v2_balance_ledger original
         ON original.id = reversal.reversal_of_entry_id
       LEFT JOIN active_balance_return active_return
         ON active_return.order_id = original.order_id
       WHERE reversal.reversal_of_entry_id IS NOT NULL
     )
     SELECT CAST(reversal_id AS CHAR) AS entity_id,
            JSON_OBJECT('originalId', original_id) AS detail
     FROM compared
     WHERE original_id IS NULL
        OR reversal_entry_type <> 'order_consumption_reversal'
        OR original_entry_type <> 'order_consumption'
        OR reversal_direction <> 'credit'
        OR original_direction <> 'debit'
        OR reversal_account_id <> original_account_id
        OR NOT (reversal_order_id <=> original_order_id)
        OR remaining_balance_amount <= 0
        OR remaining_cost_amount < 0
        OR reversal_balance_amount <= 0
        OR reversal_balance_amount > remaining_balance_amount
        OR reversal_cost_amount < 0
        OR reversal_cost_amount > remaining_cost_amount
        OR NOT (
          reversal_cost_amount <=> CASE
            WHEN reversal_balance_amount = remaining_balance_amount
              THEN remaining_cost_amount
            ELSE ROUND(
              remaining_cost_amount / remaining_balance_amount * reversal_balance_amount,
              4
            )
          END
        )`
  ),
  check(
    'gift_card_ledger_state_mismatch',
    '礼品卡状态与余额流水不一致',
    `SELECT CAST(gift_card.id AS CHAR) AS entity_id,
            JSON_OBJECT('status', gift_card.status) AS detail
     FROM id_business_v2_gift_cards gift_card
     WHERE NOT EXISTS (
       SELECT 1 FROM id_business_v2_balance_ledger ledger
       WHERE ledger.gift_card_id = gift_card.id AND ledger.entry_type = 'gift_card_credit'
     )
     OR (gift_card.status = 'redeemed' AND NOT EXISTS (
       SELECT 1 FROM id_business_v2_balance_ledger ledger
       WHERE ledger.gift_card_id = gift_card.id AND ledger.entry_type = 'gift_card_redeemed'
     ))
     OR (gift_card.status = 'withdrawn' AND NOT EXISTS (
       SELECT 1 FROM id_business_v2_balance_ledger ledger
       WHERE ledger.gift_card_id = gift_card.id AND ledger.entry_type = 'gift_card_withdrawal'
     ))`
  ),
  check(
    'order_consumption_state_mismatch',
    '订单状态与余额扣减/冲销流水不一致',
    `SELECT CAST(order_record.id AS CHAR) AS entity_id,
            JSON_OBJECT('status', order_record.status, 'balanceAmount', order_record.balance_amount) AS detail
     FROM id_business_v2_orders order_record
     WHERE (
       order_record.status = 'completed'
       AND order_record.balance_amount > 0
       AND NOT EXISTS (
         SELECT 1 FROM id_business_v2_balance_ledger ledger
         WHERE ledger.order_id = order_record.id AND ledger.entry_type = 'order_consumption'
       )
     ) OR (
       order_record.status IN ('refunded', 'cancelled', 'failed')
       AND EXISTS (
         SELECT 1 FROM id_business_v2_balance_ledger ledger
         WHERE ledger.order_id = order_record.id AND ledger.entry_type = 'order_consumption'
       )
       AND NOT EXISTS (
         SELECT 1 FROM id_business_v2_balance_ledger ledger
         WHERE ledger.order_id = order_record.id AND ledger.entry_type = 'order_consumption_reversal'
       )
     )`
  ),
  check(
    'sold_account_order_mismatch',
    '已售 ID 与销售订单的双向关系不一致',
    `SELECT CAST(account.id AS CHAR) AS entity_id,
            JSON_OBJECT('soldByOrderId', account.sold_by_order_id) AS detail
     FROM id_business_v2_accounts account
     LEFT JOIN id_business_v2_orders order_record ON order_record.id = account.sold_by_order_id
     WHERE account.sold_by_order_id IS NOT NULL
       AND (
         order_record.id IS NULL OR NOT (order_record.account_id <=> account.id)
         OR order_record.account_disposition <> 'sold'
       )
     UNION ALL
     SELECT CAST(order_record.id AS CHAR) AS entity_id,
            JSON_OBJECT('accountId', order_record.account_id) AS detail
     FROM id_business_v2_orders order_record
     LEFT JOIN id_business_v2_accounts account ON account.id = order_record.account_id
     WHERE order_record.account_disposition = 'sold'
       AND (account.id IS NULL OR NOT (account.sold_by_order_id <=> order_record.id))`
  ),
  check(
    'unsafe_active_account_lock',
    '存在过期或关联状态不安全的活动 ID 锁',
    `SELECT CAST(lock_record.id AS CHAR) AS entity_id,
            JSON_OBJECT('accountId', lock_record.account_id, 'orderId', lock_record.order_id) AS detail
     FROM id_business_v2_account_locks lock_record
     JOIN id_business_v2_accounts account ON account.id = lock_record.account_id
     JOIN id_business_v2_orders order_record ON order_record.id = lock_record.order_id
     WHERE lock_record.status = 'active'
       AND (
         lock_record.expires_at <= CURRENT_TIMESTAMP
         OR account.deleted_at IS NOT NULL OR account.record_status <> 'active'
         OR account.loss_reported_at IS NOT NULL
         OR (
           account.sold_by_order_id IS NOT NULL
           AND NOT (
             account.sold_by_order_id = order_record.id
             OR (
               order_record.account_source = 'customer_owned'
               AND order_record.source_sold_order_id = account.sold_by_order_id
             )
           )
         )
         OR order_record.deleted_at IS NOT NULL
         OR order_record.status NOT IN ('draft', 'pending', 'waiting_external', 'processing')
         OR NOT (order_record.account_id <=> account.id)
       )`
  ),
  check(
    'account_loss_state_mismatch',
    'ID 报损主状态与活动报损记录不一致',
    `SELECT CAST(account.id AS CHAR) AS entity_id,
            JSON_OBJECT('activeLossRecordId', account.active_loss_record_id) AS detail
     FROM id_business_v2_accounts account
     LEFT JOIN id_business_v2_account_losses loss
       ON loss.id = account.active_loss_record_id
     WHERE (account.loss_reported_at IS NULL) <> (account.active_loss_record_id IS NULL)
        OR (account.active_loss_record_id IS NOT NULL AND (
          loss.id IS NULL OR loss.account_id <> account.id OR loss.status <> 'active'
        ))
     UNION ALL
     SELECT CAST(loss.id AS CHAR) AS entity_id,
            JSON_OBJECT('accountId', loss.account_id) AS detail
     FROM id_business_v2_account_losses loss
     JOIN id_business_v2_accounts account ON account.id = loss.account_id
     WHERE loss.status = 'active' AND NOT (account.active_loss_record_id <=> loss.id)`
  ),
  check(
    'supplier_balance_latest_ledger_mismatch',
    '供应商钱包余额与最后一条流水不一致',
    `WITH ranked AS (
       SELECT supplier_account_id, balance_after, balance_after_cny,
              ROW_NUMBER() OVER (
                PARTITION BY supplier_account_id ORDER BY created_at DESC, id DESC
              ) AS rn
       FROM id_business_v2_topup_supplier_ledger
     ), latest AS (
       SELECT supplier_account_id, balance_after, balance_after_cny
       FROM ranked WHERE rn = 1
     )
     SELECT CAST(wallet.id AS CHAR) AS entity_id,
            JSON_OBJECT(
              'currentBalance', wallet.current_balance,
              'ledgerBalance', latest.balance_after,
              'currentBalanceCny', wallet.current_balance_cny,
              'ledgerBalanceCny', latest.balance_after_cny
            ) AS detail
     FROM id_business_v2_topup_supplier_accounts wallet
     LEFT JOIN latest ON latest.supplier_account_id = wallet.id
     WHERE (latest.supplier_account_id IS NOT NULL AND (
              wallet.current_balance <> latest.balance_after
              OR wallet.current_balance_cny <> latest.balance_after_cny
            ))
        OR (latest.supplier_account_id IS NULL AND (
              wallet.current_balance <> wallet.opening_balance
              OR wallet.current_balance_cny <> wallet.opening_balance_cny
            ))`
  ),
  check(
    'supplier_ledger_chain_discontinuity',
    '供应商钱包流水前后不连续',
    `WITH ordered AS (
       SELECT id, supplier_account_id, balance_before, balance_before_cny,
              LAG(balance_after) OVER (
                PARTITION BY supplier_account_id ORDER BY created_at, id
              ) AS previous_balance,
              LAG(balance_after_cny) OVER (
                PARTITION BY supplier_account_id ORDER BY created_at, id
              ) AS previous_balance_cny
       FROM id_business_v2_topup_supplier_ledger
     )
     SELECT CAST(id AS CHAR) AS entity_id,
            JSON_OBJECT('supplierAccountId', supplier_account_id) AS detail
     FROM ordered
     WHERE previous_balance IS NOT NULL
       AND (balance_before <> previous_balance OR balance_before_cny <> previous_balance_cny)`
  ),
  check(
    'supplier_ledger_reversal_mismatch',
    '供应商钱包冲销流水与原流水不匹配',
    `SELECT CAST(reversal.id AS CHAR) AS entity_id,
            JSON_OBJECT('originalId', original.id) AS detail
     FROM id_business_v2_topup_supplier_ledger reversal
     LEFT JOIN id_business_v2_topup_supplier_ledger original
       ON original.id = reversal.reversal_of_entry_id
     WHERE reversal.reversal_of_entry_id IS NOT NULL
       AND (
         original.id IS NULL OR reversal.supplier_account_id <> original.supplier_account_id
         OR reversal.currency <> original.currency OR reversal.amount <> original.amount
         OR reversal.amount_cny <> original.amount_cny OR reversal.direction = original.direction
       )`
  ),
  check(
    'supplier_wallet_delete_marker_mismatch',
    '供应商选项已恢复但钱包仍保留自动停用标记',
    `SELECT CAST(wallet.id AS CHAR) AS entity_id,
            JSON_OBJECT('supplierOptionId', wallet.supplier_option_id) AS detail
     FROM id_business_v2_topup_supplier_accounts wallet
     JOIN id_business_v2_options supplier ON supplier.id = wallet.supplier_option_id
     WHERE wallet.disabled_by_option_deletion_at IS NOT NULL
       AND supplier.deleted_at IS NULL
       AND supplier.status = 'active'`
  ),
  check(
    'finance_inflow_reference_integrity',
    '已填写的收入流水号未永久预留、重复处于有效入账状态或与订单收款重复',
    `WITH normalized_inflow AS (
       SELECT inflow.id,
              inflow.nature,
              LOWER(TRIM(inflow.external_reference)) AS normalized_reference,
              journal.status AS journal_status
       FROM id_business_v2_finance_inflows inflow
       JOIN id_business_v2_finance_journals journal ON journal.id = inflow.journal_id
     ), active_duplicate AS (
       SELECT normalized_reference
       FROM normalized_inflow
       WHERE journal_status = 'posted' AND normalized_reference IS NOT NULL
       GROUP BY normalized_reference
       HAVING COUNT(*) > 1
     )
     SELECT normalized_inflow.id AS entity_id,
            JSON_OBJECT(
              'reference', normalized_inflow.normalized_reference,
              'status', normalized_inflow.journal_status
            ) AS detail
     FROM normalized_inflow
     LEFT JOIN id_business_v2_finance_income_references reference_record
       ON reference_record.normalized_reference = normalized_inflow.normalized_reference
     LEFT JOIN id_business_v2_finance_inflows first_inflow
       ON first_inflow.id = reference_record.first_inflow_id
     WHERE normalized_inflow.normalized_reference IS NOT NULL
       AND (
         reference_record.normalized_reference IS NULL
         OR reference_record.source_type <> 'inflow'
         OR NOT (
           LOWER(TRIM(first_inflow.external_reference))
           <=> reference_record.normalized_reference
         )
       )
     UNION ALL
     SELECT CONCAT('active-duplicate:', active_duplicate.normalized_reference)
              COLLATE utf8mb4_unicode_ci AS entity_id,
            JSON_OBJECT('reference', active_duplicate.normalized_reference) AS detail
     FROM active_duplicate
     UNION ALL
     SELECT CONCAT('reservation:', reference_record.normalized_reference)
              COLLATE utf8mb4_unicode_ci AS entity_id,
            JSON_OBJECT(
              'sourceType', reference_record.source_type,
              'firstInflowId', reference_record.first_inflow_id,
              'orderId', reference_record.order_id
            ) AS detail
     FROM id_business_v2_finance_income_references reference_record
     WHERE NOT (
       (
         reference_record.source_type = 'inflow'
         AND reference_record.first_inflow_id IS NOT NULL
         AND reference_record.order_id IS NULL
       )
       OR (
         reference_record.source_type = 'order'
         AND reference_record.first_inflow_id IS NULL
         AND reference_record.order_id IS NOT NULL
       )
     )
     UNION ALL
     SELECT order_record.id AS entity_id,
            JSON_OBJECT(
              'orderNo', order_record.order_no,
              'platformOrderNo', order_record.platform_order_no
            ) AS detail
     FROM id_business_v2_orders order_record
     WHERE order_record.deleted_at IS NULL
       AND order_record.status IN ('completed', 'refunded')
       AND (
         NOT EXISTS (
           SELECT 1
           FROM id_business_v2_finance_income_references order_reference
           WHERE order_reference.normalized_reference = LOWER(TRIM(order_record.order_no))
             AND order_reference.source_type = 'order'
             AND order_reference.order_id = order_record.id
         )
         OR (
           order_record.platform_order_no IS NOT NULL
           AND TRIM(order_record.platform_order_no) <> ''
           AND NOT EXISTS (
             SELECT 1
             FROM id_business_v2_finance_income_references platform_reference
             WHERE platform_reference.normalized_reference = LOWER(TRIM(order_record.platform_order_no))
               AND platform_reference.source_type = 'order'
               AND platform_reference.order_id = order_record.id
           )
         )
       )
     UNION ALL
     SELECT normalized_inflow.id AS entity_id,
            JSON_OBJECT('reference', normalized_inflow.normalized_reference) AS detail
     FROM normalized_inflow
     WHERE normalized_inflow.journal_status = 'posted'
       AND normalized_inflow.nature = 'operating_income'
       AND EXISTS (
         SELECT 1
         FROM id_business_v2_orders order_record
         WHERE order_record.deleted_at IS NULL
           AND (
             LOWER(TRIM(order_record.order_no)) = normalized_inflow.normalized_reference
             OR LOWER(TRIM(order_record.platform_order_no)) = normalized_inflow.normalized_reference
           )
       )`
  ),
  check(
    'finance_inflow_receipt_integrity',
    '已上传的收入凭证无法验证或凭证元数据不完整',
    `SELECT CAST(inflow.id AS CHAR) AS entity_id,
            JSON_OBJECT(
              'receiptAttachmentId', inflow.receipt_attachment_id,
              'mimeType', attachment.mime_type,
              'sizeBytes', attachment.size_bytes
            ) AS detail
     FROM id_business_v2_finance_inflows inflow
     JOIN id_business_v2_finance_journals journal ON journal.id = inflow.journal_id
     LEFT JOIN attachments attachment ON attachment.id = inflow.receipt_attachment_id
     WHERE journal.status = 'posted'
       AND inflow.receipt_attachment_id IS NOT NULL
       AND (
         attachment.id IS NULL
         OR NOT (attachment.business_module <=> 'id_business_v2_finance')
         OR NOT (attachment.object_type <=> 'id_business_v2_finance_inflow')
         OR NOT (attachment.purpose <=> 'finance_inflow_receipt')
         OR attachment.mime_type NOT IN ('application/pdf', 'image/jpeg', 'image/png', 'image/webp')
         OR attachment.size_bytes <= 0
         OR attachment.size_bytes > 5242880
         OR attachment.content_encrypted IS NULL
         OR attachment.content_sha256 IS NULL
         OR attachment.content_sha256 NOT REGEXP '^[0-9a-f]{64}$'
       )`
  ),
  check(
    'finance_inflow_posting_mismatch',
    '收入业务记录与财务日记、账户、金额或会计科目不一致',
    `SELECT CAST(inflow.id AS CHAR) AS entity_id,
            JSON_OBJECT(
              'journalId', inflow.journal_id,
              'nature', inflow.nature,
              'journalType', journal.journal_type
            ) AS detail
     FROM id_business_v2_finance_inflows inflow
     JOIN id_business_v2_finance_journals journal ON journal.id = inflow.journal_id
     WHERE journal.source_type <> 'inflow'
        OR NOT (journal.source_id <=> inflow.id)
        OR (
          inflow.external_reference IS NOT NULL
          AND NOT (journal.source_reference <=> inflow.external_reference)
        )
        OR journal.journal_type <> CASE inflow.nature
             WHEN 'operating_income' THEN 'manual_operating_income'
             WHEN 'capital_contribution' THEN 'capital_contribution'
             WHEN 'borrowed_funds' THEN 'borrowed_funds_received'
           END
        OR NOT (
          NULLIF(
            JSON_UNQUOTE(JSON_EXTRACT(journal.metadata, '$.receiptAttachmentId')),
            'null'
          )
          <=> CAST(inflow.receipt_attachment_id AS CHAR)
        )
        OR (
          inflow.nature = 'operating_income'
          AND (
            inflow.category_option_id IS NULL
            OR NULLIF(TRIM(inflow.category_name_snapshot), '') IS NULL
          )
        )
        OR (
          inflow.nature <> 'operating_income'
          AND (inflow.category_option_id IS NOT NULL OR inflow.category_name_snapshot IS NOT NULL)
        )
        OR (SELECT COUNT(*) FROM id_business_v2_finance_journal_lines line
            WHERE line.journal_id = journal.id) <> 2
        OR NOT EXISTS (
          SELECT 1
          FROM id_business_v2_finance_journal_lines debit_line
          WHERE debit_line.journal_id = journal.id
            AND debit_line.account_code = 'cash'
            AND debit_line.direction = 'debit'
            AND debit_line.finance_account_id = inflow.finance_account_id
            AND debit_line.currency = inflow.currency
            AND debit_line.amount_original = inflow.amount_original
            AND debit_line.fx_rate_to_cny = inflow.fx_rate_to_cny
            AND debit_line.amount_cny = inflow.amount_cny
        )
        OR NOT EXISTS (
          SELECT 1
          FROM id_business_v2_finance_journal_lines credit_line
          WHERE credit_line.journal_id = journal.id
            AND credit_line.account_code = CASE inflow.nature
                  WHEN 'operating_income' THEN 'other_operating_revenue'
                  WHEN 'capital_contribution' THEN 'contributed_capital'
                  WHEN 'borrowed_funds' THEN 'borrowed_funds_payable'
                END
            AND credit_line.direction = 'credit'
            AND credit_line.finance_account_id IS NULL
            AND credit_line.currency = inflow.currency
            AND credit_line.amount_original = inflow.amount_original
            AND credit_line.fx_rate_to_cny = inflow.fx_rate_to_cny
            AND credit_line.amount_cny = inflow.amount_cny
        )`
  ),
  check(
    'completed_order_finance_reconciliation_mismatch',
    '已完成订单缺少完成凭证或订单利润与财务分录复算结果不一致',
    `WITH order_finance AS (
       SELECT order_record.id,
              order_record.order_no,
              order_record.profit_amount,
              COUNT(DISTINCT CASE
                WHEN journal.journal_type = 'order_completed' THEN journal.id
              END) AS completion_journal_count,
              COALESCE(SUM(CASE
                WHEN line.account_code IN (
                  'sales_revenue', 'platform_fee', 'gift_card_cost', 'id_cost',
                  'customer_owned_balance_cost', 'refund_loss',
                  'gift_card_redemption_loss', 'balance_loss', 'id_purchase_loss',
                  'operating_expense', 'realized_fx_gain_loss'
                )
                THEN CASE WHEN line.direction = 'credit' THEN line.amount_cny ELSE -line.amount_cny END
                ELSE 0
              END), 0) AS recalculated_profit
       FROM id_business_v2_orders order_record
       LEFT JOIN id_business_v2_finance_journals journal
         ON journal.source_type = 'order' AND journal.source_id = order_record.id
       LEFT JOIN id_business_v2_finance_journal_lines line ON line.journal_id = journal.id
       WHERE order_record.status = 'completed'
         AND order_record.deleted_at IS NULL
         AND order_record.profit_amount IS NOT NULL
       GROUP BY order_record.id, order_record.order_no, order_record.profit_amount
     )
     SELECT CAST(id AS CHAR) AS entity_id,
            JSON_OBJECT(
              'orderNo', order_no,
              'storedProfit', profit_amount,
              'recalculatedProfit', recalculated_profit,
              'completionJournalCount', completion_journal_count
            ) AS detail
     FROM order_finance
     WHERE completion_journal_count = 0
        OR recalculated_profit <> profit_amount`
  ),
  check(
    'finance_journal_unbalanced',
    '财务日记借贷不平',
    `SELECT CAST(journal.id AS CHAR) AS entity_id,
            JSON_OBJECT('journalNo', journal.journal_no) AS detail
     FROM id_business_v2_finance_journals journal
     LEFT JOIN id_business_v2_finance_journal_lines line ON line.journal_id = journal.id
     GROUP BY journal.id, journal.journal_no
     HAVING COUNT(line.id) < 2
        OR COALESCE(SUM(CASE WHEN line.direction = 'debit' THEN line.amount_cny ELSE 0 END), 0)
           <> COALESCE(SUM(CASE WHEN line.direction = 'credit' THEN line.amount_cny ELSE 0 END), 0)`
  ),
  check(
    'finance_reversal_mismatch',
    '财务冲销日记与原日记状态或分录不匹配',
    `SELECT CAST(reversal.id AS CHAR) AS entity_id,
            JSON_OBJECT('originalId', original.id) AS detail
     FROM id_business_v2_finance_journals reversal
     LEFT JOIN id_business_v2_finance_journals original
       ON original.id = reversal.reversal_of_journal_id
     WHERE reversal.journal_type = 'reversal'
       AND (
         original.id IS NULL OR original.status <> 'reversed'
         OR EXISTS (
           SELECT 1
           FROM id_business_v2_finance_journal_lines reversal_line
           LEFT JOIN id_business_v2_finance_journal_lines original_line
             ON original_line.journal_id = original.id
            AND original_line.line_no = reversal_line.line_no
           WHERE reversal_line.journal_id = reversal.id
             AND (
               original_line.id IS NULL OR original_line.direction = reversal_line.direction
               OR original_line.amount_original <> reversal_line.amount_original
               OR original_line.amount_cny <> reversal_line.amount_cny
               OR original_line.account_code <> reversal_line.account_code
               OR NOT (original_line.finance_account_id <=> reversal_line.finance_account_id)
               OR NOT (original_line.supplier_account_id <=> reversal_line.supplier_account_id)
             )
         )
         OR (SELECT COUNT(*) FROM id_business_v2_finance_journal_lines line
             WHERE line.journal_id = original.id)
            <> (SELECT COUNT(*) FROM id_business_v2_finance_journal_lines line
                WHERE line.journal_id = reversal.id)
       )
     UNION ALL
     SELECT CAST(original.id AS CHAR) AS entity_id,
            JSON_OBJECT('status', original.status) AS detail
     FROM id_business_v2_finance_journals original
     LEFT JOIN id_business_v2_finance_journals reversal
       ON reversal.reversal_of_journal_id = original.id
     WHERE (original.status = 'reversed') <> (reversal.id IS NOT NULL)`
  ),
  check(
    'finance_account_balance_mismatch',
    '资金账户余额与已过账现金分录不一致',
    `WITH movement AS (
       SELECT line.finance_account_id,
              COALESCE(SUM(CASE WHEN line.direction = 'debit'
                                THEN line.amount_original ELSE -line.amount_original END), 0) AS amount,
              COALESCE(SUM(CASE WHEN line.direction = 'debit'
                                THEN line.amount_cny ELSE -line.amount_cny END), 0) AS amount_cny
       FROM id_business_v2_finance_journal_lines line
       JOIN id_business_v2_finance_journals journal
         ON journal.id = line.journal_id
       WHERE line.finance_account_id IS NOT NULL
         AND line.account_code = 'cash'
         AND journal.journal_type <> 'opening_balance'
       GROUP BY line.finance_account_id
     )
     SELECT CAST(account.id AS CHAR) AS entity_id,
            JSON_OBJECT('currentBalance', account.current_balance) AS detail
     FROM id_business_v2_finance_accounts account
     LEFT JOIN movement ON movement.finance_account_id = account.id
     WHERE account.current_balance <> account.opening_balance + COALESCE(movement.amount, 0)
        OR account.current_balance_cny <> account.opening_balance_cny + COALESCE(movement.amount_cny, 0)`
  ),
  check(
    'soft_delete_audit_missing',
    '软删除记录缺少删除审计或显式遗留对账',
    `WITH deleted_entity AS (
       SELECT id, 'id_business_v2_option' AS object_type
       FROM id_business_v2_options WHERE deleted_at IS NOT NULL
       UNION ALL
       SELECT id, 'id_business_v2_customer' FROM id_business_v2_customers WHERE deleted_at IS NOT NULL
       UNION ALL
       SELECT id, 'id_business_v2_account' FROM id_business_v2_accounts WHERE deleted_at IS NOT NULL
       UNION ALL
       SELECT id, 'id_business_v2_order' FROM id_business_v2_orders WHERE deleted_at IS NOT NULL
     )
     SELECT CAST(deleted_entity.id AS CHAR) AS entity_id,
            JSON_OBJECT('objectType', deleted_entity.object_type) AS detail
     FROM deleted_entity
     WHERE NOT EXISTS (
       SELECT 1 FROM audit_logs audit
       WHERE audit.object_id = deleted_entity.id
         AND audit.object_type = deleted_entity.object_type
         AND (
           audit.action LIKE '%.delete'
           OR audit.action = 'id_business_v2.integrity.legacy_soft_delete_reconciled'
         )
     )`
  ),
  check(
    'audit_immutability_trigger_missing',
    '审计日志不可变触发器缺失',
    `SELECT expected.trigger_name AS entity_id,
            JSON_OBJECT('expected', TRUE) AS detail
     FROM (
       SELECT 'idv2_audit_log_no_update' AS trigger_name
       UNION ALL
       SELECT 'idv2_audit_log_no_delete' AS trigger_name
     ) expected
     WHERE idv2_integrity_trigger_exists(expected.trigger_name, 'audit_logs') = 0`
  )
]);

export function buildV2DataIntegrityCheckQueries(sql) {
  const violations = stripTrailingSemicolon(sql);
  return {
    count: `SELECT CAST(COUNT(*) AS CHAR) AS count FROM (${violations}) AS violations`,
    samples: `SELECT entity_id AS entityId, detail
FROM (${violations}) AS violations
ORDER BY entity_id
LIMIT 10`
  };
}

export function buildV2DataIntegrityCheckQuery(sql) {
  return buildV2DataIntegrityCheckQueries(sql).count;
}

export function normalizeV2DataIntegritySamples(rows) {
  return rows.map((row) => ({
    entityId: String(row.entityId),
    detail: parseJsonValue(row.detail)
  }));
}

export function assertV2AuditConnectionReadOnly(grantRows) {
  const grants = grantRows.flatMap((row) => Object.values(row)).map(String);
  if (grants.length === 0) throw new Error('无法确认数据巡检账号权限');

  for (const grant of grants) {
    if (/^GRANT\s+USAGE\s+ON\s+/i.test(grant)) continue;
    if (
      /^GRANT\s+EXECUTE\s+ON\s+FUNCTION\s+.+\.`?idv2_integrity_trigger_exists`?\s+TO\s+/i.test(
        grant
      )
    ) {
      continue;
    }
    const privilegeMatch = grant.match(/^GRANT\s+(.+?)\s+ON\s+/i);
    if (!privilegeMatch) throw new Error(`数据巡检账号存在无法识别的授权：${grant}`);
    const privileges = privilegeMatch[1].split(',').map((value) => value.trim().toUpperCase());
    if (privileges.some((privilege) => !['SELECT', 'SHOW VIEW'].includes(privilege))) {
      throw new Error('数据巡检必须使用仅具备 SELECT/SHOW VIEW 权限的 MySQL 账号');
    }
  }
}

export function assessV2DataIntegrity(results) {
  const failed = results.filter((result) => result.count > 0);
  return {
    ok: failed.length === 0,
    checkCount: results.length,
    violationCount: failed.reduce((sum, result) => sum + result.count, 0),
    failedChecks: failed.map((result) => result.code)
  };
}

function stripTrailingSemicolon(sql) {
  return sql.trim().replace(/;$/, '');
}

function parseJsonValue(value) {
  if (value === null || typeof value === 'object') return value;
  try {
    return JSON.parse(String(value));
  } catch {
    return String(value);
  }
}

function check(code, description, sql) {
  return Object.freeze({ code, description, sql: stripTrailingSemicolon(sql) });
}

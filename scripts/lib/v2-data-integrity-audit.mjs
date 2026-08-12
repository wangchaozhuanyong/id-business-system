export const V2_DATA_INTEGRITY_CHECKS = Object.freeze([
  check(
    'finance_expense_display_snapshot_missing',
    '经营开支历史分类名或资金账户名快照缺失',
    `SELECT expense.id::text AS entity_id,
            jsonb_build_object(
              'categoryNameSnapshot', expense.category_name_snapshot,
              'financeAccountNameSnapshot', expense.finance_account_name_snapshot
            ) AS detail
     FROM public.id_business_v2_finance_expenses expense
     WHERE btrim(expense.category_name_snapshot) = ''
        OR btrim(expense.finance_account_name_snapshot) = ''`
  ),
  check(
    'finance_expense_display_snapshot_not_protected',
    '经营开支历史展示快照缺少数据库防篡改触发器',
    `SELECT 'id_business_v2_finance_expenses' AS entity_id,
            jsonb_build_object('trigger', 'id_business_v2_finance_expense_display_snapshot_immutable') AS detail
     WHERE NOT EXISTS (
       SELECT 1
       FROM pg_trigger trigger_record
       JOIN pg_class table_record ON table_record.oid = trigger_record.tgrelid
       JOIN pg_namespace namespace_record ON namespace_record.oid = table_record.relnamespace
       WHERE namespace_record.nspname = 'public'
         AND table_record.relname = 'id_business_v2_finance_expenses'
         AND trigger_record.tgname = 'id_business_v2_finance_expense_display_snapshot_immutable'
         AND NOT trigger_record.tgisinternal
     )`
  ),
  check(
    'pending_or_failed_migrations',
    '存在未完成且未回滚的数据库迁移',
    `SELECT migration_name AS entity_id,
            jsonb_build_object('startedAt', started_at) AS detail
     FROM public._prisma_migrations
     WHERE finished_at IS NULL AND rolled_back_at IS NULL`
  ),
  check(
    'unvalidated_foreign_keys',
    '存在尚未验证的外键约束',
    `SELECT constraint_record.conname AS entity_id,
            jsonb_build_object('table', constraint_record.conrelid::regclass::text) AS detail
     FROM pg_constraint constraint_record
     JOIN pg_namespace namespace_record ON namespace_record.oid = constraint_record.connamespace
     WHERE namespace_record.nspname = 'public'
       AND constraint_record.contype = 'f'
       AND NOT constraint_record.convalidated`
  ),
  check(
    'order_display_snapshot_missing',
    '订单缺少不可变展示快照',
    `SELECT order_record.id::text AS entity_id,
            jsonb_build_object('orderNo', order_record.order_no) AS detail
     FROM public.id_business_v2_orders order_record
     LEFT JOIN public.id_business_v2_order_display_snapshots snapshot
       ON snapshot.order_id = order_record.id
     WHERE snapshot.order_id IS NULL`
  ),
  check(
    'deleted_option_key_not_namespaced',
    '已删除选项仍占用原唯一键',
    `SELECT option_record.id::text AS entity_id,
            jsonb_build_object('type', option_record.type::text) AS detail
     FROM public.id_business_v2_options option_record
     WHERE option_record.deleted_at IS NOT NULL
       AND (
         option_record.unique_key NOT LIKE 'deleted:' || option_record.id::text || ':%'
         OR option_record.status_before_deletion IS NULL
       )`
  ),
  check(
    'live_option_has_delete_snapshot',
    '未删除选项仍保留删除前状态快照',
    `SELECT option_record.id::text AS entity_id,
            jsonb_build_object('type', option_record.type::text) AS detail
     FROM public.id_business_v2_options option_record
     WHERE option_record.deleted_at IS NULL
       AND option_record.status_before_deletion IS NOT NULL`
  ),
  check(
    'option_cascade_marker_mismatch',
    '选项级联删除来源标记与当前删除状态不一致',
    `SELECT option_record.id::text AS entity_id,
            jsonb_build_object('parentOptionId', option_record.deleted_by_parent_option_id) AS detail
     FROM public.id_business_v2_options option_record
     LEFT JOIN public.id_business_v2_options parent_option
       ON parent_option.id = option_record.deleted_by_parent_option_id
     WHERE (option_record.deleted_at IS NULL AND option_record.deleted_by_parent_option_id IS NOT NULL)
        OR (option_record.deleted_by_parent_option_id IS NOT NULL AND (
          option_record.type::text <> 'service'
          OR parent_option.id IS NULL
          OR parent_option.deleted_at IS DISTINCT FROM option_record.deleted_at
          OR parent_option.id NOT IN (option_record.parent_id, option_record.country_option_id)
        ))`
  ),
  check(
    'live_service_under_inactive_master',
    '启用业务关联了已删除或停用的国家/业务分类',
    `SELECT service.id::text AS entity_id,
            jsonb_build_object('categoryId', category.id, 'countryId', country.id) AS detail
     FROM public.id_business_v2_options service
     LEFT JOIN public.id_business_v2_options category ON category.id = service.parent_id
     LEFT JOIN public.id_business_v2_options country ON country.id = service.country_option_id
     WHERE service.type::text = 'service'
       AND service.deleted_at IS NULL
       AND service.status::text = 'active'
       AND (
         category.id IS NULL OR category.deleted_at IS NOT NULL OR category.status::text <> 'active'
         OR country.id IS NULL OR country.deleted_at IS NOT NULL OR country.status::text <> 'active'
       )`
  ),
  check(
    'active_account_inactive_master',
    '启用 ID 关联了已删除或停用的主数据',
    `SELECT account.id::text AS entity_id,
            jsonb_build_object(
              'countryId', account.country_option_id,
              'statusId', account.status_option_id,
              'supplierId', account.supplier_option_id
            ) AS detail
     FROM public.id_business_v2_accounts account
     JOIN public.id_business_v2_options country ON country.id = account.country_option_id
     JOIN public.id_business_v2_options status_option ON status_option.id = account.status_option_id
     LEFT JOIN public.id_business_v2_options supplier ON supplier.id = account.supplier_option_id
     WHERE account.deleted_at IS NULL
       AND account.record_status::text = 'active'
       AND (
         country.deleted_at IS NOT NULL OR country.status::text <> 'active'
         OR status_option.deleted_at IS NOT NULL OR status_option.status::text <> 'active'
         OR (supplier.id IS NOT NULL AND (supplier.deleted_at IS NOT NULL OR supplier.status::text <> 'active'))
       )`
  ),
  check(
    'open_order_inactive_entity',
    '进行中订单关联了已删除或停用的业务实体',
    `SELECT order_record.id::text AS entity_id,
            jsonb_build_object('status', order_record.status::text) AS detail
     FROM public.id_business_v2_orders order_record
     JOIN public.id_business_v2_customers customer ON customer.id = order_record.customer_id
     JOIN public.id_business_v2_options service ON service.id = order_record.service_option_id
     LEFT JOIN public.id_business_v2_accounts account ON account.id = order_record.account_id
     LEFT JOIN public.id_business_v2_options settlement
       ON settlement.id = order_record.settlement_platform_option_id
     WHERE order_record.deleted_at IS NULL
       AND order_record.status::text IN ('draft', 'pending', 'waiting_external', 'processing')
       AND (
         customer.deleted_at IS NOT NULL OR customer.record_status::text <> 'active'
         OR service.deleted_at IS NOT NULL OR service.status::text <> 'active'
         OR (account.id IS NOT NULL AND (account.deleted_at IS NOT NULL OR account.record_status::text <> 'active'))
         OR (settlement.id IS NOT NULL AND (settlement.deleted_at IS NOT NULL OR settlement.status::text <> 'active'))
       )`
  ),
  check(
    'activation_order_dimension_mismatch',
    '开通记录与来源订单的客户、ID 或业务不一致',
    `SELECT activation.id::text AS entity_id,
            jsonb_build_object('orderId', activation.order_id) AS detail
     FROM public.id_business_v2_activations activation
     JOIN public.id_business_v2_orders order_record ON order_record.id = activation.order_id
     WHERE activation.customer_id <> order_record.customer_id
        OR activation.account_id IS DISTINCT FROM order_record.account_id
        OR activation.service_option_id <> order_record.service_option_id`
  ),
  check(
    'customer_service_aggregate_mismatch',
    '客户业务汇总与开通记录不一致',
    `WITH actual AS (
       SELECT customer_id, service_option_id AS option_id,
              count(*)::int AS activation_count,
              min(opened_at) AS first_opened_at,
              max(opened_at) AS last_opened_at
       FROM public.id_business_v2_activations
       GROUP BY customer_id, service_option_id
     ), compared AS (
       SELECT COALESCE(saved.customer_id, actual.customer_id) AS customer_id,
              COALESCE(saved.option_id, actual.option_id) AS option_id,
              saved.activation_count AS saved_count,
              actual.activation_count AS actual_count,
              saved.first_opened_at AS saved_first,
              actual.first_opened_at AS actual_first,
              saved.last_opened_at AS saved_last,
              actual.last_opened_at AS actual_last
       FROM (
         SELECT * FROM public.id_business_v2_customer_services WHERE source::text = 'activation'
       ) saved
       FULL JOIN actual USING (customer_id, option_id)
     )
     SELECT customer_id::text || ':' || option_id::text AS entity_id,
            jsonb_build_object('savedCount', saved_count, 'actualCount', actual_count) AS detail
     FROM compared
     WHERE saved_count IS DISTINCT FROM actual_count
        OR saved_first IS DISTINCT FROM actual_first
        OR saved_last IS DISTINCT FROM actual_last`
  ),
  check(
    'account_balance_latest_ledger_mismatch',
    'ID 当前余额/成本与最后一条余额流水不一致',
    `WITH latest AS (
       SELECT DISTINCT ON (account_id) account_id, balance_after, cost_after
       FROM public.id_business_v2_balance_ledger
       ORDER BY account_id, created_at DESC, id DESC
     )
     SELECT account.id::text AS entity_id,
            jsonb_build_object(
              'currentBalance', account.current_balance,
              'ledgerBalance', latest.balance_after,
              'currentCost', account.balance_cost_amount,
              'ledgerCost', latest.cost_after
            ) AS detail
     FROM public.id_business_v2_accounts account
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
              lag(balance_after) OVER (PARTITION BY account_id ORDER BY created_at, id) AS previous_balance,
              lag(cost_after) OVER (PARTITION BY account_id ORDER BY created_at, id) AS previous_cost
       FROM public.id_business_v2_balance_ledger
     )
     SELECT id::text AS entity_id,
            jsonb_build_object('accountId', account_id) AS detail
     FROM ordered
     WHERE previous_balance IS NOT NULL
       AND (balance_before <> previous_balance OR cost_before <> previous_cost)`
  ),
  check(
    'balance_ledger_reversal_mismatch',
    'ID 余额冲销流水与原流水不匹配',
    `SELECT reversal.id::text AS entity_id,
            jsonb_build_object('originalId', original.id) AS detail
     FROM public.id_business_v2_balance_ledger reversal
     LEFT JOIN public.id_business_v2_balance_ledger original
       ON original.id = reversal.reversal_of_entry_id
     WHERE reversal.reversal_of_entry_id IS NOT NULL
       AND (
         original.id IS NULL
         OR reversal.entry_type::text <> 'order_consumption_reversal'
         OR original.entry_type::text <> 'order_consumption'
         OR reversal.account_id <> original.account_id
         OR reversal.order_id IS DISTINCT FROM original.order_id
       )`
  ),
  check(
    'gift_card_ledger_state_mismatch',
    '礼品卡状态与余额流水不一致',
    `SELECT gift_card.id::text AS entity_id,
            jsonb_build_object('status', gift_card.status::text) AS detail
     FROM public.id_business_v2_gift_cards gift_card
     WHERE NOT EXISTS (
       SELECT 1 FROM public.id_business_v2_balance_ledger ledger
       WHERE ledger.gift_card_id = gift_card.id AND ledger.entry_type::text = 'gift_card_credit'
     )
     OR (gift_card.status::text = 'redeemed' AND NOT EXISTS (
       SELECT 1 FROM public.id_business_v2_balance_ledger ledger
       WHERE ledger.gift_card_id = gift_card.id AND ledger.entry_type::text = 'gift_card_redeemed'
     ))
     OR (gift_card.status::text = 'withdrawn' AND NOT EXISTS (
       SELECT 1 FROM public.id_business_v2_balance_ledger ledger
       WHERE ledger.gift_card_id = gift_card.id AND ledger.entry_type::text = 'gift_card_withdrawal'
     ))`
  ),
  check(
    'order_consumption_state_mismatch',
    '订单状态与余额扣减/冲销流水不一致',
    `SELECT order_record.id::text AS entity_id,
            jsonb_build_object('status', order_record.status::text, 'balanceAmount', order_record.balance_amount) AS detail
     FROM public.id_business_v2_orders order_record
     WHERE (
       order_record.status::text = 'completed'
       AND order_record.balance_amount > 0
       AND NOT EXISTS (
         SELECT 1 FROM public.id_business_v2_balance_ledger ledger
         WHERE ledger.order_id = order_record.id AND ledger.entry_type::text = 'order_consumption'
       )
     ) OR (
       order_record.status::text IN ('refunded', 'cancelled', 'failed')
       AND EXISTS (
         SELECT 1 FROM public.id_business_v2_balance_ledger ledger
         WHERE ledger.order_id = order_record.id AND ledger.entry_type::text = 'order_consumption'
       )
       AND NOT EXISTS (
         SELECT 1 FROM public.id_business_v2_balance_ledger ledger
         WHERE ledger.order_id = order_record.id AND ledger.entry_type::text = 'order_consumption_reversal'
       )
     )`
  ),
  check(
    'sold_account_order_mismatch',
    '已售 ID 与销售订单的双向关系不一致',
    `SELECT account.id::text AS entity_id,
            jsonb_build_object('soldByOrderId', account.sold_by_order_id) AS detail
     FROM public.id_business_v2_accounts account
     LEFT JOIN public.id_business_v2_orders order_record ON order_record.id = account.sold_by_order_id
     WHERE account.sold_by_order_id IS NOT NULL
       AND (
         order_record.id IS NULL OR order_record.account_id IS DISTINCT FROM account.id
         OR order_record.account_disposition::text <> 'sold'
         OR order_record.status::text <> 'completed'
       )
     UNION ALL
     SELECT order_record.id::text AS entity_id,
            jsonb_build_object('accountId', order_record.account_id) AS detail
     FROM public.id_business_v2_orders order_record
     LEFT JOIN public.id_business_v2_accounts account ON account.id = order_record.account_id
     WHERE order_record.account_disposition::text = 'sold'
       AND order_record.status::text = 'completed'
       AND (account.id IS NULL OR account.sold_by_order_id IS DISTINCT FROM order_record.id)`
  ),
  check(
    'unsafe_active_account_lock',
    '存在过期或关联状态不安全的活动 ID 锁',
    `SELECT lock_record.id::text AS entity_id,
            jsonb_build_object('accountId', lock_record.account_id, 'orderId', lock_record.order_id) AS detail
     FROM public.id_business_v2_account_locks lock_record
     JOIN public.id_business_v2_accounts account ON account.id = lock_record.account_id
     JOIN public.id_business_v2_orders order_record ON order_record.id = lock_record.order_id
     WHERE lock_record.status::text = 'active'
       AND (
         lock_record.expires_at <= CURRENT_TIMESTAMP
         OR account.deleted_at IS NOT NULL OR account.record_status::text <> 'active'
         OR account.loss_reported_at IS NOT NULL OR account.sold_by_order_id IS NOT NULL
         OR order_record.deleted_at IS NOT NULL
         OR order_record.status::text NOT IN ('draft', 'pending', 'waiting_external', 'processing')
         OR order_record.account_id IS DISTINCT FROM account.id
       )`
  ),
  check(
    'account_loss_state_mismatch',
    'ID 报损主状态与活动报损记录不一致',
    `SELECT account.id::text AS entity_id,
            jsonb_build_object('activeLossRecordId', account.active_loss_record_id) AS detail
     FROM public.id_business_v2_accounts account
     LEFT JOIN public.id_business_v2_account_losses loss
       ON loss.id = account.active_loss_record_id
     WHERE (account.loss_reported_at IS NULL) <> (account.active_loss_record_id IS NULL)
        OR (account.active_loss_record_id IS NOT NULL AND (
          loss.id IS NULL OR loss.account_id <> account.id OR loss.status::text <> 'active'
        ))
     UNION ALL
     SELECT loss.id::text AS entity_id,
            jsonb_build_object('accountId', loss.account_id) AS detail
     FROM public.id_business_v2_account_losses loss
     JOIN public.id_business_v2_accounts account ON account.id = loss.account_id
     WHERE loss.status::text = 'active' AND account.active_loss_record_id IS DISTINCT FROM loss.id`
  ),
  check(
    'supplier_balance_latest_ledger_mismatch',
    '供应商钱包余额与最后一条流水不一致',
    `WITH latest AS (
       SELECT DISTINCT ON (supplier_account_id)
              supplier_account_id, balance_after, balance_after_cny
       FROM public.id_business_v2_topup_supplier_ledger
       ORDER BY supplier_account_id, created_at DESC, id DESC
     )
     SELECT wallet.id::text AS entity_id,
            jsonb_build_object(
              'currentBalance', wallet.current_balance,
              'ledgerBalance', latest.balance_after,
              'currentBalanceCny', wallet.current_balance_cny,
              'ledgerBalanceCny', latest.balance_after_cny
            ) AS detail
     FROM public.id_business_v2_topup_supplier_accounts wallet
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
              lag(balance_after) OVER (PARTITION BY supplier_account_id ORDER BY created_at, id) AS previous_balance,
              lag(balance_after_cny) OVER (PARTITION BY supplier_account_id ORDER BY created_at, id) AS previous_balance_cny
       FROM public.id_business_v2_topup_supplier_ledger
     )
     SELECT id::text AS entity_id,
            jsonb_build_object('supplierAccountId', supplier_account_id) AS detail
     FROM ordered
     WHERE previous_balance IS NOT NULL
       AND (balance_before <> previous_balance OR balance_before_cny <> previous_balance_cny)`
  ),
  check(
    'supplier_ledger_reversal_mismatch',
    '供应商钱包冲销流水与原流水不匹配',
    `SELECT reversal.id::text AS entity_id,
            jsonb_build_object('originalId', original.id) AS detail
     FROM public.id_business_v2_topup_supplier_ledger reversal
     LEFT JOIN public.id_business_v2_topup_supplier_ledger original
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
    `SELECT wallet.id::text AS entity_id,
            jsonb_build_object('supplierOptionId', wallet.supplier_option_id) AS detail
     FROM public.id_business_v2_topup_supplier_accounts wallet
     JOIN public.id_business_v2_options supplier ON supplier.id = wallet.supplier_option_id
     WHERE wallet.disabled_by_option_deletion_at IS NOT NULL
       AND supplier.deleted_at IS NULL
       AND supplier.status::text = 'active'`
  ),
  check(
    'finance_journal_unbalanced',
    '财务日记借贷不平',
    `SELECT journal.id::text AS entity_id,
            jsonb_build_object('journalNo', journal.journal_no) AS detail
     FROM public.id_business_v2_finance_journals journal
     JOIN public.id_business_v2_finance_journal_lines line ON line.journal_id = journal.id
     GROUP BY journal.id, journal.journal_no
     HAVING count(*) < 2
        OR COALESCE(sum(line.amount_cny) FILTER (WHERE line.direction::text = 'debit'), 0)
           <> COALESCE(sum(line.amount_cny) FILTER (WHERE line.direction::text = 'credit'), 0)`
  ),
  check(
    'finance_reversal_mismatch',
    '财务冲销日记与原日记状态或分录不匹配',
    `SELECT reversal.id::text AS entity_id,
            jsonb_build_object('originalId', original.id) AS detail
     FROM public.id_business_v2_finance_journals reversal
     LEFT JOIN public.id_business_v2_finance_journals original
       ON original.id = reversal.reversal_of_journal_id
     WHERE reversal.journal_type::text = 'reversal'
       AND (
         original.id IS NULL OR original.status::text <> 'reversed'
         OR EXISTS (
           SELECT 1
           FROM public.id_business_v2_finance_journal_lines reversal_line
           LEFT JOIN public.id_business_v2_finance_journal_lines original_line
             ON original_line.journal_id = original.id
            AND original_line.line_no = reversal_line.line_no
           WHERE reversal_line.journal_id = reversal.id
             AND (
               original_line.id IS NULL OR original_line.direction = reversal_line.direction
               OR original_line.amount_original <> reversal_line.amount_original
               OR original_line.amount_cny <> reversal_line.amount_cny
               OR original_line.account_code <> reversal_line.account_code
               OR original_line.finance_account_id IS DISTINCT FROM reversal_line.finance_account_id
               OR original_line.supplier_account_id IS DISTINCT FROM reversal_line.supplier_account_id
             )
         )
         OR (SELECT count(*) FROM public.id_business_v2_finance_journal_lines line WHERE line.journal_id = original.id)
            <> (SELECT count(*) FROM public.id_business_v2_finance_journal_lines line WHERE line.journal_id = reversal.id)
       )
     UNION ALL
     SELECT original.id::text AS entity_id,
            jsonb_build_object('status', original.status::text) AS detail
     FROM public.id_business_v2_finance_journals original
     LEFT JOIN public.id_business_v2_finance_journals reversal
       ON reversal.reversal_of_journal_id = original.id
     WHERE (original.status::text = 'reversed') <> (reversal.id IS NOT NULL)`
  ),
  check(
    'finance_account_balance_mismatch',
    '资金账户余额与已过账现金分录不一致',
    `WITH movement AS (
       SELECT line.finance_account_id,
              COALESCE(sum(CASE WHEN line.direction::text = 'debit'
                                THEN line.amount_original ELSE -line.amount_original END), 0) AS amount,
              COALESCE(sum(CASE WHEN line.direction::text = 'debit'
                                THEN line.amount_cny ELSE -line.amount_cny END), 0) AS amount_cny
       FROM public.id_business_v2_finance_journal_lines line
       JOIN public.id_business_v2_finance_journals journal
         ON journal.id = line.journal_id
       WHERE line.finance_account_id IS NOT NULL
         AND line.account_code::text = 'cash'
         AND journal.journal_type::text <> 'opening_balance'
       GROUP BY line.finance_account_id
     )
     SELECT account.id::text AS entity_id,
            jsonb_build_object('currentBalance', account.current_balance) AS detail
     FROM public.id_business_v2_finance_accounts account
     LEFT JOIN movement ON movement.finance_account_id = account.id
     WHERE account.current_balance <> account.opening_balance + COALESCE(movement.amount, 0)
        OR account.current_balance_cny <> account.opening_balance_cny + COALESCE(movement.amount_cny, 0)`
  ),
  check(
    'soft_delete_audit_missing',
    '软删除记录缺少删除审计或显式遗留对账',
    `WITH deleted_entity AS (
       SELECT id, 'id_business_v2_option'::text AS object_type
       FROM public.id_business_v2_options WHERE deleted_at IS NOT NULL
       UNION ALL
       SELECT id, 'id_business_v2_customer' FROM public.id_business_v2_customers WHERE deleted_at IS NOT NULL
       UNION ALL
       SELECT id, 'id_business_v2_account' FROM public.id_business_v2_accounts WHERE deleted_at IS NOT NULL
       UNION ALL
       SELECT id, 'id_business_v2_order' FROM public.id_business_v2_orders WHERE deleted_at IS NOT NULL
     )
     SELECT deleted_entity.id::text AS entity_id,
            jsonb_build_object('objectType', deleted_entity.object_type) AS detail
     FROM deleted_entity
     WHERE NOT EXISTS (
       SELECT 1 FROM public.audit_logs audit
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
    '审计日志不可变触发器缺失或被禁用',
    `SELECT 'audit_logs_immutable' AS entity_id,
            jsonb_build_object('expected', true) AS detail
     WHERE NOT EXISTS (
       SELECT 1
       FROM pg_trigger trigger_record
       JOIN pg_class table_record ON table_record.oid = trigger_record.tgrelid
       JOIN pg_namespace namespace_record ON namespace_record.oid = table_record.relnamespace
       WHERE namespace_record.nspname = 'public'
         AND table_record.relname = 'audit_logs'
         AND trigger_record.tgname = 'audit_logs_immutable'
         AND trigger_record.tgenabled <> 'D'
         AND NOT trigger_record.tgisinternal
     )`
  )
]);

export function buildV2DataIntegrityCheckQuery(sql) {
  return `
    WITH violations AS MATERIALIZED (
      ${sql}
    )
    SELECT totals.count,
           COALESCE((
             SELECT jsonb_agg(to_jsonb(sample) ORDER BY sample.entity_id)
             FROM (SELECT * FROM violations ORDER BY entity_id LIMIT 10) sample
           ), '[]'::jsonb) AS samples
    FROM (SELECT count(*)::int AS count FROM violations) totals
  `;
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

function check(code, description, sql) {
  return Object.freeze({ code, description, sql });
}

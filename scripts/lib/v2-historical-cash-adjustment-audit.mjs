// Historical exceptions require immutable source rows, exact paired lines and committed audit receipts.
export const HISTORICAL_CASH_ADJUSTMENT_CTES = `
historical_adjustment_candidates AS (
  SELECT j.*, JSON_UNQUOTE(JSON_EXTRACT(j.metadata, '$.historicalCashAdjustment.kind')) AS adjustment_kind,
    JSON_UNQUOTE(JSON_EXTRACT(j.metadata, '$.historicalCashAdjustment.originalJournalId')) AS original_journal_id,
    JSON_UNQUOTE(JSON_EXTRACT(j.metadata, '$.historicalCashAdjustment.originalLineId')) AS original_line_id,
    JSON_UNQUOTE(JSON_EXTRACT(j.metadata, '$.historicalCashAdjustment.sourceLineFingerprint')) AS line_fingerprint,
    JSON_UNQUOTE(JSON_EXTRACT(j.metadata, '$.historicalCashAdjustment.targetAccountId')) AS target_account_id,
    JSON_UNQUOTE(JSON_EXTRACT(j.metadata, '$.historicalCashAdjustment.idempotencyKey')) AS batch_key,
    JSON_UNQUOTE(JSON_EXTRACT(j.metadata, '$.historicalCashAdjustment.batchHash')) AS batch_hash,
    JSON_UNQUOTE(JSON_EXTRACT(j.metadata, '$.historicalCashAdjustment.expectedBookCostCny')) AS expected_cost,
    JSON_UNQUOTE(JSON_EXTRACT(j.metadata, '$.historicalCashAdjustment.recomputedBookCostCny')) AS recomputed_cost
  FROM id_business_v2_finance_journals j
  WHERE JSON_EXTRACT(j.metadata, '$.historicalCashAdjustment') IS NOT NULL
     OR (j.journal_type <> 'reversal' AND j.idempotency_key LIKE 'historical_cash:%')
), historical_adjustment_sources AS (
  SELECT c.id AS correction_journal_id, s.id AS source_line_id, s.journal_id AS source_journal_id,
    s.finance_account_id AS source_account_id, s.currency AS source_currency,
    s.amount_original AS source_quantity, s.amount_cny AS source_cost,
    s.direction AS source_direction, s.fx_rate_to_cny AS source_rate, original.status AS source_status,
    original.source_type AS source_type, original.source_id AS source_id,
    s.fx_rate_snapshot_id AS source_snapshot_id
  FROM historical_adjustment_candidates c
  JOIN id_business_v2_finance_journal_lines s ON s.id = c.original_line_id
  JOIN id_business_v2_finance_journals original ON original.id = s.journal_id AND original.id = c.original_journal_id
  WHERE c.journal_type = 'manual_adjustment' AND c.source_type = 'historical_backfill'
    AND c.source_id = s.id AND c.created_by_user_id IS NOT NULL
    AND JSON_UNQUOTE(JSON_EXTRACT(c.metadata, '$.historicalCashAdjustment.version')) = '1'
    AND c.idempotency_key = CONCAT('historical_cash:', c.adjustment_kind, ':', s.id)
    AND c.batch_hash REGEXP '^[0-9a-f]{64}$'
    AND s.account_code = 'cash' AND (s.amount_original <> 0 OR s.amount_cny <> 0)
    AND s.supplier_account_id IS NULL AND original.source_type <> 'historical_backfill'
    AND BINARY c.line_fingerprint = BINARY SHA2(CONCAT_WS('|', s.journal_id, original.source_type,
      COALESCE(original.source_id, ''), s.id, s.line_no, s.account_code, s.direction, s.currency,
      CAST(s.amount_original AS CHAR), CAST(s.fx_rate_to_cny AS CHAR), CAST(s.amount_cny AS CHAR),
      COALESCE(s.finance_account_id, ''), COALESCE(s.supplier_account_id, ''), COALESCE(s.fx_rate_snapshot_id, '')), 256)
    AND (SELECT COUNT(*) FROM id_business_v2_finance_journal_lines all_lines WHERE all_lines.journal_id = c.id) = 2
    AND EXISTS (SELECT 1 FROM audit_logs receipt
      WHERE receipt.action = 'id_business_v2.historical_cash.execute' AND receipt.user_id = c.created_by_user_id
        AND JSON_UNQUOTE(JSON_EXTRACT(receipt.after_data, '$.idempotencyKey')) = c.batch_key
        AND JSON_UNQUOTE(JSON_EXTRACT(receipt.after_data, '$.batchHash')) = c.batch_hash
        AND JSON_CONTAINS(JSON_EXTRACT(receipt.after_data, '$.adjustmentJournalIds'), JSON_QUOTE(c.id))
        AND JSON_CONTAINS(JSON_EXTRACT(receipt.after_data, '$.sourceLineIds'), JSON_QUOTE(s.id)))
), historical_cash_attributions AS (
  SELECT source.*, c.target_account_id, contra.id AS contra_line_id
  FROM historical_adjustment_sources source
  JOIN historical_adjustment_candidates c ON c.id = source.correction_journal_id
  JOIN id_business_v2_finance_journal_lines target ON target.journal_id = c.id
    AND target.account_code = 'cash' AND target.finance_account_id = c.target_account_id
  JOIN id_business_v2_finance_accounts account ON account.id = target.finance_account_id AND account.currency = 'CNY'
  JOIN id_business_v2_finance_journal_lines contra ON contra.journal_id = c.id AND contra.id <> target.id
  WHERE c.adjustment_kind = 'assign_unassigned_cash' AND c.status = 'posted' AND source.source_status = 'posted'
    AND source.source_account_id IS NULL AND source.source_currency = 'CNY'
    AND source.source_quantity = source.source_cost AND source.source_rate = 1
    AND target.currency = 'CNY' AND target.direction = source.source_direction
    AND target.amount_original = source.source_quantity AND target.amount_cny = source.source_cost
    AND target.fx_rate_to_cny = 1 AND target.supplier_account_id IS NULL
    AND (target.fx_rate_snapshot_id <=> source.source_snapshot_id)
    AND contra.account_code = 'cash' AND contra.currency = 'CNY' AND contra.finance_account_id IS NULL
    AND contra.direction <> source.source_direction
    AND contra.amount_original = source.source_quantity AND contra.amount_cny = source.source_cost
    AND contra.fx_rate_to_cny = 1 AND contra.supplier_account_id IS NULL
    AND (contra.fx_rate_snapshot_id <=> source.source_snapshot_id)
    AND (source.source_type <> 'order' OR EXISTS (
      SELECT 1 FROM id_business_v2_orders o JOIN audit_logs attribution
        ON attribution.object_id = o.id AND attribution.action = 'id_business_v2.historical_cash.attribute_order'
      WHERE o.id = source.source_id AND o.received_finance_account_id = c.target_account_id
        AND attribution.user_id = c.created_by_user_id
        AND JSON_UNQUOTE(JSON_EXTRACT(attribution.after_data, '$.receivedFinanceAccountId')) = c.target_account_id
        AND JSON_UNQUOTE(JSON_EXTRACT(attribution.after_data, '$.batchHash')) = c.batch_hash
        AND JSON_CONTAINS(JSON_EXTRACT(attribution.after_data, '$.sourceLineIds'), JSON_QUOTE(source.source_line_id))))
), historical_cash_cost_adjustments AS (
  SELECT source.*, c.target_account_id, CAST(c.recomputed_cost AS DECIMAL(18,4)) AS recomputed_cost,
    c.status AS correction_status
  FROM historical_adjustment_sources source
  JOIN historical_adjustment_candidates c ON c.id = source.correction_journal_id
  JOIN id_business_v2_finance_journals original ON original.id = source.source_journal_id
  JOIN id_business_v2_finance_expenses expense ON expense.journal_id = original.id
    AND expense.id = original.source_id AND expense.finance_account_id = source.source_account_id
    AND expense.currency = source.source_currency AND expense.amount_original = source.source_quantity
    AND expense.amount_cny = source.source_cost
  JOIN id_business_v2_finance_journal_lines cash ON cash.journal_id = c.id AND cash.account_code = 'cash'
  JOIN id_business_v2_finance_journal_lines fx ON fx.journal_id = c.id AND fx.account_code = 'realized_fx_gain_loss'
  WHERE c.adjustment_kind = 'restate_foreign_cash_cost'
    AND original.journal_type = 'expense' AND original.source_type = 'expense'
    AND JSON_EXTRACT(original.metadata, '$.cashHistoricalCost.version') IS NULL
    AND source.source_account_id = c.target_account_id AND source.source_currency <> 'CNY'
    AND source.source_direction = 'credit' AND source.source_quantity > 0
    AND (SELECT COUNT(*) FROM id_business_v2_finance_journal_lines peer
      WHERE peer.journal_id = source.source_journal_id AND peer.finance_account_id = source.source_account_id
        AND peer.account_code = 'cash' AND peer.direction = 'credit' AND peer.currency <> 'CNY' AND peer.amount_original > 0) = 1
    AND CAST(c.expected_cost AS DECIMAL(18,4)) = source.source_cost
    AND CAST(c.recomputed_cost AS DECIMAL(18,4)) >= 0
    AND cash.finance_account_id = source.source_account_id AND cash.currency = source.source_currency
    AND cash.amount_original = 0 AND cash.supplier_account_id IS NULL AND cash.fx_rate_to_cny = 1
    AND cash.direction = IF(source.source_cost > CAST(c.recomputed_cost AS DECIMAL(18,4)), 'debit', 'credit')
    AND cash.amount_cny = ABS(source.source_cost - CAST(c.recomputed_cost AS DECIMAL(18,4))) AND cash.amount_cny > 0
    AND fx.finance_account_id = source.source_account_id AND fx.currency = 'CNY' AND fx.fx_rate_to_cny = 1
    AND fx.direction <> cash.direction AND fx.amount_original = cash.amount_cny AND fx.amount_cny = cash.amount_cny
    AND fx.supplier_account_id IS NULL
), historical_exact_reversals AS (
  SELECT original.id AS original_journal_id, reversal.id AS reversal_journal_id
  FROM id_business_v2_finance_journals original
  JOIN id_business_v2_finance_journals reversal ON reversal.reversal_of_journal_id = original.id
    AND reversal.journal_type = 'reversal' AND reversal.status = 'posted'
  WHERE original.status = 'reversed'
    AND (SELECT COUNT(*) FROM id_business_v2_finance_journal_lines l WHERE l.journal_id = original.id) =
        (SELECT COUNT(*) FROM id_business_v2_finance_journal_lines l WHERE l.journal_id = reversal.id)
    AND NOT EXISTS (SELECT 1 FROM id_business_v2_finance_journal_lines l
      LEFT JOIN id_business_v2_finance_journal_lines r ON r.journal_id = reversal.id AND r.line_no = l.line_no
      WHERE l.journal_id = original.id AND (r.id IS NULL OR r.account_code <> l.account_code
        OR r.direction = l.direction OR r.currency <> l.currency OR r.amount_original <> l.amount_original
        OR r.amount_cny <> l.amount_cny OR r.fx_rate_to_cny <> l.fx_rate_to_cny
        OR NOT (r.finance_account_id <=> l.finance_account_id) OR NOT (r.supplier_account_id <=> l.supplier_account_id)
        OR NOT (r.fx_rate_snapshot_id <=> l.fx_rate_snapshot_id)))
), historical_cash_cost_verifications AS (
  SELECT s.id AS source_line_id, s.journal_id AS source_journal_id, s.finance_account_id AS source_account_id
  FROM audit_logs v
  JOIN id_business_v2_finance_journal_lines s ON s.id = v.object_id
  JOIN id_business_v2_finance_journals j ON j.id = s.journal_id
  JOIN id_business_v2_finance_expenses expense ON expense.journal_id = j.id AND expense.id = j.source_id
    AND expense.finance_account_id = s.finance_account_id AND expense.currency = s.currency
    AND expense.amount_original = s.amount_original AND expense.amount_cny = s.amount_cny
  WHERE v.action = 'id_business_v2.historical_cash.verify' AND v.user_id IS NOT NULL
    AND JSON_UNQUOTE(JSON_EXTRACT(v.after_data, '$.version')) = '1'
    AND JSON_UNQUOTE(JSON_EXTRACT(v.after_data, '$.kind')) = 'restate_foreign_cash_cost'
    AND JSON_UNQUOTE(JSON_EXTRACT(v.after_data, '$.originalLineId')) = s.id
    AND JSON_UNQUOTE(JSON_EXTRACT(v.after_data, '$.originalJournalId')) = j.id
    AND JSON_UNQUOTE(JSON_EXTRACT(v.after_data, '$.targetAccountId')) = s.finance_account_id
    AND s.account_code = 'cash' AND s.currency <> 'CNY' AND s.direction = 'credit' AND s.amount_original > 0
    AND s.supplier_account_id IS NULL AND j.journal_type = 'expense' AND j.source_type = 'expense'
    AND JSON_EXTRACT(j.metadata, '$.cashHistoricalCost.version') IS NULL
    AND (SELECT COUNT(*) FROM id_business_v2_finance_journal_lines peer
      WHERE peer.journal_id = j.id AND peer.finance_account_id = s.finance_account_id
        AND peer.account_code = 'cash' AND peer.direction = 'credit' AND peer.currency <> 'CNY' AND peer.amount_original > 0) = 1
    AND CAST(JSON_UNQUOTE(JSON_EXTRACT(v.after_data, '$.expectedBookCostCny')) AS DECIMAL(18,4)) = s.amount_cny
    AND CAST(JSON_UNQUOTE(JSON_EXTRACT(v.after_data, '$.recomputedBookCostCny')) AS DECIMAL(18,4)) = s.amount_cny
    AND BINARY JSON_UNQUOTE(JSON_EXTRACT(v.after_data, '$.sourceLineFingerprint')) = BINARY SHA2(CONCAT_WS('|',
      s.journal_id, j.source_type, COALESCE(j.source_id, ''), s.id, s.line_no, s.account_code, s.direction,
      s.currency, CAST(s.amount_original AS CHAR), CAST(s.fx_rate_to_cny AS CHAR), CAST(s.amount_cny AS CHAR),
      COALESCE(s.finance_account_id, ''), COALESCE(s.supplier_account_id, ''), COALESCE(s.fx_rate_snapshot_id, '')), 256)
    AND EXISTS (SELECT 1 FROM audit_logs batch WHERE batch.action = 'id_business_v2.historical_cash.execute'
      AND batch.user_id = v.user_id
      AND JSON_UNQUOTE(JSON_EXTRACT(batch.after_data, '$.idempotencyKey')) = JSON_UNQUOTE(JSON_EXTRACT(v.after_data, '$.idempotencyKey'))
      AND JSON_UNQUOTE(JSON_EXTRACT(batch.after_data, '$.batchHash')) = JSON_UNQUOTE(JSON_EXTRACT(v.after_data, '$.batchHash'))
      AND JSON_CONTAINS(JSON_EXTRACT(batch.after_data, '$.verifiedSourceLineIds'), JSON_QUOTE(s.id)))
)`;

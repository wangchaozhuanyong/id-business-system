import assert from 'node:assert/strict';
import test from 'node:test';
import {
  V2_DATA_INTEGRITY_CHECKS,
  assessV2DataIntegrity,
  buildV2DataIntegrityCheckQuery
} from './lib/v2-data-integrity-audit.mjs';

test('integrity audit covers lifecycle, ledger, finance, and audit invariants', () => {
  const codes = new Set(V2_DATA_INTEGRITY_CHECKS.map((check) => check.code));
  for (const expected of [
    'finance_expense_display_snapshot_missing',
    'finance_expense_display_snapshot_not_protected',
    'order_display_snapshot_missing',
    'soft_delete_audit_missing',
    'account_balance_latest_ledger_mismatch',
    'supplier_balance_latest_ledger_mismatch',
    'finance_journal_unbalanced',
    'finance_reversal_mismatch',
    'customer_service_aggregate_mismatch',
    'unsafe_active_account_lock',
    'customer_owned_order_source_mismatch',
    'sold_account_ownership_mismatch',
    'customer_owned_order_duplicate_id_cost'
  ]) {
    assert.ok(codes.has(expected), `missing ${expected}`);
  }
  assert.equal(codes.size, V2_DATA_INTEGRITY_CHECKS.length);
});

test('integrity queries are wrapped in deterministic count and sample output', () => {
  const query = buildV2DataIntegrityCheckQuery(
    "SELECT 'example' AS entity_id, '{}'::jsonb AS detail"
  );
  assert.match(query, /WITH violations AS MATERIALIZED/);
  assert.match(query, /count\(\*\)::int/);
  assert.match(query, /ORDER BY entity_id LIMIT 10/);
});

test('finance account reconciliation does not count opening balances twice', () => {
  const financeAccountCheck = V2_DATA_INTEGRITY_CHECKS.find(
    (check) => check.code === 'finance_account_balance_mismatch'
  );
  assert.match(financeAccountCheck?.sql ?? '', /journal\.journal_type::text <> 'opening_balance'/);
});

test('after-sales integrity keeps recovered history while validating active ownership', () => {
  const ownershipCheck = V2_DATA_INTEGRITY_CHECKS.find(
    (check) => check.code === 'customer_owned_order_source_mismatch'
  );
  const sql = ownershipCheck?.sql ?? '';
  assert.match(sql, /source_order\.account_id IS DISTINCT FROM after_sales\.account_id/);
  assert.match(
    sql,
    /after_sales\.status::text IN \('draft', 'pending', 'waiting_external', 'processing'\)/
  );
  assert.match(sql, /activation\.due_at IS NULL OR activation\.due_at > CURRENT_TIMESTAMP/);
  assert.match(sql, /source_order\.account_disposition::text NOT IN \('sold', 'recovered'\)/);
  assert.match(sql, /source_order\.account_disposition::text = 'recovered'/);
  assert.match(sql, /account\.sold_by_order_id IS NOT NULL/);
});

test('active locks allow the original sale and ownership-consistent after-sales orders', () => {
  const lockCheck = V2_DATA_INTEGRITY_CHECKS.find(
    (check) => check.code === 'unsafe_active_account_lock'
  );
  const sql = lockCheck?.sql ?? '';
  assert.match(sql, /account\.sold_by_order_id = order_record\.id/);
  assert.match(sql, /order_record\.account_source::text = 'customer_owned'/);
  assert.match(sql, /order_record\.source_sold_order_id = account\.sold_by_order_id/);
});

test('after-sales finance integrity compares text source IDs with UUID order IDs safely', () => {
  const costCheck = V2_DATA_INTEGRITY_CHECKS.find(
    (check) => check.code === 'customer_owned_order_duplicate_id_cost'
  );
  assert.match(costCheck?.sql ?? '', /journal\.source_id = after_sales\.id::text/);
});

test('assessment fails when any invariant has violations', () => {
  assert.deepEqual(
    assessV2DataIntegrity([
      { code: 'healthy', count: 0 },
      { code: 'broken', count: 2 }
    ]),
    { ok: false, checkCount: 2, violationCount: 2, failedChecks: ['broken'] }
  );
});

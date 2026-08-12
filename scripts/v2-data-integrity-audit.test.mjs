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
    'unsafe_active_account_lock'
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

test('assessment fails when any invariant has violations', () => {
  assert.deepEqual(
    assessV2DataIntegrity([
      { code: 'healthy', count: 0 },
      { code: 'broken', count: 2 }
    ]),
    { ok: false, checkCount: 2, violationCount: 2, failedChecks: ['broken'] }
  );
});

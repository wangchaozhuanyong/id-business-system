import assert from 'node:assert/strict';
import test from 'node:test';
import {
  V2_DATA_INTEGRITY_CHECKS,
  assessV2DataIntegrity,
  assertV2AuditConnectionReadOnly,
  buildV2DataIntegrityCheckQueries,
  normalizeV2DataIntegritySamples
} from './lib/v2-data-integrity-audit.mjs';
import { buildV2AuditAccountProvisioning } from './lib/v2-data-integrity-auditor.mjs';

test('integrity audit covers lifecycle, ledger, finance, and audit invariants', () => {
  const codes = new Set(V2_DATA_INTEGRITY_CHECKS.map((check) => check.code));
  for (const expected of [
    'auth_user_phone_storage_invalid',
    'finance_expense_display_snapshot_missing',
    'finance_expense_display_snapshot_not_protected',
    'order_display_snapshot_missing',
    'soft_delete_audit_missing',
    'account_balance_latest_ledger_mismatch',
    'supplier_balance_latest_ledger_mismatch',
    'finance_inflow_reference_integrity',
    'finance_inflow_receipt_integrity',
    'finance_inflow_posting_mismatch',
    'completed_order_finance_reconciliation_mismatch',
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

test('user phone integrity rejects incomplete encryption and a legacy plaintext column', () => {
  const phoneCheck = V2_DATA_INTEGRITY_CHECKS.find(
    (check) => check.code === 'auth_user_phone_storage_invalid'
  );
  const sql = phoneCheck?.sql ?? '';

  assert.match(sql, /phone_encrypted IS NULL/);
  assert.match(sql, /phone_masked IS NULL/);
  assert.match(sql, /users_plaintext_phone_column_present/);
  assert.match(sql, /information_schema\.columns/);
  assert.match(sql, /column_record\.column_name = 'phone'/);
  assert.doesNotMatch(sql, /user_record\.phone\b/);
});

test('balance reversal integrity accepts a valid proportional partial refund', () => {
  const reversalCheck = V2_DATA_INTEGRITY_CHECKS.find(
    (check) => check.code === 'balance_ledger_reversal_mismatch'
  );
  const sql = reversalCheck?.sql ?? '';

  assert.match(sql, /id_business_v2_order_balance_returns/);
  assert.match(sql, /status = 'active'/);
  assert.match(sql, /reversal_balance_amount > remaining_balance_amount/);
  assert.match(sql, /ROUND\([\s\S]*remaining_cost_amount[\s\S]*reversal_balance_amount[\s\S]*4/);
  assert.doesNotMatch(sql, /reversal\.balance_amount <> original\.balance_amount/);
  assert.doesNotMatch(sql, /reversal\.cost_amount <> original\.cost_amount/);
});

test('MySQL integrity queries return deterministic counts and bounded samples', () => {
  const queries = buildV2DataIntegrityCheckQueries(
    "SELECT 'example' AS entity_id, JSON_OBJECT() AS detail"
  );
  assert.match(queries.count, /CAST\(COUNT\(\*\) AS CHAR\)/);
  assert.match(queries.count, /AS violations/);
  assert.match(queries.samples, /ORDER BY entity_id/);
  assert.match(queries.samples, /LIMIT 10/);
  assert.doesNotMatch(`${queries.count}\n${queries.samples}`, /::jsonb|MATERIALIZED/);
});

test('finance account reconciliation does not count opening balances twice', () => {
  const financeAccountCheck = V2_DATA_INTEGRITY_CHECKS.find(
    (check) => check.code === 'finance_account_balance_mismatch'
  );
  assert.match(financeAccountCheck?.sql ?? '', /journal\.journal_type <> 'opening_balance'/);
});

test('completed-order reconciliation independently recalculates profit from every finance line', () => {
  const orderCheck = V2_DATA_INTEGRITY_CHECKS.find(
    (check) => check.code === 'completed_order_finance_reconciliation_mismatch'
  );
  const sql = orderCheck?.sql ?? '';
  assert.match(sql, /journal\.journal_type = 'order_completed'/);
  assert.match(sql, /line\.direction = 'credit'/);
  assert.match(sql, /recalculated_profit <> profit_amount/);
  assert.doesNotMatch(sql, /LIMIT\s+50/i);
});

test('finance inflow integrity covers unique references, order overlap, receipts, and posting lines', () => {
  const referenceSql =
    V2_DATA_INTEGRITY_CHECKS.find((check) => check.code === 'finance_inflow_reference_integrity')
      ?.sql ?? '';
  const receiptSql =
    V2_DATA_INTEGRITY_CHECKS.find((check) => check.code === 'finance_inflow_receipt_integrity')
      ?.sql ?? '';
  const postingSql =
    V2_DATA_INTEGRITY_CHECKS.find((check) => check.code === 'finance_inflow_posting_mismatch')
      ?.sql ?? '';

  assert.match(referenceSql, /id_business_v2_finance_income_references/);
  assert.match(referenceSql, /active_duplicate/);
  assert.match(referenceSql, /id_business_v2_orders/);
  assert.doesNotMatch(
    referenceSql,
    /journal_status = 'posted'\s+AND normalized_inflow\.normalized_reference IS NULL/
  );
  assert.match(receiptSql, /inflow\.receipt_attachment_id IS NOT NULL/);
  assert.match(receiptSql, /content_encrypted IS NULL/);
  assert.match(receiptSql, /content_sha256 NOT REGEXP/);
  assert.match(postingSql, /inflow\.external_reference IS NOT NULL/);
  assert.match(postingSql, /manual_operating_income/);
  assert.match(postingSql, /other_operating_revenue/);
  assert.match(postingSql, /contributed_capital/);
  assert.match(postingSql, /borrowed_funds_payable/);
});

test('after-sales integrity keeps recovered history while validating active ownership', () => {
  const ownershipCheck = V2_DATA_INTEGRITY_CHECKS.find(
    (check) => check.code === 'customer_owned_order_source_mismatch'
  );
  const sql = ownershipCheck?.sql ?? '';
  assert.match(sql, /NOT \(source_order\.account_id <=> after_sales\.account_id\)/);
  assert.match(
    sql,
    /after_sales\.status IN \('draft', 'pending', 'waiting_external', 'processing'\)/
  );
  assert.match(sql, /activation\.due_at IS NULL OR activation\.due_at > CURRENT_TIMESTAMP/);
  assert.match(sql, /source_order\.account_disposition NOT IN \('sold', 'recovered'\)/);
  assert.match(sql, /source_order\.account_disposition = 'recovered'/);
  assert.match(sql, /account\.sold_by_order_id IS NOT NULL/);
});

test('active locks allow the original sale and ownership-consistent after-sales orders', () => {
  const lockCheck = V2_DATA_INTEGRITY_CHECKS.find(
    (check) => check.code === 'unsafe_active_account_lock'
  );
  const sql = lockCheck?.sql ?? '';
  assert.match(sql, /account\.sold_by_order_id = order_record\.id/);
  assert.match(sql, /order_record\.account_source = 'customer_owned'/);
  assert.match(sql, /order_record\.source_sold_order_id = account\.sold_by_order_id/);
});

test('after-sales finance integrity compares text source IDs with UUID order IDs safely', () => {
  const costCheck = V2_DATA_INTEGRITY_CHECKS.find(
    (check) => check.code === 'customer_owned_order_duplicate_id_cost'
  );
  assert.match(costCheck?.sql ?? '', /journal\.source_id = after_sales\.id/);
});

test('audit connection refuses write-capable MySQL accounts', () => {
  assert.doesNotThrow(() =>
    assertV2AuditConnectionReadOnly([
      { grant: 'GRANT USAGE ON *.* TO `audit`@`%`' },
      { grant: 'GRANT SELECT, SHOW VIEW ON `id_business_v2`.* TO `audit`@`%`' },
      {
        grant:
          'GRANT EXECUTE ON FUNCTION `id_business_v2`.`idv2_integrity_trigger_exists` TO `audit`@`%`'
      }
    ])
  );
  assert.throws(
    () =>
      assertV2AuditConnectionReadOnly([
        { grant: 'GRANT SELECT, UPDATE ON `id_business_v2`.* TO `application`@`%`' }
      ]),
    /仅具备 SELECT\/SHOW VIEW/
  );
  assert.throws(
    () =>
      assertV2AuditConnectionReadOnly([
        { grant: 'GRANT EXECUTE ON FUNCTION `id_business_v2`.`unsafe_function` TO `audit`@`%`' }
      ]),
    /仅具备 SELECT\/SHOW VIEW/
  );
});

test('production auditor provisioning is limited to the dedicated local read-only account', () => {
  const provisioning = buildV2AuditAccountProvisioning({
    V2_DATA_INTEGRITY_DATABASE_URL:
      'mysql://id_business_audit:a-real-audit-password-123456@127.0.0.1:3306/id_business_v2',
    MYSQL_DATABASE: 'id_business_v2',
    MYSQL_ROOT_PASSWORD: 'a-real-root-password-123456',
    MYSQL_HOST_PORT: '3306'
  });
  assert.match(provisioning.rootDatabaseUrl, /^mysql:\/\/root:/);
  assert.ok(provisioning.statements.some((sql) => /REVOKE ALL PRIVILEGES/.test(sql)));
  assert.ok(provisioning.statements.some((sql) => /GRANT SELECT, SHOW VIEW/.test(sql)));
  assert.ok(provisioning.statements.some((sql) => /idv2_integrity_trigger_exists/.test(sql)));
  assert.ok(provisioning.statements.every((sql) => !/\b(INSERT|UPDATE|DELETE)\b/.test(sql)));
  assert.throws(
    () =>
      buildV2AuditAccountProvisioning({
        V2_DATA_INTEGRITY_DATABASE_URL:
          'mysql://id_business_app:a-real-audit-password-123456@127.0.0.1/id_business_v2',
        MYSQL_DATABASE: 'id_business_v2',
        MYSQL_ROOT_PASSWORD: 'a-real-root-password-123456'
      }),
    /用户名必须为 id_business_audit/
  );
  assert.throws(
    () =>
      buildV2AuditAccountProvisioning({
        V2_DATA_INTEGRITY_DATABASE_URL:
          'mysql://id_business_audit:a-real-audit-password-123456@remote.example/id_business_v2',
        MYSQL_DATABASE: 'id_business_v2',
        MYSQL_ROOT_PASSWORD: 'a-real-root-password-123456'
      }),
    /仅允许通过 EC2 本机/
  );
});

test('MySQL JSON samples are normalized without losing structured details', () => {
  assert.deepEqual(
    normalizeV2DataIntegritySamples([
      { entityId: 'entity-1', detail: '{"amount":"12.3400"}' },
      { entityId: 2, detail: { status: 'broken' } }
    ]),
    [
      { entityId: 'entity-1', detail: { amount: '12.3400' } },
      { entityId: '2', detail: { status: 'broken' } }
    ]
  );
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

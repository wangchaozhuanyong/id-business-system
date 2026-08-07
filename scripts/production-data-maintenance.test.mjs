import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertApplyTargetSupported,
  assertExpectedProductionMaintenanceDatabase,
  assertProductionCutoverAuthorization,
  assertPreviewAuthorization,
  assertTargetMatchesDatabase,
  expectedProductionCutoverConfirmation,
  OPTIONAL_PRODUCTION_CUTOVER_TABLES,
  PRODUCTION_CUTOVER_TRUNCATE_TABLES,
  createOperationId,
  createSnapshotFingerprint
} from './lib/production-data-maintenance.mjs';

test('isolated maintenance accepts only loopback PostgreSQL', () => {
  assert.doesNotThrow(() =>
    assertTargetMatchesDatabase(
      'isolated',
      'postgresql://postgres@127.0.0.1:56432/id_business_reconstruction?schema=public'
    )
  );
  assert.throws(
    () =>
      assertTargetMatchesDatabase(
        'isolated',
        'postgresql://postgres@db.production.example.com/postgres'
      ),
    /只允许连接/
  );
});

test('production apply is impossible without a future validated import bundle', () => {
  assert.throws(() => assertApplyTargetSupported('production'), /生产执行被硬性禁止/);
  assert.doesNotThrow(() => assertApplyTargetSupported('isolated'));
});

test('production cutover cleanup is scoped to the verified Supabase project', () => {
  assert.doesNotThrow(() =>
    assertExpectedProductionMaintenanceDatabase(
      'postgresql://postgres.fjquufgbnxyocmuzltxi:secret@aws-0-us-west-1.pooler.supabase.com/postgres'
    )
  );
  assert.doesNotThrow(() =>
    assertExpectedProductionMaintenanceDatabase(
      'postgresql://postgres:secret@db.fjquufgbnxyocmuzltxi.supabase.co/postgres'
    )
  );
  assert.throws(
    () =>
      assertExpectedProductionMaintenanceDatabase(
        'postgresql://postgres:secret@db.other-project.supabase.co/postgres'
      ),
    /不是已核验的生产 Supabase 项目/
  );
});

test('production cutover cleanup requires a second irreversible confirmation phrase', () => {
  const hash = 'b'.repeat(64);
  const preview = {
    target: 'production',
    operationId: 'recovery-prod-123',
    snapshotFingerprint: 'fingerprint-prod-123',
    expiresAt: '2026-08-04T08:00:00.000Z'
  };
  const expectedConfirmation = expectedProductionCutoverConfirmation(preview.operationId, hash);

  assert.doesNotThrow(() =>
    assertProductionCutoverAuthorization({
      preview,
      target: 'production',
      confirmOperationId: preview.operationId,
      productionConfirmation: expectedConfirmation,
      backupSha256: hash,
      currentFingerprint: preview.snapshotFingerprint,
      now: new Date('2026-08-04T07:30:00.000Z')
    })
  );
  assert.throws(
    () =>
      assertProductionCutoverAuthorization({
        preview,
        target: 'production',
        confirmOperationId: preview.operationId,
        productionConfirmation: 'DELETE',
        backupSha256: hash,
        currentFingerprint: preview.snapshotFingerprint,
        now: new Date('2026-08-04T07:30:00.000Z')
      }),
    /确认口令不匹配/
  );
});

test('production cutover truncates business, security trail and attachment tables', () => {
  for (const table of [
    'id_business_v2_customers',
    'id_business_v2_orders',
    'id_business_v2_finance_journals',
    'active_sessions',
    'attachments',
    'audit_logs',
    'login_logs',
    'sensitive_access_approvals',
    'sensitive_access_logs'
  ]) {
    assert.ok(PRODUCTION_CUTOVER_TRUNCATE_TABLES.includes(table), `${table} should be truncated`);
  }
  for (const table of [
    'apple_account_action_plan_items',
    'apple_account_action_plans',
    'apple_account_locks',
    'apple_account_status_checks',
    'apple_accounts',
    'apple_balance_adjustments',
    'apple_balance_consumptions',
    'apple_balance_topups',
    'apple_official_price_snapshots',
    'apple_orders',
    'apple_price_change_reviews',
    'apple_service_region_prices',
    'automation_task_logs',
    'automation_tasks',
    'renewal_tasks',
    'service_activations'
  ]) {
    assert.ok(
      OPTIONAL_PRODUCTION_CUTOVER_TABLES.includes(table),
      `${table} should be optional cutover cleanup`
    );
  }
});

test('snapshot fingerprint is deterministic and operation ids are preview-specific', () => {
  const snapshot = {
    database: 'reconstruction',
    appliedMigrations: 80,
    migrationRows: 82,
    latestAuditAt: '2026-08-04T07:00:00.000Z',
    businessTables: { id_business_v2_customers: { count: 2, rowHash: 'a' } },
    preservedTables: { users: 2 }
  };
  const fingerprint = createSnapshotFingerprint(snapshot);
  assert.equal(fingerprint, createSnapshotFingerprint({ ...snapshot }));
  assert.notEqual(
    createOperationId(fingerprint, '2026-08-04T07:00:00.000Z'),
    createOperationId(fingerprint, '2026-08-04T07:01:00.000Z')
  );
});

test('apply requires an unexpired matching preview, fingerprint and backup hash', () => {
  const hash = 'a'.repeat(64);
  const preview = {
    target: 'isolated',
    operationId: 'recovery-123',
    snapshotFingerprint: 'fingerprint-123',
    expiresAt: '2026-08-04T08:00:00.000Z'
  };
  assert.doesNotThrow(() =>
    assertPreviewAuthorization({
      preview,
      target: 'isolated',
      confirmOperationId: 'recovery-123',
      backupSha256: hash,
      currentFingerprint: 'fingerprint-123',
      now: new Date('2026-08-04T07:30:00.000Z')
    })
  );
  assert.throws(
    () =>
      assertPreviewAuthorization({
        preview,
        target: 'isolated',
        confirmOperationId: 'recovery-123',
        backupSha256: hash,
        currentFingerprint: 'changed',
        now: new Date('2026-08-04T07:30:00.000Z')
      }),
    /指纹已变化/
  );
  assert.throws(
    () =>
      assertPreviewAuthorization({
        preview,
        target: 'isolated',
        confirmOperationId: 'recovery-123',
        backupSha256: hash,
        currentFingerprint: 'fingerprint-123',
        now: new Date('2026-08-04T08:00:00.000Z')
      }),
    /预览已经过期/
  );
});

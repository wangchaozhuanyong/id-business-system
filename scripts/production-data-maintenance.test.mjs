import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertApplyTargetSupported,
  assertPreviewAuthorization,
  assertTargetMatchesDatabase,
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

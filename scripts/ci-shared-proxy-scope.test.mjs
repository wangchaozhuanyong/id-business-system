import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  isSharedProxyPoolPaths,
  isSharedProxyPoolOnly,
  sharedProxyMigration
} from './ci-shared-proxy-scope.mjs';
import { checkMode, needsOnlineRechargeCiBuild, selectedParts } from './ci-recharge-scope.mjs';
const schemaPath = 'apps/api/prisma-mysql/schema.prisma';
const before = 'model User {\n  id String\n}\n\nmodel IdBusinessV2RechargeProxy {\n id String\n}\n';
const after =
  'model User {\n  id String\n}\n\nmodel IdBusinessV2RechargeProxy {\n id String\n remark String?\n}\n\nmodel IdBusinessV2ProxyAlias {\n oldId String\n}\n';
const paths = [
  'apps/api/src/id-business-v2/proxy-pool/proxy-pool.module.ts',
  schemaPath,
  sharedProxyMigration,
  'scripts/lib/v2-production-database-access.mjs'
];
test('shared pool selects real UI/API/migration/security checks without historical frozen image build', () => {
  assert.equal(checkMode(paths, before, after), 'recharge');
  assert.equal(needsOnlineRechargeCiBuild(paths), false);
  assert.deepEqual(selectedParts(paths), ['guards', 'api', 'migration', 'security']);
});
test('unrelated schema changes and other migrations are not admitted', () => {
  assert.equal(
    isSharedProxyPoolOnly(
      paths,
      before,
      after.replace('model User {', 'model User {\n  extra String?')
    ),
    false
  );
  assert.equal(
    isSharedProxyPoolOnly(
      [...paths, 'apps/api/prisma-mysql/migrations/unrelated/migration.sql'],
      before,
      after
    ),
    false
  );
  assert.equal(
    isSharedProxyPoolOnly(
      paths.filter((p) => p !== sharedProxyMigration),
      before,
      after
    ),
    false
  );
});
test('unrelated business, deployment controls and dependency changes retain normal checks', () => {
  for (const path of [
    'apps/api/src/id-business-v2/finance/public-api.ts',
    '.github/workflows/production-release.yml',
    'package-lock.json'
  ])
    assert.equal(isSharedProxyPoolPaths([...paths, path]), false);
  assert.equal(
    needsOnlineRechargeCiBuild([
      'apps/api/src/id-business-v2/online-recharge/engine/task-runner.cjs'
    ]),
    true
  );
});

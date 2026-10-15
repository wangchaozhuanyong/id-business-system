import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { test } from 'node:test';
import {
  isSharedProxyPoolPaths,
  isSharedProxyPoolOnly,
  sharedProxyMigration
} from './ci-shared-proxy-scope.mjs';
import { checkMode, needsOnlineRechargeCiBuild, selectedParts } from './ci-recharge-scope.mjs';
const schemaPath = 'apps/api/prisma-mysql/schema.prisma';
const after = readFileSync(schemaPath, 'utf8');
const before = execFileSync(
  'git',
  ['show', '5bf15a507d46ccfc76e2f7e737ea7ef38d0cc32e:' + schemaPath],
  { encoding: 'utf8' }
);
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

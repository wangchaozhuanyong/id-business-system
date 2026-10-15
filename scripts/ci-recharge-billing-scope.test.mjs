import assert from 'node:assert/strict';
import test from 'node:test';
import {
  billingControlPaths,
  billingMigrationPath,
  isRechargeBillingOnly
} from './ci-recharge-billing-scope.mjs';
import { checkMode, needsOnlineRechargeCiBuild, selectedParts } from './ci-recharge-scope.mjs';

test('billing checks keep API/Admin and reject foreign ONLINE, schema and dependency changes', () => {
  const paths = [
    ...billingControlPaths,
    'apps/api/src/id-business-v2/auto-recharge/recharge-billing-generator.ts',
    'apps/admin/src/v2/features/auto-recharge/useRechargeAddressGeneration.ts',
    'scripts/ci-recharge-check.mjs'
  ];
  assert.equal(isRechargeBillingOnly(paths), true);
  assert.equal(checkMode(paths), 'recharge');
  assert.equal(needsOnlineRechargeCiBuild(paths), false);
  assert.deepEqual(selectedParts(paths), ['guards', 'admin', 'api']);
  assert.equal(checkMode([billingMigrationPath]), 'recharge');
  assert.deepEqual(selectedParts([billingMigrationPath]), ['guards']);
  assert.equal(isRechargeBillingOnly([...paths, billingMigrationPath]), true);
  for (const foreign of [
    'apps/api/src/id-business-v2/online-recharge/engine/payment.cjs',
    'apps/api/prisma-mysql/schema.prisma',
    'apps/api/prisma-mysql/migrations/foreign/migration.sql',
    'package-lock.json',
    'scripts/production-release/recharge-billing-write.py'
  ])
    assert.equal(isRechargeBillingOnly([...paths, foreign]), false, foreign);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import {
  checkoutControlPaths,
  checkoutSourceRecoveryControls,
  isRechargeCheckoutOnly,
  isRechargeSourceRecoveryOnly
} from './ci-recharge-checkout-scope.mjs';
import {
  adminCheckCommands,
  isRechargeOnly,
  needsOnlineRechargeCiBuild,
  selectedParts
} from './ci-recharge-scope.mjs';
const paths = [
  ...checkoutControlPaths,
  'apps/admin/src/v2/features/auto-recharge/RechargeResult.vue',
  'apps/api/src/id-business-v2/auto-recharge/worker/native_checkout.py',
  'apps/api/src/id-business-v2/auto-recharge/persistence/recharge.repository.ts',
  'packages/shared/src/v2/auto-recharge.ts',
  'scripts/ci-recharge-check.mjs'
];
test('native checkout selects UI/API/connector and retains filled-details acceptance', () => {
  assert.equal(isRechargeCheckoutOnly(paths), true);
  assert.equal(isRechargeOnly(paths, 'same', 'same'), true);
  assert.equal(isRechargeOnly(paths, 'before', 'after'), false);
  assert.deepEqual(selectedParts(paths), ['guards', 'admin', 'api', 'connector']);
  assert.equal(needsOnlineRechargeCiBuild(paths), false);
  assert.ok(adminCheckCommands('recharge', paths).some((row) => row.includes('--quote-stages')));
});
test('scope rejects dependency, schema, ONLINE, auth and unrelated UI changes', () => {
  for (const extra of [
    'package-lock.json',
    '.github/workflows/quality.yml',
    'apps/api/prisma-mysql/schema.prisma',
    'apps/api/prisma-mysql/migrations/new/migration.sql',
    'apps/api/src/auth/auth.service.ts',
    'apps/admin/src/v2/features/orders/OrdersView.vue',
    'apps/api/src/id-business-v2/online-recharge/online.service.ts'
  ]) {
    assert.equal(isRechargeCheckoutOnly([...paths, extra]), false, extra);
  }
  assert.equal(isRechargeCheckoutOnly([]), false);
});

const recovery = [
  ...checkoutSourceRecoveryControls,
  'apps/api/src/id-business-v2/auto-recharge/recharge-account-restore.ts',
  'apps/api/src/id-business-v2/auto-recharge/recharge-unidentified-checkout.ts',
  'apps/api/src/id-business-v2/auto-recharge/recharge-unidentified-checkout.spec.ts',
  'scripts/ci-recharge-check.mjs',
  'docs/CHECKOUT_SOURCE_RECOVERY_20261016.md'
];
test('original checkout source recovery keeps API and control checks without unrelated components', () => {
  assert.equal(isRechargeSourceRecoveryOnly(recovery), true);
  assert.equal(isRechargeCheckoutOnly(recovery), true);
  assert.equal(isRechargeOnly(recovery, 'same', 'same'), true);
  assert.equal(isRechargeOnly(recovery, 'before', 'after'), false);
  assert.deepEqual(selectedParts(recovery), ['guards', 'api']);
  assert.equal(needsOnlineRechargeCiBuild(recovery), false);
  for (const extra of [
    'package-lock.json',
    'scripts/ci-recharge-scope.mjs',
    'apps/api/prisma-mysql/schema.prisma',
    'apps/api/src/auth/auth.service.ts',
    'apps/api/src/id-business-v2/online-recharge/public.controller.ts',
    'apps/api/src/id-business-v2/auto-registration/public-api.ts',
    'apps/admin/src/v2/features/auto-recharge/RechargeResult.vue',
    'apps/api/src/id-business-v2/auto-recharge/worker/pay.py'
  ]) {
    assert.equal(isRechargeSourceRecoveryOnly([...recovery, extra]), false, extra);
    assert.equal(isRechargeCheckoutOnly([...recovery, extra]), false, extra);
  }
});

test('checkout foreground repair selects connector regression and rejects unrelated changes', () => {
  const focus = [
    'apps/api/src/id-business-v2/auto-recharge/worker/payment_form.py',
    'apps/api/src/id-business-v2/auto-recharge/worker/test_payment_form_focus.py',
    'scripts/ci-recharge-checkout-scope.mjs',
    'scripts/ci-recharge-checkout-scope.test.mjs',
    'scripts/ci-recharge-check.mjs',
    'docs/CHECKOUT_SOURCE_RECOVERY_20261016.md'
  ];
  assert.equal(isRechargeSourceRecoveryOnly(focus), true);
  assert.equal(isRechargeOnly(focus, 'same', 'same'), true);
  assert.deepEqual(selectedParts(focus), ['guards', 'connector']);
  assert.equal(needsOnlineRechargeCiBuild(focus), false);
  for (const extra of [
    'package-lock.json',
    'apps/api/prisma-mysql/schema.prisma',
    'apps/api/src/auth/auth.service.ts',
    'apps/api/src/id-business-v2/online-recharge/worker/pay.py',
    'apps/api/src/id-business-v2/auto-recharge/worker/pay.py'
  ]) {
    assert.equal(isRechargeCheckoutOnly([...focus, extra]), false, extra);
  }
});

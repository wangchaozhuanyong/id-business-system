import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSettledCheckoutControlsOnly,
  quoteTierControlPaths,
  settledCheckoutControlPaths
} from './ci-settled-checkout-scope.mjs';
import { checkMode, selectedParts } from './ci-recharge-scope.mjs';

test('结单修复发布仅检查有限控制，不能混入业务或历史发布器', () => {
  const paths = [...settledCheckoutControlPaths];
  assert.equal(isSettledCheckoutControlsOnly(paths), true);
  assert.equal(checkMode(paths, 'schema', 'schema'), 'ci-only');
  assert.equal(checkMode(paths, 'old', 'new'), 'full');
  assert.deepEqual(selectedParts(paths), ['guards', 'release-controls']);
  assert.equal(isSettledCheckoutControlsOnly([]), false);
  for (const name of [
    paths[0],
    'package-lock.json',
    'prisma/schema.prisma',
    'scripts/production-release/bitbrowser-history-release.py',
    'apps/api/src/id-business-v2/auto-recharge/recharge-account-restore.ts'
  ]) {
    assert.equal(isSettledCheckoutControlsOnly([...paths, name]), false, name);
  }
});

test('Go 核价与 Pro 切档发布只选择自身有限控制，混入业务或其他发布器时拒绝', () => {
  const paths = [...quoteTierControlPaths];
  assert.equal(isSettledCheckoutControlsOnly(paths), true);
  assert.equal(checkMode(paths, 'same', 'same'), 'ci-only');
  assert.equal(checkMode(paths, 'old', 'new'), 'full');
  assert.deepEqual(selectedParts(paths), ['guards', 'release-controls']);
  assert.equal(isSettledCheckoutControlsOnly(paths.slice(0, 3)), false);
  for (const extra of [
    'package-lock.json',
    'docs/V2_TASKS.md',
    'scripts/production-release/settled-checkout-contract.json',
    'scripts/production-release/bitbrowser-history-release.py',
    'apps/admin/src/v2/features/auto-recharge/bitbrowser-native-quote.ts'
  ])
    assert.equal(isSettledCheckoutControlsOnly([...paths, extra]), false, extra);
  assert.equal(isSettledCheckoutControlsOnly([...paths, paths[0]]), false);
});

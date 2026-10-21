import test from 'node:test';
import assert from 'node:assert/strict';
import {
  isSettledCheckoutControlsOnly,
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

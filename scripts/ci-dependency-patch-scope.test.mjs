import assert from 'node:assert/strict';
import test from 'node:test';
import { dependencyPatchPaths, isDependencyPatchCandidate } from './ci-dependency-patch-scope.mjs';
import { checkMode, needsOnlineRechargeCiBuild } from './ci-recharge-scope.mjs';

test('reviewed dependency patch retains full checks and does not rebuild an unchanged historical ONLINE image', () => {
  assert.equal(isDependencyPatchCandidate(dependencyPatchPaths), true);
  assert.equal(checkMode(dependencyPatchPaths, 'same', 'same'), 'full');
  assert.equal(needsOnlineRechargeCiBuild(dependencyPatchPaths), false);
});

test('dependency patch admission rejects changed package bytes and every wider or incomplete scope', () => {
  assert.equal(
    isDependencyPatchCandidate(dependencyPatchPaths, () => '0'.repeat(64)),
    false
  );
  assert.equal(
    isDependencyPatchCandidate(dependencyPatchPaths, () => {
      throw new Error('unavailable');
    }),
    false
  );
  assert.equal(isDependencyPatchCandidate(dependencyPatchPaths.slice(1)), false);
  assert.equal(
    isDependencyPatchCandidate([...dependencyPatchPaths, dependencyPatchPaths[0]]),
    false
  );
  for (const name of [
    'apps/api/src/main.ts',
    'apps/api/prisma-mysql/schema.prisma',
    'apps/api/src/id-business-v2/online-recharge/engine/upstream/package-lock.json',
    'apps/api/src/id-business-v2/online-recharge/engine/worker.cjs'
  ]) {
    assert.equal(isDependencyPatchCandidate([...dependencyPatchPaths, name]), false);
    assert.equal(needsOnlineRechargeCiBuild([...dependencyPatchPaths, name]), true);
  }
});

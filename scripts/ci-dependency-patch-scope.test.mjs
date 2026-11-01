import assert from 'node:assert/strict';
import test from 'node:test';
import { execFileSync } from 'node:child_process';
import {
  dependencyPatchPaths,
  dependencyPatchSources,
  isDependencyPatchCandidate
} from './ci-dependency-patch-scope.mjs';
import { checkMode, needsOnlineRechargeCiBuild } from './ci-recharge-scope.mjs';

test('reviewed dependency patch retains full checks and does not rebuild an unchanged historical ONLINE image', () => {
  assert.equal(
    isDependencyPatchCandidate(dependencyPatchPaths, (name) => dependencyPatchSources[name]),
    true
  );
  assert.equal(checkMode(dependencyPatchPaths, 'same', 'same'), 'full');
});

test('frozen browser compatibility repair changes only the full-quality runner', () => {
  const cwd = new URL('../', import.meta.url);
  const before = execFileSync(
    'git',
    ['show', '506b371601f48838f9a6846447c2ab4d899262bb:.github/workflows/quality.yml'],
    { cwd, encoding: 'utf8' }
  );
  const after = execFileSync(
    'git',
    ['cat-file', 'blob', '745aff41f2b3ffcb13d9271e6d3a91d976b8d8fb'],
    { cwd, encoding: 'utf8' }
  );
  assert.match(
    after.split('  full-quality:')[1].split('\n  recharge:')[0],
    /runs-on: ubuntu-24\.04/
  );
  assert.equal(after.replace('runs-on: ubuntu-24.04', 'runs-on: ubuntu-latest'), before);
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

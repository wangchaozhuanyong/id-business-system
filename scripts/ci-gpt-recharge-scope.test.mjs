import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import {
  affectsGptRechargeArtifact,
  gptRechargeFrozen,
  gptRechargePaths,
  isGptRechargeOnly
} from './ci-gpt-recharge-scope.mjs';
import {
  affectsPart,
  checkMode,
  selectedParts,
  hasRechargeFlowBusinessReuseProof
} from './ci-recharge-scope.mjs';

// The historical finite recipe must remain testable after shared CI controls advance.
const frozenSource = (name) =>
  execFileSync('git', ['show', `b0d80c7f8cea818361d06873e3e432ee2c3b3229:${name}`], {
    stdio: ['ignore', 'pipe', 'pipe']
  });

test('the exact recharge integration selects guards and the reproduced API only', () => {
  assert.equal(isGptRechargeOnly(gptRechargePaths, frozenSource), true);
  const unchanged = isGptRechargeOnly(gptRechargePaths);
  assert.equal(checkMode(gptRechargePaths, 'same', 'same'), unchanged ? 'recharge' : 'full');
  if (unchanged) assert.deepEqual(selectedParts(gptRechargePaths), ['guards', 'api']);
});

test('schema or neighboring business and execution source cannot enter the finite scope', () => {
  assert.equal(checkMode(gptRechargePaths, 'before', 'after'), 'full');
  for (const path of [
    'apps/api/src/auth/auth.service.ts',
    'apps/api/prisma-mysql/schema.prisma',
    'apps/admin/src/main.ts',
    'apps/api/src/id-business-v2/online-recharge/engine/worker.cjs',
    'apps/api/src/id-business-v2/online-recharge/persistence/worker.repository.ts'
  ]) {
    assert.equal(isGptRechargeOnly([...gptRechargePaths, path]), false, path);
  }
});

test('every compiled source and release control must retain its reviewed bytes', () => {
  for (const changed of Object.keys(gptRechargeFrozen)) {
    const read = (name) => (name === changed ? Buffer.from('changed') : frozenSource(name));
    assert.equal(isGptRechargeOnly(gptRechargePaths, read), false, changed);
  }
});

test('missing source and an empty request never qualify', () => {
  assert.equal(
    isGptRechargeOnly([], () => Buffer.from('')),
    false
  );
  assert.equal(
    isGptRechargeOnly(gptRechargePaths, () => {
      throw new Error('missing');
    }),
    false
  );
});

test('partial generic config or control changes cannot select the finite application scope', () => {
  assert.equal(isGptRechargeOnly(['.env.example']), false);
  assert.equal(isGptRechargeOnly(['scripts/ci-recharge-scope.mjs']), false);
  assert.equal(
    isGptRechargeOnly(gptRechargePaths.filter((name) => !name.endsWith('/tasks.service.ts'))),
    false
  );
});

test('native GPT API evidence cannot be reused after any bound package input changes', () => {
  for (const path of ['scripts/ci-gpt-recharge-scope.mjs', ...Object.keys(gptRechargeFrozen)]) {
    assert.equal(affectsGptRechargeArtifact([path]), true, path);
    if (path.includes('gpt-recharge')) assert.equal(affectsPart('api', [path]), true, path);
  }
  assert.equal(affectsPart('api', ['docs/ONLINE_RECHARGE.md']), false);
  assert.equal(affectsPart('api', ['docs/unrelated-note.md']), false);
  assert.equal(affectsGptRechargeArtifact(['docs/unrelated-note.md']), false);
  assert.equal(affectsPart('api', ['scripts/production-release/api-admin-scope.test.py']), false);
});

test('the actual 55d to shared-pool reconstruction change invalidates the old native API evidence', () => {
  const changed = execFileSync(
    'git',
    [
      'diff',
      '--name-only',
      '8b7bd240242422ece225223d79a4d254c7fa7bcc',
      '5829f70f9ce4ebc517e54c34751b999d61a53a86'
    ],
    { encoding: 'utf8' }
  )
    .trim()
    .split('\n')
    .filter(Boolean);
  assert.ok(changed.includes('scripts/production-release/gpt-recharge-build.py'));
  assert.ok(changed.includes('scripts/production-release/gpt-recharge-contract.json'));
  assert.equal(affectsPart('api', changed), true);
  assert.equal(hasRechargeFlowBusinessReuseProof('api', changed), false);
});

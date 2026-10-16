import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  gptRechargeFrozen,
  gptRechargePaths,
  isGptRechargeOnly
} from './ci-gpt-recharge-scope.mjs';
import { checkMode, selectedParts } from './ci-recharge-scope.mjs';

test('the exact recharge integration selects guards and the reproduced API only', () => {
  assert.equal(isGptRechargeOnly(gptRechargePaths), true);
  assert.equal(checkMode(gptRechargePaths, 'same', 'same'), 'recharge');
  assert.deepEqual(selectedParts(gptRechargePaths), ['guards', 'api']);
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
    const read = (name) => (name === changed ? Buffer.from('changed') : readFileSync(name));
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

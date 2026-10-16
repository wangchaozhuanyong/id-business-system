import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  sharedBankCardPaths,
  isSharedBankCardOnly,
  sharedBankCardSchemaMatches,
  sharedBankCardCommands
} from './ci-shared-bank-card-scope.mjs';
test('finite shared pool accepts its reviewed source set and rejects unrelated payment or auth changes', () => {
  assert.equal(isSharedBankCardOnly([...sharedBankCardPaths]), true);
  for (const path of [
    'apps/api/src/auth/auth.service.ts',
    'apps/api/src/id-business-v2/online-recharge/engine/worker.cjs',
    'package-lock.json'
  ])
    assert.equal(isSharedBankCardOnly([...sharedBankCardPaths, path]), false);
  assert.equal(isSharedBankCardOnly([...sharedBankCardPaths, sharedBankCardPaths[0]]), false);
});
test('only the single additive card plan field qualifies for scoped schema checks', () => {
  const after = readFileSync(
    new URL('../apps/api/prisma-mysql/schema.prisma', import.meta.url),
    'utf8'
  );
  const line = after.split('\n').find((v) => v.includes('allowedPlans')) + '\n';
  const before = after.replace(line, '');
  assert.equal(sharedBankCardSchemaMatches(before, after), true);
  assert.equal(
    sharedBankCardSchemaMatches(before, after.replace('allowed_plans', 'other_field')),
    false
  );
  assert.equal(sharedBankCardSchemaMatches(before, after + '\nmodel Extra {}\n'), false);
  assert.equal(sharedBankCardSchemaMatches(after, after), false);
});
test('affected CI retains actual migration and every UI guard plus API and Admin builds', () => {
  for (const part of ['guards', 'api', 'admin', 'migration'])
    assert.ok(sharedBankCardCommands(part, [...sharedBankCardPaths]).length);
  assert.deepEqual(sharedBankCardCommands('migration', [...sharedBankCardPaths]), [
    ['python3', '-B', 'scripts/ci-recharge-migration.py']
  ]);
  assert.throws(() => sharedBankCardCommands('online-engine', [...sharedBankCardPaths]));
});

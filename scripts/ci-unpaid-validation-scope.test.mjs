import test from 'node:test';
import assert from 'node:assert/strict';
import {
  unpaidValidationPaths,
  unpaidValidationControls,
  isUnpaidValidationOnly,
  unpaidValidationCommands
} from './ci-unpaid-validation-scope.mjs';
import { checkMode, selectedParts, needsOnlineRechargeCiBuild } from './ci-recharge-scope.mjs';
test('unpaid batch retains all four affected checks and refuses unrelated inputs', () => {
  const paths = [...unpaidValidationPaths, ...unpaidValidationControls];
  assert.equal(isUnpaidValidationOnly(paths), true);
  assert.equal(checkMode(paths, 'same', 'same'), 'recharge');
  assert.equal(checkMode(paths, 'before', 'after'), 'full');
  assert.deepEqual(selectedParts(paths), ['guards', 'api', 'admin', 'online-engine']);
  assert.equal(needsOnlineRechargeCiBuild(paths), false);
  for (const p of unpaidValidationPaths.filter((p) => p.startsWith('apps/')))
    assert.equal(isUnpaidValidationOnly(paths.filter((n) => n !== p)), false);
  for (const extra of [
    'apps/api/prisma-mysql/schema.prisma',
    'apps/admin/src/auth/session.ts',
    'apps/api/src/id-business-v2/auto-recharge/recharge.service.ts'
  ])
    assert.equal(isUnpaidValidationOnly([...paths, extra]), false);
  assert.equal(isUnpaidValidationOnly([...paths, paths[0]]), false);
  for (const part of selectedParts(paths)) assert.ok(unpaidValidationCommands(part, paths).length);
  const commands = JSON.stringify(
    selectedParts(paths).flatMap((part) => unpaidValidationCommands(part, paths))
  );
  assert.match(commands, /test:online-recharge:engine/);
  assert.match(commands, /check:v2-loading-standard/);
  assert.doesNotMatch(commands, /migrate|financial-integrity|verify:production/);
});

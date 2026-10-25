import test from 'node:test';
import assert from 'node:assert/strict';
import {
  cardReadDiagnosticsPaths,
  persistentProfilePaths,
  isPersistentProfileOnly,
  isUnpaidValidationControlsOnly,
  unpaidValidationPaths,
  checkoutResumePaths,
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

test('baseline-only follow-up requires controls and cannot admit business changes', () => {
  const paths = ['scripts/production-release/online-unpaid-validation-contract.json'];
  assert.equal(isUnpaidValidationControlsOnly(paths), true);
  assert.equal(checkMode(paths, 'same', 'same'), 'ci-only');
  assert.deepEqual(selectedParts(paths), ['guards']);
  assert.equal(needsOnlineRechargeCiBuild(paths), false);
  assert.equal(isUnpaidValidationControlsOnly([...paths, unpaidValidationPaths[0]]), false);
  assert.throws(() => unpaidValidationCommands('api', paths));
  assert.doesNotMatch(
    JSON.stringify(unpaidValidationCommands('guards', paths)),
    /prisma|migrate|workspace|test:online-recharge:engine/
  );
});

test('exact checkout resume repair retains API and complete engine checks without an Admin change', () => {
  const paths = [
    ...checkoutResumePaths,
    'scripts/ci-unpaid-validation-scope.mjs',
    'scripts/ci-unpaid-validation-scope.test.mjs',
    'scripts/ci-recharge-scope.mjs'
  ];
  assert.equal(isUnpaidValidationOnly(paths), true);
  assert.equal(checkMode(paths, 'same', 'same'), 'recharge');
  assert.deepEqual(selectedParts(paths), ['guards', 'api', 'online-engine']);
  assert.equal(checkMode(paths, 'before', 'after'), 'full');
  for (const path of checkoutResumePaths.filter((p) => p.startsWith('apps/')))
    assert.equal(isUnpaidValidationOnly(paths.filter((p) => p !== path)), false);
  assert.equal(isUnpaidValidationOnly([...paths, 'apps/admin/src/auth/session.ts']), false);
  assert.match(
    JSON.stringify(unpaidValidationCommands('online-engine', paths)),
    /test:online-recharge:engine/
  );
  assert.match(JSON.stringify(unpaidValidationCommands('api', paths)), /typecheck/);
});

test('checkout resume publication checks only its finite controls and preserves business gates', () => {
  const paths = unpaidValidationControls.filter((p) => p.includes('online-checkout-resume-'));
  assert.equal(paths.length, 6);
  assert.equal(isUnpaidValidationControlsOnly(paths), true);
  assert.equal(checkMode(paths, 'same', 'same'), 'ci-only');
  assert.deepEqual(selectedParts(paths), ['guards']);
  const commands = JSON.stringify(unpaidValidationCommands('guards', paths));
  assert.match(commands, /online-checkout-resume-release.test.py/);
  assert.doesNotMatch(commands, /prisma|migrate|workspace|financial-integrity/);
  for (const extra of [
    'apps/api/src/id-business-v2/online-recharge/checkout-preparation.ts',
    'scripts/production-release/unreviewed-publication.py',
    'apps/api/prisma-mysql/schema.prisma'
  ])
    assert.equal(isUnpaidValidationControlsOnly([...paths, extra]), false);
});

test('persistent account browser candidate keeps complete engine checks without unrelated API/Admin or database work', () => {
  const paths = [
    ...persistentProfilePaths,
    'scripts/ci-unpaid-validation-scope.mjs',
    'scripts/ci-unpaid-validation-scope.test.mjs',
    'scripts/ci-recharge-scope.mjs'
  ];
  assert.equal(isPersistentProfileOnly(paths), true);
  assert.equal(checkMode(paths, 'same', 'same'), 'recharge');
  assert.deepEqual(selectedParts(paths), ['guards', 'online-engine']);
  for (const extra of [
    'apps/api/prisma-mysql/schema.prisma',
    'apps/admin/src/auth/session.ts',
    'apps/api/src/id-business-v2/online-recharge/engine/upstream/payment-retry.js'
  ])
    assert.equal(isPersistentProfileOnly([...paths, extra]), false);
  for (const required of persistentProfilePaths.filter((p) => p.startsWith('apps/')))
    assert.equal(isPersistentProfileOnly(paths.filter((p) => p !== required)), false);
  const guards = JSON.stringify(unpaidValidationCommands('guards', paths));
  assert.match(guards, /check:v2-module-architecture/);
  assert.match(guards, /test:online-recharge:controls/);
  assert.doesNotMatch(guards, /prisma|migrate|check:v2-color-contrast/);
  assert.match(
    JSON.stringify(unpaidValidationCommands('online-engine', paths)),
    /test:online-recharge:engine/
  );
  assert.equal(
    checkMode([...paths, 'apps/api/prisma-mysql/schema.prisma'], 'before', 'after'),
    'full'
  );
});

test('exact card read diagnostic repair requires API and complete engine checks', () => {
  const paths = [
    ...cardReadDiagnosticsPaths,
    'scripts/ci-unpaid-validation-scope.mjs',
    'scripts/ci-unpaid-validation-scope.test.mjs'
  ];
  assert.equal(isUnpaidValidationOnly(paths), true);
  assert.deepEqual(selectedParts(paths), ['guards', 'api', 'online-engine']);
  assert.equal(checkMode(paths, 'same', 'same'), 'recharge');
  assert.equal(checkMode(paths, 'before', 'after'), 'full');
  for (const p of cardReadDiagnosticsPaths.filter((p) => p.startsWith('apps/')))
    assert.equal(isUnpaidValidationOnly(paths.filter((n) => n !== p)), false);
  for (const extra of [
    'apps/api/prisma-mysql/schema.prisma',
    'apps/api/src/id-business-v2/online-recharge/engine/upstream/payment-retry.js',
    'apps/admin/src/auth/session.ts'
  ])
    assert.equal(isUnpaidValidationOnly([...paths, extra]), false);
  assert.match(JSON.stringify(unpaidValidationCommands('api', paths)), /typecheck/);
  assert.match(
    JSON.stringify(unpaidValidationCommands('online-engine', paths)),
    /test:online-recharge:engine/
  );
  assert.doesNotMatch(
    JSON.stringify(unpaidValidationCommands('guards', paths)),
    /check:admin-ui|migrate/
  );
});

test('card read diagnostic publication cannot include business files or skip its contract test', () => {
  const paths = unpaidValidationControls.filter((p) => p.includes('online-card-read-diagnostics-'));
  assert.equal(paths.length, 6);
  assert.equal(isUnpaidValidationControlsOnly(paths), true);
  assert.deepEqual(selectedParts(paths), ['guards']);
  assert.match(
    JSON.stringify(unpaidValidationCommands('guards', paths)),
    /online-card-read-diagnostics-release.test.py/
  );
  assert.throws(() => unpaidValidationCommands('api', paths));
  assert.equal(isUnpaidValidationControlsOnly([...paths, cardReadDiagnosticsPaths[0]]), false);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {
  profileLockRecoveryPaths,
  isProfileLockRecoveryOnly,
  cardReadDiagnosticsPaths,
  countryEvidencePaths,
  proxyFailureEvidencePaths,
  persistentProfilePaths,
  profileEgressLifecyclePaths,
  isProfileEgressLifecycleOnly,
  isPersistentProfileOnly,
  isUnpaidValidationControlsOnly,
  unpaidValidationPaths,
  checkoutResumePaths,
  unpaidValidationControls,
  isUnpaidValidationOnly,
  unpaidValidationCommands
} from './ci-unpaid-validation-scope.mjs';
import { checkMode, selectedParts, needsOnlineRechargeCiBuild } from './ci-recharge-scope.mjs';
test('offline profile recovery selects host guards and native browser tests only', () => {
  const paths = [
    ...profileLockRecoveryPaths,
    'scripts/ci-unpaid-validation-scope.mjs',
    'scripts/ci-unpaid-validation-scope.test.mjs',
    'scripts/ci-recharge-scope.mjs',
    'docs/ONLINE_RECHARGE.md',
    'docs/V2_TASKS.md'
  ];
  assert.equal(isProfileLockRecoveryOnly(paths), true);
  assert.equal(checkMode(paths, 'same', 'same'), 'recharge');
  assert.deepEqual(selectedParts(paths), ['guards', 'online-engine']);
  assert.equal(needsOnlineRechargeCiBuild(paths), false);
  const commands = JSON.stringify(
    selectedParts(paths).flatMap((part) => unpaidValidationCommands(part, paths))
  );
  for (const required of [
    'online-profile-lock-recovery.test.py',
    'online-profile-lock-continuity.test.mjs',
    'test/browser-profile.test.cjs',
    'online-checkout-release.test.py'
  ])
    assert.ok(commands.includes(required));
  assert.doesNotMatch(commands, /migrate|prisma|workspace.*api|financial|ffmpeg/);
  for (const missing of profileLockRecoveryPaths)
    assert.equal(isProfileLockRecoveryOnly(paths.filter((p) => p !== missing)), false);
  for (const extra of [
    'apps/api/prisma-mysql/schema.prisma',
    'apps/api/src/auth/session.ts',
    'apps/api/src/id-business-v2/online-recharge/engine/browser-profile.cjs',
    paths[0]
  ])
    assert.equal(isProfileLockRecoveryOnly([...paths, extra]), false);
  assert.throws(() => unpaidValidationCommands('api', paths));
  assert.equal(checkMode(paths, 'before', 'after'), 'full');
});
test('profile egress publication controls require their contract tests and cannot admit business input', () => {
  const paths = [
    '.github/workflows/online-profile-egress-publication.yml',
    ...['release.py', 'publication.py', 'build.py', 'release.test.py', 'contract.json'].map(
      (name) => 'scripts/production-release/online-profile-egress-' + name
    ),
    'scripts/ci-unpaid-validation-scope.mjs',
    'scripts/ci-unpaid-validation-scope.test.mjs'
  ];
  assert.equal(isUnpaidValidationControlsOnly(paths), true);
  assert.equal(checkMode(paths, 'same', 'same'), 'ci-only');
  assert.deepEqual(selectedParts(paths), ['guards']);
  assert.ok(
    JSON.stringify(unpaidValidationCommands('guards', paths)).includes(
      'online-profile-egress-release.test.py'
    )
  );
  assert.equal(isUnpaidValidationControlsOnly([...paths, profileEgressLifecyclePaths[0]]), false);
});
test('egress lifecycle batch checks Admin and full engine without an unrelated API or database job', () => {
  const paths = [
    ...profileEgressLifecyclePaths,
    'scripts/ci-unpaid-validation-scope.mjs',
    'scripts/ci-unpaid-validation-scope.test.mjs',
    'scripts/ci-recharge-scope.mjs'
  ];
  assert.equal(isProfileEgressLifecycleOnly(paths), true);
  assert.equal(isUnpaidValidationOnly(paths), true);
  assert.equal(checkMode(paths, 'same', 'same'), 'recharge');
  assert.deepEqual(selectedParts(paths), ['guards', 'admin', 'online-engine']);
  assert.equal(needsOnlineRechargeCiBuild(paths), false);
  const commands = JSON.stringify(
    selectedParts(paths).flatMap((part) => unpaidValidationCommands(part, paths))
  );
  for (const name of [
    'check:v2-loading-standard',
    'check:v2-ui-language',
    'check:admin-ui',
    'test:online-recharge:engine'
  ])
    assert.ok(commands.includes(name));
  assert.doesNotMatch(commands, /migrate|financial-integrity|prisma:mysql/);
  for (const missing of profileEgressLifecyclePaths.filter((p) => p.startsWith('apps/')))
    assert.equal(isProfileEgressLifecycleOnly(paths.filter((p) => p !== missing)), false);
  assert.equal(isProfileEgressLifecycleOnly([...paths, paths[0]]), false);
  assert.equal(
    isProfileEgressLifecycleOnly([...paths, 'apps/api/prisma-mysql/schema.prisma']),
    false
  );
  assert.equal(checkMode(paths, 'before', 'after'), 'full');
});
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

test('proxy failure evidence selects API Admin engine and all UI guardrails', () => {
  const paths = [
    ...proxyFailureEvidencePaths,
    'scripts/ci-unpaid-validation-scope.mjs',
    'scripts/ci-unpaid-validation-scope.test.mjs'
  ];
  assert.equal(isUnpaidValidationOnly(paths), true);
  assert.deepEqual(selectedParts(paths), ['guards', 'api', 'admin', 'online-engine']);
  for (const required of proxyFailureEvidencePaths.filter((p) => p.startsWith('apps/')))
    assert.equal(isUnpaidValidationOnly(paths.filter((p) => p !== required)), false);
  for (const extra of [
    'apps/api/prisma-mysql/schema.prisma',
    'apps/admin/src/auth/session.ts',
    'apps/api/src/id-business-v2/online-recharge/engine/upstream/payment-retry.js'
  ])
    assert.equal(isUnpaidValidationOnly([...paths, extra]), false);
  const guards = JSON.stringify(unpaidValidationCommands('guards', paths));
  for (const name of [
    'check:admin-ui',
    'check:v2-ui-language',
    'check:v2-color-contrast',
    'check:v2-table-standard',
    'check:v2-loading-standard',
    'check:v2-module-architecture',
    'check:v2-isolation'
  ])
    assert.ok(guards.includes(name));
  assert.equal(checkMode(paths, 'before', 'after'), 'full');
});

test('proxy failure publication is finite controls only and requires its contract tests', () => {
  const paths = unpaidValidationControls.filter((p) =>
    p.includes('online-proxy-failure-evidence-')
  );
  assert.equal(paths.length, 6);
  assert.equal(isUnpaidValidationControlsOnly(paths), true);
  assert.deepEqual(selectedParts(paths), ['guards']);
  assert.match(
    JSON.stringify(unpaidValidationCommands('guards', paths)),
    /online-proxy-failure-evidence-release.test.py/
  );
  assert.equal(isUnpaidValidationControlsOnly([...paths, proxyFailureEvidencePaths[0]]), false);
});

test('country evidence batch requires Admin API and engine checks without unrelated migration', () => {
  const paths = [
    ...countryEvidencePaths,
    'scripts/ci-unpaid-validation-scope.mjs',
    'scripts/ci-unpaid-validation-scope.test.mjs'
  ];
  assert.equal(isUnpaidValidationOnly(paths), true);
  assert.equal(checkMode(paths, 'same', 'same'), 'recharge');
  assert.deepEqual(selectedParts(paths), ['guards', 'api', 'admin', 'online-engine']);
  assert.equal(needsOnlineRechargeCiBuild(paths), false);
  const commands = JSON.stringify(
    selectedParts(paths).flatMap((part) => unpaidValidationCommands(part, paths))
  );
  for (const name of [
    'check:admin-ui',
    'check:v2-ui-language',
    'check:v2-loading-standard',
    'test:online-recharge:engine'
  ])
    assert.ok(commands.includes(name));
  assert.doesNotMatch(commands, /migrate|financial-integrity|verify:production/);
  for (const missing of countryEvidencePaths.filter((p) => p.startsWith('apps/')))
    assert.equal(isUnpaidValidationOnly(paths.filter((p) => p !== missing)), false);
  assert.equal(isUnpaidValidationOnly([...paths, paths[0]]), false);
  assert.equal(isUnpaidValidationOnly([...paths, 'apps/api/prisma-mysql/schema.prisma']), false);
});

test('country evidence publication is finite and keeps its contract test', () => {
  const paths = [
    '.github/workflows/online-country-evidence-publication.yml',
    ...['release.py', 'publication.py', 'build.py', 'release.test.py', 'contract.json'].map(
      (n) => 'scripts/production-release/online-country-evidence-' + n
    ),
    'scripts/ci-unpaid-validation-scope.mjs',
    'scripts/ci-unpaid-validation-scope.test.mjs'
  ];
  assert.equal(isUnpaidValidationControlsOnly(paths), true);
  assert.deepEqual(selectedParts(paths), ['guards']);
  assert.ok(
    JSON.stringify(unpaidValidationCommands('guards', paths)).includes(
      'online-country-evidence-release.test.py'
    )
  );
  assert.equal(isUnpaidValidationControlsOnly([...paths, countryEvidencePaths[0]]), false);
});

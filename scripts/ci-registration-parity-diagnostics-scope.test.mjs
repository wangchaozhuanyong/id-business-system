import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isRegistrationParityDiagnosticsOnly,
  isRegistrationParityDiagnosticsControlRepair,
  registrationParityDiagnosticsRepairBase,
  registrationParityDiagnosticsRepairTree,
  registrationParityDiagnosticsRepairPaths,
  registrationParityDiagnosticsBase as base,
  registrationParityDiagnosticsTree as baseTree,
  registrationParityDiagnosticsCurrent,
  registrationParityDiagnosticsApplications as applications,
  registrationParityDiagnosticsAcceptance as acceptance,
  registrationParityDiagnosticsContract as contractPath,
  registrationParityDiagnosticsControls as controls,
  registrationParityDiagnosticsPaths as paths
} from './ci-registration-parity-diagnostics-scope.mjs';

const fixture = () => {
  const hashes = Object.fromEntries(
    paths.filter((name) => name !== contractPath).map((name) => [name, 'a'.repeat(64)])
  );
  return {
    base,
    baseTree,
    sourceDigest: (name) => hashes[name],
    contract: {
      frozen: true,
      scope: 'REGISTRATION_PARITY_DIAGNOSTICS',
      sourceBaseline: base,
      sourceBaselineTree: baseTree,
      expectedCurrent: registrationParityDiagnosticsCurrent,
      migration: null,
      expectedGitChanges: [...paths],
      sourceDeltaPaths: [...registrationParityDiagnosticsRepairPaths],
      allowedApplicationPaths: [...applications],
      controlPaths: [...controls],
      sources: Object.fromEntries(applications.map((name) => [name, hashes[name]])),
      validationSources: { [acceptance]: hashes[acceptance] },
      reviewedFileHashes: hashes
    }
  };
};

test('only the new complete reviewed delta is admitted with its own source and runtime identity', () => {
  assert.equal(isRegistrationParityDiagnosticsOnly(paths, fixture()), true);
  assert.equal(
    isRegistrationParityDiagnosticsOnly(paths, { ...fixture(), base: 'a'.repeat(40) }),
    false
  );
  assert.equal(
    isRegistrationParityDiagnosticsOnly(paths, { ...fixture(), baseTree: 'b'.repeat(40) }),
    false
  );
});
test('every changed source test workflow dispatcher and guard digest is mandatory', () => {
  for (const name of paths) {
    assert.equal(
      isRegistrationParityDiagnosticsOnly(
        paths.filter((item) => item !== name),
        fixture()
      ),
      false,
      name
    );
    if (name !== contractPath)
      assert.equal(
        isRegistrationParityDiagnosticsOnly(paths, {
          ...fixture(),
          sourceDigest: (item) => (item === name ? '0'.repeat(64) : 'a'.repeat(64))
        }),
        false,
        name
      );
  }
  assert.equal(isRegistrationParityDiagnosticsOnly([...paths, paths[0]], fixture()), false);
  assert.equal(isRegistrationParityDiagnosticsOnly([], fixture()), false);
});
test('Sales schema credentials dependencies payment upstream and historical publishers stay outside the exception', () => {
  for (const name of [
    'apps/api/src/id-business-v2/auto-recharge/bank-recharge-account-sales.ts',
    'apps/api/prisma-mysql/schema.prisma',
    'apps/api/prisma-mysql/migrations/new/migration.sql',
    'apps/api/src/id-business-v2/auto-registration/upstream/src/core/register.py',
    'apps/api/src/id-business-v2/auto-recharge/worker/pay.py',
    '.env.aws.production',
    'package-lock.json',
    '.github/workflows/quality.yml',
    '.github/workflows/registration-closure-validation.yml',
    'scripts/production-release/registration-flow-evidence-contract.json',
    'scripts/ci-registration-flow-evidence-scope.mjs'
  ])
    assert.equal(isRegistrationParityDiagnosticsOnly([...paths, name], fixture()), false, name);
});
test('unfrozen missing malformed or mismatched review maps never enter the new exception', () => {
  for (const patch of [
    { frozen: false },
    { scope: 'REGISTRATION_FLOW_EVIDENCE' },
    { expectedCurrent: 'b'.repeat(40) },
    { sourceBaselineTree: 'c'.repeat(40) },
    { migration: 'new' },
    { expectedGitChanges: paths.slice(1) },
    { sourceDeltaPaths: registrationParityDiagnosticsRepairPaths.slice(1) },
    { controlPaths: controls.slice(1) },
    { allowedApplicationPaths: [...applications, 'foreign/path'] },
    { sources: {} },
    { validationSources: {} },
    { reviewedFileHashes: {} }
  ]) {
    const options = fixture();
    options.contract = { ...options.contract, ...patch };
    assert.equal(isRegistrationParityDiagnosticsOnly(paths, options), false, JSON.stringify(patch));
  }
  const options = fixture();
  options.contract.sources[applications[0]] = '0'.repeat(64);
  assert.equal(isRegistrationParityDiagnosticsOnly(paths, options), false);
  assert.equal(
    isRegistrationParityDiagnosticsOnly(paths, {
      ...fixture(),
      sourceDigest: () => {
        throw Error('absent');
      }
    }),
    false
  );
});

test('published successor repair admits only eleven controls while preserving the original complete freeze', () => {
  const options = {
    ...fixture(),
    base: registrationParityDiagnosticsRepairBase,
    baseTree: registrationParityDiagnosticsRepairTree
  };
  assert.equal(
    isRegistrationParityDiagnosticsControlRepair(registrationParityDiagnosticsRepairPaths, options),
    true
  );
  assert.equal(
    isRegistrationParityDiagnosticsOnly(registrationParityDiagnosticsRepairPaths, options),
    false
  );
  assert.equal(
    isRegistrationParityDiagnosticsControlRepair(registrationParityDiagnosticsRepairPaths, {
      ...fixture(),
      base: 'd44393c5bee8c30c82737fc3e00fa89785a95667'
    }),
    false
  );
  for (const changed of [
    registrationParityDiagnosticsRepairPaths.slice(1),
    [...registrationParityDiagnosticsRepairPaths, registrationParityDiagnosticsRepairPaths[0]],
    [...registrationParityDiagnosticsRepairPaths, applications[0]],
    [...registrationParityDiagnosticsRepairPaths, 'package-lock.json'],
    [
      ...registrationParityDiagnosticsRepairPaths,
      'scripts/production-release/account-login-release.py'
    ],
    [...registrationParityDiagnosticsRepairPaths, 'apps/api/prisma-mysql/schema.prisma'],
    [
      ...registrationParityDiagnosticsRepairPaths,
      '.github/workflows/registration-parity-diagnostics-validation.yml'
    ]
  ])
    assert.equal(isRegistrationParityDiagnosticsControlRepair(changed, options), false);
  for (const drift of [{ base: 'a'.repeat(40) }, { baseTree: 'b'.repeat(40) }])
    assert.equal(
      isRegistrationParityDiagnosticsControlRepair(registrationParityDiagnosticsRepairPaths, {
        ...options,
        ...drift
      }),
      false
    );
});

test('cwd repair still rejects any drift in the full application or validation freeze', () => {
  const options = {
    ...fixture(),
    base: registrationParityDiagnosticsRepairBase,
    baseTree: registrationParityDiagnosticsRepairTree
  };
  for (const name of paths.filter((item) => item !== contractPath))
    assert.equal(
      isRegistrationParityDiagnosticsControlRepair(registrationParityDiagnosticsRepairPaths, {
        ...options,
        sourceDigest: (item) => (item === name ? '0'.repeat(64) : 'a'.repeat(64))
      }),
      false,
      name
    );
  assert.equal(
    isRegistrationParityDiagnosticsControlRepair(registrationParityDiagnosticsRepairPaths, {
      ...options,
      contract: { ...options.contract, frozen: false }
    }),
    false
  );
  assert.equal(
    isRegistrationParityDiagnosticsControlRepair(registrationParityDiagnosticsRepairPaths, {
      ...options,
      contract: { ...options.contract, sources: {} }
    }),
    false
  );
});

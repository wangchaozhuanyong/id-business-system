import assert from 'node:assert/strict';
import test from 'node:test';
import {
  isRegistrationBrowserOnly,
  registrationBrowserBase as base,
  registrationBrowserTree as baseTree,
  registrationBrowserCurrent as current,
  registrationBrowserApplications as applications,
  registrationBrowserControls as controls,
  registrationBrowserPaths as paths,
  registrationBrowserReviewedPaths as reviewed,
  registrationBrowserContract as contractPath,
  registrationBrowserAcceptance as acceptance,
  registrationBrowserPythonTests,
  registrationBrowserCommands
} from './ci-registration-browser-scope.mjs';

const fixture = () => {
  const hashes = Object.fromEntries(
    reviewed.filter((name) => name !== contractPath).map((name) => [name, 'a'.repeat(64)])
  );
  return {
    base,
    baseTree,
    sourceDigest: (name) => hashes[name],
    contract: {
      version: 1,
      frozen: true,
      scope: 'REGISTRATION_BROWSER',
      sourceBaseline: base,
      sourceBaselineTree: baseTree,
      expectedCurrent: current,
      migration: null,
      expectedGitChanges: [...reviewed],
      sourceDeltaPaths: [...paths],
      allowedApplicationPaths: [...applications],
      controlPaths: [...controls],
      sources: Object.fromEntries(applications.map((name) => [name, hashes[name]])),
      validationSources: { [acceptance]: hashes[acceptance] },
      reviewedFileHashes: hashes
    }
  };
};

test('registration browser accepts only its fixed source base tree and actual 6fc runtime', () => {
  assert.equal(isRegistrationBrowserOnly(paths, fixture()), true);
  for (const changed of [{ base: 'a'.repeat(40) }, { baseTree: 'b'.repeat(40) }])
    assert.equal(isRegistrationBrowserOnly(paths, { ...fixture(), ...changed }), false);
});

test('registration browser every changed path and validation digest is mandatory', () => {
  for (const name of paths)
    assert.equal(
      isRegistrationBrowserOnly(
        paths.filter((item) => item !== name),
        fixture()
      ),
      false,
      name
    );
  for (const name of reviewed.filter((item) => item !== contractPath))
    assert.equal(
      isRegistrationBrowserOnly(paths, {
        ...fixture(),
        sourceDigest: (item) => (item === name ? '0'.repeat(64) : 'a'.repeat(64))
      }),
      false,
      name
    );
  assert.equal(isRegistrationBrowserOnly([...paths, paths[0]], fixture()), false);
  assert.equal(isRegistrationBrowserOnly([], fixture()), false);
  assert.equal(isRegistrationBrowserOnly([...paths, acceptance], fixture()), false);
});

test('registration browser excludes schema dependencies recharge upstream and frozen publishers', () => {
  for (const name of [
    'apps/api/prisma-mysql/schema.prisma',
    'apps/api/prisma-mysql/migrations/new/migration.sql',
    'package-lock.json',
    'apps/api/package.json',
    'apps/api/src/id-business-v2/auto-registration/worker/requirements.lock.txt',
    'apps/api/src/id-business-v2/auto-registration/upstream/src/core/register.py',
    'apps/api/src/id-business-v2/auto-recharge/auto-recharge.service.ts',
    'apps/admin/src/v2/features/auto-recharge/useAutoRecharge.ts',
    'scripts/production-release/registration-parity-diagnostics-build.py',
    'scripts/production-release/registration-flow-evidence-release.py',
    '.github/workflows/quality.yml'
  ])
    assert.equal(isRegistrationBrowserOnly([...paths, name], fixture()), false, name);
});

test('registration browser false freeze missing maps malformed hashes and source mismatches reject', () => {
  for (const changed of [
    { frozen: false },
    { version: 2 },
    { scope: 'REGISTRATION_PARITY_DIAGNOSTICS' },
    { expectedCurrent: 'a'.repeat(40) },
    { migration: {} },
    { expectedGitChanges: paths.slice(1) },
    { sourceDeltaPaths: paths.slice(1) },
    { allowedApplicationPaths: applications.slice(1) },
    { controlPaths: controls.slice(1) },
    { sources: {} },
    { validationSources: {} },
    { reviewedFileHashes: {} }
  ]) {
    const value = fixture();
    value.contract = { ...value.contract, ...changed };
    assert.equal(isRegistrationBrowserOnly(paths, value), false, JSON.stringify(changed));
  }
  const value = fixture();
  value.contract.sources[applications[0]] = 'b'.repeat(64);
  assert.equal(isRegistrationBrowserOnly(paths, value), false);
  assert.equal(
    isRegistrationBrowserOnly(paths, {
      ...fixture(),
      sourceDigest: () => {
        throw Error('missing');
      }
    }),
    false
  );
});

test('registration browser guards are pure and both control parts execute all seven UI rules', () => {
  for (const part of ['guards', 'release-controls']) {
    const commands = registrationBrowserCommands(part, paths);
    const install = commands.findIndex(
      (row) => row.join(' ') === 'npm ci --ignore-scripts --no-audit --no-fund'
    );
    const format = commands.findIndex((row) => row.includes('prettier'));
    if (part === 'release-controls') assert.ok(install >= 0 && format > install);
    else assert.equal(install, -1);
    for (const name of [
      'admin-ui',
      'v2-ui-language',
      'v2-color-contrast',
      'v2-table-standard',
      'v2-loading-standard',
      'v2-module-architecture',
      'v2-isolation'
    ])
      assert.ok(
        commands.some((row) => row.join(' ') === 'npm run check:' + name),
        name
      );
    assert.ok(
      commands.some((row) =>
        row.includes('scripts/production-release/registration-browser-release.test.py')
      )
    );
    assert.ok(
      commands.every(
        (row) =>
          !row.includes('auto-registration:setup') &&
          !row.includes('prisma:mysql:generate') &&
          !row.includes('build')
      )
    );
  }
});

test('registration browser API includes every real adapter persistence contract and connector suite', () => {
  const commands = registrationBrowserCommands('api', paths);
  assert.equal(registrationBrowserPythonTests.length, 10);
  for (const name of registrationBrowserPythonTests)
    assert.ok(
      commands.some((row) => row.includes('unittest') && row.includes(name)),
      name
    );
  assert.ok(commands.some((row) => row.includes('src/id-business-v2/auto-registration')));
  assert.ok(
    commands.some((row) => row.join(' ') === 'npm run build --workspace @apple-business/api')
  );
  assert.ok(
    commands.every(
      (row) => !row.some((arg) => /prisma:migrate|ci-recharge-migration|docker/.test(arg))
    )
  );
  assert.throws(
    () => registrationBrowserCommands('migration', paths),
    /Unsupported registration browser/
  );
});

test('registration browser Admin retains typecheck build unit tests and offline browser acceptance', () => {
  const commands = registrationBrowserCommands('admin', paths);
  assert.ok(
    commands.some((row) => row.join(' ') === 'npm run typecheck --workspace @apple-business/admin')
  );
  assert.ok(
    commands.some((row) => row.join(' ') === 'npm run build --workspace @apple-business/admin')
  );
  assert.ok(commands.some((row) => row.includes('src/v2/features/auto-registration')));
  assert.ok(commands.some((row) => row.includes(acceptance)));
  assert.ok(commands.every((row) => !row.includes('unittest')));
});

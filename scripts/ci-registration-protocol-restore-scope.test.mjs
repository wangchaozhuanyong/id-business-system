import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import {
  isRegistrationProtocolRestoreOnly,
  isRegistrationProtocolRestoreControlRepair,
  registrationProtocolRestoreRepairBase as repairBase,
  registrationProtocolRestoreRepairTree as repairTree,
  registrationProtocolRestoreRepairPaths as repairPaths,
  registrationProtocolRestoreRepairGuard as repairGuard,
  registrationProtocolRestoreBase as base,
  registrationProtocolRestoreTree as baseTree,
  registrationProtocolRestorePaths as paths,
  registrationProtocolRestoreRemovedSources as removed
} from './ci-registration-protocol-restore-scope.mjs';

function fixture() {
  const retained = paths.filter(
    (name) =>
      !(name in removed) &&
      name !== 'scripts/production-release/registration-protocol-restore-contract.json'
  );
  const reviewed = Object.fromEntries(retained.map((name) => [name, 'a'.repeat(64)]));
  const contract = {
    version: 1,
    expectedCurrent: '123ea34df9bf74a1d65e74bd70f336eaa9344165',
    schemaSha256: '51a4d25b1302458145f560acc32f25b89a7bd65fea64dc72b254dc56da430100',
    runtimeEvidence: { status: 'VERIFIED', commit: '123ea34df9bf74a1d65e74bd70f336eaa9344165' },
    frozen: true,
    scope: 'REGISTRATION_PROTOCOL_RESTORE',
    migration: null,
    sourceBaseline: base,
    sourceBaselineTree: baseTree,
    expectedGitChanges: [...paths],
    withdrawal: { sourceRemovals: { ...removed } },
    reviewedFileHashes: reviewed
  };
  return {
    base,
    baseTree,
    contract,
    sourceDigest: (name) => reviewed[name] ?? null,
    baseSourceDigest: (name) => removed[name] ?? null
  };
}

test('only the exact 42-path successor with all 14 known deletions is admitted', () => {
  assert.equal(paths.length, 42);
  assert.equal(Object.keys(removed).length, 14);
  assert.equal(isRegistrationProtocolRestoreOnly([...paths], fixture()), true);
});

test('extra app dependency schema or missing file is refused', () => {
  for (const extra of [
    'package-lock.json',
    'apps/api/prisma-mysql/schema.prisma',
    'apps/api/src/id-business-v2/online-recharge/admin.service.ts'
  ]) {
    assert.equal(isRegistrationProtocolRestoreOnly([...paths, extra], fixture()), false);
  }
  assert.equal(isRegistrationProtocolRestoreOnly(paths.slice(1), fixture()), false);
  assert.equal(isRegistrationProtocolRestoreOnly([...paths, paths[0]], fixture()), false);
});

test('each deleted file must be absent and its ancestor bytes must match', () => {
  const options = fixture();
  const first = Object.keys(removed)[0];
  assert.equal(
    isRegistrationProtocolRestoreOnly(paths, {
      ...options,
      sourceDigest: (name) => (name === first ? removed[name] : options.sourceDigest(name))
    }),
    false
  );
  assert.equal(
    isRegistrationProtocolRestoreOnly(paths, {
      ...options,
      baseSourceDigest: () => 'b'.repeat(64)
    }),
    false
  );
  delete options.contract.withdrawal.sourceRemovals[first];
  assert.equal(isRegistrationProtocolRestoreOnly(paths, options), false);
});

test('unfrozen contract wrong ancestor and mismatched retained hashes are refused', () => {
  for (const options of [
    { ...fixture(), base: '0'.repeat(40) },
    { ...fixture(), baseTree: '0'.repeat(40) },
    { ...fixture(), sourceDigest: () => 'b'.repeat(64) }
  ])
    assert.equal(isRegistrationProtocolRestoreOnly(paths, options), false);
  const options = fixture();
  options.contract.frozen = false;
  assert.equal(isRegistrationProtocolRestoreOnly(paths, options), false);
});

test('the real fixed ancestor contains exactly the declared deleted bytes', () => {
  assert.equal(
    execFileSync('git', ['rev-parse', base + '^{tree}'], { encoding: 'utf8' }).trim(),
    baseTree
  );
  for (const [name, expected] of Object.entries(removed)) {
    const bytes = execFileSync('git', ['show', base + ':' + name]);
    assert.equal(createHash('sha256').update(bytes).digest('hex'), expected);
  }
});

function repairFixture() {
  const options = fixture();
  const application = Object.fromEntries(
    Object.entries(options.contract.reviewedFileHashes).filter(([name]) => name.startsWith('apps/'))
  );
  const validation =
    'apps/api/src/id-business-v2/auto-registration/worker/test_registration_closed_loop_unit.py';
  options.contract.reviewedApplicationCommit = '2bcced63c834187ac5e69e344176da33ff82d4c9';
  options.contract.sources = { ...application };
  delete options.contract.sources[validation];
  options.contract.validationSources = { [validation]: application[validation] };
  options.contract.unchangedInputs = { 'package-lock.json': 'c'.repeat(64) };
  options.contract.validationBaselineSources = {
    'scripts/acceptance-v2-registration-parity-diagnostics.mjs': 'd'.repeat(64)
  };
  const repairBaseContract = structuredClone(options.contract);
  options.contract.validationBaselineSources = {
    ...options.contract.validationBaselineSources,
    ...repairGuard
  };
  return {
    ...options,
    base: repairBase,
    baseTree: repairTree,
    repairBaseContract,
    sourceDigest: (name) => repairGuard[name] ?? options.sourceDigest(name)
  };
}

test('the exact eight-control repair preserves the full original source closure', () => {
  assert.equal(repairPaths.length, 8);
  const options = repairFixture();
  assert.equal(isRegistrationProtocolRestoreControlRepair(repairPaths, options), true);
  assert.equal(isRegistrationProtocolRestoreOnly(repairPaths, options), false);
  assert.equal(isRegistrationProtocolRestoreControlRepair(paths, options), false);
  assert.equal(
    execFileSync('git', ['rev-parse', repairBase + '^{tree}'], { encoding: 'utf8' }).trim(),
    repairTree
  );
});

test('repair rejects missing duplicate extra business dependency schema and build paths', () => {
  for (const names of [
    repairPaths.slice(1),
    [...repairPaths, repairPaths[0]],
    ...[
      'apps/admin/src/v2/features/auto-registration/V2AppleMailboxes.vue',
      'apps/api/prisma-mysql/schema.prisma',
      'package-lock.json',
      'scripts/production-release/registration-protocol-restore-build.py'
    ].map((name) => [...repairPaths, name])
  ])
    assert.equal(isRegistrationProtocolRestoreControlRepair(names, repairFixture()), false);
  for (const change of [
    { base: base },
    { baseTree: baseTree },
    { sourceDigest: () => 'b'.repeat(64) },
    { baseSourceDigest: () => 'b'.repeat(64) }
  ])
    assert.equal(
      isRegistrationProtocolRestoreControlRepair(repairPaths, { ...repairFixture(), ...change }),
      false
    );
});

test('repair cannot rewrite the application anchor retained source or removed source facts', () => {
  for (const mutate of [
    (c) => {
      c.reviewedApplicationCommit = '0'.repeat(40);
    },
    (c) => {
      const key = Object.keys(c.sources)[0];
      c.sources[key] = 'b'.repeat(64);
      c.reviewedFileHashes[key] = 'b'.repeat(64);
    },
    (c) => {
      const key = Object.keys(c.validationSources)[0];
      c.validationSources[key] = 'b'.repeat(64);
    },
    (c) => {
      c.withdrawal.sourceRemovals[Object.keys(removed)[0]] = 'b'.repeat(64);
    },
    (c) => {
      c.unchangedInputs['package-lock.json'] = 'b'.repeat(64);
    },
    (c) => {
      c.reviewedFileHashes['.github/workflows/quality.yml'] = 'b'.repeat(64);
    }
  ]) {
    const options = repairFixture();
    mutate(options.contract);
    assert.equal(isRegistrationProtocolRestoreControlRepair(repairPaths, options), false);
  }
});

test('repair adds only the one published architecture guard with exact local bytes', () => {
  for (const mutate of [
    (c) => {
      delete c.validationBaselineSources[Object.keys(repairGuard)[0]];
    },
    (c) => {
      c.validationBaselineSources[Object.keys(repairGuard)[0]] = 'b'.repeat(64);
    },
    (c) => {
      c.validationBaselineSources['scripts/unreviewed-check.mjs'] = 'b'.repeat(64);
    },
    (c) => {
      c.validationBaselineSources['scripts/acceptance-v2-registration-parity-diagnostics.mjs'] =
        'b'.repeat(64);
    }
  ]) {
    const options = repairFixture();
    mutate(options.contract);
    assert.equal(isRegistrationProtocolRestoreControlRepair(repairPaths, options), false);
  }
  const options = repairFixture();
  assert.equal(
    isRegistrationProtocolRestoreControlRepair(repairPaths, {
      ...options,
      sourceDigest: (name) => (name in repairGuard ? 'b'.repeat(64) : options.sourceDigest(name))
    }),
    false
  );
});

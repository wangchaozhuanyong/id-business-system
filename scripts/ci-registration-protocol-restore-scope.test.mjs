import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import {
  isRegistrationProtocolRestoreOnly,
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
    expectedCurrent: '1c339754507f29459d17d75bb84afbee8fba5291',
    schemaSha256: '51a4d25b1302458145f560acc32f25b89a7bd65fea64dc72b254dc56da430100',
    runtimeEvidence: { status: 'VERIFIED', commit: '1c339754507f29459d17d75bb84afbee8fba5291' },
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

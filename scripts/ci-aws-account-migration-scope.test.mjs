import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const temporary = join(root, '.runtime', 'aws-account-migration-control-tests');
const modulePath = 'scripts/ci-aws-account-migration-scope.mjs';
const manifest = 'deploy/aws/account-migration-controls-20261024.json';
const base = 'a046d8413e3cb6c3edd6429dbdb922593dc32064';
const digest = raw => createHash('sha256').update(raw).digest('hex');

async function fixture(run, followup = false) {
  mkdirSync(temporary, { recursive: true });
  const directory = mkdtempSync(join(temporary, 'fixture-'));
  const files = followup ? {
    '.github/workflows/production-release.yml': 'role: target-account\n',
    'scripts/ci-recharge-check.mjs': '// readonly dispatcher fixture\n',
    'scripts/ci-aws-account-migration-scope.test.mjs': '// readonly scope fixture\n',
    'scripts/production-release/unpublished-component-runtime-diagnostic.test.py': '# readonly fixture\n'
  } : {
    '.github/workflows/production-release.yml': 'role: target-account\n',
    'scripts/production-release/release-storage.py': '# scoped controller fixture\n',
    'deploy/aws/release-artifact-storage-proof-20261024.json': '{"private":true}\n'
  };
  try {
    for (const [name, raw] of Object.entries(files)) {
      mkdirSync(dirname(join(directory, name)), { recursive: true });
      writeFileSync(join(directory, name), raw);
    }
    cpSync(join(root, modulePath), join(directory, modulePath));
    files[modulePath] = readFileSync(join(directory, modulePath));
    const record = { version: followup ? 2 : 1, sourceCommit: base, sourceAccount: '079740175286',
      targetAccount: '098208446664', files: Object.fromEntries(
        Object.entries(files).map(([name, raw]) => [name, digest(raw)])) };
    if (followup) record.controlBase = '9bf179b2c6dbf643404cf083171f7d3fee88944e';
    mkdirSync(dirname(join(directory, manifest)), { recursive: true });
    const save = () => writeFileSync(join(directory, manifest), JSON.stringify(record));
    save();
    const scope = await import(pathToFileURL(join(directory, modulePath)).href);
    const paths = [...Object.keys(files), manifest];
    await run({ directory, record, save, paths, check: scope.isAwsAccountMigrationControlsOnly });
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('only the exact recorded control bytes and source base are admitted', () => fixture(({ paths, check }) => {
  assert.equal(check(paths, { base }), true);
  assert.equal(check(paths, { base: 'f'.repeat(40) }), false);
  assert.equal(check(paths.filter(p => p !== manifest), { base }), false);
}));

test('a controller edit without an updated reviewed fingerprint is rejected', () => fixture(({ directory, paths, check }) => {
  writeFileSync(join(directory, 'scripts/production-release/release-storage.py'), '# drift\n');
  assert.equal(check(paths, { base }), false);
}));

test('business code cannot enter even with a matching manifest hash', () => fixture(({ directory, record, save, paths, check }) => {
  const name = 'apps/api/src/business.ts';
  mkdirSync(dirname(join(directory, name)), { recursive: true });
  writeFileSync(join(directory, name), 'export const changed = true;\n');
  record.files[name] = digest(readFileSync(join(directory, name))); save();
  assert.equal(check([...paths, name], { base }), false);
}));

test('a symlink with identical target bytes is rejected', () => fixture(({ directory, paths, check }) => {
  const name = join(directory, 'scripts/production-release/release-storage.py');
  const target = join(directory, 'preserved-fixture.txt');
  writeFileSync(target, readFileSync(name)); rmSync(name); symlinkSync(target, name);
  assert.equal(check(paths, { base }), false);
}));

test('missing, additional and duplicate changed paths are rejected', () => fixture(({ paths, check }) => {
  assert.equal(check(paths.slice(1), { base }), false);
  assert.equal(check([...paths, 'package.json'], { base }), false);
  assert.equal(check([...paths.slice(1), paths[1]], { base }), false);
}));

test('wrong account identity and malformed proof hashes are rejected', () => fixture(({ record, save, paths, check }) => {
  record.targetAccount = '000000000000'; save(); assert.equal(check(paths, { base }), false);
  record.targetAccount = '098208446664';
  record.files[Object.keys(record.files)[0]] = 'not-a-hash'; save();
  assert.equal(check(paths, { base }), false);
}));

const followupBase = '9bf179b2c6dbf643404cf083171f7d3fee88944e';
test('the exact merged migration parent admits only the pinned readonly follow-up', () => fixture(({ record, save, paths, check }) => {
  record.version = 2; record.controlBase = followupBase; save();
  assert.equal(check(paths, { base: followupBase }), true);
  assert.equal(check(paths, { base }), false);
}, true));
test('an unreviewed follow-up base or manifest version is rejected', () => fixture(({ record, save, paths, check }) => {
  record.version = 2; record.controlBase = 'f'.repeat(40); save();
  assert.equal(check(paths, { base: record.controlBase }), false);
  record.version = 3; record.controlBase = followupBase; save();
  assert.equal(check(paths, { base: followupBase }), false);
}, true));

test('readonly follow-up cannot admit another controller even when all hashes match', () => fixture(({ record, save, paths, check }) => {
  record.version = 2; record.controlBase = followupBase; save();
  assert.equal(check(paths, { base: followupBase }), false);
}));

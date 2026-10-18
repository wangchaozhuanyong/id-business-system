import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import test from 'node:test';
import {
  isFeatureRetirementOnly,
  isFeatureRetirementPermissionsRepair,
  retirementPermissionsPaths,
  retirementPermissionsBase
} from './ci-feature-retirement-scope.mjs';
import { checkMode, needsOnlineRechargeCiBuild } from './ci-recharge-scope.mjs';

const contractPath = 'scripts/production-release/feature-retirement-contract.json';
const c = JSON.parse(readFileSync(new URL('../' + contractPath, import.meta.url)));
const readFile = (name) => readFileSync(new URL('../' + name, import.meta.url));
const context = (value = c, overrides = {}) => ({
  readFile: (name) => (name === contractPath ? Buffer.from(JSON.stringify(value)) : readFile(name)),
  verifySource: () => true,
  ...overrides
});

test('only the pinned retirement source and dedicated verification recipe qualify', () => {
  assert.equal(isFeatureRetirementOnly(c.allowedPaths, context()), true);
  assert.equal(needsOnlineRechargeCiBuild(c.allowedPaths, context()), false);
  assert.equal(checkMode(c.allowedPaths), 'full');
});

test('unrelated and duplicated paths cannot suppress the historical image build', () => {
  for (const paths of [
    [],
    [contractPath],
    [...c.allowedPaths, 'apps/api/package.json'],
    [...c.allowedPaths, contractPath]
  ])
    assert.equal(isFeatureRetirementOnly(paths, context()), false);
});

test('real CI rename paths qualify only with the complete canonical source proof', () => {
  const renamed = execFileSync('git', ['diff', '--name-only', c.reviewBase, 'HEAD'], {
    cwd: new URL('../', import.meta.url),
    encoding: 'utf8'
  })
    .trim()
    .split('\n')
    .filter(Boolean);
  assert.ok(renamed.length < c.allowedPaths.length);
  assert.equal(isFeatureRetirementOnly(renamed, context()), true);
  assert.equal(needsOnlineRechargeCiBuild(renamed, context()), false);
  assert.equal(isFeatureRetirementOnly(renamed.slice(1), context()), false);
  assert.equal(isFeatureRetirementOnly([...renamed, 'unreviewed.cjs'], context()), false);
  assert.equal(isFeatureRetirementOnly(renamed, context(c, { verifySource: () => false })), false);
});

test('business source, original baselines and retirement boundaries remain fixed', () => {
  for (const mutate of [
    (v) => (v.sources[Object.keys(v.sources)[0]] = 'a'.repeat(64)),
    (v) => (v.apiSourceBaseline = 'a'.repeat(40)),
    (v) => (v.apiMainBase = 'a'.repeat(40)),
    (v) => (v.reviewBase = '--output=unreviewed'),
    (v) => (v.adminSourceBaseline = 'a'.repeat(40)),
    (v) => (v.scope = 'OTHER'),
    (v) => (v.backupCreated = true),
    (v) => (v.cleanupDataInRelease = true),
    (v) => (v.migrationPerformed = true),
    (v) => (v.businessActions = 1)
  ]) {
    const value = structuredClone(c);
    mutate(value);
    assert.equal(isFeatureRetirementOnly(value.allowedPaths, context(value)), false);
  }
});

test('ONLINE application changes still require their own image validation', () => {
  const value = structuredClone(c);
  value.allowedPaths.push('apps/api/src/id-business-v2/online-recharge/engine/worker.cjs');
  assert.equal(isFeatureRetirementOnly(value.allowedPaths, context(value)), false);
});

test('modified build verifier or workflow cannot qualify', () => {
  for (const changed of [
    'scripts/production-release/feature-retirement-build.py',
    '.github/workflows/feature-retirement-validation.yml'
  ])
    assert.equal(
      isFeatureRetirementOnly(
        c.allowedPaths,
        context(c, {
          readFile: (name) => (name === changed ? Buffer.from('changed') : context().readFile(name))
        })
      ),
      false
    );
});

test('source verification must succeed exactly and exceptions fail closed', () => {
  for (const value of [false, undefined, 0, 'true'])
    assert.equal(
      isFeatureRetirementOnly(c.allowedPaths, context(c, { verifySource: () => value })),
      false
    );
  assert.equal(
    isFeatureRetirementOnly(
      c.allowedPaths,
      context(c, {
        verifySource: () => {
          throw new Error('invalid');
        }
      })
    ),
    false
  );
  assert.equal(
    isFeatureRetirementOnly(c.allowedPaths, { readFile: () => Buffer.from('{') }),
    false
  );
});

const permissionsBaseline = JSON.parse(
  execFileSync('git', ['show', retirementPermissionsBase + ':' + contractPath], {
    encoding: 'utf8'
  })
);
const permissionsContext = (value = c, overrides = {}) =>
  context(value, {
    baselineContract: permissionsBaseline,
    changedFromPermissionsBase: () => [...retirementPermissionsPaths],
    ...overrides
  });
test('exact directory permission control repair retains the accepted application inputs', () => {
  assert.equal(
    isFeatureRetirementPermissionsRepair(retirementPermissionsPaths, permissionsContext()),
    true
  );
  assert.equal(
    checkMode(retirementPermissionsPaths, '', '', undefined, permissionsContext()),
    'ci-only'
  );
  assert.equal(needsOnlineRechargeCiBuild(retirementPermissionsPaths, permissionsContext()), false);
});
test('permission repair refuses unrelated source, omitted controls and changed build boundaries', () => {
  for (const paths of [
    retirementPermissionsPaths.slice(1),
    [...retirementPermissionsPaths, 'apps/api/src/main.ts'],
    [...retirementPermissionsPaths, contractPath]
  ]) {
    assert.equal(isFeatureRetirementPermissionsRepair(paths, permissionsContext()), false);
  }
  for (const mutate of [
    (v) => (v.sources[Object.keys(v.sources)[0]] = '0'.repeat(64)),
    (v) => (v.backupCreated = true),
    (v) => (v.expectedCurrent = '0'.repeat(40)),
    (v) => (v.databaseVerification = {})
  ]) {
    const value = structuredClone(c);
    mutate(value);
    assert.equal(
      isFeatureRetirementPermissionsRepair(retirementPermissionsPaths, permissionsContext(value)),
      false
    );
  }
});
test('permission repair fails closed on controller, checked-out tree or complete source proof drift', () => {
  for (const name of [
    'scripts/production-release/feature-retirement-release.py',
    'scripts/ci-recharge-check.mjs'
  ]) {
    assert.equal(
      isFeatureRetirementPermissionsRepair(
        retirementPermissionsPaths,
        permissionsContext(c, {
          readFile: (p) => (p === name ? Buffer.from('unreviewed') : context().readFile(p))
        })
      ),
      false
    );
  }
  assert.equal(
    isFeatureRetirementPermissionsRepair(
      retirementPermissionsPaths,
      permissionsContext(c, { changedFromPermissionsBase: () => ['unrelated'] })
    ),
    false
  );
  assert.equal(
    isFeatureRetirementPermissionsRepair(
      retirementPermissionsPaths,
      permissionsContext(c, { verifySource: () => false })
    ),
    false
  );
});

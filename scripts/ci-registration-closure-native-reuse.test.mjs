import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import {
  registrationNativeBinding as pinned,
  registrationNativeIntegrations,
  registrationNativeRepairPins,
  validateRegistrationNativeEvidence,
  validateRegistrationNativeRepair
} from './ci-registration-closure-native-reuse.mjs';
import { checkMode, selectedParts } from './ci-recharge-scope.mjs';
import { isRegistrationClosurePaths } from './ci-registration-closure-scope.mjs';

const digest = (raw) => createHash('sha256').update(raw).digest('hex');
function native() {
  const b = structuredClone(pinned);
  const tail =
    '\nRan 584 tests in 211.625s\nℹ tests 13\nℹ pass 11\nℹ fail 2\n' +
    'ReferenceError: useAuthStore is not defined\nbank-recharge-registration-mirror.service.ts:419\n' +
    'Error: Command failed: npm run test:online-recharge:controls\nscripts/ci-recharge-check.mjs:799:5\n';
  const logs = Object.fromEntries(
    Object.keys(b.jobs).map((part) => [
      part,
      Buffer.from(
        '\uFEFF2026-10-15T21:39:00Z git log -1 --format=%H\n2026-10-15T21:39:00Z ' +
          b.checkout +
          (part === 'guards' ? tail : '\n')
      )
    ])
  );
  b.rawLogs = Object.fromEntries(Object.entries(logs).map(([part, raw]) => [part, digest(raw)]));
  const run = {
    id: b.run,
    run_attempt: b.attempt,
    head_sha: b.head,
    event: 'pull_request',
    path: '.github/workflows/quality.yml',
    head_branch: b.branch,
    status: 'completed',
    conclusion: 'failure',
    repository: { full_name: b.repository },
    pull_requests: [{ number: b.pullRequest, base: { sha: b.base } }]
  };
  const jobs = Object.entries(b.jobs).map(([part, id]) => ({
    id,
    run_id: b.run,
    run_attempt: b.attempt,
    head_sha: b.head,
    name: `recharge (${part})`,
    status: 'completed',
    conclusion: part === 'guards' ? 'failure' : 'success',
    steps: [
      { name: 'Checkout', status: 'completed', conclusion: 'success' },
      { name: 'Install package dependencies', status: 'completed', conclusion: 'success' },
      { name: 'Report reused passing check', status: 'completed', conclusion: 'skipped' },
      {
        name: 'Check affected recharge part',
        status: 'completed',
        conclusion: part === 'guards' ? 'failure' : 'success'
      }
    ]
  }));
  return {
    b,
    input: {
      run,
      jobs,
      logs,
      checkout: {
        sha: b.checkout,
        tree: { sha: b.tree },
        parents: [{ sha: b.base }, { sha: b.head }]
      }
    }
  };
}

test('native PR520 evidence retains only successful parts and an authenticated failed guard prefix', () => {
  const { b, input } = native();
  assert.equal(validateRegistrationNativeEvidence(input, b), true);
  for (const mutate of [
    (v) => v.run.id++,
    (v) => v.run.run_attempt++,
    (v) => (v.run.head_sha = 'a'.repeat(40)),
    (v) => (v.run.path = '.github/workflows/production-release.yml'),
    (v) => (v.run.repository.full_name = 'other/repo'),
    (v) => (v.run.conclusion = 'success'),
    (v) => v.run.pull_requests[0].number++,
    (v) => (v.checkout.tree.sha = 'a'.repeat(40)),
    (v) => v.checkout.parents.reverse(),
    (v) => (v.jobs[1].conclusion = 'failure'),
    (v) => (v.jobs[0].steps[2].conclusion = 'success'),
    (v) => v.jobs.push(v.jobs[1]),
    (v) => (v.logs.guards = Buffer.concat([v.logs.guards, Buffer.from('\n')])),
    (v) => (v.logs.api = Buffer.from('NOT_ORIGINAL_NATIVE_LOG')),
    (v) => v.jobs[0].steps.push({ name: 'another failure', conclusion: 'failure' })
  ]) {
    const value = native();
    mutate(value.input);
    assert.equal(
      validateRegistrationNativeEvidence(value.input, value.b),
      false,
      mutate.toString()
    );
  }
  assert.equal(
    validateRegistrationNativeEvidence(input),
    false,
    'synthetic logs cannot satisfy pinned native hashes'
  );
});

function repair() {
  const contract = 'scripts/production-release/registration-closure-contract.json';
  const paths = [
    ...Object.keys(registrationNativeRepairPins),
    ...Object.keys(registrationNativeIntegrations),
    contract,
    'scripts/ci-registration-closure-native-reuse.mjs'
  ];
  const after = Object.fromEntries([...new Set(paths)].map((path) => [path, readFileSync(path)]));
  const before = Object.fromEntries(
    Object.keys(after)
      .filter(
        (path) =>
          !path.endsWith('-native-reuse.mjs') &&
          !path.endsWith('-native-reuse.test.mjs') &&
          !path.endsWith('decimal-standard.test.mjs')
      )
      .map((path) => [path, execFileSync('git', ['show', pinned.head + ':' + path])])
  );
  const changed = Object.keys(after);
  const modes = Object.fromEntries(
    changed.map((path) => [path, { before: before[path] ? '100644' : null, after: '100644' }])
  );
  return {
    changed,
    modes,
    before: (path) => before[path],
    after: (path) => after[path],
    beforeMap: before,
    afterMap: after
  };
}

test('exact repaired source pins preserve every app workflow lock and complete contract field', () => {
  assert.ok(Object.keys(registrationNativeRepairPins).length >= 5);
  const input = repair();
  assert.equal(validateRegistrationNativeRepair(input), true);
  for (const path of [
    'apps/api/src/id-business-v2/online-recharge/public.controller.ts',
    'apps/admin/src/v2/features/online-recharge/OnlineResultDialog.vue',
    'packages/shared/src/index.ts',
    '.github/workflows/quality.yml',
    'package-lock.json',
    'apps/api/prisma-mysql/schema.prisma',
    'scripts/ci-registration-closure-native-reuse-extra.mjs'
  ]) {
    const v = repair();
    v.changed.push(path);
    v.modes[path] = { before: '100644', after: '100644' };
    assert.equal(validateRegistrationNativeRepair(v), false, path);
  }
  for (const path of Object.keys(registrationNativeRepairPins)) {
    const v = repair();
    v.afterMap[path] = Buffer.from('UNREVIEWED');
    assert.equal(validateRegistrationNativeRepair(v), false, path);
  }
  for (const path of Object.keys(registrationNativeIntegrations)) {
    const v = repair();
    v.afterMap[path] = Buffer.concat([v.afterMap[path], Buffer.from('\n')]);
    assert.equal(validateRegistrationNativeRepair(v), false, path);
  }
  for (const mutate of [
    (c) => (c.current = '/another'),
    (c) => (c.changedSources.unknown = 'a'.repeat(64)),
    (c) => (c.validationSources['scripts/unknown.mjs'] = 'a'.repeat(64)),
    (c) => (c.services = {})
  ]) {
    const v = repair();
    const path = 'scripts/production-release/registration-closure-contract.json';
    const c = JSON.parse(v.afterMap[path]);
    mutate(c);
    v.afterMap[path] = Buffer.from(JSON.stringify(c));
    assert.equal(validateRegistrationNativeRepair(v), false, mutate.toString());
  }
  const mode = repair();
  mode.modes[mode.changed[0]].after = '100755';
  assert.equal(validateRegistrationNativeRepair(mode), false);
});

test('dispatcher continuation retains the original failed command and the complete original guard tail', () => {
  const path = 'scripts/ci-recharge-check.mjs';
  const old = execFileSync('git', ['show', pinned.head + ':' + path], { encoding: 'utf8' });
  const start = old.indexOf(
    '  const uiChecks = adminUiGuardChecks(mode, changed);',
    old.indexOf("} else if (part === 'guards') {")
  );
  const end = old.indexOf("\n} else if (part === 'release-controls') {", start);
  const tail = old
    .slice(start, end)
    .split('\n')
    .map((line) => '  ' + line)
    .join('\n');
  assert.ok(registrationNativeIntegrations[path].addition.includes(tail));
  for (const path of [
    'scripts/ci-registration-closure-native-reuse.mjs',
    'scripts/check-v2-decimal-standard.mjs',
    'scripts/check-v2-decimal-standard.test.mjs'
  ]) {
    assert.equal(checkMode([path], '', ''), 'ci-only');
    assert.deepEqual(selectedParts([path]), ['guards']);
    assert.equal(isRegistrationClosurePaths([path, 'apps/api/src/auth/auth.service.ts']), false);
  }
  assert.equal(checkMode(['scripts/check-v2-online-recharge-controls.test.mjs'], '', ''), 'admin');
});

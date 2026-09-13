import assert from 'node:assert/strict';
import test from 'node:test';
import {
  affectsPart,
  isRechargeOnly,
  matchingRun,
  canReuseMain,
  isCiOnly,
  isTargetedOnly,
  selectedParts
} from './ci-recharge-scope.mjs';
import { matchesSourceEvidence } from './ci-recharge-evidence.mjs';

const schema =
  'model Other { id String }\nmodel IdBusinessV2RechargeBrowserSetting { ownerId String }\n';
const files = [
  'apps/admin/src/v2/features/auto-recharge/example.vue',
  'apps/api/prisma-mysql/schema.prisma'
];
test('CI-only repairs do not select application or migration suites', () => {
  assert.equal(
    isCiOnly(['.github/workflows/quality.yml', 'scripts/ci-recharge-evidence.mjs']),
    true
  );
  assert.equal(isCiOnly(['.github/workflows/quality.yml', files[0]]), false);
  assert.equal(isCiOnly([]), false);
});
test('immutable source evidence survives a cleared PR association and rejects mismatches', () => {
  const run = { id: 42, run_attempt: 1, pull_requests: [] };
  const pr = { number: 192, head: { sha: 'head' } };
  const proof = {
    repository: 'owner/repo',
    runId: 42,
    runAttempt: 1,
    pullRequest: 192,
    headSha: 'head',
    baseSha: 'a'.repeat(40),
    testedTree: 'tree'
  };
  const expected = { repo: 'owner/repo', run, pr, tree: 'tree' };
  assert.equal(matchesSourceEvidence(proof, expected), true);
  for (const change of [
    { repository: 'other/repo' },
    { runId: 43 },
    { runAttempt: 2 },
    { pullRequest: 191 },
    { headSha: 'other' },
    { testedTree: 'different' }
  ]) {
    assert.equal(matchesSourceEvidence({ ...proof, ...change }, expected), false);
  }
});
test('main reuse rejects a different tree or an incomplete required gate', () => {
  assert.equal(canReuseMain('tree', 'tree', [{ name: 'quality', conclusion: 'success' }]), true);
  assert.equal(canReuseMain('old', 'new', [{ name: 'quality', conclusion: 'success' }]), false);
  assert.equal(canReuseMain('tree', 'tree', [{ name: 'quality', conclusion: 'failure' }]), false);
  assert.equal(
    canReuseMain('tree', 'tree', [{ name: 'recharge (api)', conclusion: 'success' }]),
    false
  );
  assert.equal(canReuseMain('tree', 'tree', []), false);
});
test('recharge settings schema changes stay scoped but other model changes do not', () => {
  assert.equal(
    isRechargeOnly(files, schema, schema.replace('ownerId String', 'ownerId String extra Json?')),
    true
  );
  assert.equal(isRechargeOnly(files, schema, schema.replace('id String', 'id Int')), false);
  assert.equal(
    isRechargeOnly([...files, 'apps/api/src/auth/auth.service.ts'], schema, schema),
    false
  );
  assert.equal(
    isRechargeOnly(
      [...files, 'apps/api/prisma-mysql/migrations/other/migration.sql'],
      schema,
      schema
    ),
    false
  );
  assert.equal(isRechargeOnly([], schema, schema), false);
});
test('a frontend-only fix retains API and connector evidence', () => {
  const changed = [files[0]];
  assert.equal(affectsPart('guards', changed), true);
  assert.equal(affectsPart('admin', changed), true);
  for (const part of ['api', 'connector', 'migration'])
    assert.equal(affectsPart(part, changed), false);
  for (const part of ['guards', 'admin', 'api', 'connector', 'migration']) {
    assert.equal(affectsPart(part, ['.github/workflows/quality.yml']), true);
    assert.equal(affectsPart(part, ['scripts/ci-recharge-check.mjs']), true);
  }
});
test('evidence is bound to the same PR, source SHA and workflow', () => {
  const run = {
    event: 'pull_request',
    path: '.github/workflows/quality.yml',
    status: 'completed',
    head_sha: 'abc',
    pull_requests: [{ number: 191, head: { sha: 'abc' } }]
  };
  assert.equal(matchingRun(run, 191, 'abc'), true);
  assert.equal(matchingRun(run, 192, 'abc'), false);
  assert.equal(matchingRun(run, 191, 'def'), false);
  assert.equal(matchingRun({ ...run, event: 'push' }, 191, 'abc'), false);
  assert.equal(matchingRun({ ...run, path: 'other.yml' }, 191, 'abc'), false);
  assert.equal(matchingRun({ ...run, status: 'in_progress' }, 191, 'abc'), false);
});

test('combined security and retry release selects affected modules without a migration run', () => {
  const changed = [
    'apps/api/src/auth/auth.service.ts',
    'apps/api/src/id-business-v2/auto-recharge/worker/bitbrowser_retry.py',
    'apps/api/src/id-business-v2/workspace/media-resolver/Dockerfile',
    'packages/shared/src/v2/auto-recharge.ts',
    '.github/workflows/quality.yml'
  ];
  assert.equal(isTargetedOnly(changed, schema, schema), true);
  assert.deepEqual(selectedParts(changed), ['guards', 'admin', 'api', 'connector', 'security']);
  assert.equal(
    isTargetedOnly([...changed, 'apps/api/src/auth/auth.controller.ts'], schema, schema),
    false
  );
  assert.equal(
    isTargetedOnly([...changed, 'apps/api/prisma-mysql/schema.prisma'], schema, schema),
    false
  );
  assert.deepEqual(selectedParts([files[0]]), ['guards', 'admin']);
});

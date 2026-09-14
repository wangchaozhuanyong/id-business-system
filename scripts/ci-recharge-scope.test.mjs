import { imageInputsChanged } from './ci-recharge-python-image.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import {
  affectsPart,
  isRechargeOnly,
  matchingRun,
  canReuseMain,
  isCiOnly,
  isMailboxOnly,
  isTargetedOnly,
  selectedParts,
  checkMode,
  adminCheckCommands
} from './ci-recharge-scope.mjs';
import { matchesSourceEvidence } from './ci-recharge-evidence.mjs';

const schema =
  'model Other { id String }\nmodel IdBusinessV2RechargeBrowserSetting { ownerId String }\n';
const files = [
  'apps/admin/src/v2/features/auto-recharge/example.vue',
  'apps/api/prisma-mysql/schema.prisma'
];
test('documentation and CI selectors do not start business or database checks', () => {
  for (const path of ['docs/V2_TASKS.md', 'AGENTS.md', 'README.md', 'scripts/ci-change-scope.mjs'])
    assert.equal(checkMode([path], schema, schema), 'ci-only');
  for (const path of [
    'package-lock.json',
    'apps/api/prisma-mysql/schema.prisma',
    'apps/api/src/auth/auth.controller.ts'
  ])
    assert.equal(checkMode([path], schema, schema), 'full');
});
test('ordinary admin modules use frontend checks instead of backend and financial suites', () => {
  const paths = ['apps/admin/src/v2/features/orders/Orders.vue', 'docs/V2_TASKS.md'];
  assert.equal(checkMode(paths, schema, schema), 'admin');
  const commands = adminCheckCommands('admin', paths);
  assert.deepEqual(commands, [
    ['run', 'build', '--workspace', '@apple-business/shared'],
    ['run', 'test', '--workspace', '@apple-business/admin'],
    ['run', 'build', '--workspace', '@apple-business/admin']
  ]);
  assert.ok(
    adminCheckCommands('admin', [...paths, files[0]]).some((args) =>
      args.includes('acceptance:v2-auto-recharge')
    )
  );
  assert.equal(
    checkMode([...paths, 'apps/api/src/id-business-v2/orders/order.service.ts'], schema, schema),
    'full'
  );
  assert.equal(checkMode(['apps/admin/src/auth/login.ts'], schema, schema), 'full');
  assert.equal(checkMode([files[0]], schema, schema), 'recharge');
});
test('Vendure mailbox integration runs only its shared, admin, API and guard checks', () => {
  const paths = [
    '.env.example',
    '.env.aws.production.example',
    'docker-compose.aws-mysql.yml',
    'apps/admin/src/api/requestPolicy.ts',
    'apps/admin/src/v2/features/auto-recharge/VendureMailboxManager.vue',
    'apps/api/src/id-business-v2/workspace/id-business-v2-vendure-mailbox.service.ts',
    'apps/api/src/id-business-v2/workspace/providers/id-business-v2-vendure-mailbox.client.ts',
    'packages/shared/src/v2/vendure-mailbox.ts',
    'docs/V2_VENDURE_MAILBOX_INTEGRATION.md',
    '.github/workflows/quality.yml',
    'scripts/ci-recharge-check.mjs',
    'scripts/ci-recharge-scope.mjs'
  ];
  assert.equal(isMailboxOnly(paths), true);
  assert.equal(checkMode(paths, schema, schema), 'mailbox');
  assert.deepEqual(adminCheckCommands('mailbox', paths), [
    ['run', 'build', '--workspace', '@apple-business/shared'],
    [
      'run',
      'test',
      '--workspace',
      '@apple-business/admin',
      '--',
      'src/api/requestPolicy.spec.ts',
      'src/v2/features/registry.spec.ts',
      'src/v2/features/auto-recharge/vendure-mailbox-ui.contract.spec.ts'
    ],
    ['run', 'build', '--workspace', '@apple-business/admin']
  ]);
  assert.equal(
    isMailboxOnly([...paths, 'apps/api/src/id-business-v2/orders/order.service.ts']),
    false
  );
});
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

test('CI selector and Python-only changes retain unrelated API and frontend checks', () => {
  const changed = [
    'scripts/ci-recharge-scope.mjs',
    'scripts/ci-recharge-python-image.mjs',
    'apps/api/src/id-business-v2/auto-recharge/worker/test_connector_health.py'
  ];
  assert.equal(affectsPart('api', changed), false);
  assert.equal(affectsPart('admin', changed), false);
  assert.equal(affectsPart('connector', changed), true);
});

test('image reuse requires unchanged complete inputs of that service', () => {
  assert.equal(
    imageInputsChanged('media-resolver', [
      'apps/api/src/id-business-v2/auto-recharge/worker/test_connector_health.py'
    ]),
    false
  );
  assert.equal(
    imageInputsChanged('auto-recharge', [
      'apps/api/src/id-business-v2/auto-recharge/worker/test_connector_health.py'
    ]),
    true
  );
  for (const service of ['media-resolver', 'auto-recharge']) {
    assert.equal(imageInputsChanged(service, ['scripts/audit-python-dependencies.py']), true);
    assert.equal(imageInputsChanged(service, ['docs/V2_TASKS.md']), false);
  }
});

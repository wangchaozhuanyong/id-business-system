import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  assertPreviewExecutionContext,
  isolatedPreviewEnvironment,
  redactPreviewOutput,
  previewServerTimings,
  seedPreviewRows,
  waitForPreviewService,
  PREVIEW_BRANCH
} from './lib/interaction-preview-runtime.mjs';
import {
  verifyPreviewEvidence,
  PRIOR_PREVIEW_COMMIT
} from './lib/interaction-preview-evidence.mjs';

const project = process.cwd();
const context = {
  GITHUB_ACTIONS: 'true',
  GITHUB_REPOSITORY: 'wangchaozhuanyong/id-business-system',
  GITHUB_REF: PREVIEW_BRANCH,
  GITHUB_WORKSPACE: project
};
test('fixture seeding refuses a database outside the caller-owned instance before importing a client', async () => {
  const owned = {
    port: 12345,
    database: 'id_business_v2_interaction_test',
    rootPassword: 'synthetic-owner-value'
  };
  await assert.rejects(
    seedPreviewRows(
      project,
      {
        DATABASE_URL:
          'mysql://root:synthetic-owner-value@invalid.invalid:12345/id_business_v2_interaction_test'
      },
      owned
    )
  );
  await assert.rejects(
    seedPreviewRows(
      project,
      { DATABASE_URL: 'mysql://root:synthetic-owner-value@127.0.0.1:12345/another_database' },
      owned
    )
  );
});
test('runtime refuses local machines, main, other repositories and inherited live connections', () => {
  assert.doesNotThrow(() => assertPreviewExecutionContext(context, project));
  for (const extra of [
    { GITHUB_ACTIONS: undefined },
    { GITHUB_REF: 'refs/heads/main' },
    { GITHUB_REPOSITORY: 'other/repo' },
    { DATABASE_URL: 'mysql://invalid.invalid/live' },
    { AWS_WEB_IDENTITY_TOKEN_FILE: '/not-a-real-token' },
    { DOCKER_HOST: 'tcp://invalid.invalid' }
  ])
    assert.throws(() => assertPreviewExecutionContext({ ...context, ...extra }, project));
});
test('child environment uses fresh credentials, loopback services and no caller secrets', () => {
  const a = isolatedPreviewEnvironment({
    PATH: '/bin',
    AWS_SECRET_ACCESS_KEY: 'not-a-real-secret',
    DATABASE_URL: 'mysql://invalid.invalid/live',
    SEED_ADMIN_PASSWORD: 'caller-placeholder',
    UNKNOWN_SETTING: 'live'
  });
  const b = isolatedPreviewEnvironment({ PATH: '/bin' });
  assert.equal(a.AWS_SECRET_ACCESS_KEY, undefined);
  assert.equal(a.DATABASE_URL, undefined);
  assert.equal(a.UNKNOWN_SETTING, undefined);
  assert.notEqual(a.SEED_ADMIN_PASSWORD, 'caller-placeholder');
  assert.notEqual(a.SEED_ADMIN_PASSWORD, b.SEED_ADMIN_PASSWORD);
  assert.equal(a.ID_BUSINESS_V2_EXCHANGE_RATE_AUTO_ENABLED, 'false');
  assert.equal(a.VITE_DEV_API_PROXY_TARGET, 'http://127.0.0.1:5300');
});
test('artifact logs redact credentials and connection strings', () => {
  const output = redactPreviewOutput(
    'synthetic-value mysql://example.invalid/db Bearer synthetic-authorization',
    ['synthetic-value']
  );
  assert.equal(output.includes('synthetic-value'), false);
  assert.equal(output.includes('example.invalid'), false);
  assert.equal(output.includes('synthetic-authorization'), false);
  assert.equal(
    redactPreviewOutput('{"passwordHash":"synthetic-hash"}').includes('synthetic-hash'),
    false
  );
});
test('Server-Timing keeps known numeric durations and excludes descriptions or custom keys', () => {
  assert.deepEqual(
    previewServerTimings('db;dur=12.5;desc="synthetic-secret", customer-123;dur=8, app;dur=4'),
    [
      { metric: 'db', duration: 12.5 },
      { metric: 'app', duration: 4 }
    ]
  );
});
test('readiness requires the owning API readiness response and fails fast on incorrect paths', async () => {
  let calls = 0;
  const request = async () => {
    calls++;
    return new Response(
      JSON.stringify({ success: true, data: { status: 'ready', database: 'ok' } }),
      { status: 200 }
    );
  };
  await assert.rejects(
    waitForPreviewService('http://127.0.0.1:5300/api/branding/public', { request, attempts: 1 })
  );
  assert.equal(calls, 0);
  await waitForPreviewService('http://127.0.0.1:5300/api/health/ready', { request });
  assert.equal(calls, 1);
  await assert.rejects(
    waitForPreviewService('http://127.0.0.1:5300/api/health/ready', {
      request: async () => new Response('', { status: 404 })
    })
  );
});
test('prior successful checks are reused only when application inputs are unchanged', async () => {
  const env = { ...context, GITHUB_SHA: 'a'.repeat(40) };
  const request = async (url) =>
    new Response(
      JSON.stringify(
        url.includes('/jobs?')
          ? {
              jobs: [
                {
                  started_at: '2026-11-03T00:00:00Z',
                  completed_at: '2026-11-03T00:05:00Z',
                  steps: [
                    'Admin tests and isolated runtime controls',
                    'Build API and production admin',
                    'UI and architecture controls'
                  ].map((name) => ({ name, conclusion: 'success' }))
                }
              ]
            }
          : {
              head_sha: url.includes('/41607976951')
                ? '837a1cb7310dcd92b6c4c70d0f746a6864b13fc9'
                : url.includes('/41606386434')
                  ? '3be4ae9416c6f30eb56ce8a6a117f7c0359d0984'
                  : url.includes('/41604661799')
                    ? '0cb89de9a6a3bedb3dfbf12655609ec853be7e2e'
                    : PRIOR_PREVIEW_COMMIT,
              conclusion: url.includes('/41606386434') ? 'success' : 'failure'
            }
      ),
      { status: 200 }
    );
  const evidence = await verifyPreviewEvidence(env, project, {
    request,
    changedPaths: () => ['scripts/acceptance-v2-interaction-ci.mjs']
  });
  assert.equal(evidence.reusedChecks.length, 3);
  const changedApplication = await verifyPreviewEvidence(env, project, {
    request,
    changedPaths: () => ['apps/admin/src/v2/components/V2Table.vue']
  });
  assert.ok(changedApplication.affectedChecksRerun.includes('all admin tests'));
  assert.deepEqual(changedApplication.reusedChecks, ['Unchanged API source checks only']);
  await assert.rejects(
    verifyPreviewEvidence(env, project, {
      request,
      changedPaths: () => ['apps/admin/src/v2/composables/useV2Query.ts']
    })
  );
});
test('dedicated workflow stays on one test branch, 45 minutes and read-only repository access', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/interaction-preview-20261103.yml', import.meta.url),
    'utf8'
  );
  assert.match(workflow, /branches: \[codex\/interaction-preview-20261103\]/);
  const limit = Number(/timeout-minutes: (\d+)/.exec(workflow)?.[1]);
  assert.ok(limit > 0 && limit <= 45);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(
    workflow,
    /secrets\.|id-token:|environment:|pull_request|production-release|workflow_dispatch/
  );
});

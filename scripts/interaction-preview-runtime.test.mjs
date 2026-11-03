import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  assertPreviewExecutionContext,
  isolatedPreviewEnvironment,
  redactPreviewOutput,
  previewServerTimings,
  seedPreviewRows,
  PREVIEW_BRANCH
} from './lib/interaction-preview-runtime.mjs';

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
test('dedicated workflow stays on one test branch, 45 minutes and read-only repository access', () => {
  const workflow = readFileSync(
    new URL('../.github/workflows/interaction-preview-20261103.yml', import.meta.url),
    'utf8'
  );
  assert.match(workflow, /branches: \[codex\/interaction-preview-20261103\]/);
  assert.match(workflow, /timeout-minutes: 45/);
  assert.match(workflow, /persist-credentials: false/);
  assert.doesNotMatch(
    workflow,
    /secrets\.|id-token:|environment:|pull_request|production-release|workflow_dispatch/
  );
});

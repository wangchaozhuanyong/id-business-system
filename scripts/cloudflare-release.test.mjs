import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RELEASE_ACCOUNT_ID,
  RELEASE_PUBLIC_URL,
  RELEASE_REPOSITORY,
  RELEASE_WORKER_NAME,
  parseGitHubRepository,
  validateGitHubReleaseState,
  validateGitState,
  validateReleaseEnvironment,
  validateWranglerConfig
} from './lib/cloudflare-release.mjs';

const validEnvironment = {
  DATABASE_URL: 'postgresql://user:password@db.production.internal:5432/app',
  JWT_SECRET: 'j'.repeat(32),
  FIELD_ENCRYPTION_KEY: 'f'.repeat(32),
  HASH_SECRET: 'h'.repeat(32),
  SMOKE_TEST_USERNAME: 'production_release_smoke',
  SMOKE_TEST_PASSWORD: 'p'.repeat(24)
};
const validConfig = {
  account_id: RELEASE_ACCOUNT_ID,
  name: RELEASE_WORKER_NAME,
  main: './deploy/cloudflare-free/worker.mjs',
  assets: {
    directory: './apps/admin/dist',
    not_found_handling: 'single-page-application',
    run_worker_first: ['/api/*']
  },
  hyperdrive: [{ binding: 'HYPERDRIVE', id: 'a'.repeat(32) }],
  vars: {
    NODE_ENV: 'production',
    CLOUDFLARE_WORKER: 'true',
    APP_PUBLIC_URL: RELEASE_PUBLIC_URL,
    CORS_ORIGIN: RELEASE_PUBLIC_URL,
    ID_BUSINESS_V2_EXCHANGE_RATE_AUTO_ENABLED: 'true',
    ID_BUSINESS_V2_EXCHANGE_RATE_STALE_MS: '600000'
  }
};

test('accepts the pinned production environment and Cloudflare target', () => {
  assert.deepEqual(validateReleaseEnvironment(validEnvironment), []);
  assert.deepEqual(validateWranglerConfig(validConfig), []);
});

test('rejects local database, weak smoke credentials and target drift', () => {
  const environmentErrors = validateReleaseEnvironment({
    ...validEnvironment,
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/app',
    SMOKE_TEST_PASSWORD: 'short'
  });
  assert.ok(environmentErrors.some((error) => error.includes('DATABASE_URL')));
  assert.ok(environmentErrors.some((error) => error.includes('SMOKE_TEST_PASSWORD')));

  const configErrors = validateWranglerConfig({
    ...validConfig,
    account_id: 'wrong',
    name: 'wrong-worker'
  });
  assert.ok(configErrors.some((error) => error.includes('account_id')));
  assert.ok(configErrors.some((error) => error.includes('Worker 名称')));
});

test('requires a clean main checkout synchronized with origin', () => {
  assert.equal(
    parseGitHubRepository('git@github.com:wangchaozhuanyong/id-business-system.git'),
    RELEASE_REPOSITORY
  );
  assert.deepEqual(
    validateGitState({
      repository: RELEASE_REPOSITORY,
      branch: 'main',
      status: '',
      head: 'abc',
      originHead: 'abc'
    }),
    []
  );
  const errors = validateGitState({
    repository: RELEASE_REPOSITORY,
    branch: 'feature',
    status: ' M package.json',
    head: 'abc',
    originHead: 'def'
  });
  assert.equal(errors.length, 3);
});

test('requires successful checks and the complete main protection policy', () => {
  const checkRuns = [
    { id: 1, name: 'quality', status: 'completed', conclusion: 'success' },
    { id: 2, name: 'production-images', status: 'completed', conclusion: 'success' }
  ];
  const protection = {
    required_status_checks: {
      strict: true,
      contexts: ['quality', 'production-images']
    },
    enforce_admins: { enabled: true },
    required_pull_request_reviews: { required_approving_review_count: 0 },
    required_linear_history: { enabled: true },
    required_conversation_resolution: { enabled: true },
    allow_force_pushes: { enabled: false },
    allow_deletions: { enabled: false }
  };

  assert.deepEqual(validateGitHubReleaseState({ checkRuns, protection }), []);
  assert.ok(
    validateGitHubReleaseState({
      checkRuns: checkRuns.slice(0, 1),
      protection: {
        ...protection,
        enforce_admins: { enabled: false }
      }
    }).length >= 2
  );
});

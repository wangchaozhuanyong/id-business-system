import assert from 'node:assert/strict';
import test from 'node:test';
import {
  RELEASE_ACCOUNT_ID,
  RELEASE_PUBLIC_URL,
  RELEASE_REQUIRED_ENV_KEYS,
  RELEASE_REQUIRED_ENV_KEY_GROUPS,
  RELEASE_REPOSITORY,
  RELEASE_SUPABASE_PROJECT_REF,
  RELEASE_V2_REALTIME_CHANGES_ENABLED,
  RELEASE_WORKER_NAME,
  createCloudflareProductionBuildEnvironment,
  createCloudflareRuntimeSecrets,
  createReleaseSubprocessEnvironment,
  getSupabaseDatabaseProjectRefFromTarget,
  isSmokeMfaBootstrapCommand,
  parseGitHubRepository,
  validateCloudflareHyperdriveTarget,
  validateGitHubReleaseState,
  validateGitState,
  validateCloudflareRemoteSecretNames,
  validateReleaseEnvironment,
  validateWranglerConfig
} from './lib/cloudflare-release.mjs';

const supabaseProjectRef = RELEASE_SUPABASE_PROJECT_REF;
const validEnvironment = {
  DATABASE_URL: `postgresql://postgres:password@db.${supabaseProjectRef}.supabase.co:5432/postgres?schema=public`,
  JWT_SECRET: 'j'.repeat(32),
  FIELD_ENCRYPTION_KEY: 'f'.repeat(32),
  HASH_SECRET: 'h'.repeat(32),
  ID_BUSINESS_V2_EXCHANGE_RATE_CRON_SECRET: 'e'.repeat(32),
  AUTH_PROVIDER: 'supabase',
  SUPABASE_URL: `https://${supabaseProjectRef}.supabase.co/`,
  SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${'p'.repeat(24)}`,
  SUPABASE_SECRET_KEY: `sb_secret_${'s'.repeat(24)}`,
  VITE_SUPABASE_URL: `https://${supabaseProjectRef}.supabase.co`,
  VITE_SUPABASE_PUBLISHABLE_KEY: `sb_publishable_${'p'.repeat(24)}`,
  VITE_API_BASE_URL: '/api',
  VITE_V2_REALTIME_CHANGES_ENABLED: 'false',
  SMOKE_TEST_USERNAME: 'production_release_smoke',
  SMOKE_TEST_PASSWORD: 'p'.repeat(24),
  SMOKE_TEST_MFA_TOTP_SECRET: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ'
};
const validHyperdrive = {
  id: 'a'.repeat(32),
  origin: {
    database: 'postgres',
    host: `db.${supabaseProjectRef}.supabase.co`,
    port: 5432,
    scheme: 'postgresql',
    user: 'postgres'
  },
  caching: {
    disabled: true
  }
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
    AUTH_PROVIDER: 'supabase',
    SUPABASE_EDGE_FUNCTION: 'false',
    ID_BUSINESS_V2_EXCHANGE_RATE_AUTO_ENABLED: 'true',
    ID_BUSINESS_V2_EXCHANGE_RATE_STALE_MS: '600000'
  }
};

test('accepts the pinned production environment and Cloudflare target', () => {
  assert.deepEqual(validateReleaseEnvironment(validEnvironment), []);
  assert.deepEqual(validateWranglerConfig(validConfig), []);
  assert.ok(RELEASE_REQUIRED_ENV_KEYS.includes('AUTH_PROVIDER'));
  assert.ok(RELEASE_REQUIRED_ENV_KEYS.includes('VITE_V2_REALTIME_CHANGES_ENABLED'));
  assert.ok(RELEASE_REQUIRED_ENV_KEYS.includes('SMOKE_TEST_MFA_TOTP_SECRET'));
  assert.deepEqual(RELEASE_REQUIRED_ENV_KEY_GROUPS, [
    ['SUPABASE_ANON_KEY', 'SUPABASE_PUBLISHABLE_KEY'],
    ['SUPABASE_SERVICE_ROLE_KEY', 'SUPABASE_SECRET_KEY'],
    ['VITE_SUPABASE_ANON_KEY', 'VITE_SUPABASE_PUBLISHABLE_KEY']
  ]);
});

test('allows the missing smoke MFA seed only for the exact provisioning bootstrap command', () => {
  assert.equal(
    isSmokeMfaBootstrapCommand('npm', ['run', 'prod:smoke-user:provision:with-env']),
    true
  );
  assert.equal(
    isSmokeMfaBootstrapCommand('npm', ['exec', 'unrelated', 'prod:smoke-user:provision:with-env']),
    false
  );
  assert.equal(isSmokeMfaBootstrapCommand('node', ['prod:smoke-user:provision:with-env']), false);
});

test('forces the Cloudflare production frontend to use version polling', () => {
  const buildEnvironment = createCloudflareProductionBuildEnvironment({
    PATH: '/trusted/bin',
    KEEP_ME: 'yes',
    DATABASE_URL: 'postgresql://secret',
    SUPABASE_SECRET_KEY: 'server-only-secret',
    SMOKE_TEST_PASSWORD: 'smoke-secret',
    SUPABASE_URL: validEnvironment.SUPABASE_URL,
    VITE_SUPABASE_URL: validEnvironment.VITE_SUPABASE_URL,
    VITE_SUPABASE_PUBLISHABLE_KEY: validEnvironment.VITE_SUPABASE_PUBLISHABLE_KEY,
    VITE_V2_REALTIME_CHANGES_ENABLED: 'true'
  });

  assert.equal(RELEASE_V2_REALTIME_CHANGES_ENABLED, 'false');
  assert.equal(buildEnvironment.VITE_V2_REALTIME_CHANGES_ENABLED, 'false');
  assert.equal(buildEnvironment.VITE_API_BASE_URL, '/api');
  assert.equal(
    buildEnvironment.VITE_SUPABASE_ANON_KEY,
    validEnvironment.VITE_SUPABASE_PUBLISHABLE_KEY
  );
  assert.equal(
    buildEnvironment.VITE_SUPABASE_PUBLISHABLE_KEY,
    validEnvironment.VITE_SUPABASE_PUBLISHABLE_KEY
  );
  assert.equal(buildEnvironment.PATH, '/trusted/bin');
  assert.equal(buildEnvironment.DATABASE_URL, undefined);
  assert.equal(buildEnvironment.SUPABASE_SECRET_KEY, undefined);
  assert.equal(buildEnvironment.SMOKE_TEST_PASSWORD, undefined);
  assert.equal(buildEnvironment.SMOKE_TEST_MFA_TOTP_SECRET, undefined);
  assert.equal(buildEnvironment.KEEP_ME, undefined);
});

test('uploads only server runtime secrets to the Worker version', () => {
  const runtimeSecrets = createCloudflareRuntimeSecrets({
    ...validEnvironment,
    ID_BUSINESS_V2_EXCHANGE_RATE_CRON_SECRET: 'e'.repeat(32),
    VITE_SUPABASE_PUBLISHABLE_KEY: 'frontend-public',
    SMOKE_TEST_PASSWORD: 'smoke-secret',
    SEED_ADMIN_PASSWORD: 'admin-secret'
  });

  assert.equal(runtimeSecrets.DATABASE_URL, validEnvironment.DATABASE_URL);
  assert.equal(runtimeSecrets.SUPABASE_SECRET_KEY, validEnvironment.SUPABASE_SECRET_KEY);
  assert.equal(runtimeSecrets.SUPABASE_SERVICE_ROLE_KEY, validEnvironment.SUPABASE_SECRET_KEY);
  assert.equal(runtimeSecrets.SUPABASE_ANON_KEY, validEnvironment.SUPABASE_PUBLISHABLE_KEY);
  assert.equal(runtimeSecrets.SUPABASE_PUBLISHABLE_KEY, validEnvironment.SUPABASE_PUBLISHABLE_KEY);
  assert.equal(runtimeSecrets.ID_BUSINESS_V2_EXCHANGE_RATE_CRON_SECRET, 'e'.repeat(32));
  assert.equal(runtimeSecrets.VITE_SUPABASE_PUBLISHABLE_KEY, undefined);
  assert.equal(runtimeSecrets.SMOKE_TEST_PASSWORD, undefined);
  assert.equal(runtimeSecrets.SMOKE_TEST_MFA_TOTP_SECRET, undefined);
  assert.equal(runtimeSecrets.SEED_ADMIN_PASSWORD, undefined);
});

test('strips release credentials from third-party subprocesses unless explicitly allowed', () => {
  const result = createReleaseSubprocessEnvironment(
    {
      ...validEnvironment,
      CLOUDFLARE_API_TOKEN: 'kept-cloudflare-token',
      PATH: '/trusted/bin'
    },
    ['DATABASE_URL']
  );

  assert.equal(result.DATABASE_URL, validEnvironment.DATABASE_URL);
  assert.equal(result.SMOKE_TEST_PASSWORD, undefined);
  assert.equal(result.SMOKE_TEST_MFA_TOTP_SECRET, undefined);
  assert.equal(result.SUPABASE_SECRET_KEY, undefined);
  assert.equal(result.VITE_SUPABASE_PUBLISHABLE_KEY, undefined);
  assert.equal(result.CLOUDFLARE_API_TOKEN, 'kept-cloudflare-token');
  assert.equal(result.PATH, '/trusted/bin');
});

test('requires the exact uncached Supabase direct Hyperdrive target', () => {
  assert.deepEqual(
    validateCloudflareHyperdriveTarget(
      validHyperdrive,
      validHyperdrive.id,
      validEnvironment.DATABASE_URL,
      validEnvironment.SUPABASE_URL
    ),
    []
  );

  for (const drifted of [
    {
      ...validHyperdrive,
      origin: {
        ...validHyperdrive.origin,
        host: 'aws-0-us-west-1.pooler.supabase.com',
        user: `postgres.${supabaseProjectRef}`
      }
    },
    {
      ...validHyperdrive,
      origin: { ...validHyperdrive.origin, port: 6543 }
    },
    {
      ...validHyperdrive,
      caching: { disabled: false }
    }
  ]) {
    assert.ok(
      validateCloudflareHyperdriveTarget(
        drifted,
        validHyperdrive.id,
        validEnvironment.DATABASE_URL,
        validEnvironment.SUPABASE_URL
      ).some((error) => error.includes('关闭查询缓存'))
    );
  }
});

test('rejects stale or missing Worker secret names instead of allowing hidden overrides', () => {
  const expected = ['DATABASE_URL', 'SUPABASE_ANON_KEY', 'SUPABASE_SERVICE_ROLE_KEY'];
  assert.deepEqual(
    validateCloudflareRemoteSecretNames(['DATABASE_URL'], expected, { allowMissing: true }),
    []
  );
  assert.ok(
    validateCloudflareRemoteSecretNames(['DATABASE_URL', 'AUTH_PROVIDER'], expected, {
      allowMissing: true
    }).some((error) => error.includes('AUTH_PROVIDER'))
  );
  assert.ok(
    validateCloudflareRemoteSecretNames(['DATABASE_URL'], expected).some((error) =>
      error.includes('SUPABASE_ANON_KEY')
    )
  );
});

test('rejects local database, weak smoke credentials and target drift', () => {
  const environmentErrors = validateReleaseEnvironment({
    ...validEnvironment,
    DATABASE_URL: 'postgresql://postgres:postgres@localhost:5432/app',
    SMOKE_TEST_USERNAME: 'employee',
    SMOKE_TEST_PASSWORD: 'short',
    SMOKE_TEST_MFA_TOTP_SECRET: 'invalid!'
  });
  assert.ok(environmentErrors.some((error) => error.includes('DATABASE_URL')));
  assert.ok(environmentErrors.some((error) => error.includes('必须固定')));
  assert.ok(environmentErrors.some((error) => error.includes('SMOKE_TEST_PASSWORD')));
  assert.ok(environmentErrors.some((error) => error.includes('SMOKE_TEST_MFA_TOTP_SECRET')));

  const configErrors = validateWranglerConfig({
    ...validConfig,
    account_id: 'wrong',
    name: 'wrong-worker'
  });
  assert.ok(configErrors.some((error) => error.includes('account_id')));
  assert.ok(configErrors.some((error) => error.includes('Worker 名称')));
});

test('rejects Supabase project drift, local auth and enabled Realtime on first release', () => {
  const errors = validateReleaseEnvironment({
    ...validEnvironment,
    AUTH_PROVIDER: 'local',
    VITE_SUPABASE_URL: 'https://zyxwvutsrqponmlkjihg.supabase.co',
    VITE_V2_REALTIME_CHANGES_ENABLED: 'true'
  });

  assert.ok(errors.some((error) => error.includes('AUTH_PROVIDER')));
  assert.ok(errors.some((error) => error.includes('同一个 Supabase 项目')));
  assert.ok(errors.some((error) => error.includes('VITE_V2_REALTIME_CHANGES_ENABLED=false')));
});

test('requires both Supabase URLs to be canonical project roots', () => {
  for (const [name, value] of [
    ['SUPABASE_URL', `https://${supabaseProjectRef}.supabase.co/auth/v1`],
    ['VITE_SUPABASE_URL', `https://${supabaseProjectRef}.supabase.co/?prefix=wrong`],
    ['VITE_SUPABASE_URL', `https://${supabaseProjectRef}.supabase.co/#wrong`],
    ['SUPABASE_URL', `https://${supabaseProjectRef}.supabase.co:444/`]
  ]) {
    assert.ok(
      validateReleaseEnvironment({
        ...validEnvironment,
        [name]: value
      }).some((error) => error.includes(`${name} 必须是无路径`))
    );
  }
});

test('rejects a production database that cannot be proven to belong to the Auth project', () => {
  const errors = validateReleaseEnvironment({
    ...validEnvironment,
    DATABASE_URL:
      'postgresql://postgres:password@db.production.internal:5432/postgres?schema=public'
  });
  assert.ok(errors.some((error) => error.includes('可核验的 Supabase 项目 ref')));

  const driftErrors = validateReleaseEnvironment({
    ...validEnvironment,
    DATABASE_URL:
      'postgresql://postgres.zyxwvutsrqponmlkjihg:password@aws-0-us-west-1.pooler.supabase.com:5432/postgres?schema=public'
  });
  assert.ok(driftErrors.some((error) => error.includes('属于同一个生产项目')));
  assert.equal(
    getSupabaseDatabaseProjectRefFromTarget(
      'aws-0-us-west-1.pooler.supabase.com',
      `postgres.${supabaseProjectRef}`
    ),
    supabaseProjectRef
  );
  assert.equal(
    getSupabaseDatabaseProjectRefFromTarget(
      'db.production.internal',
      `postgres.${supabaseProjectRef}`
    ),
    ''
  );
});

test('requires the production postgres database and public schema', () => {
  for (const databaseUrl of [
    `postgresql://postgres:password@db.${supabaseProjectRef}.supabase.co:5432/id_business_v2?schema=public`,
    `postgresql://postgres:password@db.${supabaseProjectRef}.supabase.co:5432/postgres?schema=private`
  ]) {
    assert.ok(
      validateReleaseEnvironment({
        ...validEnvironment,
        DATABASE_URL: databaseUrl
      }).some((error) => error.includes('postgres/public'))
    );
  }
});

test('requires complete and separated Supabase public and service credentials', () => {
  const missingErrors = validateReleaseEnvironment({
    ...validEnvironment,
    VITE_SUPABASE_PUBLISHABLE_KEY: ''
  });
  assert.ok(missingErrors.some((error) => error.includes('前端 Supabase publishable/anon key')));

  const sharedCredential = `sb_shared_${'x'.repeat(24)}`;
  const separationErrors = validateReleaseEnvironment({
    ...validEnvironment,
    SUPABASE_PUBLISHABLE_KEY: sharedCredential,
    SUPABASE_SECRET_KEY: sharedCredential,
    VITE_SUPABASE_PUBLISHABLE_KEY: sharedCredential,
    VITE_SUPABASE_SECRET_KEY: `sb_frontend_secret_${'z'.repeat(24)}`
  });
  assert.ok(separationErrors.some((error) => error.includes('必须分离')));
  assert.ok(separationErrors.some((error) => error.includes('不得进入前端环境')));
});

test('positively classifies modern and legacy Supabase credentials', () => {
  const legacyPublicKey = createLegacySupabaseJwt('anon');
  const legacyServiceKey = createLegacySupabaseJwt('service_role');
  assert.deepEqual(
    validateReleaseEnvironment({
      ...validEnvironment,
      SUPABASE_PUBLISHABLE_KEY: '',
      SUPABASE_ANON_KEY: legacyPublicKey,
      SUPABASE_SECRET_KEY: '',
      SUPABASE_SERVICE_ROLE_KEY: legacyServiceKey,
      VITE_SUPABASE_PUBLISHABLE_KEY: '',
      VITE_SUPABASE_ANON_KEY: legacyPublicKey
    }),
    []
  );

  const frontendServiceErrors = validateReleaseEnvironment({
    ...validEnvironment,
    VITE_SUPABASE_PUBLISHABLE_KEY: `sb_secret_${'x'.repeat(24)}`
  });
  assert.ok(
    frontendServiceErrors.some(
      (error) =>
        error.includes('前端 Supabase publishable/anon key') && error.includes('可正向识别')
    )
  );

  const backendPublicAsServiceErrors = validateReleaseEnvironment({
    ...validEnvironment,
    SUPABASE_SECRET_KEY: `sb_publishable_${'x'.repeat(24)}`
  });
  assert.ok(
    backendPublicAsServiceErrors.some(
      (error) => error.includes('后端 Supabase service/secret key') && error.includes('可正向识别')
    )
  );
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
    required_pull_request_reviews: {
      required_approving_review_count: 1,
      dismiss_stale_reviews: true,
      require_code_owner_reviews: true,
      require_last_push_approval: true
    },
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
  assert.ok(
    validateGitHubReleaseState({
      checkRuns,
      protection: {
        ...protection,
        required_pull_request_reviews: {
          required_approving_review_count: 0,
          dismiss_stale_reviews: false,
          require_code_owner_reviews: false,
          require_last_push_approval: false
        }
      }
    }).length >= 4
  );
});

function createLegacySupabaseJwt(role) {
  return [
    Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url'),
    Buffer.from(JSON.stringify({ iss: 'supabase', role })).toString('base64url'),
    'signature'
  ].join('.');
}

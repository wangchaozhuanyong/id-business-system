import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import {
  RELEASE_ACCOUNT_ID,
  RELEASE_PUBLIC_URL,
  RELEASE_REPOSITORY,
  RELEASE_SUPABASE_API_BASE_URL,
  RELEASE_SUPABASE_FUNCTION_REGION,
  RELEASE_V2_REALTIME_CHANGES_ENABLED,
  RELEASE_WORKER_NAME,
  createCloudflareProductionBuildEnvironment,
  parseGitHubRepository,
  validateGitHubReleaseState,
  validateGitState,
  validateReleaseEnvironment,
  validateWranglerConfig
} from './lib/cloudflare-release.mjs';

const validEnvironment = {
  DATABASE_URL:
    'postgresql://id_business_v2_runtime.fjquufgbnxyocmuzltxi:password@aws-0-ap-northeast-1.pooler.supabase.com:6543/postgres?pgbouncer=true',
  JWT_SECRET: 'j'.repeat(32),
  FIELD_ENCRYPTION_KEY: 'f'.repeat(32),
  HASH_SECRET: 'h'.repeat(32),
  V2_TRUSTED_PROXY_SECRET: 't'.repeat(32),
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
  vars: {
    APP_PUBLIC_URL: RELEASE_PUBLIC_URL,
    SUPABASE_API_BASE_URL: RELEASE_SUPABASE_API_BASE_URL,
    SUPABASE_FUNCTION_REGION: RELEASE_SUPABASE_FUNCTION_REGION
  }
};

test('accepts the pinned production environment and Cloudflare target', () => {
  assert.deepEqual(validateReleaseEnvironment(validEnvironment), []);
  assert.deepEqual(validateWranglerConfig(validConfig), []);
});

test('forces the Cloudflare production frontend to use version polling', () => {
  const buildEnvironment = createCloudflareProductionBuildEnvironment({
    KEEP_ME: 'yes',
    VITE_V2_REALTIME_CHANGES_ENABLED: 'true'
  });

  assert.equal(RELEASE_V2_REALTIME_CHANGES_ENABLED, 'false');
  assert.equal(buildEnvironment.VITE_API_BASE_URL, '/api');
  assert.equal(buildEnvironment.VITE_V2_REALTIME_CHANGES_ENABLED, 'false');
  assert.equal(buildEnvironment.KEEP_ME, 'yes');
});

test('pins the Supabase function to the production database region', () => {
  assert.equal(RELEASE_SUPABASE_FUNCTION_REGION, 'ap-northeast-1');
  assert.equal(validConfig.vars.SUPABASE_FUNCTION_REGION, RELEASE_SUPABASE_FUNCTION_REGION);
});

test('keeps the production performance probe within smoke permissions and always logs out', async () => {
  const source = await readFile(new URL('./probe-v2-api-performance.mjs', import.meta.url), 'utf8');

  assert.doesNotMatch(source, /id-business-v2\/options\/bootstrap/);
  assert.match(source, /try\s*\{[\s\S]*finally\s*\{/);
  assert.match(source, /finally\s*\{[\s\S]*request\('\/auth\/logout'/);
});

test('builds the shared package before the Cloudflare admin bundle', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  );
  const buildScript = packageJson.scripts['build:cloudflare-free'];
  const sharedBuild = buildScript.indexOf('build --workspace @apple-business/shared');
  const adminBuild = buildScript.indexOf('build --workspace @apple-business/admin');

  assert.notEqual(sharedBuild, -1);
  assert.notEqual(adminBuild, -1);
  assert.ok(sharedBuild < adminBuild);
  assert.equal(buildScript.includes('build:cloudflare'), false);
  assert.equal(buildScript.includes('prisma:generate'), false);
});

test('builds shared contracts before both Supabase API bundles', async () => {
  const packageJson = JSON.parse(
    await readFile(new URL('../package.json', import.meta.url), 'utf8')
  );

  for (const scriptName of ['build:supabase-v2-api', 'build:supabase-v2-api:perf']) {
    const buildScript = packageJson.scripts[scriptName];
    const sharedBuild = buildScript.indexOf('build --workspace @apple-business/shared');
    const apiBuild = buildScript.indexOf('build:cloudflare --workspace @apple-business/api');
    assert.notEqual(sharedBuild, -1);
    assert.notEqual(apiBuild, -1);
    assert.ok(sharedBuild < apiBuild);
  }
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
    name: 'wrong-worker',
    alias: { '@cloudflare-prisma/client': './generated/client.ts' },
    compatibility_flags: ['nodejs_compat'],
    hyperdrive: [{ binding: 'HYPERDRIVE', id: 'a'.repeat(32) }]
  });
  assert.ok(configErrors.some((error) => error.includes('account_id')));
  assert.ok(configErrors.some((error) => error.includes('Worker 名称')));
  assert.ok(configErrors.some((error) => error.includes('NestJS/Prisma')));
  assert.ok(configErrors.some((error) => error.includes('Hyperdrive')));
  assert.ok(configErrors.some((error) => error.includes('nodejs_compat')));
});

test('deploys and verifies Supabase API before switching the Cloudflare proxy', async () => {
  const source = await readFile(new URL('./deploy-cloudflare-free.mjs', import.meta.url), 'utf8');
  const supabaseDeploy = source.indexOf("'functions',\n  'deploy',\n  'v2-api'");
  const apiVerification = source.indexOf("RELEASE_SUPABASE_API_BASE_URL,\n  '--api-only'");
  const cloudflareDeploy = source.indexOf("'wrangler@4.114.0',\n  'deploy'");

  assert.notEqual(supabaseDeploy, -1);
  assert.notEqual(apiVerification, -1);
  assert.notEqual(cloudflareDeploy, -1);
  assert.match(source, /'--use-docker'/);
  assert.match(source, /'secret',\s*\n\s*'bulk'/);
  assert.ok(supabaseDeploy < apiVerification);
  assert.ok(apiVerification < cloudflareDeploy);
  assert.match(source, /V2_TRUSTED_PROXY_SECRET/);
});

test('keeps Supabase Edge authentication configurable for the current local accounts', async () => {
  const source = await readFile(
    new URL('../supabase/functions/v2-api/index.ts', import.meta.url),
    'utf8'
  );

  assert.match(source, /Deno\.env\.get\('AUTH_PROVIDER'\)/);
  assert.doesNotMatch(source, /AUTH_PROVIDER:\s*'supabase'/);
  assert.match(source, /authProvider === 'local'[\s\S]*requireEnv\('JWT_SECRET'\)/);
});

test('requires the scoped runtime database role without an admin fallback', async () => {
  const source = await readFile(
    new URL('../supabase/functions/v2-api/index.ts', import.meta.url),
    'utf8'
  );

  assert.match(source, /requireEnv\('V2_RUNTIME_DATABASE_URL'\)/);
  assert.doesNotMatch(source, /firstEnv\('SUPABASE_DB_URL', 'DATABASE_URL'\)/);
  assert.match(source, /id_business_v2_runtime/);

  const errors = validateReleaseEnvironment({
    ...validEnvironment,
    DATABASE_URL:
      'postgresql://postgres.fjquufgbnxyocmuzltxi:password@aws-0-ap-northeast-1.pooler.supabase.com:5432/postgres'
  });
  assert.ok(errors.some((error) => error.includes('id_business_v2_runtime')));
});

test('keeps production migrations behind a backup fingerprint and clean main gate', async () => {
  const source = await readFile(
    new URL('./deploy-production-migrations.mjs', import.meta.url),
    'utf8'
  );

  assert.match(source, /--backup-sha256/);
  assert.match(source, /MIGRATE_/);
  assert.match(source, /branch !== 'main'/);
  assert.match(source, /head !== originHead/);
  assert.match(source, /prisma:migrate:deploy/);
  assert.match(source, /FIELD_ENCRYPTION_KEY/);
  assert.match(source, /backfill:user-phone/);
  assert.match(source, /userPhoneEncryption: 'verified'/);
  assert.ok(source.indexOf('prisma:migrate:deploy') < source.indexOf('backfill:user-phone'));
  assert.match(source, /RECOVERABLE_ROLLED_BACK_MIGRATIONS/);
  assert.match(source, /--resolve-rolled-back=/);
  assert.match(source, /finished_at IS NULL/);
  assert.match(source, /applied_steps_count !== 0/);
  assert.match(source, /失败 migration 存在未预期的部分生效状态/);
  assert.match(source, /BEIJING_BUSINESS_TIMEZONE_MIGRATION/);
  assert.match(source, /timezone_default/);
  assert.match(source, /shanghai_count !== 0/);
  assert.match(source, /失败的北京时间 migration 存在未预期的部分生效状态/);
  assert.match(source, /'--rolled-back'/);
  assert.match(source, /waitForProductionBackups/);
  assert.match(source, /BACKUP_WAIT_TIMEOUT_MS = 3 \* 60 \* 1000/);
  assert.match(source, /inspectProductionBackupTransactions/);
  assert.match(source, /已在 Prisma 执行前停止/);
  assert.doesNotMatch(source, /pg_terminate_backend/);
  assert.doesNotMatch(source, /shell:\s*true/);
});

test('guards the legacy auth identity cleanup against relation drift', async () => {
  const migration = await readFile(
    new URL(
      '../apps/api/prisma/migrations/20260805083000_v2_auth_identity_legacy_column_cleanup/migration.sql',
      import.meta.url
    ),
    'utf8'
  );
  const consistencyGuard = migration.indexOf('legacy_user_id IS DISTINCT FROM user_id');
  const cleanup = migration.indexOf('DROP COLUMN IF EXISTS legacy_user_id');

  assert.notEqual(consistencyGuard, -1);
  assert.notEqual(cleanup, -1);
  assert.ok(consistencyGuard < cleanup);
  assert.match(migration, /RAISE EXCEPTION/);
  assert.match(migration, /DROP CONSTRAINT IF EXISTS v2_auth_identities_legacy_user_id_fkey/);
  assert.match(migration, /DROP INDEX IF EXISTS public\.v2_auth_identities_legacy_user_id_key/);
});

test('retries database role authentication and restores prior passwords on failure', async () => {
  const source = await readFile(
    new URL('./provision-production-database-roles.mjs', import.meta.url),
    'utf8'
  );

  assert.match(source, /verifyRoleLoginWithRetry/);
  assert.match(source, /restorePreviousRolePasswords/);
  assert.match(source, /id-v2-role-provisioner-compensation/);
});

test('grants and continuously verifies production access to user table preferences', async () => {
  const migration = await readFile(
    new URL(
      '../apps/api/prisma/migrations/20260809090000_user_table_preferences_runtime_access/migration.sql',
      import.meta.url
    ),
    'utf8'
  );
  const provisioner = await readFile(
    new URL('./provision-production-database-roles.mjs', import.meta.url),
    'utf8'
  );
  const verifier = await readFile(
    new URL('./verify-production-database-roles.mjs', import.meta.url),
    'utf8'
  );

  assert.match(migration, /GRANT SELECT, INSERT, UPDATE, DELETE[\s\S]*id_business_v2_runtime/);
  assert.match(migration, /GRANT SELECT[\s\S]*id_business_v2_audit/);
  assert.match(migration, /id_business_v2_runtime_access/);
  assert.match(migration, /id_business_v2_audit_read/);
  assert.match(migration, /target\.relrowsecurity/);
  assert.match(provisioner, /'id_business_v2_user_table_preferences'/);
  assert.match(verifier, /'id_business_v2_user_table_preferences'/);
});

test('keeps workspace and managed mailbox privileges aligned across release tooling', async () => {
  const migration = await readFile(
    new URL(
      '../apps/api/prisma/migrations/20260815100000_managed_mailboxes/migration.sql',
      import.meta.url
    ),
    'utf8'
  );
  const reservationAccessMigration = await readFile(
    new URL(
      '../apps/api/prisma/migrations/20260815205000_atomic_security_reservation_runtime_access/migration.sql',
      import.meta.url
    ),
    'utf8'
  );
  const provisioner = await readFile(
    new URL('./provision-production-database-roles.mjs', import.meta.url),
    'utf8'
  );
  const verifier = await readFile(
    new URL('./verify-production-database-roles.mjs', import.meta.url),
    'utf8'
  );
  const appendOnlyTables = provisioner.match(
    /const RUNTIME_APPEND_ONLY_TABLES = \[([\s\S]*?)\];/
  )?.[1];
  const provisionedDeleteTables = provisioner.match(
    /const RUNTIME_DELETE_TABLES = \[([\s\S]*?)\];/
  )?.[1];
  const verifiedDeleteTables = verifier.match(
    /const expectedRuntimeDeleteTables = new Set\(\[([\s\S]*?)\]\);/
  )?.[1];

  assert.match(
    migration,
    /GRANT SELECT, INSERT, UPDATE\s+ON TABLE public\.id_business_v2_managed_mailboxes/
  );
  assert.match(
    migration,
    /GRANT SELECT, INSERT\s+ON TABLE public\.id_business_v2_mail_query_attempts/
  );
  assert.match(
    reservationAccessMigration,
    /GRANT UPDATE \(mailbox_id, outcome\)\s+ON TABLE public\.id_business_v2_mail_query_attempts/
  );
  assert.match(
    provisioner,
    /GRANT UPDATE \(mailbox_id, outcome\) ON TABLE public\.id_business_v2_mail_query_attempts/
  );
  assert.match(verifier, /has_column_privilege\(/);
  assert.match(appendOnlyTables ?? '', /'id_business_v2_mail_query_attempts'/);
  assert.doesNotMatch(provisionedDeleteTables ?? '', /'id_business_v2_mail_query_attempts'/);
  assert.doesNotMatch(verifiedDeleteTables ?? '', /'id_business_v2_mail_query_attempts'/);
  for (const table of [
    'id_business_v2_workspace_shortcuts',
    'id_business_v2_managed_mailboxes',
    'id_business_v2_mail_query_attempts'
  ]) {
    assert.match(provisioner, new RegExp(`'${table}'`));
    assert.match(verifier, new RegExp(`'${table}'`));
  }
  assert.match(provisionedDeleteTables ?? '', /'id_business_v2_workspace_shortcuts'/);
  assert.match(verifiedDeleteTables ?? '', /'id_business_v2_workspace_shortcuts'/);
});

test('keeps customer tag replacement compatible with the scoped runtime role', async () => {
  const migration = await readFile(
    new URL(
      '../apps/api/prisma/migrations/20260814010000_customer_tag_runtime_delete_access/migration.sql',
      import.meta.url
    ),
    'utf8'
  );
  const provisioner = await readFile(
    new URL('./provision-production-database-roles.mjs', import.meta.url),
    'utf8'
  );
  const verifier = await readFile(
    new URL('./verify-production-database-roles.mjs', import.meta.url),
    'utf8'
  );
  const provisionedDeleteTables = provisioner.match(
    /const RUNTIME_DELETE_TABLES = \[([\s\S]*?)\];/
  )?.[1];
  const verifiedDeleteTables = verifier.match(
    /const expectedRuntimeDeleteTables = new Set\(\[([\s\S]*?)\]\);/
  )?.[1];

  assert.match(
    migration,
    /GRANT DELETE ON TABLE public\.id_business_v2_customer_tags\s+TO id_business_v2_runtime/
  );
  assert.match(provisionedDeleteTables ?? '', /'id_business_v2_customer_tags'/);
  assert.match(verifiedDeleteTables ?? '', /'id_business_v2_customer_tags'/);
});

test('keeps sensitive display policies and governed cleanup within scoped database roles', async () => {
  const provisioner = await readFile(
    new URL('./provision-production-database-roles.mjs', import.meta.url),
    'utf8'
  );
  const verifier = await readFile(
    new URL('./verify-production-database-roles.mjs', import.meta.url),
    'utf8'
  );
  const provisionedDeleteTables = provisioner.match(
    /const RUNTIME_DELETE_TABLES = \[([\s\S]*?)\];/
  )?.[1];
  const verifiedDeleteTables = verifier.match(
    /const expectedRuntimeDeleteTables = new Set\(\[([\s\S]*?)\]\);/
  )?.[1];

  assert.match(provisioner, /'id_business_v2_sensitive_display_policies'/);
  assert.match(verifier, /'id_business_v2_sensitive_display_policies'/);
  assert.match(provisionedDeleteTables ?? '', /'id_business_v2_sensitive_display_policies'/);
  assert.match(verifiedDeleteTables ?? '', /'id_business_v2_sensitive_display_policies'/);
  for (const source of [provisioner, verifier]) {
    assert.match(source, /execute_id_business_v2_governance_exchange_rate_cleanup/);
    assert.match(source, /cleanup_id_business_v2_exchange_rate_history/);
    assert.match(source, /invoke_id_business_v2_exchange_rate_cron/);
  }
  for (const directDeleteTable of [
    'id_business_v2_exchange_rate_runs',
    'id_business_v2_exchange_rate_snapshots',
    'id_business_v2_exchange_rate_provider_snapshots',
    'id_business_v2_exchange_rate_quote_samples'
  ]) {
    assert.doesNotMatch(provisionedDeleteTables ?? '', new RegExp(`'${directDeleteTable}'`));
    assert.doesNotMatch(verifiedDeleteTables ?? '', new RegExp(`'${directDeleteTable}'`));
  }
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

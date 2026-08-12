import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const containerName = `id-business-v2-governance-${process.pid}`;
const databaseName = `id_business_v2_governance_drill_${process.pid}`;
const databasePassword = 'v2_governance_drill_only';
const expectedMigrationCount = readdirSync('apps/api/prisma/migrations', {
  withFileTypes: true
}).filter((entry) => entry.isDirectory()).length;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: process.cwd(),
    encoding: 'utf8',
    ...options
  });
  if (result.status !== 0) {
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `\n${detail}` : ''}`);
  }
  return result.stdout?.trim() ?? '';
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

try {
  run('docker', [
    'run',
    '--rm',
    '--detach',
    '--name',
    containerName,
    '--env',
    `POSTGRES_PASSWORD=${databasePassword}`,
    '--env',
    `POSTGRES_DB=${databaseName}`,
    '--publish',
    '127.0.0.1::5432',
    'postgres:16-alpine'
  ]);

  let ready = false;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    const probe = spawnSync(
      'docker',
      ['exec', containerName, 'psql', '-U', 'postgres', '-d', databaseName, '-Atc', 'SELECT 1;'],
      { encoding: 'utf8' }
    );
    if (probe.status === 0) {
      ready = true;
      break;
    }
    await wait(250);
  }
  if (!ready) throw new Error('数据治理隔离 PostgreSQL 在 15 秒内未就绪');

  const portOutput = run('docker', ['port', containerName, '5432/tcp']);
  const portMatch = portOutput.match(/:(\d+)$/m);
  if (!portMatch) throw new Error('无法解析数据治理隔离 PostgreSQL 端口');
  const databaseUrl = `postgresql://postgres:${databasePassword}@127.0.0.1:${portMatch[1]}/${databaseName}`;

  run('docker', [
    'exec',
    containerName,
    'psql',
    '-U',
    'postgres',
    '-d',
    databaseName,
    '-v',
    'ON_ERROR_STOP=1',
    '-c',
    "CREATE ROLE id_business_v2_runtime LOGIN PASSWORD 'runtime_acceptance_only'; CREATE ROLE id_business_v2_audit LOGIN PASSWORD 'audit_acceptance_only';"
  ]);

  run('npx', ['prisma', 'migrate', 'deploy', '--schema', 'apps/api/prisma/schema.prisma'], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: databaseUrl }
  });
  run('node', ['scripts/v2-data-integrity-audit.mjs'], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl }
  });
  const runtimeDeleteTables = run('docker', [
    'exec',
    containerName,
    'psql',
    '-U',
    'postgres',
    '-d',
    databaseName,
    '-Atc',
    `SELECT string_agg(c.relname, ',' ORDER BY c.relname)
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public'
       AND c.relkind IN ('r', 'p')
       AND has_table_privilege('id_business_v2_runtime', c.oid, 'DELETE');`
  ]);
  const expectedRuntimeDeleteTables = [
    'id_business_v2_exchange_rate_provider_snapshots',
    'id_business_v2_exchange_rate_quote_samples',
    'id_business_v2_exchange_rate_runs',
    'id_business_v2_exchange_rate_snapshots',
    'id_business_v2_user_table_preferences',
    'ip_whitelists',
    'role_permissions',
    'user_roles'
  ].join(',');
  if (runtimeDeleteTables !== expectedRuntimeDeleteTables) {
    throw new Error(`运行时 DELETE 白名单不符合预期：${runtimeDeleteTables || '(empty)'}`);
  }
  run(
    'npm',
    [
      'run',
      'test',
      '--workspace',
      '@apple-business/api',
      '--',
      '--run',
      'src/id-business-v2/data-governance/id-business-v2-data-governance-postgres.integration.spec.ts'
    ],
    {
      stdio: 'inherit',
      env: { ...process.env, V2_DATA_GOVERNANCE_DATABASE_URL: databaseUrl }
    }
  );
  run('node', ['scripts/v2-data-integrity-audit.mjs'], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: databaseUrl, DIRECT_URL: databaseUrl }
  });

  const state = JSON.parse(
    run('docker', [
      'exec',
      containerName,
      'psql',
      '-U',
      'postgres',
      '-d',
      databaseName,
      '-Atc',
      `select json_build_object(
        'migrations', (select count(*) from _prisma_migrations
          where finished_at is not null and rolled_back_at is null),
        'failedMigrations', (select count(*) from _prisma_migrations
          where finished_at is null and rolled_back_at is null),
        'users', (select count(*) from users),
        'customers', (select count(*) from id_business_v2_customers),
        'jobs', (select count(*) from id_business_v2_governance_jobs),
        'items', (select count(*) from id_business_v2_governance_job_items),
        'approvals', (select count(*) from id_business_v2_governance_approvals),
        'checkpoints', (select count(*) from id_business_v2_governance_checkpoints),
        'auditLogs', (select count(*) from audit_logs),
        'orderSnapshots', (select count(*) from id_business_v2_order_display_snapshots)
      );`
    ])
  );
  const expectedState = {
    migrations: expectedMigrationCount,
    failedMigrations: 0,
    users: 2,
    customers: 1,
    jobs: 2,
    items: 2,
    approvals: 1,
    checkpoints: 1,
    auditLogs: 6,
    orderSnapshots: 1
  };
  if (JSON.stringify(state) !== JSON.stringify(expectedState)) {
    throw new Error(`数据治理隔离库终态不符合预期：${JSON.stringify(state)}`);
  }

  console.log(
    JSON.stringify({
      ok: true,
      database: databaseName,
      workflow: [
        'empty-database-integrity-audit',
        'populated-database-integrity-audit',
        'requester-preview',
        'requester-cancel',
        'cancelled-task-approval-rejected',
        'replacement-preview',
        'self-approval-rejected',
        'independent-approval',
        'immutable-preview',
        'batch-execution',
        'idempotent-replay'
      ],
      verifiedState: state,
      cleanup: 'remove-disposable-postgres-container'
    })
  );
} finally {
  spawnSync('docker', ['rm', '--force', containerName], { stdio: 'ignore' });
}

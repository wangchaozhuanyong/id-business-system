import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const containerName = `id-business-v2-governance-${process.pid}`;
const databaseName = `id_business_v2_governance_drill_${process.pid}`;
const databasePassword = 'v2_governance_drill_only';
const schemaPath = 'apps/api/prisma-mysql/schema.prisma';
const integrationSpec =
  'src/id-business-v2/data-governance/id-business-v2-data-governance-mysql.integration.spec.ts';
const expectedMigrationCount = readdirSync('apps/api/prisma-mysql/migrations', {
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

function mysqlArgs(sql) {
  return [
    'exec',
    containerName,
    'mysql',
    '--user=root',
    `--password=${databasePassword}`,
    '--batch',
    '--skip-column-names',
    databaseName,
    '--execute',
    sql
  ];
}

try {
  run('docker', [
    'run',
    '--rm',
    '--detach',
    '--name',
    containerName,
    '--env',
    `MYSQL_ROOT_PASSWORD=${databasePassword}`,
    '--env',
    `MYSQL_DATABASE=${databaseName}`,
    '--publish',
    '127.0.0.1::3306',
    'mysql:8.4',
    '--character-set-server=utf8mb4',
    '--collation-server=utf8mb4_0900_ai_ci',
    '--default-time-zone=+00:00',
    '--sql-mode=ANSI_QUOTES,STRICT_TRANS_TABLES,ERROR_FOR_DIVISION_BY_ZERO,NO_ENGINE_SUBSTITUTION',
    '--log-bin-trust-function-creators=1'
  ]);

  let ready = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const probe = spawnSync(
      'docker',
      [
        'exec',
        containerName,
        'mysqladmin',
        'ping',
        '--host=127.0.0.1',
        '--user=root',
        `--password=${databasePassword}`,
        '--silent'
      ],
      { encoding: 'utf8' }
    );
    if (probe.status === 0) {
      ready = true;
      break;
    }
    await wait(500);
  }
  if (!ready) throw new Error('数据治理隔离 MySQL 在 60 秒内未就绪');

  const portOutput = run('docker', ['port', containerName, '3306/tcp']);
  const portMatch = portOutput.match(/:(\d+)$/m);
  if (!portMatch) throw new Error('无法解析数据治理隔离 MySQL 端口');
  const databaseUrl = `mysql://root:${databasePassword}@127.0.0.1:${portMatch[1]}/${databaseName}`;

  run('npm', ['run', 'prisma:mysql:generate'], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: databaseUrl }
  });
  run('npx', ['prisma', 'migrate', 'deploy', '--schema', schemaPath], {
    stdio: 'inherit',
    env: { ...process.env, DATABASE_URL: databaseUrl }
  });
  run(
    'npm',
    ['run', 'test', '--workspace', '@apple-business/api', '--', '--run', integrationSpec],
    {
      stdio: 'inherit',
      env: {
        ...process.env,
        DATABASE_URL: databaseUrl,
        V2_DATA_GOVERNANCE_DATABASE_URL: databaseUrl
      }
    }
  );

  const state = JSON.parse(
    run(
      'docker',
      mysqlArgs(`SELECT JSON_OBJECT(
        'migrations', (SELECT COUNT(*) FROM _prisma_migrations
          WHERE finished_at IS NOT NULL AND rolled_back_at IS NULL),
        'failedMigrations', (SELECT COUNT(*) FROM _prisma_migrations
          WHERE finished_at IS NULL AND rolled_back_at IS NULL),
        'users', (SELECT COUNT(*) FROM users),
        'customers', (SELECT COUNT(*) FROM id_business_v2_customers),
        'jobs', (SELECT COUNT(*) FROM id_business_v2_governance_jobs),
        'items', (SELECT COUNT(*) FROM id_business_v2_governance_job_items),
        'approvals', (SELECT COUNT(*) FROM id_business_v2_governance_approvals),
        'checkpoints', (SELECT COUNT(*) FROM id_business_v2_governance_checkpoints),
        'auditLogs', (SELECT COUNT(*) FROM audit_logs),
        'orderSnapshots', (SELECT COUNT(*) FROM id_business_v2_order_display_snapshots)
      );`)
    )
  );
  const expectedState = {
    migrations: expectedMigrationCount,
    failedMigrations: 0,
    users: 2,
    customers: 1,
    jobs: 3,
    items: 3,
    approvals: 2,
    checkpoints: 2,
    auditLogs: 10,
    orderSnapshots: 1
  };
  if (
    Object.entries(expectedState).some(
      ([key, expectedValue]) => Number(state[key]) !== expectedValue
    )
  ) {
    throw new Error(`数据治理隔离库终态不符合预期：${JSON.stringify(state)}`);
  }

  console.log(
    JSON.stringify({
      ok: true,
      database: databaseName,
      workflow: [
        'empty-database-check',
        'requester-preview',
        'requester-cancel',
        'cancelled-task-approval-rejected',
        'replacement-preview',
        'self-approval-rejected',
        'independent-approval',
        'immutable-preview',
        'batch-execution',
        'idempotent-replay',
        'approved-exchange-rate-cleanup',
        'final-state-check'
      ],
      verifiedState: state,
      cleanup: 'remove-disposable-mysql-container'
    })
  );
} finally {
  spawnSync('docker', ['rm', '--force', containerName], { stdio: 'ignore' });
}

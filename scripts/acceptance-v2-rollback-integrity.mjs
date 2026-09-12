import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';

const containerName = `id-business-v2-rollback-integrity-${process.pid}`;
const databaseName = `id_business_v2_rollback_integrity_${process.pid}`;
const databasePassword = 'v2_rollback_drill_only';
const schemaPath = 'apps/api/prisma-mysql/schema.prisma';
const integrationSpec =
  'src/id-business-v2/finance/id-business-v2-rollback-integrity-mysql.integration.spec.ts';
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
  if (!ready) throw new Error('回滚验收隔离 MySQL 在 60 秒内未就绪');

  const portOutput = run('docker', ['port', containerName, '3306/tcp']);
  const portMatch = portOutput.match(/:(\d+)$/m);
  if (!portMatch) throw new Error('无法解析回滚验收隔离 MySQL 端口');
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
        V2_FINANCIAL_INTEGRITY_DATABASE_URL: databaseUrl
      }
    }
  );

  run('node', ['--test', 'scripts/v2-data-integrity-mysql.test.mjs'], {
    stdio: 'inherit',
    env: { ...process.env, V2_FINANCIAL_INTEGRITY_DATABASE_URL: databaseUrl }
  });

  console.log(
    JSON.stringify({
      ok: true,
      suite: 'rollback-delete-restore',
      migrations: expectedMigrationCount,
      cleanup: 'remove-disposable-mysql-container'
    })
  );
} finally {
  spawnSync('docker', ['rm', '--force', containerName], { stdio: 'ignore' });
}

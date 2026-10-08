import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import {
  parseNativeMysqlTestOptions,
  startNativeMysqlTestInstance
} from './lib/native-mysql-test-instance.mjs';

const containerName = `id-business-v2-rollback-integrity-${process.pid}`;
const databaseName = `id_business_v2_rollback_integrity_${process.pid}`;
const runtimeOptions = parseNativeMysqlTestOptions(process.argv.slice(2));
let databasePassword = 'v2_rollback_drill_only';
let nativeInstance;
const testCounts = [];
let createdContainerId;
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
    ...options,
    ...(runtimeOptions.runtime === 'native' ? { stdio: 'pipe' } : {})
  });
  if (result.status !== 0) {
    if (runtimeOptions.runtime === 'native')
      throw new Error('回滚原生验收子进程失败；SQL、凭据和原始输出已隐藏');
    const detail = [result.stdout, result.stderr].filter(Boolean).join('\n').trim();
    throw new Error(`${command} ${args.join(' ')} failed${detail ? `\n${detail}` : ''}`);
  }
  if (runtimeOptions.runtime === 'native') {
    const ansi = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
    const output = (result.stdout || '').replace(ansi, '');
    for (const match of output.matchAll(/\b(Test Files|Tests)\s+(\d+) passed\s*\((\d+)\)/g))
      testCounts.push({ kind: match[1], passed: Number(match[2]), total: Number(match[3]) });
    for (const match of output.matchAll(/(?:^|\n)[ℹ#] (tests|pass|fail|skipped) (\d+)\b/g))
      testCounts.push({ kind: match[1], count: Number(match[2]) });
  }
  return result.stdout?.trim() ?? '';
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

try {
  let portMatch;
  if (runtimeOptions.runtime === 'native') {
    nativeInstance = await startNativeMysqlTestInstance({
      mysqlBin: runtimeOptions.mysqlBin,
      database: databaseName
    });
    databasePassword = nativeInstance.rootPassword;
    portMatch = [String(nativeInstance.port), String(nativeInstance.port)];
  } else {
    createdContainerId = run('docker', [
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
    portMatch = portOutput.match(/:(\d+)$/m);
    if (!portMatch) throw new Error('无法解析回滚验收隔离 MySQL 端口');
  }
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
      runtime: runtimeOptions.runtime,
      ...(runtimeOptions.runtime === 'native' ? { testCounts } : {}),
      cleanup:
        runtimeOptions.runtime === 'native'
          ? 'remove-owned-disposable-native-mysql'
          : 'remove-owned-disposable-mysql-container'
    })
  );
} finally {
  if (nativeInstance) await nativeInstance.cleanup();
  if (createdContainerId && /^[a-f0-9]{64}$/.test(createdContainerId))
    spawnSync('docker', ['rm', '--force', createdContainerId], { stdio: 'ignore' });
}

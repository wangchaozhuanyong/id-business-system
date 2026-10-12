// Own empty native database only; no production configuration or browser requests.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, cpSync, readdirSync, readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startNativeMysqlTestInstance } from './lib/native-mysql-test-instance.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const mysqlBin = process.argv.find((arg) => arg.startsWith('--mysql-bin='))?.slice(12);
if (!mysqlBin) throw new Error('需要指定本机已有 MySQL 8.4 安装目录');
const output = resolve(root, '.runtime/employee-connections-20261012');
mkdirSync(output, { recursive: true });
const database = 'id_business_v2_employee_connections_' + Date.now();
const instance = await startNativeMysqlTestInstance({ mysqlBin, database, project: root });
const report = {
  scope: 'OWNED_EMPTY_DATABASE',
  productionActions: 0,
  browserRequests: 0,
  migration: 'NOT_RUN',
  databaseTests: 'NOT_RUN',
  cleanup: 'NOT_RUN'
};
try {
  const url = `mysql://root:${instance.rootPassword}@127.0.0.1:${instance.port}/${database}`;
  const env = Object.fromEntries(
    ['PATH', 'HOME', 'LANG', 'LC_ALL', 'TMPDIR']
      .filter((key) => process.env[key])
      .map((key) => [key, process.env[key]])
  );
  Object.assign(env, { DATABASE_URL: url, V2_RECHARGE_TEST_DATABASE_URL: url });
  async function migrate(schema, logName) {
    const child = spawn(
      process.execPath,
      [
        resolve(root, 'node_modules/prisma/build/index.js'),
        'migrate',
        'deploy',
        '--schema',
        schema
      ],
      { cwd: resolve(root, 'apps/api'), env, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    let log = '';
    child.stdout.on('data', (value) => {
      log += value;
    });
    child.stderr.on('data', (value) => {
      log += value;
    });
    const code = await new Promise((done, reject) => {
      child.once('error', reject);
      child.once('exit', done);
    });
    writeFileSync(resolve(output, logName), log.replaceAll(instance.rootPassword, '[redacted]'));
    if (code !== 0) {
      report.migration = 'FAIL';
      throw new Error('隔离迁移失败，脱敏日志已保存');
    }
  }
  const fixture = resolve(output, 'legacy-migration-fixture');
  const legacyMigrations = resolve(fixture, 'migrations');
  mkdirSync(legacyMigrations, { recursive: true });
  const migrationRoot = resolve(root, 'apps/api/prisma-mysql/migrations');
  for (const name of readdirSync(migrationRoot)) {
    if (name === '20261012143000_recharge_connection_profiles') continue;
    cpSync(resolve(migrationRoot, name), resolve(legacyMigrations, name), { recursive: true });
  }
  writeFileSync(
    resolve(fixture, 'schema.prisma'),
    readFileSync(resolve(root, 'apps/api/prisma-mysql/schema.prisma'))
  );
  await migrate(resolve(fixture, 'schema.prisma'), 'mysql-legacy-migration.log');
  instance.query(
    `INSERT INTO id_business_v2_recharge_browser_settings
    (owner_id, local_api_token_encrypted, connector_token_encrypted, browser_options, updated_at)
    VALUES ('synthetic-upgrade-owner', 'synthetic-existing-api-ciphertext',
      'synthetic-existing-helper-ciphertext', JSON_OBJECT('accountCopySuffix', 'synthetic suffix'), UTC_TIMESTAMP(3));`,
    database
  );
  const fingerprintSql = `SELECT SHA2(CONCAT_WS('|', owner_id, local_api_token_encrypted,
    connector_token_encrypted, browser_options, connector_url, local_api_url, updated_at), 256)
    FROM id_business_v2_recharge_browser_settings WHERE owner_id='synthetic-upgrade-owner';`;
  const before = instance.query(fingerprintSql, database);
  await migrate(resolve(root, 'apps/api/prisma-mysql/schema.prisma'), 'mysql-migration.log');
  if (before !== instance.query(fingerprintSql, database)) throw new Error('迁移改动了原连接配置');
  report.migration = 'PASS_FORWARD_CHAIN_AND_EXISTING_DEFAULT_UNCHANGED';
  let log = '';
  const child = spawn(
    process.execPath,
    [
      resolve(root, 'node_modules/vitest/vitest.mjs'),
      'run',
      'src/id-business-v2/auto-recharge/recharge-employee-concurrency.mysql.integration.spec.ts'
    ],
    { cwd: resolve(root, 'apps/api'), env, stdio: ['ignore', 'pipe', 'pipe'] }
  );
  child.stdout.on('data', (value) => {
    log += value;
  });
  child.stderr.on('data', (value) => {
    log += value;
  });
  const code = await new Promise((done, reject) => {
    child.once('error', reject);
    child.once('exit', done);
  });
  const sanitized = log.replaceAll(instance.rootPassword, '[redacted]');
  writeFileSync(resolve(output, 'mysql-concurrency-tests.log'), sanitized);
  report.databaseTests = code === 0 ? 'PASS' : 'FAIL';
  if (code !== 0) process.exitCode = 1;
  console.log(sanitized);
} finally {
  await instance.cleanup();
  report.cleanup = 'PASS_OWN_INSTANCE_ONLY';
  writeFileSync(
    resolve(output, 'mysql-concurrency-result.json'),
    JSON.stringify(report, null, 2) + '\n'
  );
}

// Own empty database only; no production configuration or browser requests.
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync, cpSync, readdirSync, readFileSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  parseOwnedMysqlTestOptions,
  startOwnedMysqlTestInstance
} from './lib/owned-mysql-test-instance.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
export const rechargeEmployeeDatabaseTestFiles = Object.freeze([
  'src/id-business-v2/auto-recharge/recharge-employee-concurrency.mysql.integration.spec.ts',
  'src/id-business-v2/auto-recharge/recharge-subscription-cycle.mysql.integration.spec.ts',
  'src/id-business-v2/auto-recharge/recharge-callback-receipts.mysql.integration.spec.ts'
]);

export function rechargeEmployeeDatabaseName(combinedRelease) {
  const suffix = combinedRelease ? 'flow_' : '';
  return `id_business_v2_employee_connections_${suffix}${Date.now()}`;
}

export function parseRechargeEmployeeAcceptanceOptions(args, environment = process.env) {
  const combinedFlags = args.filter((arg) => arg === '--combined-release').length;
  if (combinedFlags > 1) throw new Error('组合发布验收参数不能重复');
  const combinedRelease = combinedFlags === 1;
  if (combinedRelease && environment.GITHUB_ACTIONS !== 'true')
    throw new Error('组合发布数据库验收仅允许在 GitHub Actions 运行');
  return {
    ...parseOwnedMysqlTestOptions(
      args.filter((arg) => arg !== '--combined-release'),
      { legacyNative: true }
    ),
    combinedRelease
  };
}

export function validateRechargeEmployeeTestReport(value, files) {
  const valid =
    value?.success === true &&
    Number.isInteger(value.numTotalTests) &&
    value.numTotalTests > 0 &&
    value.numPassedTests === value.numTotalTests &&
    value.numFailedTests === 0 &&
    value.numPendingTests === 0 &&
    value.numTodoTests === 0 &&
    value.numFailedTestSuites === 0 &&
    value.numPendingTestSuites === 0 &&
    Array.isArray(value.testResults) &&
    value.testResults.length === files.length;
  if (!valid) throw new Error('数据库验收回执含失败、跳过或缺失测试');
  const expected = new Set(files.map((file) => resolve(root, 'apps/api', file)));
  let count = 0;
  for (const result of value.testResults) {
    if (
      !expected.delete(result.name) ||
      result.status !== 'passed' ||
      !Array.isArray(result.assertionResults) ||
      !result.assertionResults.length ||
      result.assertionResults.some((assertion) => assertion.status !== 'passed')
    )
      throw new Error('数据库验收文件未全部实际通过');
    count += result.assertionResults.length;
  }
  if (expected.size || count !== value.numTotalTests)
    throw new Error('数据库验收文件或测试数量不一致');
  return {
    testFiles: files.length,
    testFilesPassed: files.length,
    testsTotal: count,
    testsPassed: count,
    testsSkipped: 0,
    testsTodo: 0
  };
}

async function main() {
  const options = parseRechargeEmployeeAcceptanceOptions(process.argv.slice(2));
  const files = options.combinedRelease
    ? rechargeEmployeeDatabaseTestFiles
    : rechargeEmployeeDatabaseTestFiles.slice(0, 1);
  for (const path of ['.env', 'apps/api/.env', 'apps/api/prisma-mysql/.env'])
    if (existsSync(resolve(root, path))) throw new Error('验收副本不能含自动读取的环境文件');
  const output = resolve(root, '.runtime/employee-connections-20261012');
  mkdirSync(output, { recursive: true });
  const database = rechargeEmployeeDatabaseName(options.combinedRelease);
  const instance = await startOwnedMysqlTestInstance({
    runtime: options.runtime,
    mysqlBin: options.mysqlBin,
    database,
    project: root
  });
  const report = {
    scope: 'OWNED_EMPTY_DATABASE',
    runtime: instance.runtime,
    productionActions: 0,
    browserRequests: 0,
    migration: 'NOT_RUN',
    databaseTests: 'NOT_RUN',
    testFiles: files.length,
    testFilesPassed: 0,
    testsTotal: null,
    testsPassed: null,
    testsSkipped: null,
    testsTodo: null,
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
    if (before !== instance.query(fingerprintSql, database))
      throw new Error('迁移改动了原连接配置');
    report.migration = 'PASS_FORWARD_CHAIN_AND_EXISTING_DEFAULT_UNCHANGED';
    let stdout = '';
    let stderr = '';
    const child = spawn(
      process.execPath,
      [resolve(root, 'node_modules/vitest/vitest.mjs'), 'run', '--reporter=json', ...files],
      { cwd: resolve(root, 'apps/api'), env, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    child.stdout.on('data', (value) => {
      stdout += value;
    });
    child.stderr.on('data', (value) => {
      stderr += value;
    });
    const code = await new Promise((done, reject) => {
      child.once('error', reject);
      child.once('exit', done);
    });
    const sanitized = (stdout + '\n' + stderr).replaceAll(instance.rootPassword, '[redacted]');
    writeFileSync(resolve(output, 'mysql-concurrency-tests.log'), sanitized);
    report.databaseTests = 'FAIL';
    if (code === 0) {
      let value;
      try {
        value = JSON.parse(stdout);
      } catch {
        throw new Error('数据库验收没有返回有效测试回执，脱敏日志已保存');
      }
      Object.assign(report, validateRechargeEmployeeTestReport(value, files));
      report.databaseTests = 'PASS';
    } else process.exitCode = 1;
    console.log(sanitized);
  } finally {
    await instance.cleanup();
    report.cleanup = 'PASS_OWN_INSTANCE_ONLY';
    writeFileSync(
      resolve(output, 'mysql-concurrency-result.json'),
      JSON.stringify(report, null, 2) + '\n'
    );
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();

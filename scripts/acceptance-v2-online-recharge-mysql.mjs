import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  startNativeMysqlTestInstance,
  parseNativeMysqlTestOptions
} from './lib/native-mysql-test-instance.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const options = parseNativeMysqlTestOptions(process.argv.slice(2));
assert.equal(options.runtime, 'native', '本专项入口仅支持新建原生隔离 MySQL');
const evidence = resolve(root, '.runtime/online-recharge');
mkdirSync(evidence, { recursive: true });
const report = {
  scope: 'OWNED_EMPTY_MYSQL_ONLY',
  migration: 'NOT_RUN',
  databaseChecks: [],
  tests: [],
  realPayment: 'NOT_MEASURED'
};
let instance;
function execute(args, env, cwd) {
  const result = spawnSync(process.execPath, args, {
    cwd,
    env,
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.status !== 0) {
    let diagnostics = `${result.stderr ?? ''}\n${result.stdout ?? ''}`;
    for (const value of Object.values(env).filter(
      (value) => typeof value === 'string' && value.length >= 16
    ))
      diagnostics = diagnostics.split(value).join('[隐藏]');
    if (instance?.rootPassword)
      diagnostics = diagnostics.split(instance.rootPassword).join('[隐藏]');
    diagnostics = diagnostics.replace(/mysql:\/\/[^\s"']+/g, '[隐藏数据库连接]');
    throw new Error(diagnostics.slice(-12000) || '隔离数据库步骤未通过');
  }
  return result.stdout;
}
try {
  instance = await startNativeMysqlTestInstance({
    mysqlBin: options.mysqlBin,
    database: 'id_business_v2_online_recharge_fixture',
    project: root
  });
  const env = {
    PATH: process.env.PATH,
    HOME: process.env.HOME,
    NODE_ENV: 'test',
    DATABASE_URL: `mysql://root:${instance.rootPassword}@127.0.0.1:${instance.port}/${instance.database}`,
    FIELD_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    HASH_SECRET: randomBytes(32).toString('hex'),
    ONLINE_RECHARGE_WORKER_KEY: randomBytes(32).toString('base64url'),
    ONLINE_RECHARGE_MYSQL_TEST: '1'
  };
  execute(
    [
      resolve(root, 'node_modules/prisma/build/index.js'),
      'migrate',
      'deploy',
      '--schema',
      'prisma-mysql/schema.prisma'
    ],
    env,
    resolve(root, 'apps/api')
  );
  report.migration = 'PASS';
  const count = Number(
    instance.query(
      "SELECT COUNT(*) FROM information_schema.tables WHERE table_schema=DATABASE() AND table_name LIKE 'online_recharge_%'",
      instance.database
    )
  );
  assert.equal(count, 9);
  assert.equal(
    Number(
      instance.query(
        "SELECT COUNT(*) FROM information_schema.columns WHERE table_schema=DATABASE() AND table_name LIKE 'online_recharge_%' AND LOWER(column_name) IN ('cvc','cvv','security_code')",
        instance.database
      )
    ),
    0
  );
  assert.equal(
    Number(
      instance.query(
        "SELECT COUNT(*) FROM permissions WHERE code LIKE 'id_business_v2.online_recharge.%'",
        instance.database
      )
    ),
    3
  );
  assert.equal(
    Number(
      instance.query(
        "SELECT COUNT(*) FROM permissions WHERE code='id_business_v2.online_recharge.sensitive' AND action='sensitive'",
        instance.database
      )
    ),
    1
  );
  assert.equal(
    Number(
      instance.query(
        "SELECT COUNT(*) FROM id_business_v2_scope_versions WHERE scope='online-recharge'",
        instance.database
      )
    ),
    1
  );
  report.databaseChecks.push(
    '专属九表',
    '没有安全码字段',
    '三项独立权限',
    '敏感权限登记',
    '独立数据范围'
  );
  // 验证新权限只给现有管理员；合成角色不包含用户，不触碰生产资料。
  instance.query(
    "INSERT INTO roles (id,name,code,created_at,updated_at) VALUES ('ac710000-0000-4000-8000-000000000001','隔离管理员','admin',NOW(6),NOW(6)),('ac710000-0000-4000-8000-000000000002','隔离员工','employee',NOW(6),NOW(6))",
    instance.database
  );
  const permissionDml = readFileSync(
    resolve(root, 'apps/api/prisma-mysql/migrations/20261009093000_online_recharge/migration.sql'),
    'utf8'
  ).split('-- 仅登记本模块权限；')[1];
  assert.ok(permissionDml);
  instance.query('-- 仅登记本模块权限；' + permissionDml, instance.database);
  assert.equal(
    Number(
      instance.query(
        "SELECT COUNT(*) FROM role_permissions WHERE role_id='ac710000-0000-4000-8000-000000000001'",
        instance.database
      )
    ),
    3
  );
  assert.equal(
    Number(
      instance.query(
        "SELECT COUNT(*) FROM role_permissions WHERE role_id='ac710000-0000-4000-8000-000000000002'",
        instance.database
      )
    ),
    0
  );
  report.databaseChecks.push('管理员默认权限', '员工无自动权限', '权限初始化幂等');
  const output = execute(
    [
      resolve(root, 'node_modules/vitest/vitest.mjs'),
      'run',
      'src/id-business-v2/online-recharge/mysql.integration.spec.ts',
      '--reporter=json',
      '--silent'
    ],
    env,
    resolve(root, 'apps/api')
  );
  const start = output.indexOf('{');
  const results = JSON.parse(output.slice(start));
  assert.equal(results.numFailedTests, 0);
  assert.ok(results.numPassedTests > 0);
  report.tests = results.testResults.flatMap((file) =>
    file.assertionResults.map((test) => ({ title: test.title, status: test.status }))
  );
  report.passedTests = results.numPassedTests;
  report.status = 'PASS';
} catch (error) {
  report.status = 'FAIL';
  report.error =
    error instanceof assert.AssertionError
      ? '隔离检查断言未通过'
      : String(error.message ?? '隔离迁移或专项执行未通过');
  process.exitCode = 1;
} finally {
  if (instance) await instance.cleanup();
  writeFileSync(resolve(evidence, 'mysql-acceptance.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(JSON.stringify(report));
}

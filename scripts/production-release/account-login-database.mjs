// CI-owned disposable MySQL only. Never inherit or print a database connection.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startOwnedMysqlTestInstance } from '../lib/owned-mysql-test-instance.mjs';

const root = fileURLToPath(new URL('../../', import.meta.url));
assert.equal(process.env.GITHUB_ACTIONS, 'true', '仅允许远端隔离 CI 验证数据库');
assert.match(process.env.GITHUB_RUN_ID ?? '', /^\d+$/);
const quality = process.argv.includes('--quality');
const output = resolve(
  root,
  quality ? '.deploy/account-login-quality' : '.deploy/account-login-release'
);
const candidate = quality ? root : resolve(output, 'candidate');
mkdirSync(output, { recursive: true });
const contract = JSON.parse(
  readFileSync(resolve(root, 'scripts/production-release/account-login-contract.json'))
);
let baseline = resolve(output, 'baseline');
if (quality) {
  mkdirSync(baseline);
  const archive = spawnSync('git', ['archive', contract.reviewBase, 'apps/api/prisma-mysql'], {
    cwd: root,
    maxBuffer: 16 * 1024 ** 2
  });
  assert.equal(archive.status, 0, '隔离基线来源不可用');
  const extracted = spawnSync('tar', ['-xf', '-', '-C', baseline], { input: archive.stdout });
  assert.equal(extracted.status, 0, '隔离基线解包失败');
}
const owned = await startOwnedMysqlTestInstance({
  runtime: 'docker',
  database: 'id_business_v2_financial_integrity_' + process.env.GITHUB_RUN_ID,
  project: candidate
});
try {
  const env = { ...process.env };
  for (const n of Object.keys(env)) if (/DATABASE_URL$/.test(n)) delete env[n];
  const url = `mysql://root:${owned.rootPassword}@127.0.0.1:${owned.port}/${owned.database}`;
  env.DATABASE_URL = url;
  function execute(cwd, args) {
    const r = spawnSync(process.execPath, args, {
      cwd,
      env,
      encoding: 'utf8',
      timeout: 300000,
      maxBuffer: 16 * 1024 ** 2
    });
    // Prisma diagnostics may include connection details. Never forward them.
    assert.equal(r.status, 0, '隔离迁移或事务验收失败；连接详情已隐藏');
    return r;
  }
  const cli = [
    'node_modules/prisma/build/index.js',
    'migrate',
    'deploy',
    '--schema',
    'apps/api/prisma-mysql/schema.prisma'
  ];
  if (quality) {
    execute(candidate, [
      cli[0],
      'migrate',
      'deploy',
      '--schema',
      resolve(baseline, 'apps/api/prisma-mysql/schema.prisma')
    ]);
  } else execute(baseline, cli);
  owned.query(
    "INSERT INTO id_business_v2_chatgpt_accounts (id,email_encrypted,email_hash,email_masked,registered,updated_at) VALUES ('00000000-0000-4000-8000-000000000001','fixture',REPEAT('a',64),'legacy***@example.invalid',1,'2026-01-01'),('00000000-0000-4000-8000-000000000002','fixture',REPEAT('b',64),'legacy***@example.invalid',0,'2026-01-01')"
  );
  const before = owned.query(
    'SELECT id,email_encrypted,email_hash,email_masked,registered,updated_at FROM id_business_v2_chatgpt_accounts ORDER BY id'
  );
  execute(candidate, cli);
  assert.equal(
    owned.query(
      'SELECT id,email_encrypted,email_hash,email_masked,registered,updated_at FROM id_business_v2_chatgpt_accounts ORDER BY id'
    ),
    before
  );
  assert.equal(
    owned.query(
      'SELECT COUNT(*) FROM id_business_v2_chatgpt_accounts WHERE JSON_LENGTH(email_search_tokens)=0'
    ),
    '2'
  );
  owned.query(
    "DELETE FROM id_business_v2_chatgpt_accounts WHERE id IN ('00000000-0000-4000-8000-000000000001','00000000-0000-4000-8000-000000000002')"
  );
  env.V2_BANK_RECHARGE_TEST_DATABASE_URL = url;
  env.V2_FINANCIAL_INTEGRITY_DATABASE_URL = url;
  const reportPath = resolve(output, 'mysql-vitest.json');
  execute(resolve(candidate, 'apps/api'), [
    '../../node_modules/vitest/vitest.mjs',
    'run',
    'src/id-business-v2/auto-recharge/bank-recharge-account-sales.mysql.integration.spec.ts',
    'src/id-business-v2/auto-recharge/bank-recharge-mysql.integration.spec.ts',
    '--reporter=json',
    '--outputFile=' + reportPath
  ]);
  const report = JSON.parse(readFileSync(reportPath));
  assert.equal(report.success, true);
  assert.equal(report.numPassedTests, 7);
  assert.equal(report.numPendingTests, 0);
  assert.equal(report.numFailedTests, 0);
  writeFileSync(
    resolve(output, 'database-verification.json'),
    JSON.stringify({
      isolated: true,
      migration: contract.migration.name,
      legacyDefaultsVerified: true,
      testsPassed: 7,
      testsSkipped: 0,
      businessActions: 0
    }) + '\n'
  );
  console.log('账号搜索及日期远端隔离迁移和 7 项事务验收通过');
} finally {
  await owned.cleanup();
}

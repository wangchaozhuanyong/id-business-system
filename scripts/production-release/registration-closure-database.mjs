// Remote disposable databases only; never accept an inherited connection URL.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
const root = fileURLToPath(new URL('../../', import.meta.url));
assert.equal(process.env.GITHUB_ACTIONS, 'true', '联合数据库验证仅在远端隔离 CI 执行');
const output = resolve(root, '.deploy/registration-closure-release');
const candidate = resolve(output, 'candidate');
const python = resolve(output, 'python/bin/python');
const env = { ...process.env };
for (const key of ['DATABASE_URL', 'V2_RECHARGE_TEST_DATABASE_URL']) delete env[key];
for (const [script, args] of [
  [
    'scripts/acceptance-v2-registration-mirror-mysql.mjs',
    ['--runtime=docker', `--python=${python}`]
  ],
  ['scripts/acceptance-v2-shared-proxy-mysql.mjs', []]
]) {
  const result = spawnSync(process.execPath, [resolve(candidate, script), ...args], {
    cwd: candidate,
    env,
    stdio: 'inherit',
    timeout: 720000
  });
  assert.equal(result.status, 0, '隔离数据库验证未通过');
}
// The scripts keep safe receipts containing counts and classifications only.
const registration = JSON.parse(
  readFileSync(
    resolve(candidate, '.runtime/registration-closed-loop-20261011/mirror-mysql-acceptance.json'),
    'utf8'
  )
);
assert.equal(registration.status, 'PASS');
assert.equal(registration.jointClosedLoop.status, 'PASS');
assert.equal(registration.externalRequests, 0);
const proxy = JSON.parse(
  readFileSync(resolve(candidate, '.runtime/shared-proxy-mysql/result.json'), 'utf8')
);
assert.equal(proxy.status, 'PASS');
mkdirSync(output, { recursive: true });
writeFileSync(
  resolve(output, 'database-verification.json'),
  JSON.stringify({
    isolated: true,
    registrationMysqlSqlite: 'PASS',
    proxyMysql: 'PASS',
    externalRequests: 0,
    businessActions: 0
  }) + '\n'
);

// Run only on a disposable GitHub runner, never against a caller-supplied database.
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
assert.equal(process.env.GITHUB_ACTIONS, 'true', '共用代理池数据库验收仅在远端 CI 隔离环境运行');
const root = fileURLToPath(new URL('../', import.meta.url));
const directory = resolve(root, '.runtime/shared-proxy-mysql');
mkdirSync(directory, { recursive: true });
const name = 'shared-proxy-fixture-' + randomUUID();
const password = randomBytes(32).toString('hex');
const image = 'mysql:8.4@sha256:b3b90af2a6552ae30c266fdb7d5dd55f3afb72404bb78d37fe8a23eb857fd3fb';
let container;
function run(file, args, options = {}) {
  const result = spawnSync(file, args, {
    cwd: root,
    encoding: 'utf8',
    timeout: 180000,
    maxBuffer: 16 * 1024 * 1024,
    ...options
  });
  if (result.status !== 0) {
    const message = `${result.stdout || ''}\n${result.stderr || ''}`
      .replaceAll(password, '[隐藏]')
      .replace(/mysql:\/\/[^\s"']+/g, '[隐藏数据库连接]');
    throw new Error(message.slice(-16000) || '隔离数据库步骤失败');
  }
  return result.stdout.trim();
}
try {
  container = run(
    'docker',
    [
      'run',
      '-d',
      '--name',
      name,
      '-p',
      '127.0.0.1::3306',
      '--tmpfs',
      '/var/lib/mysql:rw,nosuid,size=1g',
      '-e',
      'MYSQL_ROOT_PASSWORD',
      '-e',
      'MYSQL_DATABASE=id_business_v2_online_recharge_fixture',
      image
    ],
    { env: { ...process.env, MYSQL_ROOT_PASSWORD: password } }
  );
  assert.match(container, /^[a-f0-9]{64}$/);
  const port = JSON.parse(run('docker', ['inspect', container]))[0].NetworkSettings.Ports[
    '3306/tcp'
  ][0].HostPort;
  const deadline = Date.now() + 120000;
  while (true) {
    const ready = spawnSync(
      'docker',
      [
        'exec',
        '-e',
        'MYSQL_PWD',
        container,
        'mysqladmin',
        '-h127.0.0.1',
        '-uroot',
        'ping',
        '--silent'
      ],
      { env: { ...process.env, MYSQL_PWD: password }, stdio: 'ignore' }
    );
    if (ready.status === 0) break;
    assert.ok(Date.now() < deadline, '隔离数据库启动超时');
    await new Promise((resolve) => setTimeout(resolve, 1000));
  }
  const env = {
    ...process.env,
    NODE_ENV: 'test',
    DATABASE_URL: `mysql://root:${password}@127.0.0.1:${port}/id_business_v2_online_recharge_fixture`,
    FIELD_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
    HASH_SECRET: randomBytes(32).toString('hex'),
    ONLINE_RECHARGE_WORKER_KEY: randomBytes(32).toString('base64url'),
    ONLINE_RECHARGE_MYSQL_TEST: '1'
  };
  run(
    process.execPath,
    [
      resolve(root, 'node_modules/prisma/build/index.js'),
      'migrate',
      'deploy',
      '--schema',
      resolve(root, 'apps/api/prisma-mysql/schema.prisma')
    ],
    { env }
  );
  const output = run(
    'npm',
    [
      'run',
      'test',
      '--workspace',
      '@apple-business/api',
      '--',
      'src/id-business-v2/online-recharge/mysql.integration.spec.ts'
    ],
    { env, timeout: 240000 }
  );
  console.log(output);
  writeFileSync(
    resolve(directory, 'result.json'),
    JSON.stringify(
      {
        status: 'PASS',
        scope: 'OWNED_EMPTY_DOCKER_MYSQL_8_4_ONLY',
        migration: 'PASS',
        integration: 'PASS',
        realPayment: 'NOT_RUN'
      },
      null,
      2
    ) + '\n'
  );
} finally {
  if (container) run('docker', ['rm', '-f', container]);
}

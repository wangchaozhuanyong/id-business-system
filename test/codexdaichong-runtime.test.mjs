import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { checkProductionDatabase, isolatedCodexdaichongEnv, productionRuntimeEnv } from '../modules/recharge/codexdaichong/runtime.mjs';
import { probeCodexdaichongRuntime } from '../modules/recharge/codexdaichong/runtime-health.mjs';

test('isolated startup rejects implicit, remote and shared databases and only forwards allowed settings', () => {
  const env = {
    PORT: '43101',
    DB_HOST: '127.0.0.1',
    DB_PORT: '43102',
    DB_NAME: 'id_redesign_codexdaichong_test_fixture',
    DB_USER: 'fixture_user',
    DB_PASSWORD: randomBytes(18).toString('hex'),
    ID_RECHARGE_BRIDGE_SECRET: randomBytes(32).toString('hex')
  };
  assert.throws(() => isolatedCodexdaichongEnv({}), /缺少隔离运行配置/);
  assert.throws(
    () => isolatedCodexdaichongEnv({ ...env, DB_HOST: 'mysql.example.test' }),
    /回环 MySQL/
  );
  assert.throws(
    () => isolatedCodexdaichongEnv({ ...env, DB_NAME: 'id_redesign_codexdaichong' }),
    /专用测试库/
  );
  assert.throws(() => isolatedCodexdaichongEnv({ ...env, DB_USER: ' ROOT ' }), /非 root/);
  assert.throws(() => isolatedCodexdaichongEnv({ ...env, PORT: env.DB_PORT }), /不同的有效端口/);
  assert.deepEqual(
    isolatedCodexdaichongEnv({ ...env, NODE_OPTIONS: '--inspect', OTHER: 'fixture' }),
    env
  );
});

test('production preflight checks the actual dedicated database and rejects active tasks or asset locks', async () => {
  const env = {
    PORT: '43101', DB_HOST: '127.0.0.1', DB_PORT: '43102',
    DB_NAME: 'id_redesign_codexdaichong_prod', DB_USER: 'id_redesign_recharge',
    DB_PASSWORD: randomBytes(18).toString('hex'), ID_RECHARGE_BRIDGE_SECRET: randomBytes(32).toString('hex')
  };
  const result = { databaseName: env.DB_NAME, account: env.DB_USER + '@localhost', pending: 0, assetsLocked: 0 };
  const check = (row, database = env) => checkProductionDatabase(database, async ({ host, database: name }) => {
    assert.equal(host, '127.0.0.1');
    assert.equal(name, env.DB_NAME);
    let reads = 0;
    return {
      async query({ sql }) {
        if (reads++ === 0) assert.equal(sql, 'START TRANSACTION READ ONLY');
        else assert.match(sql.trim(), /^SELECT DATABASE\(\)/);
        return [[row]];
      },
      async end() { assert.equal(reads, 2); }
    };
  });
  await check(result);
  await assert.rejects(check(result, { ...env, DB_NAME: 'id_redesign_codexdaichong_test' }), /专用回环/);
  await assert.rejects(check({ ...result, account: 'root@localhost' }), /实际身份/);
  await assert.rejects(check({ ...result, pending: 1 }), /未确认/);
  await assert.rejects(check({ ...result, assetsLocked: 1 }), /资产锁/);
});

test('isolated and production startup preserve upstream browser settings without inheriting another job', () => {
  const base = {
    PORT: '43101', DB_HOST: '127.0.0.1', DB_PORT: '43102',
    DB_USER: 'fixture_user', DB_PASSWORD: randomBytes(18).toString('hex'),
    ID_RECHARGE_BRIDGE_SECRET: randomBytes(32).toString('hex')
  };
  const settings = {
    BROWSER_POOL: '0', BROWSER_POOL_SIZE: '4', BROWSER_POOL_MAX_SIZE: '8',
    BROWSER_POOL_BASE_PORT: '19322', BROWSER_POOL_ACQUIRE_TIMEOUT_MS: '60000',
    HEADFUL: '1', DISPLAY: ':99', CHROMIUM_CHANNEL: 'chrome',
    PLAYWRIGHT_BROWSERS_PATH: '/fixture/browser-cache',
    PROXY: 'http://proxy.example.test:8080', RECORD_VIDEO: '0',
    MAX_CONCURRENT_ACTIVATIONS: '4', PAYMENT_MAX_CARD_ATTEMPTS: '4',
    PROCESS_IDLE_TIMEOUT_MS: '240000', CHECKOUT_UI_MODE: 'custom',
    CHECKOUT_READY_WAIT_MS: '90000', GPT_API_MAX_POLLS: '10',
    GPT_API_POLL_INTERVAL_MS: '3000', JSON_BODY_LIMIT: '15mb',
    HOME: '/fixture/home', XDG_CACHE_HOME: '/fixture/cache', TMPDIR: '/fixture/tmp'
  };
  const unrelated = {
    NODE_OPTIONS: '--inspect', NODE_PATH: '/unrelated/modules', OTHER: 'fixture',
    CHATGPT_TOKEN: 'synthetic-old-job', CHATGPT_SESSION_JSON: '{"oldJob":true}',
    CDK_CODE: 'synthetic-old-code', CDK_PLAN_TYPE: 'pro500', PLAN_NAME_OVERRIDE: 'old-plan',
    PAYMENT_REGION_OVERRIDE: 'US', JOB_KEY: 'old-job', ACTIVATION_EMAIL: 'old@example.test',
    CHECKOUT_DEBUG_ONLY: '1', CHECKOUT_API_ONLY: '1', CHECKOUT_MODE: 'ui',
    ID_VENDURE_SINGLE_ATTEMPT: '1', ID_RECHARGE_RUNTIME_MODE: 'production',
    BROWSER_RUNTIME_MODE: 'pool', BROWSER_POOL_SLOT: '5', BROWSER_POOL_CDP_URL: 'http://127.0.0.1:19327',
    CDP_PORT: '19327', CDP_URL: 'http://127.0.0.1:19327'
  };
  for (const [createEnv, database] of [
    [isolatedCodexdaichongEnv, { DB_NAME: 'id_redesign_codexdaichong_test_fixture' }],
    [productionRuntimeEnv, { DB_NAME: 'id_redesign_codexdaichong_prod', DB_USER: 'id_redesign_recharge' }]
  ]) {
    const input = { ...base, ...database, ...settings, ...unrelated };
    const before = { ...input };
    assert.deepEqual(createEnv(input), { ...base, ...database, ...settings });
    assert.deepEqual(input, before);
  }
});

test('a local diagnostic proxy cannot replace production proxy selection', () => {
  const env = {
    PORT: '43101', DB_HOST: '127.0.0.1', DB_PORT: '43102',
    DB_NAME: 'id_redesign_codexdaichong_test_fixture', DB_USER: 'fixture_user',
    DB_PASSWORD: randomBytes(18).toString('hex'),
    ID_RECHARGE_BRIDGE_SECRET: randomBytes(32).toString('hex'),
    ID_RECHARGE_CHECKOUT_DEBUG_PROXY: 'http://127.0.0.1:43103'
  };
  assert.equal(isolatedCodexdaichongEnv(env).ID_RECHARGE_CHECKOUT_DEBUG_PROXY, env.ID_RECHARGE_CHECKOUT_DEBUG_PROXY);
  const production = productionRuntimeEnv({ ...env, DB_NAME: 'id_redesign_codexdaichong_prod', DB_USER: 'id_redesign_recharge' });
  assert.equal(production.ID_RECHARGE_CHECKOUT_DEBUG_PROXY, undefined);
});

test('signed health distinguishes real readiness from an arbitrary 200 and does not expose upstream errors', async (t) => {
  const secret = randomBytes(32).toString('hex');
  let payload = { success: true, runtime: { active_foreground_jobs: 0, max_foreground_jobs: 1 } };
  let status = 200;
  const server = createServer((req, res) => {
    assert.equal(req.url, '/api/public/runtime');
    assert.equal(req.headers['x-real-ip'], '127.0.0.1');
    const [message, signature] = req.headers['x-id-recharge-assertion'].split('.');
    if (createHmac('sha256', secret).update(message).digest('base64url') !== signature) {
      res.writeHead(401).end();
      return;
    }
    const claim = JSON.parse(Buffer.from(message, 'base64url'));
    assert.equal(claim.path, req.url);
    assert.equal(claim.actor.admin, false);
    res.writeHead(status, { 'Content-Type': 'application/json' }).end(JSON.stringify(payload));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise((resolve) => server.close(resolve)));
  const upstreamUrl = 'http://127.0.0.1:' + server.address().port;
  const probe = (overrides = {}) =>
    probeCodexdaichongRuntime({ upstreamUrl, secret, clientIp: '127.0.0.1', ...overrides });
  assert.deepEqual(await probe(), { ready: true });
  assert.deepEqual(await probe({ secret: randomBytes(32).toString('hex') }), {
    ready: false,
    reason: 'bridge_rejected'
  });
  payload = { success: true };
  assert.deepEqual(await probe(), { ready: false, reason: 'invalid_runtime_response' });
  payload = { message: 'private diagnostic fixture' };
  status = 500;
  assert.deepEqual(await probe(), { ready: false, reason: 'runtime_not_ready' });
  await assert.rejects(probe({ upstreamUrl: 'http://mysql.example.test:43101' }), /回环端口/);
});

import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import {
  checkNativeProductionDatabase, checkProductionDatabase, isolatedCodexdaichongEnv,
  nativeProductionRuntimeEnv, productionRuntimeEnv
} from '../modules/recharge/codexdaichong/runtime.mjs';
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

test('only the pristine process permits explicit RFC1918 database addresses while the adapter stays on loopback', () => {
  const env = {
    PORT: '3000', DB_HOST: '127.0.0.1', DB_PORT: '3306',
    DB_NAME: 'id_redesign_codexdaichong_prod', DB_USER: 'id_redesign_recharge',
    DB_PASSWORD: randomBytes(18).toString('hex'), ID_RECHARGE_BRIDGE_SECRET: randomBytes(32).toString('hex')
  };
  for (const host of ['10.0.0.1', '10.255.255.254', '172.16.0.1', '172.31.255.254', '192.168.0.1', '192.168.255.254']) {
    const input = { ...env, DB_HOST: host };
    assert.equal(nativeProductionRuntimeEnv(input).DB_HOST, host);
    assert.throws(() => productionRuntimeEnv(input), /专用回环/);
    assert.equal(input.DB_HOST, host);
  }
  assert.equal(nativeProductionRuntimeEnv(env).DB_HOST, '127.0.0.1');
  for (const host of ['mysql.example.test', 'localhost', '8.8.8.8', '172.15.255.255', '172.32.0.1',
    '169.254.0.1', '0.0.0.0', '192.169.0.1', '10.0.0.256', '10.0.0.01', '::1', '::ffff:172.18.0.2'])
    assert.throws(() => nativeProductionRuntimeEnv({ ...env, DB_HOST: host }), /私网 IPv4/);
  for (const changed of [{ DB_USER: 'root' }, { DB_USER: ' ROOT ' }, { DB_NAME: 'another_database' },
    { ID_RECHARGE_BRIDGE_SECRET: 'short' }])
    assert.throws(() => nativeProductionRuntimeEnv({ ...env, DB_HOST: '172.18.0.2', ...changed }));
});

test('private-network native preflight still checks actual database identity, pending tasks and asset locks read-only', async () => {
  const env = {
    PORT: '3000', DB_HOST: '172.18.0.2', DB_PORT: '3306',
    DB_NAME: 'id_redesign_codexdaichong_prod', DB_USER: 'id_redesign_recharge',
    DB_PASSWORD: randomBytes(18).toString('hex'), ID_RECHARGE_BRIDGE_SECRET: randomBytes(32).toString('hex')
  };
  const row = { databaseName: env.DB_NAME, account: env.DB_USER + '@172.18.%', pending: 0, assetsLocked: 0 };
  let connections = 0;
  const check = (state, config = env) => checkNativeProductionDatabase(config, async (options) => {
    connections++;
    assert.equal(options.host, env.DB_HOST);
    assert.equal(options.port, 3306);
    assert.equal(options.database, env.DB_NAME);
    assert.equal(options.user, env.DB_USER);
    const sql = [];
    return {
      async query({ sql: query }) { sql.push(query); return [[state]]; },
      async end() {
        assert.equal(sql[0], 'START TRANSACTION READ ONLY');
        assert.match(sql[1].trim(), /^SELECT DATABASE\(\)/);
        assert.equal(sql.length, 2);
      }
    };
  });
  await check(row);
  await assert.rejects(check({ ...row, databaseName: 'another_database' }), /实际身份/);
  await assert.rejects(check({ ...row, account: 'root@172.18.%' }), /实际身份/);
  await assert.rejects(check({ ...row, pending: 1 }), /未确认/);
  await assert.rejects(check({ ...row, assetsLocked: 1 }), /资产锁/);
  await assert.rejects(check(row, { ...env, DB_HOST: '8.8.8.8' }), /私网 IPv4/);
  assert.equal(connections, 5);
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
  assert.equal(isolatedCodexdaichongEnv(env).ID_RECHARGE_CHECKOUT_DEBUG_PROXY, undefined);
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

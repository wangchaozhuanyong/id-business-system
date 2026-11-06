import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';
import { isolatedCodexdaichongEnv } from '../modules/recharge/codexdaichong/runtime.mjs';
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

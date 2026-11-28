import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { signRechargeAssertion } from '../assertion.mjs';
import { createCodexdaichongGateway, CODEXDAICHONG_PREFIX } from './gateway.mjs';
import { createNativeRechargeAdapter } from './native-adapter.mjs';
import { RechargeRouteError } from './native-routing.mjs';
import { createManualRouteTickets } from './manual-routing-service.mjs';
import { createManualRoutingClient, manualRoutingDigest, manualRoutingPrefix } from './manual-routing-client.mjs';

function fixture() {
  const binding = { planType: 'plus', region: 'PH', configVersion: 12, proxyId: 42,
    proxyType: 'mobile', labelCountryCode: 'PH', configHash: manualRoutingDigest('fixture-route') };
  const route = { ...binding, protocol: 'http', proxy: 'http://example-user:fixture@proxy.example.test:8080', ip: '1.1.1.1', latencyMs: 18 };
  const pool = { async manualOptions() { return { plans: { plus: 'PH' }, choices: [{ id: '42' }] }; },
    async manualProbe() { return route; }, async validateManual(value) {
      if (value !== route) assert.deepEqual(value, binding);
    } };
  const actor = { id: 'test-operator', role: 'admin', active: true };
  const input = { email: 'browser@example.test', plan: 'plus', proxyId: 'auto' };
  return { route, binding, pool, actor, input };
}

test('tickets bind email, plan and owner, expire, and are single-use across concurrent launches', async () => {
  const { route, binding, pool, input } = fixture();
  let time = 100;
  const handle = createManualRouteTickets(pool, { now: () => time });
  const probe = await handle('operator-1', 'probe', input);
  assert.equal(probe.protocol, 'http');
  assert.equal(probe.expiresAt, time + 120_000);
  const consume = { email: input.email, plan: input.plan, ticket: probe.ticket };
  assert.doesNotMatch(JSON.stringify(probe), /example-user|proxy\.example|proxyUrl/);
  await assert.rejects(handle('operator-2', 'consume', consume), /失效/);
  await assert.rejects(handle('operator-1', 'consume', { ...consume, email: 'other@example.test' }), /失效/);
  await assert.rejects(handle('operator-1', 'consume', { ...consume, plan: 'pro200' }), /失效/);
  const results = await Promise.allSettled([handle('operator-1', 'consume', consume), handle('operator-1', 'consume', consume)]);
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.deepEqual(results.find(result => result.status === 'fulfilled').value, {
    proxyUrl: route.proxy, expectedCountry: 'PH', expectedIp: route.ip, routeBinding: binding });
  consume.ticket = (await handle('operator-1', 'probe', input)).ticket;
  time += 120_001;
  await assert.rejects(handle('operator-1', 'consume', consume), /失效/);
});

test('late completion cannot replace a more recent result for the operator', async () => {
  const { route, pool, input } = fixture();
  let complete;
  pool.manualProbe = () => new Promise(resolve => { complete = resolve; });
  const handle = createManualRouteTickets(pool);
  const older = handle('test', 'probe', input);
  pool.manualProbe = async () => route;
  const current = await handle('test', 'probe', input);
  complete(route);
  await assert.rejects(older, /失效/);
  assert.equal((await handle('test', 'consume', { email: input.email, plan: input.plan, ticket: current.ticket })).expectedIp, route.ip);
});

test('starting a new probe while a launch revalidates revokes the older claim', async () => {
  const { pool, input } = fixture();
  let complete;
  pool.validateManual = () => new Promise(resolve => { complete = resolve; });
  const handle = createManualRouteTickets(pool);
  const older = await handle('test', 'probe', input);
  const consume = { email: input.email, plan: input.plan, ticket: older.ticket };
  const pending = handle('test', 'consume', consume);
  const current = await handle('test', 'probe', input);
  complete();
  await assert.rejects(pending, /失效/);
  pool.validateManual = async () => {};
  assert.ok((await handle('test', 'consume', { ...consume, ticket: current.ticket })).proxyUrl);
});

async function listen(t, handler) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => new Promise(resolve => { server.close(resolve); server.closeAllConnections(); }));
  return 'http://127.0.0.1:' + server.address().port;
}

test('site uses the signed loopback adapter; browsers, ordinary signed admin assertions and changed bodies fail closed', async t => {
  const { route, binding, pool, actor, input } = fixture();
  const secret = randomBytes(48).toString('hex');
  const adapter = createNativeRechargeAdapter({ nativeUrl: 'http://127.0.0.1:1', secret,
    getNativeAdminToken: () => { throw new Error('should never request a native token'); },
    manualRoutes: createManualRouteTickets(pool) });
  const upstreamUrl = await listen(t, adapter.handle);
  const client = createManualRoutingClient({ upstreamUrl, secret });
  assert.equal((await client.options(actor, 'plus')).choices[0].id, '42');
  for (const denied of [{ ...actor, active: false }, { ...actor, role: 'finance' }])
    await assert.rejects(client.probe(denied, input), { status: 403 });
  const { ticket } = await client.probe(actor, input);
  const launch = await client.consume(actor, { email: input.email, plan: input.plan, ticket });
  assert.equal(launch.proxyUrl, route.proxy);
  assert.deepEqual(launch.routeBinding, binding);
  assert.deepEqual(await client.validate(actor, { routeBinding: launch.routeBinding }), { ok: true });
  for (const invalid of [null, { ...binding, proxyType: 'UNKNOWN' }, { ...binding, proxyId: '42' },
    { ...binding, configVersion: 0 }, { ...binding, configHash: 'invalid' }, { ...binding, labelCountryCode: 'EG' },
    { ...binding, planType: ['plus'] }, { ...binding, region: 'UNKNOWN' }, { ...binding, proxyUrl: route.proxy }])
    await assert.rejects(client.validate(actor, { routeBinding: invalid }), { status: 400 });
  await assert.rejects(client.validate(actor, { routeBinding: binding, other: true }), { status: 400 });
  pool.validateManual = async () => { throw new RechargeRouteError('套餐或代理配置已变更，请重新测速', 'route_version_conflict'); };
  await assert.rejects(client.validate(actor, { routeBinding: binding }), { status: 409 });
  const signedStaff = { id: 'site-super', email: 'operator@example.test', admin: true, sensitive: true };
  const body = JSON.stringify({ plan: 'plus' });
  const path = manualRoutingPrefix + 'options?digest=' + manualRoutingDigest(body);
  const call = (who, supplied, extra = {}) => fetch(upstreamUrl + path, { method: 'POST',
    headers: { 'content-type': 'application/json', 'x-id-recharge-assertion': signRechargeAssertion(secret, 'POST', path, who), ...extra },
    body: supplied });
  assert.equal((await call(signedStaff, body)).status, 403);
  const service = { ...signedStaff, id: 'manual-routing:' + manualRoutingDigest(actor.id) };
  assert.equal((await call(service, body, { origin: upstreamUrl })).status, 401);
  assert.equal((await call(service, body, { cookie: 'simulated=1' })).status, 401);
  assert.equal((await call(service, JSON.stringify({plan: 'pro200'}))).status, 403);
  const website = createCodexdaichongGateway({ upstreamUrl, secret, publicOrigin: 'https://site.example.test',
    getUnifiedPrincipal: () => signedStaff });
  const site = await listen(t, website.handle);
  assert.equal((await fetch(site + CODEXDAICHONG_PREFIX + path, { method: 'POST', body,
    headers: { origin: 'https://site.example.test' } })).status, 404);
});

test('internal routing bypasses configured HTTP proxies even with Node environment proxy support enabled', async t => {
  const { pool, actor } = fixture();
  const secret = randomBytes(48).toString('hex');
  const adapter = createNativeRechargeAdapter({ nativeUrl: 'http://127.0.0.1:1', secret,
    getNativeAdminToken: () => { throw new Error('unexpected native call'); },
    manualRoutes: createManualRouteTickets(pool) });
  const upstreamUrl = await listen(t, adapter.handle);
  let upstreamProxyCalls = 0;
  const externalProxy = await listen(t, (_req, res) => { upstreamProxyCalls++; res.writeHead(502).end(); });
  const call = `import { createManualRoutingClient } from ${JSON.stringify(new URL('./manual-routing-client.mjs', import.meta.url).href)};
    const result = await createManualRoutingClient({upstreamUrl:process.env.FIXTURE_ADAPTER,
      secret:process.env.FIXTURE_ASSERTION_KEY}).options(${JSON.stringify(actor)}, 'plus');
    if (result.choices[0].id !== '42') process.exitCode = 1;`;
  const child = spawn(process.execPath, ['--input-type=module', '-e', call], { stdio: 'ignore',
    env: { ...process.env, FIXTURE_ADAPTER: upstreamUrl, FIXTURE_ASSERTION_KEY: secret,
      NODE_USE_ENV_PROXY: '1', HTTP_PROXY: externalProxy, http_proxy: externalProxy,
      HTTPS_PROXY: externalProxy, https_proxy: externalProxy, NO_PROXY: '', no_proxy: '' } });
  assert.equal((await once(child, 'exit'))[0], 0);
  assert.equal(upstreamProxyCalls, 0);
});

import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { once } from 'node:events';
import { createServer, request as httpRequest } from 'node:http';
import { createRequire } from 'node:module';
import test from 'node:test';
import { signRechargeAssertion } from '../modules/recharge/assertion.mjs';
import { createNativeRechargeAdapter, createNativeAdminTokenIssuer, startNativeRechargeAdapter } from '../modules/recharge/codexdaichong/native-adapter.mjs';
import { verifyNativeNetworkIsolation } from '../modules/recharge/codexdaichong/native-network.mjs';

const nativeAuth = createRequire(import.meta.url)('../.upstream/codexdaichong/admin-auth.js');
const customer = { id: 'synthetic-customer', email: 'customer@example.test', admin: false, sensitive: false };
const admin = { ...customer, admin: true };
const superUser = { ...admin, sensitive: true };
async function listen(t, handler) {
  const server = createServer(handler);
  const sockets = new Set();
  server.on('connection', (socket) => { sockets.add(socket); socket.once('close', () => sockets.delete(socket)); });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(() => { for (const socket of sockets) socket.destroy(); return new Promise((resolve) => server.close(resolve)); });
  return { server, url: 'http://127.0.0.1:' + server.address().port };
}

test('the outer adapter uses native authentication without exposing its token or granting customers card access', async (t) => {
  const nativeSecret = randomBytes(32).toString('hex');
  const secret = randomBytes(32).toString('hex');
  const requests = [];
  const raw = await listen(t, async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    requests.push({ path: req.url, headers: req.headers, body: Buffer.concat(chunks).toString() });
    if (req.url.startsWith('/api/admin/')) {
      const token = req.headers.authorization?.slice(7);
      const verified = nativeAuth.verifySignedToken(token, { expectedSub: 'admin', secret: nativeSecret });
      assert.equal(verified.pv, 7);
      assert.equal(verified.email, customer.email);
      assert(verified.exp - verified.iat <= 15_000);
    } else assert.equal(req.headers.authorization, undefined);
    res.writeHead(200, { 'Content-Type': 'application/json', 'Set-Cookie': 'native-private=never-forward' });
    res.end(JSON.stringify({ success: true, accepted: true }));
  });
  const getNativeAdminToken = createNativeAdminTokenIssuer({
    issueSignedToken: nativeAuth.issueSignedToken, secret: nativeSecret, readPasswordVersion: async () => 7
  });
  const adapter = createNativeRechargeAdapter({ nativeUrl: raw.url, secret, getNativeAdminToken });
  const host = await listen(t, adapter.handle);
  const request = (path, actor = customer, body) => {
    const method = body ? 'POST' : 'GET';
    return fetch(host.url + path, { method, headers: {
      'x-id-recharge-assertion': signRechargeAssertion(secret, method, path, actor),
      ...(body ? { 'content-type': 'application/json' } : {})
    }, ...(body ? { body: JSON.stringify(body) } : {}) });
  };
  assert.equal((await fetch(host.url + '/api/admin/cards')).status, 401);
  assert.equal((await request('/api/admin/cards')).status, 403);
  assert.equal((await request('/api/admin/cards', admin)).status, 403);
  assert.equal((await request('/API/ADMIN/CARDS/', admin)).status, 403);
  assert.equal((await request('/api/admin/sessions', admin)).status, 403);
  assert.equal((await request('/api/admin/login', superUser, {})).status, 404);
  assert.equal((await request('/api/admin/cards?token=forged', superUser)).status, 404);
  assert.equal((await request('/api/admin/cards%2Fother', superUser)).status, 404);
  assert.equal(requests.length, 0);
  const session = await request('/api/admin/session', admin);
  assert.equal((await session.json()).token, null);
  assert.equal(requests.length, 0);
  const cards = await request('/api/admin/cards', superUser);
  assert.equal(cards.status, 200);
  assert.equal(cards.headers.get('set-cookie'), null);
  assert.equal(JSON.stringify(await cards.json()).includes('native-private'), false);
  const body = { cdk: 'synthetic-code', session: 'synthetic-session' };
  assert.equal((await request('/api/run-process', customer, body)).status, 200);
  assert.deepEqual(JSON.parse(requests.at(-1).body), body);
  assert.equal(requests.at(-1).headers['x-id-recharge-assertion'], undefined);
  await request('/api/run-process', { ...customer, clientIp: '203.0.113.15' }, body);
  assert.equal(requests.at(-1).headers['x-real-ip'], '203.0.113.15');
  assert.equal((await request('/api/admin/screenshots?path=fixture.png')).status, 403);
  assert.equal((await request('/api/admin/video?path=fixture.webm')).status, 403);
  assert.equal((await request('/api/admin/screenshots?path=checkout_debug%2Ffixture.png', admin)).status, 200);
  assert.equal(requests.at(-1).path, '/api/admin/screenshots?path=checkout_debug%2Ffixture.png');
  assert.equal((await request('/api/admin/orbitcard/products', admin)).status, 200);
});

test('network preflight rejects public, host-network, stopped, wrong-port and UDP-only native services', async () => {
  const base = { nativeUrl: 'http://127.0.0.1:31993', container: 'synthetic-native' };
  const safe = { containerId: 'a'.repeat(64), running: true, networkMode: 'private-native', ports: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '31993' }] } };
  await assert.rejects(startNativeRechargeAdapter({ nativeUrl: base.nativeUrl }, 31993), /不同端口/);
  assert.deepEqual(await verifyNativeNetworkIsolation({ ...base, inspect: async () => safe }), { isolated: true });
  for (const state of [
    { ...safe, running: false }, { ...safe, networkMode: 'host' }, { ...safe, networkMode: 'container:other' },
    { ...safe, ports: { '3000/tcp': [{ HostIp: '0.0.0.0', HostPort: '31993' }] } },
    { ...safe, ports: { '3000/tcp': [{ HostIp: '127.0.0.1', HostPort: '31994' }] } },
    { ...safe, ports: { '3000/udp': [{ HostIp: '127.0.0.1', HostPort: '31993' }] } }
  ]) await assert.rejects(verifyNativeNetworkIsolation({ ...base, inspect: async () => state }));
  await assert.rejects(verifyNativeNetworkIsolation({ ...base, inspect: async () => { throw new Error('private diagnostic'); } }),
    (error) => !error.message.includes('private diagnostic'));
});

test('adapter shutdown closes upgraded tunnels without changing or restarting the native service', async (t) => {
  const raw = await listen(t, (_req, res) => res.end());
  let nativeSocket;
  raw.server.on('upgrade', (req, socket) => {
    nativeSocket = socket;
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    socket.once('end', () => socket.destroy());
    socket.resume();
  });
  // Reserve a random free test port; no original engine or database is started.
  const reserve = await listen(t, (_req, res) => res.end());
  const port = reserve.server.address().port;
  await new Promise((resolve) => reserve.server.close(resolve));
  const secret = randomBytes(32).toString('hex');
  const adapter = await startNativeRechargeAdapter({ nativeUrl: raw.url, secret, getNativeAdminToken: async () => '' }, port);
  t.after(() => adapter.close());
  const request = httpRequest({ hostname: '127.0.0.1', port, path: '/', headers: {
    connection: 'Upgrade', upgrade: 'websocket', 'sec-websocket-version': '13',
    'sec-websocket-key': randomBytes(16).toString('base64'),
    'x-id-recharge-assertion': signRechargeAssertion(secret, 'GET', '/', admin)
  } });
  request.end();
  const [, client] = await once(request, 'upgrade', { signal: AbortSignal.timeout(3000) });
  const closed = once(client, 'close', { signal: AbortSignal.timeout(3000) });
  const nativeClosed = once(nativeSocket, 'close', { signal: AbortSignal.timeout(3000) });
  await adapter.close();
  await closed;
  await nativeClosed;
  assert(nativeSocket.destroyed);
});

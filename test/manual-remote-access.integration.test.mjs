import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createLocalAuth, initializeLocalAdmin } from '../server/local-auth.mjs';
import { createLocalBusinessStore } from '../server/local-business.mjs';
import { manualDesktopOwnerKey, manualDesktopWorkspaceKey } from '../server/manual-desktop-workspace.mjs';
import { createManualRemoteAccess } from '../server/manual-remote-access.mjs';

function stream(url, origin, cookie) {
  return new Promise((resolve, reject) => {
    const req = request(url, { headers: { cookie, origin, connection: 'Upgrade', upgrade: 'websocket',
      'sec-websocket-version': '13', 'sec-websocket-key': randomBytes(16).toString('base64') } });
    req.once('error', reject);
    req.once('response', response => { response.resume(); resolve({ status: response.statusCode }); });
    req.once('upgrade', (response, socket, head) => {
      socket.on('error', () => socket.destroy());
      resolve({ status: response.statusCode, socket, head });
    });
    req.end();
  });
}

async function readFixtureJson(request) {
  let body = '';
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 1024) throw new RangeError('Fixture request too large');
  }
  return JSON.parse(body);
}

test('independent platform logins share only their own renewal desktop and revoking one does not close the other', { timeout: 15_000 }, async t => {
  const checkout = fileURLToPath(new URL('..', import.meta.url));
  const parent = dirname(checkout);
  const project = ['.worktrees', '.codex-worktrees'].includes(basename(parent)) ? dirname(parent) : checkout;
  const runtime = join(project, '.runtime');
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const dir = await mkdtemp(join(runtime, 'rws-')), socketPath = join(dir, 's');
  const authPath = join(dir, 'accounts.json');
  const bootstrap = { name: '隔离站超级管理员', email: 'qa-root@example.test', password: randomUUID() };
  const owner = { name: '隔离财务操作员', email: 'workspace-owner@example.test', password: randomUUID() };
  const other = { name: '另一名隔离管理员', email: 'other-workspace-owner@example.test', password: randomUUID() };
  const peers = new Set(), openPaths = [], streamPaths = [], privateCalls = [];
  const running = new Map(), rechargeProofs = new Map(), rechargeSubmissions = [];
  const rechargeReceipt = { exitIp: '1.1.1.1', country: 'PH', accountStatus: 'check-in-browser' };
  let rechargeEnabled = true;
  function identify(req) {
    const ownerKey = req.headers['x-manual-owner'];
    const key = req.url.split('/')[3];
    privateCalls.push({ ownerKey, key, path: req.url, cookie: req.headers.cookie, origin: req.headers.origin });
    return { ownerKey, key, conflict: running.has(ownerKey) && running.get(ownerKey) !== key };
  }
  let store, server, broker, remote, stopStatus = 503;
  t.after(async () => {
    try {
      remote?.close();
      for (const peer of peers) peer.destroy();
      await Promise.all([server, broker].filter(s => s?.listening).map(s => {
        const closed = new Promise(done => s.close(done));
        s.closeAllConnections();
        return closed;
      }));
    } finally {
      store?.close();
      await rm(dir, { recursive: true, force: true });
    }
  });

  await initializeLocalAdmin(authPath, bootstrap);
  const auth = createLocalAuth(authPath);
  store = createLocalBusinessStore(':memory:');
  broker = createServer(async (req, res) => {
    if (req.method === 'GET' && req.url === '/v1/recharge/status') {
      return rechargeEnabled
        ? res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify({ rechargeBootstrap: 1 }))
        : res.writeHead(503).end();
    }
    if (req.method === 'GET' && req.url.endsWith('/recharge-status')) {
      const { ownerKey, key } = identify(req);
      return rechargeProofs.get(key) === ownerKey
        ? res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(rechargeReceipt))
        : res.writeHead(409).end();
    }
    if (req.method !== 'POST') return res.writeHead(405).end();
    const { ownerKey, key, conflict } = identify(req);
    if (conflict) return res.writeHead(423).end();
    if (req.url.endsWith('/stop')) {
      if (stopStatus === 204) {
        running.delete(ownerKey);
        rechargeProofs.delete(key);
      }
      return res.writeHead(stopStatus).end();
    }
    if (req.url.endsWith('/prepare')) {
      try {
        rechargeSubmissions.push(await readFixtureJson(req));
        running.set(ownerKey, key);
        rechargeProofs.set(key, ownerKey);
        return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(rechargeReceipt));
      } catch {
        return res.writeHead(400).end();
      }
    }
    running.set(ownerKey, key);
    openPaths.push(req.url);
    res.writeHead(204).end();
  });
  const greeting = Buffer.concat([Buffer.from([0x82, 12]), Buffer.from('RFB 003.008\n')]);
  broker.on('upgrade', (req, socket) => {
    const { ownerKey, key, conflict } = identify(req);
    const recharge = req.url.endsWith('/recharge-stream');
    const available = recharge ? rechargeProofs.get(key) === ownerKey : running.get(ownerKey) === key;
    if (conflict || !available) {
      const status = conflict ? 423 : recharge ? 409 : 404;
      return socket.end('HTTP/1.1 ' + status + ' No Desktop\r\nConnection: close\r\nContent-Length: 0\r\n\r\n');
    }
    peers.add(socket);
    socket.on('error', () => socket.destroy());
    socket.on('close', () => peers.delete(socket));
    streamPaths.push(req.url);
    const accept = createHash('sha1').update(req.headers['sec-websocket-key'] + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
    socket.write('HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: websocket\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
    socket.write(greeting);
  });
  broker.listen(socketPath);
  await once(broker, 'listening');
  server = createServer(async (req, res) => {
    if (req.url.startsWith('/api/local/auth/')) return void auth.handle(req, res);
    if (req.method === 'POST' && req.url === '/qa/prepare-recharge') {
      try {
        const result = await remote.prepareRecharge(req, await readFixtureJson(req));
        return res.writeHead(200, { 'Content-Type': 'application/json' }).end(JSON.stringify(result));
      } catch (error) {
        return res.writeHead(error.status || 500).end();
      }
    }
    return void remote.handle(req, res);
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  remote = createManualRemoteAccess({ socketPath, getActor: auth.getActor, store, publicOrigin: origin, recheckInterval: 25 });
  server.on('upgrade', remote.upgrade);
  const http = (path, { method = 'GET', cookie, body, headers = {} } = {}) => fetch(origin + path, {
    method, redirect: 'error', signal: AbortSignal.timeout(5000),
    headers: { ...(cookie && { cookie }), ...(method !== 'GET' && { origin }),
      ...(body && { 'Content-Type': 'application/json' }), ...headers },
    body: body && JSON.stringify(body)
  });
  async function signIn({ email, password }) {
    const response = await http('/api/local/auth/login', { method: 'POST', body: { email, password } });
    assert.equal(response.status, 200);
    const { actor } = await response.json();
    const cookie = response.headers.get('set-cookie')?.split(';', 1)[0];
    assert.ok(cookie && actor?.id);
    return { actor, cookie };
  }
  const root = await signIn(bootstrap);
  const newFinance = await http('/api/local/auth/employees', { method: 'POST', cookie: root.cookie, body: { ...owner, role: 'finance' } });
  assert.equal(newFinance.status, 201);
  const first = await signIn(owner);
  assert.equal(first.actor.role, 'finance');
  const second = await signIn(owner);
  assert.equal(first.actor.id, second.actor.id);
  assert.ok(first.cookie !== second.cookie, 'platform issued independent sessions');
  const added = await http('/api/local/auth/employees', { method: 'POST', cookie: root.cookie, body: { ...other, role: 'admin' } });
  assert.equal(added.status, 201);
  const stranger = await signIn(other);
  assert.equal(stranger.actor.role, 'admin');
  const { record } = store.saveManualRenewalRecord({ email: 'isolated-subscription@example.test', status: 'pending_renewal', currentPlan: 'plus', renewalNotes: '' }, first.actor);
  const page = '/manual-workspaces/' + record.id + '/';
  const { key } = store.resolveManualWorkspace(record.id, first.actor);
  assert.equal((await http(page)).status, 401);
  assert.equal((await http(page, stranger)).status, 404);
  assert.equal((await http(page + 'open', { ...stranger, method: 'POST' })).status, 404);
  assert.equal((await stream(origin + page + 'stream', origin, stranger.cookie)).status, 404);
  assert.deepEqual([openPaths, streamPaths], [[], []]);

  for (const session of [first, second]) {
    const pageResponse = await http(page, session);
    assert.equal(pageResponse.status, 200);
    assert.match(await pageResponse.text(), /账号工作区/);
    assert.equal((await http(page + 'open', { ...session, method: 'POST' })).status, 204);
  }
  assert.deepEqual(openPaths, Array(2).fill('/v1/workspaces/' + key + '/open'));
  assert.ok(!store.getManualRenewalRecord(record.id, first.actor).lastOpenedAt);
  async function connect(session, target = page) {
    const active = await stream(origin + target + 'stream', origin, session.cookie);
    assert.equal(active.status, 101);
    const bytes = active.head.length ? active.head : (await once(active.socket, 'data', { signal: AbortSignal.timeout(2500) }))[0];
    assert.deepEqual(bytes, greeting);
    active.socket.resume();
    return active.socket;
  }
  const screenA = await connect(first);
  assert.equal((await http(page + 'connected', { ...second, method: 'POST' })).status, 409, 'other device cannot confirm this connection');
  assert.equal((await http(page + 'connected', { ...first, method: 'POST' })).status, 204);
  assert.ok(store.getManualRenewalRecord(record.id, first.actor).lastOpenedAt);
  const screenB = await connect(second);
  assert.deepEqual(streamPaths, Array(2).fill('/v1/workspaces/' + key + '/stream'));
  const disconnected = once(screenA, 'close', { signal: AbortSignal.timeout(3000) });
  assert.equal((await http('/api/local/auth/logout', { ...first, method: 'POST' })).status, 200);
  await disconnected;
  assert.equal((await http(page, first)).status, 401);
  assert.equal((await stream(origin + page + 'stream', origin, first.cookie)).status, 401);
  assert.equal((await http(page, second)).status, 200);
  assert.equal(screenB.destroyed, false);
  assert.equal((await http(page + 'connected', { ...second, method: 'POST' })).status, 204, 'second live stream survives first logout');

  const secondDesktop = store.saveManualRenewalRecord({ email: 'another-record@example.test', status: 'active', currentPlan: '', renewalNotes: '' }, second.actor).record;
  const queuedPage = '/manual-workspaces/' + secondDesktop.id + '/';
  const blocked = await http(queuedPage + 'open', { ...second, method: 'POST' });
  assert.equal(blocked.status, 423);
  assert.match(await blocked.text(), /保存并关闭工作区/);
  assert.equal((await stream(origin + queuedPage + 'stream', origin, second.cookie)).status, 423);
  const independent = store.saveManualRenewalRecord({ email: 'independent@example.test', status: 'active', currentPlan: '', renewalNotes: '' }, stranger.actor).record;
  const otherPage = '/manual-workspaces/' + independent.id + '/';
  assert.equal((await http(otherPage + 'open', { ...stranger, method: 'POST' })).status, 204);
  const separate = await connect(stranger, otherPage);
  const thirdLogin = await signIn(owner);
  const screenC = await connect(thirdLogin);
  const stop = session => http(page + 'stop', { ...session, method: 'POST' });
  assert.equal((await stop(stranger)).status, 404);
  assert.equal((await stop(first)).status, 401);
  assert.equal((await stop(second)).status, 503, 'unconfirmed shutdown is an error');
  for (const socket of [screenB, screenC, separate]) assert.equal(socket.destroyed, false);
  stopStatus = 204;
  const closes = [screenB, screenC].map(socket => once(socket, 'close', { signal: AbortSignal.timeout(3000) }));
  assert.equal((await stop(second)).status, 204);
  await Promise.all(closes);
  assert.equal((await stop(second)).status, 204, 'stopping an already closed desktop remains idempotent');
  assert.equal((await http(page + 'connected', { ...thirdLogin, method: 'POST' })).status, 409);
  assert.equal((await http(otherPage + 'connected', { ...stranger, method: 'POST' })).status, 204, 'other operator retains their live stream');
  assert.equal(separate.destroyed, false);
  assert.equal((await http(queuedPage + 'open', { ...second, method: 'POST' })).status, 204, 'closing releases the desk for the next record');
  const separateKey = store.resolveManualWorkspace(independent.id, stranger.actor).key;
  for (const entry of privateCalls) {
    const expectedId = entry.key === separateKey ? stranger.actor.id : first.actor.id;
    assert.equal(entry.ownerKey, manualDesktopOwnerKey(expectedId));
    assert.match(entry.ownerKey, /^owner-v1-[0-9a-f]{64}$/);
  }

  const config = { email: 'recharge-fixture@example.test', proxyUrl: 'http://proxy.example.test:8080', expectedCountry: 'PH' };
  const prepare = (session, body = config, headers = {}) => http('/qa/prepare-recharge', {
    ...session, method: 'POST', body, headers
  });
  const rechargeOffset = privateCalls.length;
  const legacyOpenCount = openPaths.length;
  assert.equal((await prepare({})).status, 401);
  assert.equal((await prepare(second)).status, 403);
  assert.equal((await prepare(root, config, { origin: 'https://outside.invalid' })).status, 403);
  assert.equal((await prepare(root, config, { 'sec-fetch-site': 'cross-site' })).status, 403);
  rechargeEnabled = false;
  assert.equal((await prepare(root)).status, 503);
  rechargeEnabled = true;
  assert.equal(privateCalls.length, rechargeOffset);
  assert.deepEqual(rechargeSubmissions, []);

  const ready = await prepare(root);
  assert.equal(ready.status, 200);
  const result = await ready.json();
  const rechargeId = 'recharge-' + createHash('sha256').update(JSON.stringify([root.actor.id, config.email])).digest('hex');
  const rechargePage = '/manual-workspaces/' + rechargeId + '/';
  const rechargeKey = manualDesktopWorkspaceKey({ operatorId: root.actor.id, accountId: rechargeId });
  const endpoint = '/v1/workspaces/' + rechargeKey;
  assert.deepEqual(result, { viewerUrl: rechargePage, ...rechargeReceipt });
  assert.deepEqual(rechargeSubmissions, [config]);

  assert.equal((await http(rechargePage)).status, 401);
  assert.equal((await http(rechargePage, second)).status, 403);
  assert.equal((await http(rechargePage + 'open', { ...second, method: 'POST' })).status, 403);
  assert.equal((await stream(origin + rechargePage + 'stream', origin, second.cookie)).status, 403);
  assert.equal((await http(rechargePage + 'open', { ...root, method: 'POST', headers: { origin: 'https://outside.invalid' } })).status, 403);
  assert.equal((await stream(origin + rechargePage + 'stream', 'https://outside.invalid', root.cookie)).status, 403);
  assert.deepEqual(privateCalls.slice(rechargeOffset).map(call => call.path), [endpoint + '/prepare']);

  assert.equal((await http(rechargePage, root)).status, 200);
  const proof = await http(rechargePage + 'open', { ...root, method: 'POST' });
  assert.equal(proof.status, 200);
  assert.deepEqual(await proof.json(), rechargeReceipt);
  const rechargeScreen = await connect(root, rechargePage);
  rechargeScreen.destroy();
  assert.notEqual((await http(rechargePage + 'open', { ...stranger, method: 'POST' })).status, 200);
  assert.notEqual((await stream(origin + rechargePage + 'stream', origin, stranger.cookie)).status, 101);
  const firstCalls = privateCalls.slice(rechargeOffset).filter(call => call.key === rechargeKey);
  assert.deepEqual(firstCalls.map(call => call.path), [endpoint + '/prepare', endpoint + '/recharge-status', endpoint + '/recharge-stream']);
  assert(firstCalls.every(call => call.ownerKey === manualDesktopOwnerKey(root.actor.id) && !call.cookie && !call.origin));

  rechargeProofs.delete(rechargeKey);
  assert.equal((await http(rechargePage + 'open', { ...root, method: 'POST' })).status, 409);
  assert.equal((await stream(origin + rechargePage + 'stream', origin, root.cookie)).status, 503);
  assert.equal((await http(rechargePage + 'stop', { ...root, method: 'POST' })).status, 204);
  assert.equal(openPaths.length, legacyOpenCount, 'recharge reconnect never falls back to generic desktop startup');
  assert.equal(streamPaths.at(-1), endpoint + '/recharge-stream');

  const nextConfig = { ...config, email: 'another-recharge@example.test' };
  const next = await prepare(root, nextConfig);
  assert.equal(next.status, 200);
  assert.notEqual((await next.json()).viewerUrl, rechargePage, 'viewer identity depends on the email');
  assert.deepEqual(rechargeSubmissions, [config, nextConfig]);

});

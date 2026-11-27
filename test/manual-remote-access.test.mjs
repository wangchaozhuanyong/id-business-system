import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { createServer, request } from 'node:http';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { manualDesktopOwnerKey } from '../server/manual-desktop-workspace.mjs';
import { createManualRemoteAccess } from '../server/manual-remote-access.mjs';

const key = 'manual-v1-' + '1'.repeat(64);
const pagePath = '/manual-workspaces/record-1/';
const member = { id: 'operator-1', role: 'admin' };
const cookie = 'synthetic-member';
const plain = { 'content-type': 'text/plain' };
const accept = challenge => createHash('sha1').update(challenge + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');

async function fixture(t, { enabled = true } = {}) {
  const checkout = fileURLToPath(new URL('..', import.meta.url));
  // Keep short Unix socket names inside the owning project, including nested Git worktrees on macOS.
  const parent = dirname(checkout);
  const project = ['.worktrees', '.codex-worktrees'].includes(basename(parent)) ? dirname(parent) : checkout;
  const scratch = join(project, '.runtime');
  await mkdir(scratch, { recursive: true });
  const dir = await mkdtemp(join(scratch, 'remote-qa-')), socketPath = join(dir, 'desk');
  const peers = new Set(), calls = [], opened = [];
  const state = { loggedIn: true, exists: true, openCode: 204, upgradeAllowed: true };
  const broker = createServer((req, res) => {
    calls.push({ method: req.method, path: req.url, cookie: req.headers.cookie, origin: req.headers.origin, owner: req.headers['x-manual-owner'] });
    if (req.url === '/v1/workspaces/' + key + '/open') {
      res.writeHead(state.openCode, { ...plain, 'x-internal-detail': 'private' }).end(state.openCode === 204 ? undefined : 'internal detail');
    } else if (req.url === '/v1/workspaces/' + key + '/stop') {
      res.writeHead(204).end();
    } else if (req.url === '/v1/client/core/rfb.js') {
      res.writeHead(200, { ...plain, 'set-cookie': 'private' }).end('export default class RFB {}');
    } else res.writeHead(404, plain).end('private path');
  });
  broker.on('upgrade', (req, peer) => {
    calls.push({ method: 'WS', path: req.url, cookie: req.headers.cookie, origin: req.headers.origin, owner: req.headers['x-manual-owner'] });
    if (!state.upgradeAllowed) return peer.end('HTTP/1.1 ' + (state.streamError || 503) + ' Unavailable\r\nContent-Length: 0\r\n\r\n');
    peers.add(peer);
    peer.on('close', () => peers.delete(peer));
    peer.on('error', () => peer.destroy());
    peer.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' +
      accept(req.headers['sec-websocket-key']) + '\r\n' + (req.headers['sec-websocket-protocol'] ? 'Sec-WebSocket-Protocol: binary\r\n' : '') +
      'X-Internal-Detail: private\r\n\r\n');
    peer.write(Buffer.concat([Buffer.from([0x82, 12]), Buffer.from('RFB 003.008\n')]));
  });
  broker.listen(socketPath);
  await once(broker, 'listening');
  const remote = createManualRemoteAccess({ socketPath: enabled ? socketPath : undefined, recheckInterval: 30,
    getActor(req) {
      if (state.authUnavailable) { req.localAuthUnavailable = true; return null; }
      if (!state.loggedIn) return null;
      if (req.headers.cookie === cookie) return member;
      if (req.headers.cookie === 'other-operator') return { id: 'other', role: 'admin' };
      if (req.headers.cookie === 'inactive-finance') return { id: 'finance', role: 'finance', active: false };
      if (['employee', 'supervisor', 'registrar'].includes(req.headers.cookie))
        return { id: req.headers.cookie, role: req.headers.cookie };
      return null;
    },
    store: {
      resolveManualWorkspace(id, actor) {
        if (!state.exists || actor.id !== member.id || id !== 'record-1') throw Object.assign(new Error('private'), { status: 404 });
        return { key };
      },
      markManualRenewalOpened(id, actor) { opened.push({ id, actor: actor.id }); }
    } });
  const server = createServer(remote.handle);
  server.on('upgrade', remote.upgrade);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const origin = 'http://127.0.0.1:' + server.address().port;
  t.after(async () => {
    remote.close();
    for (const peer of peers) peer.destroy();
    server.closeAllConnections();
    await Promise.all([new Promise(done => server.close(done)), new Promise(done => broker.close(done))]);
    await rm(dir, { recursive: true, force: true });
  });
  const http = (path, method = 'GET', headers = {}) => fetch(origin + pagePath + path, {
    method, headers: { cookie, origin, ...headers }, signal: AbortSignal.timeout(5000)
  });
  const connect = (headers = {}) => new Promise((resolve, reject) => {
    const req = request(origin + pagePath + 'stream', { headers: { cookie, origin, connection: 'Upgrade',
      upgrade: 'websocket', 'sec-websocket-version': '13', 'sec-websocket-key': randomBytes(16).toString('base64'), ...headers } });
    req.once('error', reject);
    req.once('response', res => { res.resume(); resolve({ status: res.statusCode }); });
    req.once('upgrade', (res, socket, head) => { socket.on('error', () => {}); resolve({ status: res.statusCode, headers: res.headers, socket, head }); });
    req.end();
  });
  return { state, opened, calls, http, connect };
}

test('manual access resolves owner before broker use, serves a bounded asset tree and keeps GET side-effect free', async t => {
  const { http, state, calls, opened } = await fixture(t);
  const page = await http('');
  assert.equal(page.status, 200);
  const html = await page.text();
  assert(html.includes('./client/core/rfb.js') && html.includes('连接工作区'));
  assert(!html.includes(key));
  assert.match(page.headers.get('permissions-policy'), /clipboard-read=\(\), clipboard-write=\(\)/);
  assert.match(page.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert(page.headers.get('content-security-policy').includes("connect-src 'self' " + new URL(page.url).origin.replace('http:', 'ws:') + ';'));
  assert.equal((await http('', 'GET', { cookie: '' })).status, 401);
  assert.equal((await http('', 'GET', { cookie: 'employee' })).status, 403);
  assert.equal((await http('open', 'POST', { cookie: 'inactive-finance' })).status, 403);
  for (const role of ['supervisor', 'registrar']) {
    assert.equal((await http('', 'GET', { cookie: role })).status, 403);
    assert.equal((await http('open', 'POST', { cookie: role })).status, 403);
  }
  assert.equal((await http('', 'GET', { cookie: 'other-operator' })).status, 404);
  assert.equal((await http('open')).status, 405);
  assert.equal((await http('stop')).status, 405);
  assert.equal((await http('stop', 'POST', { cookie: '' })).status, 401);
  assert.equal((await http('stop', 'POST', { cookie: 'other-operator' })).status, 404);
  assert.equal((await http('stop', 'POST', { origin: 'https://outside.invalid' })).status, 403);
  assert.equal((await http('open', 'POST', { origin: 'https://outside.invalid' })).status, 403);
  assert.equal((await http('open', 'POST', { origin: '' })).status, 403);
  assert.equal((await http('client/not-allowed/module.js')).status, 404);
  assert.equal((await http('client/core/worker.js?file=elsewhere')).status, 404);
  assert.equal((await http('client/core/thing%2Fother.js')).status, 404);
  assert.deepEqual(calls, []);
  const forged = 'owner-v1-' + 'e'.repeat(64);
  const asset = await http('client/core/rfb.js', 'GET', { 'X-Manual-Owner': forged });
  assert.equal(calls.at(-1).owner, undefined);
  assert.equal(asset.status, 200);
  assert.equal(asset.headers.get('set-cookie'), null);
  assert.equal(await asset.text(), 'export default class RFB {}');
  state.openCode = 429;
  const full = await http('open', 'POST');
  assert.equal(full.status, 429);
  assert(!(await full.text()).includes('internal'));
  state.openCode = 423;
  const locked = await http('open', 'POST', { 'X-Manual-Owner': forged });
  assert.equal(locked.status, 423);
  assert.match(await locked.text(), /另一个账号工作区.*保存并关闭工作区/);
  assert.equal(locked.headers.get('x-manual-owner'), null);
  state.openCode = 204;
  assert.equal((await http('open', 'POST')).status, 204);
  assert.equal((await http('stop', 'POST', { 'X-Manual-Owner': forged })).status, 204);
  assert(calls.filter(call => call.method === 'POST').every(call => call.owner === manualDesktopOwnerKey(member.id)));
  assert.equal((await http('connected', 'POST')).status, 409);
  assert.deepEqual(opened, []);
  assert(calls.every(call => !call.cookie && !call.origin));
  assert.deepEqual(calls.map(call => [call.method, call.path]), [['GET', '/v1/client/core/rfb.js'],
    ...Array.from({ length: 3 }, () => ['POST', '/v1/workspaces/' + key + '/open']), ['POST', '/v1/workspaces/' + key + '/stop']]);
});

test('desktop stream rejects cross-origin and missing sessions, records connected desktop once, disconnects revoked access', async t => {
  const { http, state, opened, calls, connect } = await fixture(t);
  state.authUnavailable = true;
  assert.equal((await connect()).status, 503);
  state.authUnavailable = false;
  assert.equal((await connect({ cookie: '' })).status, 401);
  assert.equal((await connect({ cookie: 'inactive-finance' })).status, 403);
  for (const role of ['employee', 'supervisor', 'registrar'])
    assert.equal((await connect({ cookie: role })).status, 403);
  assert.equal((await connect({ origin: 'https://outside.invalid' })).status, 403);
  assert.equal((await connect({ 'sec-websocket-protocol': 'other' })).status, 400);
  assert.deepEqual(calls, []);
  state.upgradeAllowed = false;
  assert.equal((await connect()).status, 503);
  state.streamError = 423;
  assert.equal((await connect({ 'x-manual-owner': 'ignored' })).status, 423);
  assert.equal((await http('connected', 'POST')).status, 409);
  state.upgradeAllowed = true;
  const active = await connect({ 'sec-websocket-protocol': 'binary', 'x-manual-owner': 'ignored' });
  assert(calls.filter(call => call.method === 'WS').every(call => call.owner === manualDesktopOwnerKey(member.id)));
  assert.equal(active.status, 101);
  assert.equal(active.headers['sec-websocket-protocol'], 'binary');
  assert(!active.headers['x-internal-detail']);
  if (!active.head.length) await once(active.socket, 'data');
  assert.deepEqual(opened, []);
  assert.equal((await http('connected', 'POST', { cookie: 'other-operator' })).status, 404);
  assert.equal((await http('connected', 'POST')).status, 204);
  assert.equal((await http('connected', 'POST')).status, 204);
  assert.deepEqual(opened, [{ id: 'record-1', actor: member.id }]);
  assert(calls.every(call => !call.cookie && !call.origin));
  const closed = once(active.socket, 'close', { signal: AbortSignal.timeout(2000) });
  active.socket.resume();
  state.loggedIn = false;
  await closed;
  assert.equal((await http('connected', 'POST')).status, 401);
});

test('missing workspace service is explicit and requires authentication before reporting availability', async t => {
  const { http, opened, connect } = await fixture(t, { enabled: false });
  assert.equal((await http('', 'GET', { cookie: '' })).status, 401);
  const result = await http('');
  assert.equal(result.status, 503);
  assert.match(await result.text(), /暂不可用/);
  assert.equal((await connect()).status, 503);
  assert.deepEqual(opened, []);
  assert.throws(() => createManualRemoteAccess({ socketPath: 'relative/path' }), /绝对 Unix socket/);
});

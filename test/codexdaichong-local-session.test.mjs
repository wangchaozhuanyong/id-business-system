import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { runInNewContext } from 'node:vm';
import { createLocalAuth, initializeLocalAdmin } from '../server/local-auth.mjs';
import { createLocalCodexdaichongGateway } from '../modules/recharge/codexdaichong/local-gateway.mjs';

const prefix = '/integrations/codexdaichong';
const authPrefix = '/api/local/auth';
const superUser = { name: '测试主管', email: 'lead@example.test' };
const adminUser = { name: '测试管理员', email: 'admin@example.test', role: 'admin' };
const member = { name: '测试员工', email: 'staff@example.test', role: 'employee' };
const password = () => randomBytes(24).toString('base64url');
const wsGuid = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11';

function useBridge(source, secret) {
  const module = { exports: {} };
  runInNewContext(source, {
    require: createRequire(import.meta.url),
    process: { env: { ID_RECHARGE_BRIDGE_SECRET: secret } },
    module,
    Buffer
  });
  return module.exports;
}

async function listen(t, handler) {
  const server = createServer(handler);
  const sockets = new Set();
  server.on('connection', (socket) => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  t.after(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => server.close(resolve));
  });
  return { server, origin: 'http://127.0.0.1:' + server.address().port };
}

function sendJson(res, payload, status = 200) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(payload));
}

async function readJson(req) {
  const chunks = [];
  for await (const chunk of req) chunks.push(chunk);
  return JSON.parse(Buffer.concat(chunks).toString());
}

function serverFrame(payload) {
  const body = Buffer.from(JSON.stringify(payload));
  assert(body.length < 126);
  return Buffer.concat([Buffer.from([0x81, body.length]), body]);
}

async function taskMessage(ws) {
  const [event] = await once(ws, 'message', { signal: AbortSignal.timeout(3000) });
  return JSON.parse(event.data);
}

test('real staff sessions gate the isolated recharge transport and revoke live task push on logout', async (t) => {
  const runtime = fileURLToPath(new URL('../.runtime/', import.meta.url));
  await mkdir(runtime, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(runtime, 'recharge-session-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'fixture-accounts.json');
  const credentials = [superUser, adminUser, member].map((user) => ({
    ...user,
    password: password()
  }));
  const [supervisor, ordinaryAdmin, employee] = credentials;
  const createdSuper = await initializeLocalAdmin(path, supervisor);
  const auth = createLocalAuth(path);
  const secret = randomBytes(48).toString('base64url');
  const bridge = useBridge(
    await readFile(
      new URL('../modules/recharge/codexdaichong/upstream-bridge.cjs', import.meta.url),
      'utf8'
    ),
    secret
  );
  const observed = [];
  const jobKey = 'fixture-task';
  const task = { jobKey, status: 'running', progress: 30 };
  let socketUpstream;
  const engine = await listen(t, (req, res) => {
    const url = new URL(req.url, 'http://127.0.0.1');
    req.path = url.pathname;
    res.status = (code) => {
      res.statusCode = code;
      return res;
    };
    res.json = (payload) => sendJson(res, payload, res.statusCode);
    bridge.requireGateway(req, res, () => {
      observed.push({
        path: url.pathname,
        actor: { ...req.idRechargeActor },
        receivedSession: 'cookie' in req.headers || 'authorization' in req.headers
      });
      if (url.pathname === '/api/public/runtime')
        return res.json({
          success: true,
          runtime: { active_foreground_jobs: 0, max_foreground_jobs: 1 }
        });
      if (url.pathname === '/api/admin/session') {
        return bridge.authenticateAdmin(req, res, () => {
          res.json({ success: true, email: req.admin.email });
        });
      }
      if (url.pathname === '/api/admin/sessions') {
        return bridge.requireSensitive(req, res, () => res.json({ success: true, data: [] }));
      }
      if (url.pathname === '/api/task-status/' + jobKey) {
        return res.json({
          success: true,
          data: { ...task, isTerminal: task.status === 'success' }
        });
      }
      if (url.pathname === '/api/cdk/query' && url.searchParams.get('cdk') === 'fixture-cdk') {
        return res.json({ success: true, data: { status: '开通中', jobKey } });
      }
      if (['/api/verify-cdk', '/api/run-process'].includes(url.pathname)) {
        void readJson(req).then(
          (body) => {
            if (body.cdk !== 'fixture-cdk') return res.status(400).json({ success: false });
            if (url.pathname === '/api/verify-cdk') {
              return res.json({ success: true, data: { plan_type: 'plus' } });
            }
            if (body.session !== 'fixture-session') return res.status(400).json({ success: false });
            return res.json({ success: true, jobKey });
          },
          () => res.status(400).json({ success: false })
        );
        return;
      }
      res.status(404).json({ success: false });
    });
  });
  engine.server.on('upgrade', (req, socket) => {
    if (!bridge.verifyWebSocket({ req })) return socket.destroy();
    const accept = createHash('sha1')
      .update(req.headers['sec-websocket-key'] + wsGuid)
      .digest('base64');
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n' +
        'Sec-WebSocket-Accept: ' +
        accept +
        '\r\n\r\n'
    );
    socketUpstream = socket;
    socket.once('data', (chunk) => {
      const length = chunk[1] & 127;
      const mask = chunk.subarray(2, 6);
      const payload = Buffer.from(chunk.subarray(6, 6 + length));
      // Decode the client's small masked subscription frame.
      for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i % 4];
      const subscription = JSON.parse(payload.toString());
      if (subscription.type === 'subscribe' && subscription.jobKey === jobKey) {
        socket.write(serverFrame(task));
      }
    });
  });

  let gateway;
  const host = await listen(t, (req, res) =>
    req.url.startsWith(authPrefix + '/') ? auth.handle(req, res) : gateway.handle(req, res)
  );
  gateway = createLocalCodexdaichongGateway({
    upstreamUrl: engine.origin,
    publicOrigin: host.origin,
    secret,
    getActor: (req) => auth.getActor(req)
  });
  host.server.on('upgrade', (req, socket, head) => gateway.upgrade(req, socket, head));

  function request(
    route,
    { method = 'GET', session, body, requestOrigin = host.origin, headers } = {}
  ) {
    return fetch(host.origin + route, {
      method,
      headers: {
        ...(method !== 'GET' ? { Origin: requestOrigin } : {}),
        ...(session ? { Cookie: session } : {}),
        ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        ...headers
      },
      body: body === undefined ? undefined : JSON.stringify(body)
    });
  }
  async function login(user) {
    const response = await request(authPrefix + '/login', { method: 'POST', body: user });
    assert.equal(response.status, 200);
    const cookie = response.headers.get('set-cookie');
    assert.match(cookie, /HttpOnly/);
    await response.json();
    return cookie.split(';', 1)[0];
  }

  assert.equal((await request(prefix + '/status')).status, 401);
  const superSession = await login(supervisor);
  const enrolled = await Promise.all(
    [ordinaryAdmin, employee].map(async (user) => {
      const response = await request(authPrefix + '/employees', {
        method: 'POST',
        session: superSession,
        body: user
      });
      assert.equal(response.status, 201);
      return (await response.json()).employee;
    })
  );
  const [adminSession, employeeSession] = await Promise.all([
    login(ordinaryAdmin),
    login(employee)
  ]);
  assert.equal(
    (
      await request(prefix + '/status', {
        session: employeeSession,
        headers: { 'x-id-recharge-role': 'super', 'x-id-recharge-assertion': 'fixture-forged' }
      })
    ).status,
    401
  );
  assert.deepEqual(await (await request(prefix + '/status', { session: adminSession })).json(), {
    ready: true,
    admin: true
  });
  assert.equal((await request(prefix + '/redeem', { session: adminSession })).status, 200);
  assert.equal(
    (await request(prefix + '/api/admin/session', { session: adminSession })).status,
    200
  );
  assert.equal(
    (await request(prefix + '/api/admin/sessions', { session: adminSession })).status,
    403
  );
  assert.equal(
    (await request(prefix + '/api/admin/sessions', { session: superSession })).status,
    200
  );
  assert.deepEqual(observed.at(-1).actor, {
    id: createdSuper.id,
    email: supervisor.email,
    admin: true,
    sensitive: true
  });
  assert.equal(
    (
      await request(prefix + '/api/admin/login', {
        method: 'POST',
        session: superSession
      })
    ).status,
    404
  );
  assert.equal(
    (
      await request(prefix + '/api/run-process', {
        method: 'POST',
        session: adminSession,
        requestOrigin: 'http://foreign.example.test'
      })
    ).status,
    403
  );

  const cdk = 'fixture-cdk';
  const redeem = (action, body) =>
    request(prefix + action, {
      method: 'POST',
      session: adminSession,
      body,
      headers: { Authorization: 'Bearer fixture' }
    });
  assert.deepEqual(await (await redeem('/api/verify-cdk', { cdk })).json(), {
    success: true,
    data: { plan_type: 'plus' }
  });
  assert.equal(
    (await (await redeem('/api/run-process', { cdk, session: 'fixture-session' })).json()).jobKey,
    jobKey
  );
  assert.equal(
    (await (await request(prefix + '/api/cdk/query?cdk=' + cdk, { session: adminSession })).json())
      .data.jobKey,
    jobKey
  );
  assert.deepEqual(observed.at(-1).actor, {
    id: enrolled[0].id,
    email: ordinaryAdmin.email,
    admin: true,
    sensitive: false
  });
  assert(observed.every(({ receivedSession }) => !receivedSession));
  const beforeUnsupported = observed.length;
  assert.equal(
    (await request(prefix + '/api/external/cards/push', { method: 'POST' })).status,
    404
  );
  for (const unsupported of [
    '/api/id-business-v2/online-recharge/integrations/vendure/submit',
    '/api/worker/claim',
    '/api/worker/callback'
  ]) {
    assert.equal(
      (await request(prefix + unsupported, { method: 'POST', session: superSession })).status,
      404
    );
  }
  assert.equal(observed.length, beforeUnsupported);

  const wsAddress = host.origin.replace('http:', 'ws:') + prefix + '/socket';
  const openSocket = (session, origin = host.origin) =>
    new WebSocket(wsAddress, { headers: { Cookie: session, Origin: origin } });
  await blockedEvent(openSocket(employeeSession));
  await blockedEvent(openSocket(adminSession, 'http://foreign.example.test'));
  assert.equal(socketUpstream, undefined);
  const ws = openSocket(adminSession);
  await once(ws, 'open', { signal: AbortSignal.timeout(3000) });
  const first = taskMessage(ws);
  ws.send(JSON.stringify({ type: 'subscribe', jobKey }));
  assert.deepEqual(await first, task);
  const update = taskMessage(ws);
  Object.assign(task, { status: 'success', progress: 100 });
  socketUpstream.write(serverFrame(task));
  assert.deepEqual(await update, task);
  assert.deepEqual(
    (await (await request(prefix + '/api/task-status/' + jobKey, { session: adminSession })).json())
      .data,
    { ...task, isTerminal: true }
  );

  let leaked = false;
  ws.addEventListener('message', () => {
    leaked = true;
  });
  assert.equal(
    (await request(authPrefix + '/logout', { method: 'POST', session: adminSession })).status,
    200
  );
  assert.equal(
    (await request(prefix + '/api/task-status/' + jobKey, { session: adminSession })).status,
    401
  );
  const closed = new Promise((resolve, reject) => {
    ws.addEventListener('close', resolve, { once: true });
    AbortSignal.timeout(3000).addEventListener('abort', reject, { once: true });
  });
  socketUpstream.write(serverFrame(task));
  await closed;
  assert.equal(leaked, false);
  await blockedEvent(openSocket(adminSession));

  const renewed = await login(ordinaryAdmin);
  const changed = await request(authPrefix + '/employees/' + enrolled[0].id, {
    method: 'PATCH',
    session: superSession,
    body: { role: 'employee', version: enrolled[0].version }
  });
  assert.equal(changed.status, 200);
  assert.equal((await request(prefix + '/status', { session: renewed })).status, 401);
  assert.equal(
    (await request(prefix + '/status', { session: await login(ordinaryAdmin) })).status,
    401
  );
});

function blockedEvent(ws) {
  return new Promise((resolve, reject) => {
    ws.addEventListener('open', () => reject(new Error('unexpected socket upgrade')), {
      once: true
    });
    ws.addEventListener('error', resolve, { once: true });
    AbortSignal.timeout(3000).addEventListener('abort', reject, { once: true });
  });
}

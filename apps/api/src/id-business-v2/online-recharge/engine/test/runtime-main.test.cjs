'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const http = require('node:http');
const net = require('node:net');
const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');
const credentials = require('../credentials.cjs');
const { check } = require('../healthcheck.cjs');
const { transientRoot, clearTransientRoot } = require('../paths.cjs');
const key = 'synthetic-online-recharge-runtime-test-key-long-enough';
const engine = path.join(__dirname, '..');
async function freePort() {
  const listener = net.createServer();
  await new Promise((resolve) => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise((resolve) => listener.close(resolve));
  return port;
}
function worker(env, args = []) {
  const child = spawn(process.execPath, [path.join(engine, 'worker.cjs'), ...args], {
    cwd: engine,
    env: { PATH: process.env.PATH, ONLINE_RECHARGE_WORKER_KEY: key, ...env },
    stdio: ['ignore', 'pipe', 'pipe']
  });
  let output = '';
  child.stdout.on('data', (data) => {
    output += data;
  });
  child.stderr.on('data', (data) => {
    output += data;
  });
  const exit = new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', (code, signal) => resolve({ code, signal, output }));
  });
  const timer = setTimeout(() => child.kill('SIGKILL'), 8000);
  return {
    child,
    exit,
    cleanup() {
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
    }
  };
}
async function until(fn) {
  const until = Date.now() + 5000;
  while (Date.now() < until) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      /* Startup may still bind. */
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('合成运行验收等待超时');
}
async function rpcServer(handle) {
  const server = http.createServer(async (req, res) => {
    if (req.headers['x-online-recharge-worker'] !== key) {
      res.writeHead(403);
      return res.end('{}');
    }
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const body = JSON.parse(Buffer.concat(chunks).toString());
    await handle(body, (value) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(value));
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${server.address().port}/rpc`,
    close: async () => {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  };
}
const config = {
  maxConcurrent: 1,
  browserPool: { enabled: false, size: 2 },
  hcaptcha: {},
  telegram: {},
  planNames: { plus: 'chatgptplusplan' },
  headful: false
};
const task = {
  id: 'synthetic-runtime-task',
  operation: 'proxy_test',
  provider: 'local',
  plan: 'plus',
  payload: { proxyId: 'synthetic-proxy' },
  workerId: 'synthetic-runtime-worker',
  leaseId: 'synthetic-runtime-lease',
  leaseVersion: 1
};

test('health is authenticated, secret-free and reports readiness without exposing card data', async () => {
  let ready = true;
  const listener = await credentials.start({
    url: 'http://127.0.0.1:0',
    key,
    health: () => ({ ready, mode: 'enabled', activeTasks: 0, stopping: false })
  });
  const env = {
    ONLINE_RECHARGE_WORKER_KEY: key,
    ONLINE_RECHARGE_CREDENTIALS_URL: `http://127.0.0.1:${listener.server.address().port}`
  };
  try {
    const response = await fetch(new URL('/health', env.ONLINE_RECHARGE_CREDENTIALS_URL), {
      method: 'POST',
      body: '{}'
    });
    assert.equal(response.status, 401);
    const state = await check(env);
    assert.equal(state.ready, true);
    assert.equal(state.mode, 'enabled');
    assert.doesNotMatch(JSON.stringify(state), /synthetic-online|cvc|cards|token|lease/i);
    ready = false;
    await assert.rejects(check(env), /尚未就绪/);
  } finally {
    await listener.close();
  }
});
test('task runtime and browser profiles use an owned 0700 transient directory, media stays in project', () => {
  const root = transientRoot();
  try {
    assert.equal(fs.statSync(root).mode & 0o777, 0o700);
    const env = require('../worker.cjs').childEnvironment(task);
    assert.equal(env.ONLINE_RECHARGE_RUNTIME_DIR, path.join(root, 'tasks', task.id));
    assert.ok(!env.ONLINE_RECHARGE_RUNTIME_DIR.startsWith(`${engine}${path.sep}`));
    assert.ok(env.ONLINE_RECHARGE_MEDIA_DIR.startsWith(`${engine}${path.sep}`));
    assert.throws(
      () => require('../worker.cjs').childEnvironment({ id: '../other-project' }),
      /目录标识/
    );
    require('../upstream/browser-pool').setRuntimeProfileRoot(root);
    assert.throws(
      () => require('../upstream/browser-pool').setRuntimeProfileRoot('relative'),
      /绝对路径/
    );
  } finally {
    clearTransientRoot();
  }
  assert.equal(fs.existsSync(root), false);
});
test('credentials-only worker has private health and exits cleanly on SIGINT without RPC', async () => {
  const url = `http://127.0.0.1:${await freePort()}`;
  const process = worker(
    { ONLINE_RECHARGE_ENGINE_ENABLED: '0', ONLINE_RECHARGE_CREDENTIALS_URL: url },
    ['--credentials-only']
  );
  try {
    assert.equal(
      (
        await until(() =>
          check({ ONLINE_RECHARGE_WORKER_KEY: key, ONLINE_RECHARGE_CREDENTIALS_URL: url })
        )
      ).mode,
      'credentials-only'
    );
    process.child.kill('SIGINT');
    const exit = await process.exit;
    assert.equal(exit.code, 0);
    assert.equal(exit.signal, null);
    assert.doesNotMatch(exit.output, /synthetic-online/);
  } finally {
    process.cleanup();
  }
});
test('SIGTERM after child exit still waits its result transaction and exits without an exit-listener race', async () => {
  let claimed = false,
    completeReply;
  const api = await rpcServer(async (body, reply) => {
    if (body.method === 'getRuntimeConfig') return reply(config);
    if (body.method === 'claimJob') {
      if (claimed) return reply(null);
      claimed = true;
      return reply(task);
    }
    if (body.method === 'getActiveProxy') return reply(null);
    if (body.method === 'completeJob') {
      completeReply = reply;
      return;
    }
    return reply({ ok: true });
  });
  const process = worker({
    ONLINE_RECHARGE_ENGINE_ENABLED: '1',
    ONLINE_RECHARGE_CREDENTIALS_URL: `http://127.0.0.1:${await freePort()}`,
    ONLINE_RECHARGE_RPC_URL: api.url
  });
  try {
    await until(() => Boolean(completeReply));
    process.child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 60));
    completeReply({ ok: true });
    const exit = await process.exit;
    assert.equal(exit.code, 0);
    assert.equal(exit.signal, null);
    assert.doesNotMatch(exit.output, /关停等待超时|synthetic-online/);
  } finally {
    process.cleanup();
    await api.close();
  }
});
test('a task arriving after SIGTERM is left for its lease recovery and never starts external execution', async () => {
  let claimReply,
    configReads = 0,
    completionCalls = 0;
  const api = await rpcServer(async (body, reply) => {
    if (body.method === 'getRuntimeConfig') {
      configReads++;
      return reply(config);
    }
    if (body.method === 'claimJob') {
      claimReply = reply;
      return;
    }
    completionCalls++;
    return reply({ ok: true });
  });
  const process = worker({
    ONLINE_RECHARGE_ENGINE_ENABLED: '1',
    ONLINE_RECHARGE_CREDENTIALS_URL: `http://127.0.0.1:${await freePort()}`,
    ONLINE_RECHARGE_RPC_URL: api.url
  });
  try {
    await until(() => Boolean(claimReply));
    process.child.kill('SIGTERM');
    await new Promise((resolve) => setTimeout(resolve, 60));
    claimReply(task);
    const exit = await process.exit;
    assert.equal(exit.code, 0);
    assert.equal(exit.signal, null);
    assert.equal(configReads, 1);
    assert.equal(completionCalls, 0);
  } finally {
    process.cleanup();
    await api.close();
  }
});
test('SIGTERM interrupting an unconfirmed child leaves outcome to backend lease recovery without inventing a result', async () => {
  let claimed = false,
    proxyStarted = false,
    completionCalls = 0;
  const api = await rpcServer(async (body, reply) => {
    if (body.method === 'getRuntimeConfig') return reply(config);
    if (body.method === 'claimJob') {
      if (claimed) return reply(null);
      claimed = true;
      return reply(task);
    }
    if (body.method === 'getActiveProxy') {
      proxyStarted = true;
      return;
    }
    if (['completeJob', 'failJob'].includes(body.method)) completionCalls++;
    return reply({ ok: true });
  });
  const process = worker({
    ONLINE_RECHARGE_ENGINE_ENABLED: '1',
    ONLINE_RECHARGE_CREDENTIALS_URL: `http://127.0.0.1:${await freePort()}`,
    ONLINE_RECHARGE_RPC_URL: api.url
  });
  try {
    await until(() => proxyStarted);
    process.child.kill('SIGTERM');
    const exit = await process.exit;
    assert.equal(exit.code, 0);
    assert.equal(exit.signal, null);
    assert.equal(completionCalls, 0);
  } finally {
    process.cleanup();
    await api.close();
  }
});

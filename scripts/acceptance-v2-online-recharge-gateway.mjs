// Actual pinned production Nginx and online-recharge API classes; synthetic records only.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { request } from 'node:http';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('..', import.meta.url));
const evidence = resolve(root, '.runtime/online-recharge/gateway');
const require = createRequire(import.meta.url);
require('reflect-metadata');
const { ConfigService } = require('@nestjs/config');
const { Test } = require('@nestjs/testing');
const { WebSocket } = require('ws');
const load = (path) => require(resolve(root, 'apps/api/dist', path));
const { OnlineRechargePublicController, OnlineRechargePublicLimiter } = load(
  'id-business-v2/online-recharge/public.controller.js'
);
const { OnlineRechargeTasksService } = load('id-business-v2/online-recharge/tasks.service.js');
const { OnlineRechargeTasksRepository } = load(
  'id-business-v2/online-recharge/persistence/tasks.repository.js'
);
const { OnlineRechargeEphemeralCredentials } = load(
  'id-business-v2/online-recharge/ephemeral-credentials.service.js'
);
const { OnlineRechargeProgressWebsocket } = load(
  'id-business-v2/online-recharge/progress-websocket.service.js'
);
const { FieldEncryptionService } = load('common/crypto/field-encryption.service.js');
const docker = process.env.ONLINE_RECHARGE_GATEWAY_DOCKER || 'docker';
const image =
  'nginx:1.27-alpine@sha256:65645c7bb6a0661892a8b03b89d0743208a18dd2f3f17a54ef4b76fb8e2f2a10';
const container = `online-recharge-gateway-${randomUUID()}`;
const label = 'id-business-v2.fixture=online-recharge-gateway';
const command = (args) =>
  execFileSync(docker, args, {
    encoding: 'utf8',
    timeout: 60000,
    stdio: ['ignore', 'pipe', 'pipe']
  }).trim();
const pause = (ms) => new Promise((done) => setTimeout(done, ms));
async function until(check) {
  for (let attempt = 0; attempt < 100; attempt++) {
    if (await check()) return;
    await pause(100);
  }
  throw new Error('Synthetic gateway fixture did not become ready');
}
const config = new ConfigService({
  HASH_SECRET: 'synthetic-gateway-hash-only',
  FIELD_ENCRYPTION_KEY: 'synthetic-gateway-key-only'
});
const encryption = new FieldEncryptionService(config);
const credentials = new OnlineRechargeEphemeralCredentials(config);
const taskA = '11111111-1111-4111-8111-111111111111';
const taskB = '22222222-2222-4222-8222-222222222222';
const tokenA = 'synthetic-gateway-capability-a';
const records = new Map(
  [taskA, taskB].map((id) => [
    id,
    {
      id,
      operation: 'subscription',
      status: 'queued',
      plan: 'plus',
      provider: 'local',
      progress: 0,
      stage: 'queued',
      message: 'Synthetic fixture',
      publicTokenHash: encryption.hash(id === taskA ? tokenA : 'synthetic-gateway-capability-b'),
      createdAt: new Date('2026-10-09T00:00:00Z'),
      updatedAt: new Date('2026-10-09T00:00:00Z')
    }
  ])
);
const repository = {
  read: (action) =>
    action({
      onlineRechargeTask: { findUnique: async ({ where }) => records.get(where.id) ?? null }
    })
};
const tasks = new OnlineRechargeTasksService(
  new OnlineRechargeTasksRepository(repository, {}, encryption, credentials)
);
const report = {
  scope: 'OFFLINE_SYNTHETIC_GATEWAY_ONLY',
  database: 'NOT_CONNECTED',
  realSession: 'NOT_USED',
  realPayment: 'NOT_MEASURED',
  image,
  cases: []
};
let app, progress, containerId;
const sockets = new Set();
function socketResult(url, payload, origin) {
  return new Promise((done, reject) => {
    const ws = new WebSocket(url, { origin });
    sockets.add(ws);
    let upgradeStatus;
    const timeout = setTimeout(() => {
      ws.terminate();
      reject(new Error('Synthetic WebSocket fixture timed out'));
    }, 8000);
    const finish = (value) => {
      clearTimeout(timeout);
      done({ ws, upgradeStatus, ...value });
    };
    ws.once('upgrade', (response) => {
      upgradeStatus = response.statusCode;
    });
    ws.once('open', () => ws.send(JSON.stringify(payload)));
    ws.once('message', (value) => finish({ data: JSON.parse(value.toString()) }));
    ws.once('close', (code) => {
      sockets.delete(ws);
      finish({ closeCode: code });
    });
    ws.once('unexpected-response', (_, response) => {
      ws.terminate();
      finish({ rejectedStatus: response.statusCode });
    });
    ws.once('error', () => finish({ failed: true }));
  });
}
async function closeSocket(ws) {
  if (ws.readyState === WebSocket.CLOSED) return;
  const closed = new Promise((done) => ws.once('close', done));
  ws.close();
  await closed;
}
try {
  mkdirSync(evidence, { recursive: true });
  const source = readFileSync(resolve(root, 'deploy/nginx/admin.conf'), 'utf8');
  assert.match(
    source,
    /location = \/api\/id-business-v2\/online-recharge\/ws\s*\{[\s\S]*?proxy_set_header Upgrade \$http_upgrade;/
  );
  const general = source.match(/location \/api\/\s*\{([\s\S]*?)\n\s{2}\}/)?.[1];
  assert.ok(
    general && !general.includes('proxy_set_header Upgrade'),
    'ordinary API must not accept upgrades'
  );
  report.nginxSourceSha256 = createHash('sha256').update(source).digest('hex');
  report.apiClassInputs = [
    'id-business-v2/online-recharge/public.controller',
    'id-business-v2/online-recharge/tasks.service',
    'id-business-v2/online-recharge/persistence/tasks.repository',
    'id-business-v2/online-recharge/ephemeral-credentials.service',
    'id-business-v2/online-recharge/progress-websocket.service',
    'common/crypto/field-encryption.service'
  ].map((path) => ({
    path,
    sourceSha256: createHash('sha256')
      .update(readFileSync(resolve(root, 'apps/api/src', path + '.ts')))
      .digest('hex'),
    compiledSha256: createHash('sha256')
      .update(readFileSync(resolve(root, 'apps/api/dist', path + '.js')))
      .digest('hex')
  }));
  command(['image', 'inspect', image]);
  const module = await Test.createTestingModule({
    controllers: [OnlineRechargePublicController],
    providers: [
      OnlineRechargePublicLimiter,
      { provide: OnlineRechargeTasksService, useValue: tasks }
    ]
  }).compile();
  app = module.createNestApplication({ logger: false });
  app.setGlobalPrefix('api');
  app
    .getHttpAdapter()
    .getInstance()
    .get('/api/gateway-fixture/headers', (req, res) =>
      res.json({ upgrade: req.headers.upgrade ?? null, connection: req.headers.connection ?? null })
    );
  await app.listen(0, '0.0.0.0');
  progress = new OnlineRechargeProgressWebsocket(
    { httpAdapter: app.getHttpAdapter() },
    config,
    credentials,
    tasks
  );
  progress.onApplicationBootstrap();
  const apiPort = app.getHttpServer().address().port;
  const fixtureConfig = resolve(evidence, 'admin.fixture.conf');
  const staticRoot = resolve(evidence, 'static');
  mkdirSync(staticRoot, { recursive: true });
  writeFileSync(
    resolve(staticRoot, 'index.html'),
    '<!doctype html><title>offline gateway fixture</title>offline gateway fixture'
  );
  writeFileSync(
    fixtureConfig,
    source.replaceAll('http://api:3000', `http://host.docker.internal:${apiPort}`)
  );
  containerId = command([
    'run',
    '-d',
    '--pull=never',
    '--platform',
    'linux/amd64',
    '--name',
    container,
    '--label',
    label,
    '--read-only',
    '--user',
    '101:101',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges:true',
    '--tmpfs',
    '/var/cache/nginx:rw,noexec,nosuid,nodev,uid=101,gid=101,mode=0700',
    '--tmpfs',
    '/var/run:rw,noexec,nosuid,nodev,uid=101,gid=101,mode=0700',
    '--publish',
    '127.0.0.1::80',
    '--mount',
    `type=bind,source=${fixtureConfig},target=/etc/nginx/conf.d/default.conf,readonly`,
    '--mount',
    `type=bind,source=${staticRoot},target=/usr/share/nginx/html,readonly`,
    '--entrypoint',
    'nginx',
    image,
    '-g',
    'daemon off;'
  ]);
  const port = command(['port', container, '80/tcp']).split(':').at(-1);
  const origin = `http://127.0.0.1:${port}`;
  config.set('CORS_ORIGIN', origin);
  await until(async () => (await fetch(origin).catch(() => null))?.ok);
  for (const path of ['/online-recharge', '/online-recharge/subscription']) {
    const response = await fetch(origin + path);
    assert.equal(response.status, 200);
    assert.match(await response.text(), /offline gateway fixture/);
    report.cases.push({ case: `spa-fallback:${path}`, result: 'PASS' });
  }
  for (const endpoint of ['task', 'subscribe']) {
    const response = await fetch(
      `${origin}/api/id-business-v2/online-recharge/public/${endpoint}`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ id: taskB, taskToken: tokenA })
      }
    );
    assert.equal(response.status, 403, 'cross-task capability must fail before issuing a ticket');
    report.cases.push({ case: `cross-task-capability-denied:${endpoint}`, result: 'PASS' });
  }
  const subscription = await fetch(
    `${origin}/api/id-business-v2/online-recharge/public/subscribe`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ id: taskA, taskToken: tokenA })
    }
  );
  assert.equal(subscription.status, 201);
  const issued = await subscription.json();
  const wsUrl = `${origin.replace('http:', 'ws:')}${issued.wsPath}`;
  const valid = await socketResult(
    wsUrl,
    { type: 'subscribe', ticket: issued.ticket, taskId: taskB },
    origin
  );
  assert.equal(valid.upgradeStatus, 101);
  assert.equal(
    valid.data?.task.id,
    taskA,
    'task id in a frame cannot override the authorized ticket'
  );
  assert.equal(valid.data?.task.email, undefined);
  assert.equal(valid.data?.task.cardLast4, undefined);
  await closeSocket(valid.ws);
  report.cases.push({ case: 'nginx-to-api-101-authoritative-ticket-task', result: 'PASS' });
  const replay = await socketResult(wsUrl, { type: 'subscribe', ticket: issued.ticket }, origin);
  assert.equal(replay.closeCode, 1008);
  report.cases.push({ case: 'one-use-ticket-replay-denied', result: 'PASS' });
  const noTicket = await socketResult(wsUrl, { type: 'subscribe', taskId: taskB }, origin);
  assert.equal(noTicket.closeCode, 1008);
  report.cases.push({ case: 'task-id-only-subscription-denied', result: 'PASS' });
  const foreign = await socketResult(
    wsUrl,
    { type: 'subscribe', ticket: credentials.ticket(taskA).ticket },
    'https://synthetic-other-origin.example.test'
  );
  assert.notEqual(foreign.upgradeStatus, 101);
  assert.ok(foreign.failed || foreign.rejectedStatus);
  report.cases.push({ case: 'foreign-origin-upgrade-denied', result: 'PASS' });
  const headers = await new Promise((done, reject) => {
    const req = request(
      origin + '/api/gateway-fixture/headers',
      { headers: { Upgrade: 'websocket', Connection: 'upgrade' } },
      (res) => {
        let data = '';
        res.on('data', (chunk) => {
          data += chunk;
        });
        res.on('end', () => done(JSON.parse(data)));
      }
    );
    req.on('error', reject);
    req.end();
  });
  assert.equal(headers.upgrade, null);
  report.cases.push({ case: 'ordinary-api-upgrade-not-forwarded', result: 'PASS' });
  report.ok = true;
  writeFileSync(resolve(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n');
  console.log(
    JSON.stringify({ ok: true, cases: report.cases.length, evidence, scope: report.scope })
  );
} finally {
  for (const socket of sockets) socket.terminate();
  progress?.onModuleDestroy();
  await app?.close();
  if (containerId) {
    const actualId = command(['inspect', container, '--format', '{{.Id}}']);
    const actualLabel = command([
      'inspect',
      container,
      '--format',
      '{{index .Config.Labels "id-business-v2.fixture"}}'
    ]);
    assert.equal(actualId, containerId);
    assert.equal(actualLabel, 'online-recharge-gateway');
    command(['rm', '-f', container]);
    if (report.ok) {
      report.cleanup = 'OWNED_FIXTURE_CONTAINER_REMOVED';
      writeFileSync(resolve(evidence, 'result.json'), JSON.stringify(report, null, 2) + '\n');
    }
  }
}

import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { once } from 'node:events';
import { mkdir, mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:http';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { createRechargePartnerHandlers, partnerApiPrefix } from '../server/recharge-partner-api.mjs';
import { rechargePartnerGateway } from '../server/recharge-partner-gateway.mjs';
import {
  commitPartnerIssue, createStorefrontAdmissionClient, listenPrivateRechargeSocket, listenStorefrontAdmission,
  moyaoRechargeChannel, partnerTaskDirectoryName, partnerTaskSocketName, storefrontAdmissionSocketName
} from '../modules/recharge/vendure/admission.mjs';
import {
  createLoopbackVendureRechargeBridge, rechargeWorkerPrefix, signRechargeWorkerRequest, vendureRechargePrefix
} from '../modules/recharge/vendure/loopback-bridge.mjs';

const publicOrigin = 'https://id.example.test';
const admin = { id: 'synthetic-admin', name: '测试管理员', active: true, role: 'super' };
const session = JSON.stringify({
  user: { id: 'synthetic-user', email: 'synthetic@example.test' }, accessToken: 'synthetic-not-a-real-session'
});
const nativeCodes = ['A', 'B', 'C', 'D'].map(letter => 'KC-' + letter.repeat(15));
const vendureKey = 'only-synthetic-legacy-gateway-credential';
const workerSecret = 'only-synthetic-worker-signing-credential';
const copies = value => structuredClone(value);

async function fixture(t) {
  const documents = new Map();
  const keyDigests = new Map();
  const read = name => copies(documents.get(name) ?? { version: 0, data: null });
  const conflict = () => Object.assign(new Error('version conflict'), { status: 409 });
  const store = {
    featureDocument: read,
    rechargePartnerTicket: id => createHmac('sha256', 'synthetic-ticket-signing-key').update(id).digest('base64url'),
    rechargePartnerKeyHash(value) {
      if (!keyDigests.has(value)) keyDigests.set(value, randomBytes(32).toString('hex'));
      return keyDigests.get(value);
    },
    saveFeatureDocument(name, version, data) {
      if (read(name).version !== version) throw conflict();
      documents.set(name, { version: version + 1, data: copies(data) });
    },
    saveRechargePartnerBatch(version, inventoryVersion, batch) {
      const partners = read('recharge-partners');
      const inventory = read('recharge-codes');
      if (partners.version !== version || inventory.version !== inventoryVersion) throw conflict();
      store.saveFeatureDocument('recharge-partners', version, {
        ...partners.data, batches: [...(partners.data?.batches ?? []), batch]
      });
      store.saveFeatureDocument('recharge-codes', inventoryVersion, {
        ...inventory.data, partnerReservedCodes: [...(inventory.data?.partnerReservedCodes ?? []),
          ...batch.codes.map(row => row.nativeCode)]
      });
    }
  };
  let now = Date.now();
  const stock = nativeCodes.map(code => ({ code, plan: 'plus' }));
  let beforeNativeLookup;
  const transport = {
    listCodeStock: async () => stock,
    async verifyStorefrontCode(code) {
      await beforeNativeLookup?.(code);
      return stock.some(row => row.code === code) ? { plan: 'plus', status: 'available' } : null;
    }
  };
  let partnerHandlers;
  const bridge = createLoopbackVendureRechargeBridge({
    codes: [], vendureKey, workerSecret, now: () => now,
    lookupAdmission: (...args) => partnerHandlers.lookupAdmission(...args),
    commitPartnerBatch: (id, codes) => partnerHandlers.issueBatch(id, codes)
  });
  const partnerServer = createServer(bridge.handlePartner);
  const server = createServer((req, res) => {
    const url = req.url;
    if (url === '/admin') return void partnerHandlers.admin(req, res, req.headers['x-test-role']
      ? { ...admin, role: req.headers['x-test-role'] } : admin);
    if (url === '/authorize') return void partnerHandlers.authorization(req, res);
    if (url.startsWith(partnerApiPrefix + '/'))
      return void partnerHandlers.api(req, res, url.slice(partnerApiPrefix.length));
    return void bridge.handle(req, res);
  });
  for (const listener of [server, partnerServer]) {
    listener.listen(0, '127.0.0.1');
    await once(listener, 'listening');
  }
  t.after(async () => {
    bridge.close();
    await Promise.all([server, partnerServer].map(listener => new Promise(resolve => listener.close(resolve))));
  });
  let loseResponse = false, maintenance = false, rejectSubmit = false;
  const address = listener => 'http://127.0.0.1:' + listener.address().port;
  const gateway = async (action, data) => {
    if (action === 'config' && maintenance) return { maintenance: true };
    if (action === 'submit' && rejectSubmit) return { rejected: true };
    const res = await fetch(address(partnerServer) + '/' + action, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(data)
    });
    if (action === 'issue' && res.status === 409) return false;
    if ((action === 'query' && res.status === 400) || (action === 'task' && res.status === 404)) return null;
    const value = await res.json();
    if (action === 'submit' && loseResponse) throw new Error('synthetic lost response');
    assert.equal(res.status, 200);
    return value;
  };
  partnerHandlers = createRechargePartnerHandlers({
    store, transport, gateway, origin: publicOrigin, readSource: () => '203.0.113.2',
    authorizeAdmin: req => req.headers['x-test-unverified'] !== '1',
    clock: () => now
  });
  const call = async (path, body, headers = {}) => {
    const res = await fetch(address(server) + path, {
      ...(body && { method: 'POST', body: JSON.stringify(body) }),
      headers: { 'content-type': 'application/json', ...headers }
    });
    assert.equal(res.headers.get('cache-control'), 'no-store');
    return { status: res.status, body: await res.json() };
  };
  return {
    documents, advance: ms => { now += ms; }, setMaintenance: flag => { maintenance = flag; },
    rejectSubmit: flag => { rejectSubmit = flag; },
    onNativeLookup: fn => { beforeNativeLookup = fn; },
    loseResponse: flag => { loseResponse = flag; },
    admin: (body, headers) => call('/admin', body, { origin: publicOrigin, ...headers }),
    api: (key, path, body, operation) => call(partnerApiPrefix + path, body, {
      authorization: 'Bearer ' + key, ...(operation && { 'idempotency-key': operation })
    }),
    authorize: (body, origin = publicOrigin) => call('/authorize', body, { origin }),
    legacy: (action, body) => call(vendureRechargePrefix + '/' + action, body, {
      'x-vendure-recharge-key': vendureKey, 'x-vendure-client-ip': '203.0.113.2',
      'x-vendure-recharge-channel': moyaoRechargeChannel
    }),
    worker: (action, body = {}) => {
      const path = rechargeWorkerPrefix + '/' + action;
      return call(path, body, signRechargeWorkerRequest(workerSecret, path, JSON.stringify(body), now));
    }
  };
}

async function enrollment(f, name, count = 1) {
  const result = await f.admin({ action: 'create', name, operationId: 'create-' + name });
  assert.equal(result.status, 201);
  const { partner, apiKey } = result.body;
  const issue = { action: 'issue', partnerId: partner.id, plan: 'plus', count, operationId: 'issue-' + name };
  const allocated = await f.admin(issue);
  assert.equal(allocated.status, 201, JSON.stringify(allocated.body));
  assert.deepEqual((await f.admin(issue)).body, allocated.body);
  return { ...partner, apiKey, codes: allocated.body.batch.codes };
}

const authorizationInput = request => {
  const [id, ticket] = new URL(request.authorizationUrl).hash.slice(1).split('.');
  return { id, ticket };
};

test('partner keys, inventory and task receipts stay private across both storefront routes', async t => {
  const f = await fixture(t);
  const denied = { action: 'create', name: 'denied', operationId: 'test-denied' };
  assert.equal((await f.admin(denied, { 'x-test-role': 'admin' })).status, 403);
  assert.equal((await f.admin(denied, { 'x-test-unverified': '1' })).status, 403);
  const a = await enrollment(f, 'merchant-a');
  const b = await enrollment(f, 'merchant-b');
  const [code] = a.codes;
  assert.equal((await f.api(a.apiKey, '/config')).body.maintenance, false);
  assert.equal((await f.api(a.apiKey + 'x', '/config')).status, 401);
  assert.deepEqual((await f.api(a.apiKey, '/codes/verify', { code })).body, { plan: 'plus', status: 'available' });
  assert.equal((await f.api(b.apiKey, '/codes/verify', { code })).status, 404);
  assert.equal((await f.api(a.apiKey, '/codes/query', { code: b.codes[0] })).status, 404);
  assert.equal((await f.legacy('query', { code: nativeCodes[0] })).status, 400);
  const get = await f.admin();
  assert(!JSON.stringify(get.body).includes(a.apiKey));
  assert(!JSON.stringify(get.body).includes(nativeCodes[0]));
  assert(!JSON.stringify([...f.documents]).includes(a.apiKey));
  const repeatedKey = await f.admin({ action: 'create', name: 'merchant-a', operationId: 'create-merchant-a' });
  assert.equal(repeatedKey.body.apiKey, undefined);

  const requests = await Promise.all([0, 1, 2].map(() =>
    f.api(a.apiKey, '/redemptions', { code }, 'source-order-1')));
  assert.equal(new Set(requests.map(row => row.body.id)).size, 1);
  assert.equal(requests.filter(row => row.status === 201).length, 1);
  const created = requests[0].body;
  assert.equal(created.status, 'awaiting_authorization');
  const ticket = authorizationInput(created);
  assert(!JSON.stringify([...f.documents]).includes(ticket.ticket));
  assert.equal((await f.api(b.apiKey, '/redemptions/' + ticket.id)).status, 404);
  assert.equal((await f.authorize(ticket, 'https://other.example.test')).status, 403);
  assert.equal((await f.authorize(ticket)).body.partner, 'merchant-a');
  assert.equal((await f.authorize({ ...ticket, session: '{}' })).status, 422);
  assert.equal((await f.worker('claim')).body.task, null);

  f.loseResponse(true);
  await Promise.all([0, 1, 2].map(() => f.authorize({ ...ticket, session })));
  const running = (await f.worker('claim')).body.task;
  assert.equal(running.executionCode, nativeCodes[0]);
  assert.equal(running.session, session);
  assert.equal((await f.worker('claim')).body.task, null);
  const fromCode = (await f.api(a.apiKey, '/codes/query', { code })).body;
  assert.equal(fromCode.status, 'reserved');
  assert.equal(fromCode.task.id, ticket.id);
  assert.equal(fromCode.task.status, 'running');
  assert(!JSON.stringify(fromCode).includes('taskToken'));
  assert(!JSON.stringify([...f.documents]).includes('synthetic-not-a-real-session'));
  assert.equal((await f.api(a.apiKey, '/redemptions', { code }, 'second-order')).status, 409);
  await f.worker('result', { id: running.id, leaseToken: running.leaseToken, outcome: 'confirmed_success',
    evidenceId: 'synthetic-receipt' });
  assert.equal((await f.api(a.apiKey, '/redemptions/' + ticket.id)).body.status, 'succeeded');
});

test('expiry, maintenance and disabling credentials never create an execution task', async t => {
  const f = await fixture(t);
  const a = await enrollment(f, 'merchant-a', 2);
  const [code, other] = a.codes;
  const created = (await f.api(a.apiKey, '/redemptions', { code }, 'order')).body;
  const ticket = authorizationInput(created);
  const same = (await f.api(a.apiKey, '/redemptions', { code }, 'different-order')).body;
  assert.equal(same.id, ticket.id);
  assert.equal((await f.api(a.apiKey, '/redemptions', { code: other }, 'different-order')).status, 409);
  f.advance(15 * 60_000 + 1);
  assert.equal((await f.authorize({ ...ticket, session })).status, 410);
  assert.equal((await f.api(a.apiKey, '/redemptions/' + ticket.id)).body.status, 'expired');
  f.setMaintenance(true);
  assert.equal((await f.api(a.apiKey, '/codes/verify', { code })).status, 503);
  assert.equal((await f.api(a.apiKey, '/redemptions', { code }, 'new-order')).status, 503);
  f.setMaintenance(false);
  const newRequest = await f.api(a.apiKey, '/redemptions', { code }, 'new-order');
  assert.equal(newRequest.status, 201);
  assert.notEqual(newRequest.body.id, ticket.id);
  f.rejectSubmit(true);
  const newTicket = authorizationInput(newRequest.body);
  const rejected = await f.authorize({ ...newTicket, session });
  assert.equal(rejected.body.code, 'not_accepted');
  assert.equal((await f.authorize(newTicket)).body.status, 'awaiting_authorization');
  assert.equal((await f.admin({ action: 'disable', partnerId: a.id, operationId: 'disable-a' })).status, 200);
  assert.equal((await f.api(a.apiKey, '/config')).status, 401);
  assert.equal((await f.authorize({ ...authorizationInput(newRequest.body), session })).status, 410);
  assert.equal((await f.worker('claim')).body.task, null);
});

test('a partner batch cannot consume stock already queued by the original storefront', async t => {
  const f = await fixture(t);
  assert.equal((await f.legacy('submit', { code: nativeCodes[0], session })).body.status, 'queued');
  const a = await enrollment(f, 'merchant-a');
  const allocation = f.documents.get('recharge-codes').data.partnerReservedCodes;
  assert.deepEqual(allocation, [nativeCodes[1]]);
  assert.equal((await f.api(a.apiKey, '/codes/verify', { code: a.codes[0] })).body.status, 'available');
  assert.equal((await f.worker('claim')).body.task.executionCode, nativeCodes[0]);
});

test('issuing the same stock invalidates an in-flight legacy check before it can enqueue', async t => {
  const f = await fixture(t);
  const started = Promise.withResolvers();
  const unblock = Promise.withResolvers();
  f.onNativeLookup(async code => {
    if (code === nativeCodes[0]) {
      started.resolve();
      await unblock.promise;
    }
  });
  const legacy = f.legacy('submit', { code: nativeCodes[0], session });
  await started.promise;
  try {
    await enrollment(f, 'merchant-a');
  } finally {
    unblock.resolve();
  }
  assert.equal((await legacy).body.rejected, true);
  assert.equal((await f.worker('claim')).body.task, null);
});

test('the private task socket uses the same admission listener and returns only the request owner', async t => {
    const projectRoot = fileURLToPath(new URL('../', import.meta.url));
    const worktreeOwner = /^(.+)\/\.(?:codex-)?worktrees\/[^/]+\/$/.exec(projectRoot)?.[1];
    const root = join(worktreeOwner || projectRoot, '.runtime');
    if (Buffer.byteLength(join(root, 'rp-XXXXXX', partnerTaskDirectoryName, partnerTaskSocketName)) >= 104)
      return t.skip('project path exceeds the platform Unix socket limit');
    await mkdir(root, { recursive: true, mode: 0o700 });
    const directory = await realpath(await mkdtemp(join(root, 'rp-')));
    const input = { partnerId: 'rp_' + 'a'.repeat(24), clientIp: '203.0.113.3', code: nativeCodes[0],
      requestId: '11111111-1111-4111-8111-111111111111' };
    let issued;
    const admission = await listenStorefrontAdmission(directory, async (code, ip, partnerId) =>
      code === input.code && ip === input.clientIp && partnerId === input.partnerId
        ? { status: 'available', plan: 'plus' } : null, (id, codes) => {
      issued = { id, codes };
      return 200;
    });
    const admissionPath = join(directory, storefrontAdmissionSocketName);
    const bridge = createLoopbackVendureRechargeBridge({
      codes: [], vendureKey, workerSecret,
      lookupAdmission: createStorefrontAdmissionClient(admissionPath),
      commitPartnerBatch: (id, codes) => commitPartnerIssue(admissionPath, id, codes)
    });
    const socket = await listenPrivateRechargeSocket(join(directory, partnerTaskDirectoryName),
      partnerTaskSocketName, bridge.handlePartner);
    t.after(async () => {
      bridge.close();
      await Promise.all([admission, socket].map(listener => new Promise(resolve => listener.close(resolve))));
      await rm(directory, { recursive: true });
    });
    const queue = rechargePartnerGateway(directory);
    assert.equal((await queue('query', { ...input, partnerId: 'rp_' + 'b'.repeat(24) })), null);
    assert.equal((await queue('query', input)).status, 'available');
    await queue('issue', { ...input, codes: [input.code], count: 1 });
    assert.deepEqual(issued, { id: input.requestId, codes: [input.code] });
    assert.equal((await queue('submit', { ...input, session })).status, 'queued');
    assert.equal((await queue('task', input)).status, 'queued');
});

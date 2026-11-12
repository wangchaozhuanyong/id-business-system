import assert from 'node:assert/strict';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import test from 'node:test';
import { Worker } from 'node:worker_threads';
import { createCardManagementHandler } from '../server/card-management.mjs';
import { createLocalBusinessStore, handleLocalBusiness } from '../server/local-business.mjs';

// This suite exercises the real SQLite store using only disposable project-local fixtures.
const administrators = ['a', 'b'].map(id => ({ id: 'fixture-' + id, name: '合成管理员 ' + id, role: 'admin' }));
const origin = 'https://isolated.example.test';
const commerceRoute = '/api/local/commerce';
const cardTypesRoute = '/api/local/card-types';
const storeUrl = new URL('../server/local-business.mjs', import.meta.url).href;
const day = 86_400_000;

async function temporary(t) {
  const root = new URL('../.runtime/', import.meta.url);
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(new URL('mailbox-customer-persistence-', root));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'isolated.sqlite');
}

const rotateWorker = `
  const { parentPort, workerData } = require('node:worker_threads');
  const { once } = require('node:events');
  (async () => {
    const { createLocalBusinessStore } = await import(workerData.storeUrl);
    const store = createLocalBusinessStore(workerData.path);
    try {
      const start = once(parentPort, 'message');
      parentPort.postMessage('ready');
      await start;
      let status;
      try {
        store.rotateManagedMailboxDelivery(workerData.command, workerData.actor, workerData.operation);
        status = 200;
      } catch (error) {
        status = error.status || 500;
      }
      parentPort.postMessage(status);
    } finally { store.close(); }
  })().catch(error => { throw error; });
`;

test('邮箱查询码由两个 SQLite 写入者争用，重启后重放保留同一个新码和员工设置', { timeout: 15000 }, async t => {
  const path = await temporary(t);
  const initial = createLocalBusinessStore(path);
  let command, oldCode;
  try {
    const created = await initial.saveVerifiedManagedMailboxPool({ action: 'create', version: 0,
      provider: 'google', email: 'mailbox-fixture@example.test', appPassword: 'synthetic-credential' },
    administrators[0], async () => {});
    oldCode = created.issuedCode;
    assert.ok(oldCode && initial.findManagedMailbox(oldCode));
    command = { mode: 'single', scope: 'pool', ids: [created.items[0].id],
      version: created.version, inventoryVersion: created.inventoryVersion };
    for (const actor of administrators)
      initial.saveMailboxDeliverySettings({ version: 0, relayQuery: '', googleCredentials: '',
        managedQuery: '合成后缀 ' + actor.id }, actor);
  } finally { initial.close(); }

  const operations = ['fixture-rotation-writer-a', 'fixture-rotation-writer-b'];
  const workers = administrators.map((actor, index) => new Worker(rotateWorker, {
    eval: true, workerData: { storeUrl, path, command, actor, operation: operations[index] }
  }));
  let responses;
  try {
    const ready = await Promise.all(workers.map(worker => once(worker, 'message')));
    assert.deepEqual(ready, [['ready'], ['ready']]);
    const results = workers.map(worker => once(worker, 'message'));
    const exits = workers.map(worker => once(worker, 'exit'));
    for (const worker of workers) worker.postMessage('start');
    responses = (await Promise.all(results)).flat();
    assert.deepEqual(await Promise.all(exits), [[0], [0]]);
    assert.deepEqual([...responses].sort(), [200, 409]);
  } finally { await Promise.all(workers.map(worker => worker.terminate())); }

  const store = createLocalBusinessStore(path);
  try {
    const winner = responses.indexOf(200);
    assert.equal(store.findManagedMailbox(oldCode), null);
    const before = store.audit().length;
    const replay = store.rotateManagedMailboxDelivery(command, administrators[winner], operations[winner]);
    assert.equal(replay.replayed, true);
    assert.equal(replay.version, command.version + 1);
    assert.ok(replay.issuedCode && replay.issuedCode !== oldCode);
    assert.equal(store.findManagedMailbox(replay.issuedCode)?.id, command.ids[0]);
    assert.equal(store.audit().length, before);
    assert.throws(() => store.rotateManagedMailboxDelivery({ ...command, mode: 'all' }, administrators[winner],
      operations[winner]), { status: 409 });
    assert.throws(() => store.rotateManagedMailboxDelivery(command, administrators[1 - winner],
      operations[winner]), { status: 409 });
    for (const actor of administrators)
      assert.equal(store.mailboxDeliverySettings(actor).managedQuery, '合成后缀 ' + actor.id);
  } finally { store.close(); }
});

async function request(invoke, method, route, body, operation) {
  const input = Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]), {
    method, url: route, headers: { origin, 'content-type': 'application/json', 'x-id-operation': operation }
  });
  let status, data;
  await invoke(input, {
    setHeader() {},
    writeHead(code) { status = code; },
    end(value) { data = JSON.parse(value); }
  });
  return { status, data };
}

test('实际订单事务拒绝死卡与解封中卡，保留已开通订单和同尾号其他卡', async t => {
  const path = await temporary(t);
  const store = createLocalBusinessStore(path);
  const [actor, second] = administrators;
  const number = '4242424242424242', sameTail = '4000000000004242';
  const start = new Date(Date.now() - day).toISOString(), expiry = new Date(Date.now() + 29 * day).toISOString();
  const customer = { id: 'fixture-customer', name: '合成客户', active: true };
  const order = (id, card) => ({ id, version: 1, orderNo: id, customerId: customer.id, email: id + '@example.test',
    source: '管理员手工', ownerId: actor.id, product: 'GPT', plan: 'Plus', businessType: '续费', payment: '银行卡',
    proMaterialMode: 'manual_card', proCardNumber: card, cardId: '', paidConfirmed: true, receiptConfirmed: true,
    paidAmount: '20', paidCurrency: 'USD', saleAmount: '100', saleCurrency: 'CNY', start, expiry,
    corrections: [], refunds: [], bankReturns: [] });
  const save = (version, data, operation) => request((input, response) =>
    handleLocalBusiness(input, response, commerceRoute, store, actor, { publicOrigin: origin, readOrderOwners: () => administrators }),
  'PUT', commerceRoute, { version, data, action: '新增独立订单' }, operation);
  const cardHandler = createCardManagementHandler({ store, publicOrigin: origin });
  const mark = (who, body, operation) => request((input, response) =>
    cardHandler(input, response, cardTypesRoute, who), 'POST', cardTypesRoute, body, operation);
  const append = (id, card, operation) => {
    const snapshot = store.load('commerce');
    snapshot.data.orders.push(order(id, card));
    return save(snapshot.version, snapshot.data, operation);
  };
  try {
    const original = await save(0, { customers: [customer], orders: [order('original-order', number)],
      tenants: [], operating: [], rentBatches: [], logs: [] }, 'fixture-card-original');
    assert.equal(original.status, 200, original.data?.error);
    const savedOrder = store.load('commerce').data.orders[0];
    const command = { action: 'health', orderId: savedOrder.id, orderVersion: savedOrder.version,
      version: 0, state: 'dead', reason: '合成资料用于验收状态保存' };
    const marked = await mark(actor, command, 'fixture-card-dead');
    assert.equal(marked.status, 200, marked.data?.error);
    assert.equal((await mark(second, { ...command, state: 'normal' }, 'fixture-card-conflict')).status, 409);
    const rejected = await append('blocked-order', number, 'fixture-card-blocked');
    assert.equal(rejected.status, 409, rejected.data?.error);
    assert.match(rejected.data.error, /死卡/);
    assert.equal(store.load('commerce').version, original.data.version);
    assert.equal(store.load('commerce').data.orders[0].entitlementStatus, 'active');
    const other = await append('same-tail-order', sameTail, 'fixture-card-same-tail');
    assert.equal(other.status, 200, other.data?.error);
    const unlock = await mark(actor, { ...command, version: marked.data.version, state: 'unlocking' }, 'fixture-card-unlock');
    assert.equal(unlock.status, 200, unlock.data?.error);
    assert.match((await append('blocked-order', number, 'fixture-card-unlock-block')).data.error, /解封中/);
    const normal = await mark(actor, { ...command, version: unlock.data.version, state: 'normal' }, 'fixture-card-restore');
    assert.equal(normal.status, 200, normal.data?.error);
    assert.equal((await append('restored-order', number, 'fixture-card-restored')).status, 200);
    assert.deepEqual(store.load('commerce').data.orders.map(row => row.id),
      ['original-order', 'same-tail-order', 'restored-order']);
  } finally { store.close(); }
});

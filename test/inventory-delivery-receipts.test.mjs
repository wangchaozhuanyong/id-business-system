import assert from 'node:assert/strict';
import test from 'node:test';
import { Readable } from 'node:stream';
import { createLocalBusinessStore } from '../server/local-business.mjs';
import { createRelayDeliveryJournal, createRelayDeliveryReconcile, createRelayDeliveryReset } from '../server/apple-relay/code-reset.mjs';
import { createAppleRelayService } from '../server/apple-relay/local-service.mjs';
import { describeWriteOperation } from '../server/write-operation.mjs';
import { localBusinessRequest } from './helpers/local-business-request.mjs';

const actor = { id: 'receipt-admin', name: '合成管理员', role: 'admin' };
const otherActor = { ...actor, id: 'other-receipt-admin' };
const origin = 'https://receipt.example.test';
const inventory = () => ({ mailboxes: [], accounts: [], batches: [], returnRecords: [],
  importRecords: [], registrationRecords: [], tableSettings: [], undo: [] });
const read = (store, route, operationId, acting = actor) =>
  localBusinessRequest(store, route, { operationId, actor: acting, publicOrigin: origin });

test('库存提取回执与批次同事务，后续提取及其他操作人不改变原结果', async t => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const writeId = 'synthetic-stock-extraction';
  const path = 'inventory/extraction-receipt';
  const command = { version: 0, action: 'inventory_extract', data: {
    ...inventory(),
    accounts: [{ id: 'stock', type: 'gpt', email: 'stock@example.test', health: 'normal',
      inventoryState: 'claimed', claimId: 'original-claim', claimBatchId: 'original-batch', used: true, usageLinks: [] }],
    batches: [{ id: 'original-batch', kind: 'account', purpose: '客户交付', time: '2026-11-21 10:30',
      actorId: actor.id, actorName: actor.name,
      items: [{ id: 'original-claim', assetId: 'stock', type: 'gpt', status: 'pending', claimedAt: '2026-11-21 10:30' }] }]
  } };
  assert.deepEqual((await read(store, path, writeId)).body, { status: 'pending' });
  const first = await localBusinessRequest(store, 'inventory', { body: command, method: 'PUT',
    actor, operationId: writeId, publicOrigin: origin });
  assert.equal(first.status, 200, JSON.stringify(first.body));
  assert.equal(store.load('inventory').version, 1);
  await localBusinessRequest(store, 'inventory', { body: command, method: 'PUT',
    actor, operationId: writeId, publicOrigin: origin });
  const received = await read(store, path, writeId);
  assert.deepEqual(received.body, { status: 'saved', batchId: 'original-batch' });
  assert.equal(received['Cache-Control'], 'private, no-store');
  assert.equal(store.load('inventory').version, 1);
  assert.deepEqual((await read(store, path, writeId, otherActor)).body, { status: 'pending' });
  assert.equal((await read(store, path, writeId, { ...actor, role: 'registrar' })).status, 403);
  assert.equal((await read(store, path, 'malformed')).status, 400);
  assert.deepEqual((await read(store, 'tools/mailbox-pool/delivery-receipt', writeId)).body, { status: 'pending' });
});

test('普通邮箱回执只读原结果并排除查询码与凭据', async t => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const password = 'synthetic-mailbox-credential';
  const result = store.saveManagedMailboxPool({
    action: 'create', version: 0, email: 'rotation@example.test', provider: 'google', appPassword: password
  }, actor);
  const operationId = 'synthetic-mailbox-rotation';
  const pool = store.loadManagedMailboxPool();
  const target = pool.items[0].id;
  assert.ok(result.issuedCode);
  const command = { action: 'rotate-delivery', scope: 'pool', mode: 'single', ids: [target],
    version: pool.version, inventoryVersion: pool.inventoryVersion };
  const rotated = store.rotateManagedMailboxDelivery(command, actor, operationId);
  assert.ok(rotated.issuedCode);
  const path = 'tools/mailbox-pool/delivery-receipt';
  const receipt = await read(store, path, operationId);
  assert.equal(receipt.status, 200);
  assert.equal(receipt.body.status, 'saved');
  assert.deepEqual(receipt.body.results, rotated.results);
  assert(!JSON.stringify(receipt.body).includes(rotated.issuedCode));
  assert(!JSON.stringify(receipt.body).includes(password));
  assert.deepEqual((await read(store, path, operationId, otherActor)).body, { status: 'pending' });
  assert.equal(store.loadManagedMailboxPool().version, rotated.version);
  assert.equal((await read(store, path, operationId, { ...actor, role: 'employee' })).status, 403);
  assert.deepEqual((await read(store, 'inventory/extraction-receipt', operationId)).body, { status: 'pending' });
});

test('隐藏邮箱只读回执投影保持待核对，已完成项只展示结果', () => {
  const records = new Map();
  let writes = 0, audits = 0;
  const journal = createRelayDeliveryJournal({
    read: domain => records.get(domain) || { version: 0 }, inventoryVersion: () => 4,
    write(domain, version, data) { writes++; records.set(domain, { version, data }); },
    audit() { audits++; }, transaction: operation => operation()
  });
  const id = 'synthetic-relay-delivery';
  const operation = describeWriteOperation(id, actor, ['original-command-fixture']);
  const started = journal.start(operation, 4, [{ id: 'alias', email: 'alias@example.test', version: 1 }]);
  const queued = started.rows[0];
  const pending = journal.receipt(actor, id);
  assert.equal(pending.status, 'pending');
  assert.equal(pending.results[0].status, 'pending');
  assert.equal(writes, 1);
  const startedAt = Date.now(), digest = 'fixture-only-digest';
  const running = journal.claim(operation, queued, 'private-upstream-identifier', 'previous-digest',
    null, startedAt, startedAt, 4, actor);
  assert.equal(running.ok, true);
  journal.finish(operation, running.row, { status: 'success', digest }, actor);
  const afterWrite = writes;
  assert.deepEqual(journal.receipt(actor, id), { status: 'saved',
    results: [{ id: 'alias', email: 'alias@example.test', status: 'success' }] });
  assert.deepEqual(journal.receipt(otherActor, id), { status: 'pending' });
  assert.equal(writes, afterWrite);
  assert.equal(audits, 1);
});

test('隐藏邮箱刷新后按原编号核对已提交的供应商重置，未确认或未领取的保留待核对', async () => {
  const docs = new Map();
  const now = () => Date.parse('2026-11-22T12:00:00Z');
  const duration = 86_400_000;
  const ids = ['provider-committed', 'provider-unknown', 'not-claimed'];
  const targets = ids.map(id => ({ id, email: id + '@example.test', version: 1 }));
  const remoteIds = new Map(targets.map(row => ['remote-' + row.id, row.id]));
  const providerCommitted = new Set();
  const audit = [];
  const providerRead = [];
  let mutations = 0;
  const createJournal = () => createRelayDeliveryJournal({
    read: key => docs.get(key) || { version: 0 }, inventoryVersion: () => 7,
    write: (key, version, data) => docs.set(key, { version, data }),
    transaction: callback => callback(), now, audit: (acting, id) => audit.push([acting.id, id])
  });
  const lookup = async (kind, id) => {
    assert.equal(kind, 'alias');
    providerRead.push(id);
    const local = targets.find(row => row.id === id), changed = providerCommitted.has(id);
    return { local, remoteId: 'remote-' + id, owner: { remote: { status: 'ACTIVE' } },
      remote: { buyerQueryCode: changed ? 'fixture-code-after' : 'fixture-code-before',
        codeExpiresAt: new Date(now() + (changed ? 30 : 1) * duration).toISOString() } };
  };
  const journal = createJournal();
  const reset = createRelayDeliveryReset({ journal, lookup, now,
    readAliases: async () => ({ aliases: new Map(targets.map(row => [row.id, row])) }),
    async mutate(kind, remoteId) {
      assert.equal(kind, 'alias');
      mutations++;
      if (remoteIds.get(remoteId) === ids[0]) providerCommitted.add(ids[0]);
      throw new Error('synthetic upstream response lost');
    }
  });
  const firstId = 'synthetic-relay-reconcile';
  const first = await reset({ mode: 'selected', ids: ids.slice(0, 2), inventoryVersion: 7 }, actor, firstId);
  assert.deepEqual(first.results.map(row => row.status), ['pending', 'pending']);
  const unclaimedId = 'synthetic-relay-unclaimed';
  journal.start(describeWriteOperation(unclaimedId, actor, ['fixture']), 7, [targets[2]]);

  const reloaded = createJournal();
  const reconcile = createRelayDeliveryReconcile({ journal: reloaded, lookup, now });
  providerRead.length = 0;
  assert.equal(reloaded.receipt(actor, firstId).status, 'pending');
  assert.deepEqual(await reconcile(otherActor, firstId), { status: 'pending' });
  assert.equal((await reconcile(actor, unclaimedId)).status, 'pending');
  assert.deepEqual(providerRead, []);

  const result = await reconcile(actor, firstId);
  assert.equal(result.status, 'pending');
  assert.deepEqual(result.results.map(row => row.status), ['success', 'pending']);
  assert.deepEqual(providerRead.sort(), ids.slice(0, 2).sort());
  assert.doesNotMatch(JSON.stringify(result), /fixture-code-|remote-provider/);
  assert.equal(mutations, 2);
  assert.deepEqual(audit, [[actor.id, ids[0]]]);
  assert.deepEqual(await reconcile(actor, firstId), result);
  assert.deepEqual(audit, [[actor.id, ids[0]]]);

  providerCommitted.add(ids[1]);
  const complete = await reconcile(actor, firstId);
  assert.equal(complete.status, 'saved');
  assert.deepEqual(complete.results.map(row => row.status), ['success', 'success']);
  assert.equal(mutations, 2);
  assert.deepEqual(audit, [[actor.id, ids[0]], [actor.id, ids[1]]]);
});

test('隐藏邮箱核对接口要求同源管理员使用专用 POST', async () => {
  const calls = [];
  const service = createAppleRelayService({ publicOrigin: origin, readInventory: () => ({ mailboxes: [] }),
    deliveryJournal: {
      receipt() { return { status: 'pending' }; },
      operationRows(acting, id) { calls.push([acting.id, id]); return {}; }
    } });
  const route = '/api/local/apple-relay/code-delivery-reconcile', operationId = 'synthetic-relay-auth';
  const request = async (acting, method, source = origin, body = {}) => {
    const input = Readable.from([Buffer.from(JSON.stringify(body))]);
    Object.assign(input, { method, url: route, headers: { origin: source, 'x-id-operation': operationId,
      'content-type': 'application/json' } });
    const res = { setHeader() {}, writeHead(status) { this.status = status; },
      end(payload) { this.body = JSON.parse(payload); } };
    await service.handle(input, res, route, acting);
    return res;
  };
  assert.equal((await request(actor, 'GET')).status, 405);
  assert.equal((await request(actor, 'POST', 'https://other.example.test')).status, 403);
  assert.equal((await request({ ...actor, role: 'employee' }, 'POST')).status, 403);
  assert.equal((await request(actor, 'POST', origin, { id: 'unrelated-target' })).status, 400);
  assert.deepEqual(calls, []);
  const allowed = await request(actor, 'POST');
  assert.equal(allowed.status, 200);
  assert.deepEqual(allowed.body, { status: 'pending' });
  assert.deepEqual(calls, [[actor.id, operationId]]);
});

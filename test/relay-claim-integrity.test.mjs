import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createLocalBusinessStore, handleLocalBusiness } from '../server/local-business.mjs';

const actor = { id: 'relay-manager', name: '邮箱管理员', role: 'admin' };
const time = '2026-11-05 10:30';
const parentId = 'apple-main-1';
const settings = { mailboxTypes: [], costSettings: {} };

function inventory() {
  return {
    mailboxes: ['a', 'b'].map((id) => ({
      id,
      type: 'relay',
      email: `${id}@example.test`,
      parentMailboxId: parentId,
      relayStatus: 'ACTIVE',
      health: 'normal',
      status: '正常',
      inventoryState: 'available',
      used: false,
      usageLinks: []
    })),
    accounts: [],
    batches: [],
    returnRecords: [],
    importRecords: [],
    registrationRecords: [],
    tableSettings: [],
    undo: [],
    appleRelay: {
      parents: [{ id: parentId, status: 'ACTIVE', email: 'main@example.test' }],
      imports: [],
      events: []
    }
  };
}

function withClaims(previous, ids, batchId = 'mail-batch-1') {
  const next = structuredClone(previous);
  const batch = {
    id: batchId,
    kind: 'mail',
    actorId: actor.id,
    actorName: actor.name,
    purpose: '注册',
    time,
    items: []
  };
  for (const id of ids) {
    const asset = next.mailboxes.find((row) => row.id === id);
    const item = {
      id: `claim-${batchId}-${id}`,
      assetId: id,
      email: asset.email,
      type: 'relay',
      parentMailboxId: asset.parentMailboxId,
      status: 'pending',
      claimedAt: time
    };
    batch.items.push(item);
    Object.assign(asset, {
      inventoryState: 'claimed',
      used: true,
      claimId: item.id,
      claimBatchId: batch.id,
      lastOperatedById: actor.id
    });
  }
  next.batches.unshift(batch);
  return next;
}

function inventoryWrite(version, data, action = 'inventory_extract') {
  return { domain: 'inventory', version, data, action };
}

function fixture(t) {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const source = inventory();
  store.saveBatch([inventoryWrite(0, source, 'inventory_relay_alias_save')], { actor });
  return { store, source };
}

async function put(store, domain, body, verifyRelayExtraction, operator = actor) {
  const host = '127.0.0.1:4348';
  const request = Readable.from([Buffer.from(JSON.stringify(body))]);
  request.headers = { host, origin: `http://${host}`, 'content-type': 'application/json' };
  request.method = 'PUT';
  const response = {
    setHeader() {},
    writeHead(status) {
      this.status = status;
      return this;
    },
    end(value) {
      this.body = JSON.parse(value);
    }
  };
  await handleLocalBusiness(request, response, `/api/local/${domain}`, store, operator, {
    verifyRelayExtraction
  });
  return { status: response.status, body: response.body };
}

const settingsWrite = { domain: 'settings', version: 0, data: settings };

test('generic and batch PUT reject caller-supplied proof, even with the latest inventory version', async (t) => {
  const { store, source } = fixture(t);
  const write = { ...inventoryWrite(1, withClaims(source, ['a'])), verifiedRelayClaimIds: ['a'] };
  assert.equal((await put(store, 'inventory', write)).status, 503);
  assert.equal((await put(store, 'batch', [settingsWrite, write])).status, 503);
  assert.throws(() => store.saveBatch([write], { actor, verifiedRelayClaimIds: ['a'] }), {
    status: 503
  });
  assert.deepEqual(store.load('inventory'), { version: 1, data: source });
  assert.deepEqual(store.load('settings'), { version: 0, data: null });
  assert.equal(store.audit().length, 1);
});

test('verification uses exactly the chosen local IDs and authenticated actor for both PUT paths', async (t) => {
  const { store, source } = fixture(t);
  const calls = [];
  const verifier = async (ids, operator) => {
    calls.push({ ids, operator });
    return [...ids].reverse();
  };
  const first = withClaims(source, ['a']);
  assert.equal((await put(store, 'inventory', inventoryWrite(1, first), verifier)).status, 200);
  const second = withClaims(first, ['b'], 'mail-batch-2');
  assert.equal((await put(store, 'batch', [settingsWrite, inventoryWrite(2, second)], verifier)).status, 200);
  assert.deepEqual(calls, [{ ids: ['a'], operator: actor }, { ids: ['b'], operator: actor }]);
  assert.deepEqual(store.load('inventory'), { version: 3, data: second });
  assert.deepEqual(store.load('settings'), { version: 1, data: settings });
  assert.equal(store.audit().filter(({ action }) => action === 'inventory_extract').length, 2);
});

test('partial, substituted, duplicate and failed remote checks leave every document intact', async (t) => {
  const { store, source } = fixture(t);
  const next = withClaims(source, ['a', 'b']);
  for (const verified of [['a'], ['a', 'other'], ['a', 'a'], ['a', 'b', 'other'], true]) {
    const result = await put(store, 'batch', [settingsWrite, inventoryWrite(1, next)], async (ids) => {
      assert.deepEqual(ids, ['a', 'b']);
      return verified;
    });
    assert.equal(result.status, verified === true ? 503 : 409);
  }
  const unavailable = await put(store, 'inventory', inventoryWrite(1, next), async () => {
    throw new Error('private provider failure');
  });
  assert.equal(unavailable.status, 503);
  assert.doesNotMatch(JSON.stringify(unavailable.body), /private provider failure/);
  assert.deepEqual(store.load('inventory'), { version: 1, data: source });
  assert.deepEqual(store.load('settings'), { version: 0, data: null });
  assert.equal(store.audit().length, 1);

  const exact = await put(store, 'batch', [settingsWrite, inventoryWrite(1, next)], async () => ['b', 'a']);
  assert.equal(exact.status, 200);
});

test('rejects forged actors, missing links, moved aliases, and direct consumption before provider access', async (t) => {
  const { store, source } = fixture(t);
  let verifyCalls = 0;
  const verifier = async (ids) => { verifyCalls++; return ids; };
  const write = inventoryWrite(1, withClaims(source, ['a']));
  const employee = { ...actor, role: 'employee' };
  assert.equal((await put(store, 'inventory', write, verifier, employee)).status, 403);
  for (const edit of [
    (doc) => { doc.batches[0].actorId = 'other'; },
    (doc) => { doc.batches[0].actorName = '其他员工'; },
    (doc) => { doc.mailboxes[0].lastOperatedById = 'other'; },
    (doc) => { doc.batches[0].items[0].parentMailboxId = 'different-parent'; },
    (doc) => { doc.batches[0].items[0].type = 'google'; },
    (doc) => { doc.batches[0].items[0].status = 'used'; },
    (doc) => { doc.batches[0].items[0].taskId = 'existing-task'; },
    (doc) => { doc.batches[0].items.push({ ...doc.batches[0].items[0], id: 'second-claim' }); },
    (doc) => { doc.mailboxes[0].claimBatchId = 'other-batch'; },
    (doc) => { doc.mailboxes[0].inventoryState = 'available'; },
    (doc) => { doc.batches = []; },
    (doc) => { doc.appleRelay.parents[0].email = 'changed@example.test'; },
    (doc) => { doc.appleRelay.parents[0].deleted = true; },
    (doc) => { doc.mailboxes[0].type = 'google'; doc.batches[0].items[0].type = 'google'; },
    (doc) => { doc.mailboxes[0].email = 'changed@example.test'; },
    (doc) => { doc.mailboxes.splice(0, 1); doc.batches = []; }
  ]) {
    const next = withClaims(source, ['a']);
    edit(next);
    assert.equal((await put(store, 'inventory', inventoryWrite(1, next), verifier)).status, 409);
  }
  const directUse = inventory();
  Object.assign(directUse.mailboxes[0], { inventoryState: 'used', used: true });
  assert.equal((await put(store, 'inventory', inventoryWrite(1, directUse, 'inventory_use'), verifier)).status, 409);
  assert.equal((await put(store, 'inventory', { ...write, action: 'inventory_edit' }, verifier)).status, 409);
  assert.equal(verifyCalls, 0);
  assert.equal(store.load('inventory').version, 1);
});

test('returned rows can be claimed again after fresh verification and historical receipts stay intact', async (t) => {
  const { store, source } = fixture(t);
  const first = withClaims(source, ['a']);
  assert.equal((await put(store, 'inventory', inventoryWrite(1, first), async () => ['a'])).status, 200);
  const returned = structuredClone(first);
  Object.assign(returned.mailboxes[0], { inventoryState: 'available', used: false, claimId: '', claimBatchId: '' });
  Object.assign(returned.batches[0].items[0], { status: 'returned', returnedAt: time, reason: '未使用' });
  returned.returnRecords.push({ id: 'receipt-1', assetId: 'a', batchId: first.batches[0].id, actorId: actor.id, time });
  assert.equal((await put(store, 'inventory', inventoryWrite(2, returned, 'inventory_return'))).status, 200);

  const appended = withClaims(returned, ['a'], 'mail-batch-2');
  appended.batches[1].items.push(appended.batches[0].items[0]);
  appended.batches.shift();
  appended.mailboxes[0].claimBatchId = returned.batches[0].id;
  assert.equal((await put(store, 'inventory', inventoryWrite(3, appended), async () => ['a'])).status, 409);

  const fresh = withClaims(returned, ['a'], 'mail-batch-2');
  assert.equal((await put(store, 'inventory', inventoryWrite(3, fresh))).status, 503);
  assert.equal((await put(store, 'inventory', inventoryWrite(3, fresh), async () => ['a'])).status, 200);
  assert.deepEqual(store.load('inventory').data.batches[1], returned.batches[0]);
  assert.deepEqual(store.load('inventory').data.returnRecords, returned.returnRecords);
});

test('inventory version is checked again after remote verification and a conflicting batch is rolled back', async (t) => {
  const { store, source } = fixture(t);
  const next = withClaims(source, ['a']);
  const concurrent = structuredClone(source);
  concurrent.mailboxes[0].notes = '另一窗口已登记备注';
  const response = await put(store, 'batch', [settingsWrite, inventoryWrite(1, next)], async (ids) => {
    store.saveBatch([inventoryWrite(1, concurrent, 'inventory_edit')], { actor });
    return ids;
  });
  assert.equal(response.status, 409);
  assert.deepEqual(store.load('inventory'), { version: 2, data: concurrent });
  assert.deepEqual(store.load('settings'), { version: 0, data: null });
  assert.equal(store.audit().length, 2);
});

test('recording a use against an existing verified claim needs no new verification', async (t) => {
  const { store, source } = fixture(t);
  const claimed = withClaims(source, ['a']);
  assert.equal((await put(store, 'inventory', inventoryWrite(1, claimed), async () => ['a'])).status, 200);
  const used = structuredClone(claimed);
  used.mailboxes[0].inventoryState = 'used';
  used.mailboxes[0].usageLinks.push({ kind: 'registration', registrationId: 'registration-a' });
  Object.assign(used.batches[0].items[0], { status: 'used', usedAt: time });
  used.registrationRecords.push({ id: 'registration-a', assetId: 'a', state: '成功' });
  const result = await put(store, 'inventory', inventoryWrite(2, used, 'inventory_registration_result'));
  assert.equal(result.status, 200);
  assert.deepEqual(store.load('inventory'), { version: 3, data: used });
});

import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createLocalBusinessStore, handleLocalBusiness } from '../server/local-business.mjs';

const actor = { id: 'relay-manager', name: '邮箱管理员', role: 'super' };
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

function registeredAccount(type, email, id) {
  return {
    id, type, email, emailType: 'relay', source: '自己注册', registered: '2026-11-05T11:00',
    inventoryState: 'available', health: 'normal', status: '正常', usageLinks: [], version: 1,
    country: '马来西亚', city: '吉隆坡',
    ...(type === 'claude' && { device: '合成设备', proxyUrl: 'socks5://proxy.example.test:1080' }),
    ...(type === 'grok' && { loginMethod: 'email' }),
    ...(type === 'gemini' && { loginMethod: 'google' })
  };
}

test('十个隐藏邮箱领用后，三个平台注册各回写两条，余下四条归还原批次', async (t) => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const data = inventory();
  data.mailboxes = Array.from({ length: 10 }, (_, i) => ({
    ...data.mailboxes[0], id: `relay-${i}`, email: `relay-${i}@example.test`
  }));
  store.saveBatch([inventoryWrite(0, data, 'inventory_relay_alias_save')], { actor });
  const claims = withClaims(data, data.mailboxes.map(row => row.id));
  assert.equal((await put(store, 'inventory', inventoryWrite(1, claims), async ids => ids)).status, 200);

  for (const [index, type] of ['gpt', 'claude', 'grok'].entries()) {
    const snapshot = store.load('inventory');
    const additions = snapshot.data.mailboxes.slice(index * 2, index * 2 + 2).map((mail, i) =>
      registeredAccount(type, mail.email.toUpperCase(), `${type}-${i}`));
    if (type === 'gpt') {
      snapshot.data.accounts.push({ ...additions.shift(), emailType: 'relay' });
      const single = await put(store, 'inventory', inventoryWrite(snapshot.version, snapshot.data, 'inventory_create'));
      assert.equal(single.status, 200, single.body.error);
      snapshot.version = single.body.version;
      snapshot.data = single.body.data;
    }
    snapshot.data.accounts.push(...additions);
    const saved = await put(store, 'inventory', inventoryWrite(snapshot.version, snapshot.data, 'inventory_import'));
    assert.equal(saved.status, 200, saved.body.error);
  }
  const result = store.load('inventory');
  const batch = result.data.batches[0];
  assert.deepEqual(batch.items.map(item => item.status), [...Array(6).fill('used'), ...Array(4).fill('pending')]);
  for (const [index, mailbox] of result.data.mailboxes.slice(0, 6).entries()) {
    assert.equal(mailbox.inventoryState, 'used');
    assert.equal(mailbox.usageLinks.length, 1);
    const [link] = mailbox.usageLinks;
    const account = result.data.accounts.find(row => row.id === link.accountId);
    assert.equal(link.product, ['gpt', 'claude', 'grok'][Math.floor(index / 2)]);
    assert.equal(account.email.toLowerCase(), mailbox.email);
    assert.equal(account.inventoryState, 'available');
    assert.equal(account.emailType, 'relay');
    assert.equal(link.batchId, batch.id);
    assert.equal(link.claimId, batch.items[index].id);
  }

  const gemini = structuredClone(result.data);
  gemini.accounts.push(registeredAccount('gemini', gemini.mailboxes[6].email, 'gemini-forbidden'));
  const refused = await put(store, 'inventory', inventoryWrite(result.version, gemini, 'inventory_create'));
  assert.equal(refused.status, 409);
  assert.match(refused.body.error, /Gemini 请使用谷歌邮箱/);

  const returned = structuredClone(result.data);
  for (const item of returned.batches[0].items.slice(6)) {
    const asset = returned.mailboxes.find(row => row.id === item.assetId);
    Object.assign(asset, { inventoryState: 'available', used: false, claimId: '', claimBatchId: '' });
    Object.assign(item, { status: 'returned', returnedAt: '2026-11-05 12:00' });
    returned.returnRecords.push({ id: `receipt-${item.id}`, assetId: asset.id, batchId: batch.id, actorId: actor.id });
  }
  assert.equal((await put(store, 'inventory', inventoryWrite(result.version, returned, 'inventory_return'))).status, 200);
  assert.deepEqual(store.load('inventory').data.batches[0].items.map(item => item.status),
    [...Array(6).fill('used'), ...Array(4).fill('returned')]);
});

test('两个平台并发录入相同注册邮箱只有一笔提交，刷新后批量录入仍提示原账号', async (t) => {
  const { store, source } = fixture(t);
  assert.equal((await put(store, 'inventory', inventoryWrite(1, withClaims(source, ['a'])), async ids => ids)).status, 200);
  const pending = store.load('inventory');
  const attempts = await Promise.all(['gpt', 'grok'].map(type => {
    const next = structuredClone(pending.data);
    next.accounts.push(registeredAccount(type, 'A@example.test', `${type}-winner`));
    return put(store, 'inventory', inventoryWrite(pending.version, next, 'inventory_create'));
  }));
  assert.deepEqual(attempts.map(result => result.status).sort(), [200, 409]);
  let saved = store.load('inventory');
  assert.equal(saved.data.accounts.length, 1);
  const [account] = saved.data.accounts;
  assert.equal(saved.data.mailboxes[0].usageLinks[0].accountId, account.id);
  assert.equal(saved.data.batches[0].items[0].status, 'used');

  const archived = structuredClone(saved.data);
  archived.accounts[0].health = 'dead';
  assert.equal((await put(store, 'inventory', inventoryWrite(saved.version, archived, 'inventory_health_change'))).status, 200);
  saved = store.load('inventory');

  const next = structuredClone(saved.data);
  next.accounts.push(registeredAccount('claude', ' a@EXAMPLE.test ', 'claude-duplicate'));
  const duplicate = await put(store, 'inventory', inventoryWrite(saved.version, next, 'inventory_import'));
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.body.error, new RegExp(`关联账号 ${account.id}`));
  assert.deepEqual(store.load('inventory'), saved);
});

test('历史已登记 Grok 用途只能补到原平台账号，并保留首次使用和领用记录', async (t) => {
  const { store, source } = fixture(t);
  assert.equal((await put(store, 'inventory', inventoryWrite(1, withClaims(source, ['a'])), async ids => ids)).status, 200);
  const snapshot = store.load('inventory');
  const [asset] = snapshot.data.mailboxes;
  const [item] = snapshot.data.batches[0].items;
  const usedAt = '2026-11-05 11:00';
  Object.assign(asset, { inventoryState: 'used', actualUsedAt: usedAt });
  Object.assign(item, { status: 'used', usedAt });
  snapshot.data.registrationRecords.push({ id: 'register-grok', assetId: asset.id, email: asset.email,
    product: 'GROK', state: '成功', time: usedAt, actorId: actor.id });
  asset.usageLinks.push({ kind: 'registration', registrationId: 'register-grok', product: 'grok', time: usedAt });
  const marked = await put(store, 'inventory', inventoryWrite(snapshot.version, snapshot.data, 'inventory_registration_result'));
  assert.equal(marked.status, 200, marked.body.error);

  const other = structuredClone(marked.body.data);
  other.accounts.push(registeredAccount('gpt', asset.email, 'gpt-forbidden'));
  const rejected = await put(store, 'inventory', inventoryWrite(marked.body.version, other, 'inventory_create'));
  assert.equal(rejected.status, 409);
  assert.match(rejected.body.error, /已用于注册 Grok/);

  const next = structuredClone(marked.body.data);
  next.accounts.push(registeredAccount('grok', asset.email, 'grok-original'));
  const linked = await put(store, 'inventory', inventoryWrite(marked.body.version, next, 'inventory_create'));
  assert.equal(linked.status, 200, linked.body.error);
  const [saved] = linked.body.data.mailboxes;
  assert.equal(saved.usageLinks.filter(link => link.accountId).length, 1);
  assert.equal(saved.usageLinks.at(-1).accountId, 'grok-original');
  assert.equal(saved.usageLinks.at(-1).claimId, item.id);
  assert.equal(saved.actualUsedAt, usedAt);
  assert.deepEqual(linked.body.data.batches, marked.body.data.batches);
  assert.deepEqual(linked.body.data.registrationRecords, marked.body.data.registrationRecords);
});

test('Gemini 的谷歌注册邮箱参与跨平台查重', async (t) => {
  const { store, source } = fixture(t);
  const email = 'gemini-stock@example.test';
  source.accounts.push({ ...registeredAccount('gemini', email, 'gemini-stock'), emailType: 'google' });
  const created = await put(store, 'inventory', inventoryWrite(1, source, 'inventory_create'));
  assert.equal(created.status, 200, created.body.error);
  const current = store.load('inventory');
  const next = structuredClone(current.data);
  next.accounts.push(registeredAccount('grok', email, 'grok-forbidden'));
  const duplicate = await put(store, 'inventory', inventoryWrite(current.version, next, 'inventory_create'));
  assert.equal(duplicate.status, 409);
  assert.match(duplicate.body.error, /注册 Gemini，关联账号 gemini-stock/);
  assert.deepEqual(store.load('inventory'), current);
});

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
  used.registrationRecords.push({ id: 'registration-a', assetId: 'a', product: 'GPT', state: '成功' });
  const result = await put(store, 'inventory', inventoryWrite(2, used, 'inventory_registration_result'));
  assert.equal(result.status, 200);
  assert.deepEqual(store.load('inventory'), { version: 3, data: used });
});

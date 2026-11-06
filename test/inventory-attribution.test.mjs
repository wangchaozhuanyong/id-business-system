import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalBusinessStore } from '../server/local-business.mjs';

const actor = (name) => ({ id: `fixture-${name}`, name, role: 'admin' });
const creator = actor('录入员');
const editor = actor('更正员');
const operator = actor('提取员');
const returner = actor('归还员');
const forged = { id: 'not-the-session', name: '伪造人员' };
const time = '2026-11-06 10:00';
const asset = (id, type = 'gpt', values = {}) => ({
  id,
  type,
  email: `${id}@example.test`,
  inventoryState: 'available',
  used: false,
  usageLinks: [],
  inventoryHistory: [],
  version: 1,
  ...values
});
const event = (id, action) => ({
  id,
  action,
  actorId: forged.id,
  actor: forged.name,
  time: '1999-01-01 00:00'
});
const inventory = (values = {}) => ({
  accounts: [],
  mailboxes: [],
  batches: [],
  returnRecords: [],
  registrationRecords: [],
  importRecords: [],
  tableSettings: [],
  undo: [],
  ...values
});
const save = (store, version, data, action, who) =>
  store.saveBatch([{ domain: 'inventory', version, data, action }], { actor: who });
const read = (store) => store.load('inventory').data;

test('ordinary stock provenance comes from the session and past event identities do not change', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-06T02:00:00.000Z') });
  const store = createLocalBusinessStore(':memory:');
  try {
    const newAccount = asset('test-stock', 'gpt', {
      createdById: forged.id,
      createdBy: forged.name,
      createdAt: '1999-01-01 00:00',
      importedAt: '1999-01-01 00:00',
      lastOperatedById: forged.id,
      lastOperatedBy: forged.name,
      inventoryHistory: [event('created', '新增资料')]
    });
    save(store, 0, inventory({ accounts: [newAccount] }), 'inventory_create', creator);
    const [created] = read(store).accounts;
    assert.equal(created.createdById, creator.id);
    assert.equal(created.createdBy, creator.name);
    assert.equal(created.createdAt, time);
    assert.equal(created.importedAt, time);
    assert.equal(created.lastOperatedById, creator.id);
    assert.equal(created.lastOperatedAt, time);
    assert.deepEqual(created.inventoryHistory[0], {
      id: 'created',
      action: '新增资料',
      actorId: creator.id,
      actor: creator.name,
      time
    });

    t.mock.timers.tick(60_000);
    const changed = {
      ...created,
      notes: '已核对客户信息',
      version: 2,
      createdById: forged.id,
      createdBy: forged.name,
      createdAt: '2000-01-01 00:00',
      lastOperatedById: forged.id,
      inventoryHistory: [...created.inventoryHistory, event('edited', '修改资料')]
    };
    save(store, 1, inventory({ accounts: [changed] }), 'inventory_edit', editor);
    const [edited] = read(store).accounts;
    assert.equal(edited.createdById, creator.id);
    assert.equal(edited.createdAt, time);
    assert.equal(edited.lastOperatedById, editor.id);
    assert.equal(edited.lastOperatedAt, '2026-11-06 10:01');
    assert.deepEqual(edited.inventoryHistory[0], created.inventoryHistory[0]);

    t.mock.timers.tick(60_000);
    const batch = {
      id: 'batch-1',
      actorId: forged.id,
      actorName: forged.name,
      kind: 'account',
      purpose: '客户交付',
      items: [{ id: 'claim-1', assetId: edited.id, status: 'pending' }]
    };
    const claimed = {
      ...edited,
      inventoryState: 'claimed',
      used: true,
      claimId: 'claim-1',
      claimBatchId: batch.id,
      version: 3,
      lastOperatedById: forged.id,
      inventoryHistory: [...edited.inventoryHistory, event('extracted', '提取')]
    };
    save(
      store,
      2,
      inventory({ accounts: [claimed], batches: [batch] }),
      'inventory_extract',
      operator
    );
    const [extracted] = read(store).accounts;
    const [storedBatch] = read(store).batches;
    assert.equal(storedBatch.actorId, operator.id);
    assert.equal(storedBatch.actorName, operator.name);
    assert.equal(extracted.createdById, creator.id);
    assert.equal(extracted.lastOperatedById, operator.id);
    assert.equal(extracted.lastOperatedAt, '2026-11-06 10:02');
    assert.deepEqual(
      extracted.inventoryHistory.map(({ action, actorId }) => [action, actorId]),
      [
        ['新增资料', creator.id],
        ['修改资料', editor.id],
        ['提取', operator.id]
      ]
    );
    assert.deepEqual(
      store.audit().map(({ actorId }) => actorId),
      [operator.id, editor.id, creator.id]
    );

    const prior = read(store);
    const returned = {
      ...prior,
      accounts: [
        {
          ...extracted,
          inventoryState: 'available',
          used: false,
          claimId: '',
          claimBatchId: '',
          inventoryHistory: [...extracted.inventoryHistory, event('returned', '归还')]
        }
      ],
      batches: [
        {
          ...storedBatch,
          items: [{ ...storedBatch.items[0], status: 'returned', reason: '未使用' }]
        }
      ],
      returnRecords: [
        {
          id: 'return-1',
          assetId: extracted.id,
          batchId: batch.id,
          reason: '未使用',
          time,
          actorId: forged.id,
          actor: forged.name
        }
      ]
    };
    save(store, 3, returned, 'inventory_return', returner);
    const afterReturn = read(store);
    assert.equal(afterReturn.batches[0].actorId, operator.id);
    assert.equal(afterReturn.returnRecords[0].actorId, returner.id);
    assert.equal(afterReturn.returnRecords[0].actor, returner.name);
    assert.equal(afterReturn.accounts[0].lastOperatedById, returner.id);
    for (const modified of [
      { ...afterReturn, batches: [{ ...afterReturn.batches[0], actorName: forged.name }] },
      { ...afterReturn, returnRecords: [{ ...afterReturn.returnRecords[0], actorId: forged.id }] },
      { ...afterReturn, returnRecords: [] },
      { ...afterReturn, batches: [...afterReturn.batches, afterReturn.batches[0]] }
    ]) {
      assert.throws(() => save(store, 4, modified, 'inventory_edit', editor), { status: 409 });
    }
    assert.deepEqual(read(store), afterReturn);
  } finally {
    store.close();
  }
});

test('identity-only writes and historical event edits do not save or advance the audit', () => {
  const store = createLocalBusinessStore(':memory:');
  try {
    save(
      store,
      0,
      inventory({
        accounts: [
          asset('protected', 'claude', {
            inventoryHistory: [event('original', '新增资料')]
          })
        ]
      }),
      'inventory_create',
      creator
    );
    const before = store.load('inventory');
    const [row] = before.data.accounts;
    const writes = [
      { ...row, lastOperatedBy: forged.name, lastOperatedById: forged.id },
      { ...row, notes: '更正说明', inventoryHistory: [] },
      {
        ...row,
        inventoryHistory: [{ ...row.inventoryHistory[0], actorId: forged.id }]
      },
      {
        ...row,
        inventoryHistory: [...row.inventoryHistory, event('fake-event', '提取')]
      }
    ];
    for (const attempted of writes) {
      assert.throws(
        () => save(store, 1, inventory({ accounts: [attempted] }), 'inventory_edit', editor),
        { status: 409 }
      );
    }
    for (const misplaced of [
      inventory({ mailboxes: [row] }),
      inventory({ accounts: [row], mailboxes: [{ ...row, type: 'google' }] }),
      inventory({ accounts: [row, { ...row, notes: '重复编号' }] })
    ]) {
      assert.throws(() => save(store, 1, misplaced, 'inventory_edit', editor), { status: 409 });
    }
    assert.throws(
      () =>
        save(
          store,
          0,
          inventory({ accounts: [{ ...row, notes: '过时草稿' }] }),
          'inventory_edit',
          editor
        ),
      { status: 409 }
    );
    assert.deepEqual(store.load('inventory'), before);
    assert.equal(store.audit().length, 1);
  } finally {
    store.close();
  }
});

test('legacy unknown creators, last editor and separate Apple or relay modules retain their scopes', () => {
  const store = createLocalBusinessStore(':memory:');
  try {
    const old = asset('legacy-ordinary', 'gpt', {
      updatedById: 'known-prior-editor',
      updatedBy: '旧更正员',
      updatedAt: '2026-01-01 10:00'
    });
    const anonymous = { type: 'gpt', email: 'old-no-id@example.test' };
    const apple = asset('apple-wallet-asset', 'apple', { createdById: 'wallet-created' });
    const relay = asset('apple-relay-asset', 'relay', {
      parentMailboxId: 'parent-1',
      createdById: 'relay-created'
    });
    const snapshot = inventory({
      accounts: [old, anonymous],
      mailboxes: [apple, relay],
      appleRelay: { parents: [{ id: 'parent-1' }], imports: [], events: [] }
    });
    save(store, 0, snapshot, 'inventory_create');
    assert.deepEqual(read(store), snapshot);

    const edited = {
      ...old,
      notes: '已有资料补录',
      createdById: forged.id,
      createdBy: forged.name,
      inventoryHistory: [event('real-edit', '修改资料')]
    };
    const normalized = {
      ...anonymous,
      inventoryState: 'available',
      health: 'normal',
      status: '正常',
      used: false,
      usageLinks: [],
      inventoryHistory: [],
      version: 1
    };
    save(store, 1, { ...snapshot, accounts: [edited, normalized] }, 'inventory_edit', editor);
    const saved = read(store);
    assert.equal(saved.accounts[0].createdById, undefined);
    assert.equal(saved.accounts[0].createdBy, undefined);
    assert.equal(saved.accounts[0].updatedById, editor.id);
    assert.equal(saved.accounts[0].updatedBy, editor.name);
    assert.deepEqual(saved.accounts[1], normalized);
    assert.deepEqual(saved.mailboxes, [apple, relay]);

    const current = saved.accounts[0];
    const healthChange = {
      ...current,
      health: 'dead',
      healthChangedAt: time,
      updatedById: forged.id,
      inventoryHistory: [...current.inventoryHistory, event('health', '健康状态变化')]
    };
    save(
      store,
      2,
      { ...saved, accounts: [healthChange, normalized] },
      'inventory_health_change',
      operator
    );
    const after = read(store).accounts[0];
    assert.equal(after.updatedById, editor.id);
    assert.equal(after.lastOperatedById, operator.id);
    assert.equal(after.inventoryHistory[1].actorId, operator.id);
  } finally {
    store.close();
  }
});

test('a real registration result can add an attributed event without rewriting main asset fields', () => {
  const store = createLocalBusinessStore(':memory:');
  try {
    const mailbox = asset('google-claimed', 'google', {
      inventoryState: 'claimed',
      used: true,
      claimId: 'claim-1',
      claimBatchId: 'batch-1'
    });
    const claim = {
      id: 'claim-1',
      assetId: mailbox.id,
      status: 'pending',
      registrationId: 'registration-1'
    };
    const record = {
      id: 'registration-1',
      assetId: mailbox.id,
      state: '待核对',
      createdById: forged.id,
      createdBy: forged.name,
      actorId: forged.id,
      actor: forged.name
    };
    const before = inventory({
      mailboxes: [mailbox],
      batches: [{ id: 'batch-1', kind: 'mail', items: [claim] }],
      registrationRecords: [record]
    });
    save(store, 0, before, 'inventory_create', creator);
    const saved = read(store);
    const [firstRegistration] = saved.registrationRecords;
    assert.equal(firstRegistration.createdById, creator.id);
    assert.equal(firstRegistration.createdBy, creator.name);
    assert.equal(firstRegistration.actorId, creator.id);
    assert.throws(
      () =>
        save(
          store,
          1,
          {
            ...saved,
            registrationRecords: [{ ...firstRegistration, actorId: forged.id, time }]
          },
          'inventory_registration_result',
          operator
        ),
      { status: 409 }
    );
    const resolved = {
      ...saved,
      mailboxes: [
        {
          ...saved.mailboxes[0],
          inventoryHistory: [event('registration-failed', '登记注册失败且未使用')]
        }
      ],
      batches: [{ ...saved.batches[0], items: [{ ...claim, registrationId: '' }] }],
      registrationRecords: [
        {
          ...firstRegistration,
          state: '失败且未使用',
          createdById: forged.id,
          createdBy: forged.name,
          createdAt: '1999-01-01 00:00',
          actorId: forged.id,
          actor: forged.name
        }
      ]
    };
    save(store, 1, resolved, 'inventory_registration_result', operator);
    assert.equal(read(store).mailboxes[0].lastOperatedById, operator.id);
    assert.equal(read(store).mailboxes[0].inventoryHistory[0].actorId, operator.id);
    assert.equal(read(store).mailboxes[0].inventoryState, 'claimed');
    const [outcome] = read(store).registrationRecords;
    assert.equal(outcome.createdById, creator.id);
    assert.equal(outcome.createdAt, firstRegistration.createdAt);
    assert.equal(outcome.actorId, operator.id);
    assert.equal(outcome.actor, operator.name);
    assert.equal(outcome.time, read(store).mailboxes[0].lastOperatedAt);
  } finally {
    store.close();
  }
});

test('ordinary import receipts are attributed and immutable while old Apple-only receipts are untouched', () => {
  const store = createLocalBusinessStore(':memory:');
  try {
    const appleOnly = { id: 'apple-import', type: 'apple', actorId: forged.id, actor: forged.name };
    const anonymous = { type: 'claude', status: '历史未记录' };
    const old = inventory({ importRecords: [appleOnly, anonymous] });
    save(store, 0, old, 'inventory_import');
    const imported = {
      id: 'ordinary-import',
      type: 'mixed',
      types: ['claude', 'apple'],
      actorId: forged.id,
      actor: forged.name,
      results: [{ id: 'claude-imported', type: 'claude' }]
    };
    const row = asset('claude-imported', 'claude', { importId: imported.id });
    save(
      store,
      1,
      {
        ...old,
        accounts: [row],
        importRecords: [imported, appleOnly, anonymous]
      },
      'inventory_import',
      creator
    );
    const stored = read(store);
    assert.equal(stored.accounts[0].createdById, creator.id);
    assert.equal(stored.importRecords[0].actorId, creator.id);
    assert.equal(stored.importRecords[0].actor, creator.name);
    assert.deepEqual(stored.importRecords.slice(1), [appleOnly, anonymous]);
    const [receipt] = stored.importRecords;
    for (const modified of [
      [appleOnly, anonymous],
      [{ ...receipt, actorId: forged.id }, appleOnly, anonymous],
      [receipt, { ...receipt, actorId: forged.id }, appleOnly, anonymous]
    ]) {
      assert.throws(
        () => save(store, 2, { ...stored, importRecords: modified }, 'inventory_edit', editor),
        {
          status: 409
        }
      );
    }
    assert.deepEqual(read(store), stored);
  } finally {
    store.close();
  }
});

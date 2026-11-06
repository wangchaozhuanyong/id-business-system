import assert from 'node:assert/strict';
import test from 'node:test';
import { checkInventoryHistory } from '../server/inventory-history.mjs';
import { createLocalBusinessStore } from '../server/local-business.mjs';

const takenAt = '2026-11-05 10:30';
const returnedAt = '2026-11-05 11:30';
const available = (id) => ({
  id,
  type: 'gpt',
  email: `${id}@example.test`,
  inventoryState: 'available',
  used: false,
  health: 'normal',
  usageLinks: []
});
const inventory = (values = {}) => ({
  mailboxes: [],
  accounts: [],
  batches: [],
  returnRecords: [],
  importRecords: [],
  registrationRecords: [],
  tableSettings: [],
  undo: [],
  ...values
});
const pending = (id, batchId = 'batch-1') => ({
  asset: {
    ...available(id),
    inventoryState: 'claimed',
    used: true,
    claimId: `claim-${id}`,
    claimBatchId: batchId
  },
  item: { id: `claim-${id}`, assetId: id, type: 'gpt', status: 'pending', claimedAt: takenAt }
});
const batch = (items, id = 'batch-1') => ({
  id,
  actorId: 'tester',
  purpose: '客户交付',
  time: takenAt,
  kind: 'account',
  items
});
const submitInventory = (store, version, data, action = 'inventory_return') =>
  store.saveBatch([{ domain: 'inventory', version, data, action }]);

test('server rejects restocking used accounts with the latest document version', () => {
  const store = createLocalBusinessStore(':memory:');
  const used = pending('used-account');
  const consumed = {
    ...used.asset,
    inventoryState: 'used',
    usageLinks: [{ kind: 'manual-use', label: '确认使用', time: takenAt }]
  };
  const source = inventory({
    accounts: [consumed],
    batches: [batch([{ ...used.item, status: 'used', usedAt: takenAt }])]
  });
  try {
    submitInventory(store, 0, source, 'inventory_use');
    assert.throws(
      () =>
        submitInventory(
          store,
          1,
          inventory({
            accounts: [available(consumed.id)]
          })
        ),
      { status: 409, message: '已实际使用的库存资料不能退回或替换' }
    );
    assert.throws(() => submitInventory(store, 1, inventory()), {
      status: 409,
      message: '已有使用或领用记录的库存资料必须保留'
    });
    const alteredLinks = {
      ...source,
      accounts: [{ ...consumed, usageLinks: [{ ...consumed.usageLinks[0], time: returnedAt }] }]
    };
    assert.throws(() => submitInventory(store, 1, alteredLinks), {
      status: 409,
      message: '原有库存使用关联必须保留'
    });
    assert.deepEqual(store.load('inventory'), { version: 1, data: source });
    assert.equal(store.audit().length, 1);
  } finally {
    store.close();
  }
});

test('partial return and a subsequent extraction keep the original claim and return receipt', () => {
  const store = createLocalBusinessStore(':memory:');
  const chosen = pending('chosen');
  const other = pending('other');
  const prior = inventory({
    accounts: [chosen.asset, other.asset],
    batches: [batch([chosen.item, other.item])]
  });
  const receipt = {
    id: 'return-1',
    batchId: 'batch-1',
    assetId: 'chosen',
    reason: '未使用',
    time: returnedAt,
    actorId: 'tester'
  };
  const returnedItem = {
    ...chosen.item,
    status: 'returned',
    returnedAt,
    reason: '未使用'
  };
  const returned = {
    ...prior,
    accounts: [available('chosen'), other.asset],
    batches: [batch([returnedItem, other.item])],
    returnRecords: [receipt]
  };
  try {
    submitInventory(store, 0, prior, 'inventory_extract');
    submitInventory(store, 1, returned);
    const again = pending('chosen', 'batch-2');
    const reextracted = {
      ...returned,
      accounts: [again.asset, other.asset],
      batches: [batch([{ ...again.item, id: 'claim-chosen-2' }], 'batch-2'), ...returned.batches]
    };
    reextracted.accounts[0].claimId = 'claim-chosen-2';
    submitInventory(store, 2, reextracted, 'inventory_extract');
    assert.equal(store.load('inventory').data.batches[1].items[0].status, 'returned');
    assert.equal(store.load('inventory').data.batches[1].items[1].status, 'pending');
    assert.throws(() => submitInventory(store, 3, { ...reextracted, returnRecords: [] }), {
      status: 409,
      message: '原有归还记录必须保留'
    });
    assert.throws(
      () =>
        submitInventory(store, 3, {
          ...reextracted,
          batches: [reextracted.batches[0], batch([other.item])]
        }),
      { status: 409, message: '原有提取明细及已完成结果必须保留' }
    );
    assert.equal(store.load('inventory').version, 3);
  } finally {
    store.close();
  }
});

test('cannot reopen a pending or downstream-linked account as unused', () => {
  const store = createLocalBusinessStore(':memory:');
  const chosen = pending('linked');
  const other = pending('unresolved');
  const order = pending('order');
  const free = pending('free');
  const items = [
    { ...chosen.item, taskId: 'task-1' },
    { ...other.item, registrationId: 'review-1' },
    { ...order.item, orderId: 'order-1' },
    free.item
  ];
  const prior = inventory({
    accounts: [chosen.asset, other.asset, order.asset, free.asset],
    batches: [batch(items)]
  });
  try {
    submitInventory(store, 0, prior, 'inventory_extract');
    const released = structuredClone(prior);
    released.accounts[3] = available(free.asset.id);
    assert.throws(() => submitInventory(store, 1, released), {
      status: 409,
      message: '库存使用状态必须与原提取明细的处理结果一致'
    });
    const detached = structuredClone(prior);
    detached.accounts[3].claimId = '';
    assert.throws(() => submitInventory(store, 1, detached), {
      status: 409,
      message: '库存使用状态必须与原提取明细的处理结果一致'
    });
    for (const [index, item] of items.slice(0, 3).entries()) {
      const changed = structuredClone(prior);
      changed.accounts[index] = available(item.assetId);
      Object.assign(changed.batches[0].items[index], { status: 'returned', returnedAt });
      assert.throws(() => submitInventory(store, 1, changed), {
        status: 409,
        message: '已关联任务、订单或注册核对的库存资料不能直接归还'
      });
    }
    assert.deepEqual(store.load('inventory'), { version: 1, data: prior });
  } finally {
    store.close();
  }
});

test('preserves extraction facts but permits a pending claim to end in use or an abnormal return', () => {
  const first = pending('used');
  const second = pending('dead');
  const prior = inventory({
    accounts: [first.asset, second.asset],
    batches: [batch([first.item, second.item])]
  });
  const finished = structuredClone(prior);
  Object.assign(finished.accounts[0], {
    inventoryState: 'used',
    usageLinks: [{ kind: 'manual-use', time: returnedAt }]
  });
  Object.assign(finished.accounts[1], { ...available('dead'), health: 'dead' });
  Object.assign(finished.batches[0].items[0], { status: 'used', usedAt: returnedAt });
  Object.assign(finished.batches[0].items[1], {
    status: 'abnormal',
    returnedAt,
    reason: '死号'
  });
  assert.equal(checkInventoryHistory(prior, finished), undefined);

  const erased = { ...prior, batches: [] };
  assert.match(checkInventoryHistory(prior, erased), /提取批次/);
  const changed = { ...prior, batches: [{ ...prior.batches[0], actorId: 'wrong-operator' }] };
  assert.match(checkInventoryHistory(prior, changed), /提取批次/);
  const rewound = structuredClone(finished);
  rewound.batches[0].items[0].status = 'pending';
  assert.match(checkInventoryHistory(finished, rewound), /已完成结果/);
});

test('registration may move from review to a recorded result, but terminal history stays', () => {
  const entry = {
    id: 'registration-1',
    assetId: 'mail-1',
    email: 'mail@example.test',
    product: 'GPT',
    state: '待核对',
    createdById: 'tester',
    time: takenAt,
    actorId: 'tester'
  };
  const prior = inventory({ registrationRecords: [entry] });
  const failed = inventory({
    registrationRecords: [
      { ...entry, state: '失败且未使用', time: returnedAt, actorId: 'reviewer' }
    ]
  });
  assert.equal(checkInventoryHistory(prior, failed), undefined);
  assert.match(checkInventoryHistory(prior, inventory()), /注册记录/);
  assert.match(
    checkInventoryHistory(
      prior,
      inventory({
        registrationRecords: [{ ...failed.registrationRecords[0], product: 'Claude' }]
      })
    ),
    /注册记录/
  );
  assert.match(checkInventoryHistory(failed, prior), /已确认结果/);
});

test('legacy inventory without new fields and unreferenced unused deletions remain valid', () => {
  const used = { id: 'legacy-used', type: 'gpt', used: true };
  const unused = { id: 'legacy-unused', type: 'gpt', used: false };
  const noId = { note: '早期记录没有编号' };
  const prior = { accounts: [used, unused], returnRecords: [noId] };
  const edited = inventory({
    accounts: [{ ...used, inventoryState: 'used', health: 'dead', usageLinks: [] }],
    returnRecords: [noId]
  });
  assert.equal(checkInventoryHistory(prior, edited), undefined);
  assert.match(checkInventoryHistory(prior, { ...edited, returnRecords: [] }), /归还记录/);
  assert.match(
    checkInventoryHistory(prior, {
      ...edited,
      accounts: [{ ...used, inventoryState: 'available' }]
    }),
    /已实际使用/
  );
  const referenced = inventory({
    accounts: [unused],
    batches: [batch([{ id: 'old-claim', assetId: unused.id, status: 'returned' }])]
  });
  assert.match(checkInventoryHistory(referenced, { ...referenced, accounts: [] }), /必须保留/);
});

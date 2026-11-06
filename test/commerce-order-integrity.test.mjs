import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalBusinessStore } from '../server/local-business.mjs';

const time = '2026-11-05 10:30';
const account = {
  id: 'stock-gpt-1',
  type: 'gpt',
  email: 'stock@example.test',
  inventoryState: 'available',
  used: false,
  health: 'normal',
  status: '正常',
  usageLinks: [],
  version: 1
};
const saleLink = (orderId) => ({
  kind: 'order-sale',
  orderId,
  label: `成品交付订单 ${orderId}`,
  time
});
const inventory = (accounts) => ({
  mailboxes: [],
  accounts,
  batches: [],
  returnRecords: [],
  importRecords: [],
  registrationRecords: [],
  tableSettings: [],
  undo: []
});
const commerce = (orders, customers = []) => ({
  customers,
  tenants: [],
  orders,
  operating: [],
  rentBatches: [],
  logs: []
});
const order = (id, values = {}) => ({
  id,
  orderNo: id,
  product: 'GPT',
  plan: 'Plus',
  businessType: '续费',
  email: 'buyer@example.test',
  accountId: '',
  payment: '银行卡',
  cardId: 'card-1',
  paymentId: '012345',
  paidAmount: '20.0000',
  paidCurrency: 'USD',
  paidConfirmed: true,
  saleAmount: '100.0000',
  saleCurrency: 'CNY',
  receiptConfirmed: true,
  start: '2026-11-05T10:30',
  expiry: '2026-12-04T10:30',
  refunds: [],
  bankReturns: [],
  version: 1,
  ...values
});
const stockOrder = (id) =>
  order(id, {
    businessType: '成品交付',
    accountId: account.id,
    email: account.email
  });
const inventoryWrite = (version, accounts, action) => ({
  domain: 'inventory',
  version,
  data: inventory(accounts),
  action
});
const commerceWrite = (version, data, action = '新增独立订单') => ({
  domain: 'commerce',
  version,
  data,
  action
});

test('a finished-account order cannot be written directly without a valid atomic inventory allocation', () => {
  const store = createLocalBusinessStore(':memory:');
  try {
    const delivery = stockOrder('sale-order-1');
    const direct = commerceWrite(0, commerce([delivery]));
    assert.throws(() => store.saveBatch([direct]), { status: 409 });
    assert.deepEqual(store.load('commerce'), { version: 0, data: null });
    assert.equal(store.audit().length, 0);

    store.saveBatch([inventoryWrite(0, [account], 'inventory_create')]);
    assert.throws(() => store.saveBatch([direct]), { status: 409 });
    assert.throws(
      () => store.saveBatch([direct, inventoryWrite(1, [account], 'inventory_order_sale')]),
      { status: 409 }
    );
    const used = {
      ...account,
      inventoryState: 'used',
      used: true,
      usageLinks: [saleLink(delivery.id)]
    };
    assert.throws(() => store.saveBatch([inventoryWrite(1, [used], 'inventory_order_sale')]), {
      status: 409
    });
    assert.throws(
      () => store.saveBatch([direct, inventoryWrite(1, [used, account], 'inventory_order_sale')]),
      { status: 409 }
    );
    assert.deepEqual(store.load('inventory'), { version: 1, data: inventory([account]) });
    assert.deepEqual(store.load('commerce'), { version: 0, data: null });
    assert.equal(store.audit().length, 1);
  } finally {
    store.close();
  }
});

test('one successful atomic stock delivery prevents another delivery without blocking an independent renewal', () => {
  const store = createLocalBusinessStore(':memory:');
  try {
    store.saveBatch([inventoryWrite(0, [account], 'inventory_create')]);
    const first = stockOrder('sale-order-1');
    const usedAccount = {
      ...account,
      inventoryState: 'used',
      used: true,
      usageLinks: [saleLink(first.id)],
      version: 2
    };
    const firstOrders = commerce([first]);
    store.saveBatch([
      commerceWrite(0, firstOrders),
      inventoryWrite(1, [usedAccount], 'inventory_order_sale')
    ]);
    assert.deepEqual(store.load('commerce'), { version: 1, data: firstOrders });
    assert.deepEqual(store.load('inventory'), { version: 2, data: inventory([usedAccount]) });

    const second = stockOrder('sale-order-2');
    const forged = {
      ...usedAccount,
      usageLinks: [...usedAccount.usageLinks, saleLink(second.id)],
      version: 3
    };
    assert.throws(
      () =>
        store.saveBatch([
          commerceWrite(1, commerce([first, second])),
          inventoryWrite(2, [forged], 'inventory_order_sale')
        ]),
      { status: 409 }
    );
    assert.deepEqual(store.load('commerce'), { version: 1, data: firstOrders });
    assert.deepEqual(store.load('inventory'), { version: 2, data: inventory([usedAccount]) });
    assert.equal(store.audit().length, 3);

    const renewal = order('renewal-order-1', { email: first.email });
    const renewed = commerce([first, renewal]);
    store.saveBatch([commerceWrite(1, renewed)]);
    assert.deepEqual(store.load('commerce'), { version: 2, data: renewed });
    assert.deepEqual(store.load('inventory'), { version: 2, data: inventory([usedAccount]) });
  } finally {
    store.close();
  }
});

test('an unrelated legacy inventory row without a stable id does not block a valid delivery', () => {
  const store = createLocalBusinessStore(':memory:');
  try {
    const legacy = { type: 'gpt', email: 'legacy@example.test' };
    const delivery = stockOrder('sale-order-with-legacy');
    const used = {
      ...account,
      inventoryState: 'used',
      used: true,
      version: 2,
      usageLinks: [saleLink(delivery.id)]
    };
    store.saveBatch([inventoryWrite(0, [legacy, account], 'inventory_create')]);
    store.saveBatch([
      commerceWrite(0, commerce([delivery])),
      inventoryWrite(1, [legacy, used], 'inventory_order_sale')
    ]);
    assert.deepEqual(store.load('inventory'), { version: 2, data: inventory([legacy, used]) });
    assert.deepEqual(store.load('commerce'), { version: 1, data: commerce([delivery]) });
  } finally {
    store.close();
  }
});

test('Claude inventory must have a known and eligible registration age at delivery', (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-11-05T02:30:00.000Z') });
  const store = createLocalBusinessStore(':memory:');
  try {
    const claude = { ...account, id: 'stock-claude-1', type: 'claude', registered: '' };
    const delivery = order('claude-sale', {
      businessType: '成品交付',
      product: 'Claude Pro',
      plan: 'Pro',
      accountId: claude.id,
      email: claude.email
    });
    const used = (row) => ({
      ...row,
      inventoryState: 'used',
      used: true,
      usageLinks: [saleLink(delivery.id)],
      version: row.version + 1
    });
    const commit = (version, row) =>
      store.saveBatch([
        commerceWrite(0, commerce([delivery])),
        inventoryWrite(version, [used(row)], 'inventory_order_sale')
      ]);

    store.saveBatch([inventoryWrite(0, [claude], 'inventory_create')]);
    assert.throws(() => commit(1, claude), { status: 409 });
    const young = { ...claude, version: 2, registered: '2026-11-02 10:31' };
    store.saveBatch([inventoryWrite(1, [young], 'inventory_edit')]);
    assert.throws(() => commit(2, young), { status: 409 });
    assert.deepEqual(store.load('inventory'), { version: 2, data: inventory([young]) });
    assert.deepEqual(store.load('commerce'), { version: 0, data: null });
    const eligible = { ...young, version: 3, registered: '2026-11-02 10:30' };
    store.saveBatch([inventoryWrite(2, [eligible], 'inventory_edit')]);
    commit(3, eligible);
    assert.deepEqual(store.load('commerce'), { version: 1, data: commerce([delivery]) });
    assert.deepEqual(store.load('inventory'), { version: 4, data: inventory([used(eligible)]) });
  } finally {
    store.close();
  }
});

test('orders with confirmed payment or receipt cannot be cancelled or deleted directly', () => {
  const store = createLocalBusinessStore(':memory:');
  const cancel = (row) => ({
    ...row,
    cancelled: true,
    version: row.version + 1,
    cancellationEvents: [
      { id: `cancel-${row.id}`, action: '业务撤单', reason: '测试撤单', actor: '测试员', at: time }
    ]
  });
  try {
    const paid = order('paid-only', { receiptConfirmed: false });
    const received = order('received-only', { paidConfirmed: false });
    const draft = order('draft-order', { paidConfirmed: false, receiptConfirmed: false });
    const original = [paid, received, draft];
    store.saveBatch([commerceWrite(0, commerce(original))]);
    for (const confirmed of [paid, received]) {
      const cancelled = original.map((row) => (row.id === confirmed.id ? cancel(row) : row));
      assert.throws(() => store.saveBatch([commerceWrite(1, commerce(cancelled), '业务撤单')]), {
        status: 409
      });
      const removed = original.filter((row) => row.id !== confirmed.id);
      assert.throws(() => store.saveBatch([commerceWrite(1, commerce(removed), '业务撤单')]), {
        status: 409
      });
    }
    assert.deepEqual(store.load('commerce'), { version: 1, data: commerce(original) });
    assert.equal(store.audit().length, 1);
    const valid = commerce([paid, received, cancel(draft)]);
    store.saveBatch([commerceWrite(1, valid, '业务撤单')]);
    assert.deepEqual(store.load('commerce'), { version: 2, data: valid });
  } finally {
    store.close();
  }
});

test('customer refunds remain append-only and cannot exceed the confirmed receipt', () => {
  const store = createLocalBusinessStore(':memory:');
  const refund = (id, amount) => ({
    id,
    amount,
    currency: 'CNY',
    payment: '银行卡',
    reason: '实际退款',
    at: '2026-11-05T11:30',
    actor: '测试员',
    actorId: 'test-operator'
  });
  const withRefunds = (row, ...refunds) =>
    commerce([{ ...row, refunds, version: row.version + 1 }]);
  try {
    const original = order('refund-order-1');
    const unconfirmed = { ...original, receiptConfirmed: false };
    assert.throws(
      () =>
        store.saveBatch([
          commerceWrite(0, withRefunds(unconfirmed, refund('unconfirmed', '1.0000')), '退款登记')
        ]),
      { status: 409 }
    );
    assert.deepEqual(store.load('commerce'), { version: 0, data: null });
    store.saveBatch([commerceWrite(0, commerce([original]))]);
    const first = refund('refund-1', '30.0000');
    const firstRefund = withRefunds(original, first);
    store.saveBatch([commerceWrite(1, firstRefund, '退款登记')]);
    const second = refund('refund-2', '70.0000');
    const twoRefunds = withRefunds(firstRefund.orders[0], first, second);
    store.saveBatch([commerceWrite(2, twoRefunds, '退款登记')]);

    const current = twoRefunds.orders[0];
    for (const [action, changed] of [
      ['退款登记', withRefunds(current, first, second, refund('refund-3', '0.0001'))],
      [
        '退款登记',
        withRefunds(
          { ...current, saleAmount: '110.0000' },
          first,
          second,
          refund('refund-3', '10.0000')
        )
      ],
      ['更正订单', withRefunds(current, first)],
      ['更正订单', withRefunds(current, { ...first, amount: '29.9999' }, second)],
      ['更正订单', withRefunds({ ...current, saleAmount: '99.9999' }, first, second)]
    ]) {
      assert.throws(() => store.saveBatch([commerceWrite(3, changed, action)]), { status: 409 });
      assert.deepEqual(store.load('commerce'), { version: 3, data: twoRefunds });
      assert.equal(store.audit().length, 3);
    }

    const unrelated = commerce([current], [{ id: 'customer-1', name: '测试客户' }]);
    store.saveBatch([commerceWrite(3, unrelated, '新增资料')]);
    assert.deepEqual(store.load('commerce'), { version: 4, data: unrelated });
  } finally {
    store.close();
  }
});

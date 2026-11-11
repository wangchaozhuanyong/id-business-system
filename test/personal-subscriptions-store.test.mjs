import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalBusinessStore } from '../server/local-business.mjs';

test('个人订单与库存及 Apple 余额在加密业务库一起提交，冲突后可在原单继续', t => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const actor = { id: 'personal-ci-admin', name: '隔离测试经办人', role: 'admin' };
  const save = (...entries) => store.saveBatch(entries, { actor });
  const write = (domain, version, data, action) => ({ domain, version, data, action });
  const email = 'personal-stock@example.test';
  const appleIdId = 'apple-stock';
  const mailbox = { id: 'mail-stock', type: 'google', email, country: '马来西亚', device: '合成设备',
    status: '正常', health: 'normal', inventoryState: 'available', usageLinks: [] };
  const apple = { id: appleIdId, type: 'apple', email: 'wallet@example.test', status: '正常', appStoreRegion: 'MY' };
  const inventory = { mailboxes: [mailbox, apple], accounts: [], batches: [], returnRecords: [],
    importRecords: [], registrationRecords: [], tableSettings: [], undo: [] };
  save(write('inventory', 0, inventory, 'inventory_create'));
  const account = { id: 'gemini-stock', type: 'gemini', email, loginMethod: 'google',
    source: '自己注册', sourceMailboxId: mailbox.id, sourceClaimId: '', status: '正常', health: 'normal',
    inventoryState: 'available', usageLinks: [], version: 1 };
  const seeded = store.load('inventory');
  seeded.data.accounts.push(account);
  save(write('inventory', seeded.version, seeded.data, 'inventory_create'));
  const stock = store.load('inventory');
  assert.equal(stock.data.mailboxes[0].inventoryState, 'used');
  assert.equal(stock.data.mailboxes[0].usageLinks[0].accountId, account.id);
  assert.equal(stock.data.registrationRecords[0].actorId, actor.id);

  const fund = { id: 'fund', appleIdId, kind: 'manual', amount: '30', before: '0', after: '30', versionAfter: 2 };
  const initialLedger = { wallets: [{ id: appleIdId, currency: 'USD', balance: '30', version: 2 }],
    allocations: [], movements: [fund], refunds: [] };
  save(write('appleBalance', 0, initialLedger, 'apple_adjust'));
  save(write('settings', 0, { mailboxTypes: [], costSettings: {}, applePaidPrices: { Gemini: { 'Google AI Pro': { MY: '12' } } } }, 'apple_paid_prices_save'));
  const order = { id: 'gemini-order', orderNo: 'fixture-order', product: 'Gemini', plan: 'Google AI Pro',
    subscriptionSeries: 'google_ai', businessType: '成品交付', customerId: 'fixture-customer', email,
    loginMethod: 'google', accountId: account.id, accountSource: '库存', payment: '苹果内购', appleIdId,
    entitlementStatus: 'pending', paidCurrency: 'USD', paidAmount: '12',
    paidConfirmed: false, costBasis: 'standard', saleCurrency: 'CNY', saleAmount: '', receiptConfirmed: false,
    start: '', expiry: '', refunds: [], bankReturns: [], version: 1 };
  const commerce = { customers: [{ id: order.customerId, name: '合成客户' }], orders: [order],
    tenants: [], operating: [], rentBatches: [], logs: [] };
  save(write('commerce', 0, commerce, '新增独立订单'));
  const pending = store.load('commerce');
  const active = { ...pending.data.orders[0], entitlementStatus: 'active',
    paidConfirmed: true, appleGoogleVerified: true, start: '2026-11-09T09:00', expiry: '2026-12-09T09:00', version: 2 };
  const confirmation = () => write('commerce', pending.version, { ...pending.data, orders: [structuredClone(active)] }, '更正订单');
  const occupied = () => {
    const next = structuredClone(stock.data);
    next.accounts[0].inventoryState = 'used';
    next.accounts[0].used = true;
    next.accounts[0].version++;
    next.accounts[0].usageLinks.push({ kind: 'order-sale', orderId: order.id, label: '隔离交付' });
    return write('inventory', stock.version, next, 'inventory_order_sale');
  };
  const debit = { id: 'debit', appleIdId, orderId: order.id, kind: 'order-charge', amount: '-12',
    before: '30', after: '18', versionAfter: 3 };
  const ledger = () => write('appleBalance', 1, { wallets: [{ id: appleIdId, currency: 'USD', balance: '18', version: 3 }],
    allocations: [{ appleIdId, orderId: order.id, amount: '12', returned: '0' }],
    movements: [fund, debit], refunds: [] }, 'apple_order_charge');

  assert.throws(() => save(confirmation(), ledger()), { status: 409 });
  assert.throws(() => save(confirmation(), occupied()), { status: 409 });
  assert.equal(store.load('commerce').data.orders[0].entitlementStatus, 'pending');
  assert.equal(store.load('inventory').data.accounts[0].inventoryState, 'available');
  assert.equal(store.load('appleBalance').data.wallets[0].balance, '30');

  save(confirmation(), occupied(), ledger());
  assert.equal(store.load('commerce').data.orders[0].entitlementStatus, 'active');
  assert.equal(store.load('inventory').data.accounts[0].accountLifecycle.customerId, order.customerId);
  assert.equal(store.load('appleBalance').data.wallets[0].balance, '18');
  assert.throws(() => save(confirmation(), occupied(), ledger()), { status: 409 });
  assert.equal(store.load('appleBalance').data.movements.filter(row => row.orderId === order.id).length, 1);
});

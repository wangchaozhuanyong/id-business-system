import assert from 'node:assert/strict';
import test from 'node:test';
import { accountLifecycleSummaries, accountLifecycleSummary, checkInventoryRenewals } from '../server/account-lifecycle.mjs';
import { lifecycleFixture } from './helpers/account-lifecycle-fixture.mjs';

test('batch lifecycle reads match individual reads across ambiguous, released and personal accounts', () => {
  const { inventory, commerce } = lifecycleFixture('gpt');
  const original = commerce.orders[0];
  commerce.customers.push({ ...commerce.customers[0], name: '重复编号不能取代第一条' });
  commerce.tenants.push({ ...commerce.tenants[0], name: '重复租户编号不能取代第一条' });
  commerce.orders.push({ ...original, id: 'renewal', accountId: '', businessType: '续费', start: '2026-10-01T12:00', expiry: '2026-11-01T12:00' });
  commerce.orders.push({ ...original, id: 'other-customer', accountId: '', customerId: 'customer-b', businessType: '续费' });
  inventory.accounts.push({ ...inventory.accounts[0], id: 'duplicate-email', usageLinks: [] });
  inventory.accounts[0].accountLifecycleEvents = [{ action: 'release', orderIds: ['order-a'], time: '2026-11-01' }];
  for (const [i, type] of ['claude', 'gemini', 'grok'].entries()) {
    const account = { ...inventory.accounts[0], id: 'personal-' + i, type, loginMethod: type === 'grok' ? 'x' : 'email',
      email: 'personal@example.test', xHandle: type === 'grok' ? '@synthetic' : '', platformAccountId: 'platform-' + i,
      usageLinks: [], accountLifecycleEvents: [] };
    inventory.accounts.push(account);
    const order = { ...original, id: 'personal-order-' + i, accountId: account.id,
      product: { claude: 'Claude Pro', gemini: 'Gemini', grok: 'Grok' }[type],
      email: account.email.toUpperCase(), loginMethod: account.loginMethod, xHandle: account.xHandle,
      platformAccountId: account.platformAccountId, entitlementStatus: 'active' };
    commerce.orders.push(order, { ...order, id: 'wrong-platform-' + i, platformAccountId: 'other-platform' });
  }
  inventory.accounts.push({ id: 'unsupported', type: 'apple', email: 'personal@example.test' });
  const before = structuredClone({ inventory, commerce }), at = Date.parse('2026-11-12T00:00:00Z');
  const expected = inventory.accounts.filter(row => row.type !== 'apple').map(row => accountLifecycleSummary(row, commerce, at));
  assert.deepEqual(accountLifecycleSummaries(inventory, commerce, at), expected);
  assert.deepEqual({ inventory, commerce }, before, 'read optimization must not mutate any business record');
  assert.equal(expected[0].customer, '客户 A');
  assert(!expected[0].orders.some(row => row.id === 'other-customer'));
});

test('bulk lifecycle reads scale with actual matching records instead of accounts times all orders', () => {
  const count = 1200;
  let inspectedProducts = 0;
  const inventory = { accounts: [] }, commerce = { orders: [], customers: [] };
  for (let i = 0; i < count; i++) {
    inventory.accounts.push({ id: 'a-' + i, type: 'gpt', email: `account-${i}@example.test` });
    commerce.customers.push({ id: 'c-' + i, name: '合成客户 ' + i });
    commerce.orders.push({ id: 'o-' + i, get product() { inspectedProducts++; return 'GPT'; },
      accountId: 'a-' + i, customerId: 'c-' + i, email: `account-${i}@example.test`,
      start: '2026-11-01T00:00', expiry: '2026-12-01T00:00' });
  }
  const result = accountLifecycleSummaries(inventory, commerce, Date.parse('2026-11-12T00:00:00Z'));
  assert.equal(result.length, count);
  assert.equal(result.at(-1).orders[0].id, 'o-' + (count - 1));
  assert(inspectedProducts < count * 12, `bulk read inspected ${inspectedProducts} product fields`);
});

test('checking unchanged orders does not scan all inventory for each existing order', () => {
  const count = 1200, inventory = { accounts: [] }, commerce = { orders: [] };
  let idReads = 0;
  for (let i = 0; i < count; i++) {
    inventory.accounts.push({ get id() { idReads++; return 'a-' + i; }, type:'gpt', email:`account-${i}@example.test` });
    commerce.orders.push({ id:'o-'+i, accountId:'a-'+i, product:'GPT', email:`account-${i}@example.test` });
  }
  assert.equal(checkInventoryRenewals(structuredClone(commerce), commerce, inventory), undefined);
  assert(idReads < count * 5, `save validation inspected ${idReads} account IDs`);
  const changed = structuredClone(commerce);
  changed.orders.at(-1).customerId = 'changed-customer';
  assert.match(checkInventoryRenewals(commerce, changed, inventory), /原库存账号及客户关联必须保留/);
});

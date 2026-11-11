import assert from 'node:assert/strict';
import test from 'node:test';
import {
  applyAccountOrderLifecycle, checkInventoryRenewals, accountLifecycleSummary
} from '../server/account-lifecycle.mjs';
import { applyInventoryUsage, inspectInventoryUsage } from '../server/inventory-usage.mjs';
import { checkAppleLedger, checkStockDeliveries } from '../server/local-business-integrity.mjs';
import { checkAppleOrder } from '../server/order-policy.mjs';
import { personalOrderError, preparePersonalInventory } from '../server/personal-subscriptions.mjs';

const actor = { id: 'operator', name: '合成经办人' };
const customers = [{ id: 'customer', name: '合成客户' }];
const at = new Date('2026-11-10T09:00:00+08:00');
const makeInventory = () => ({ mailboxes: [], accounts: [], batches: [], registrationRecords: [] });
const account = { id: 'stock-grok', type: 'grok', email: '', loginMethod: 'x', xHandle: '@fixture',
  status: '正常', health: 'normal', source: '自己注册', inventoryState: 'available', usageLinks: [] };
const grok = { id: 'grok-first', product: 'Grok', plan: 'X Premium', loginMethod: 'x', email: '',
  xHandle: '@fixture', xLinkState: 'linked', platformAccountId: 'platform-11', subscriptionSeries: 'x_premium',
  customerId: 'customer', businessType: '续费',
  payment: '银行卡', entitlementStatus: 'pending', paidAmount: '', start: '', expiry: '' };
const apple = { id: 'apple-first', product: 'Gemini', plan: 'Google AI Pro', loginMethod: 'google',
  email: 'fixture@example.test', subscriptionSeries: 'google_ai', customerId: 'customer',
  businessType: '成品交付', payment: '苹果内购', appleIdId: 'apple-1',
  entitlementStatus: 'active', start: '2026-11-10T08:00', expiry: '2027-11-10T08:00', paidConfirmed: true,
  paidAmount: '19.99', paidCurrency: 'USD', appleGoogleVerified: true, cardId: '', refunds: [] };

test('个人订单直接登记付款方式，历史账单、权益和旧系列切换各自核对', () => {
  const validate = (row, prior = null, orders = []) => personalOrderError(row, prior, orders, customers);
  assert.equal(validate(grok), undefined);
  assert.equal(validate(apple), undefined);
  assert.match(validate({ ...apple, appleGoogleVerified: false }), /对应的 Google 账号/);
  assert.match(validate({ ...grok, loginMethod: 'email' }), /登录方式/);
  assert.match(validate({ ...grok, tenantId: 'fixture-tenant' }), /仅适用于 Claude/);
  assert.match(validate({ ...grok, customerId: '' }), /请选择订单客户/);
  assert.match(validate({ ...grok, receiptConfirmed: true }), /实收/);
  assert.match(validate({ ...grok, paidConfirmed: true }), /实际付款资源/);
  assert.match(validate({ ...grok, entitlementStatus: 'active' }), /开通及到期/);
  const settled = { ...grok, entitlementStatus: 'active', start: apple.start, expiry: apple.expiry };
  assert.equal(validate(settled), undefined, '已确认权益可独立于平台付款');
  const bank = { ...settled, paidConfirmed: true,
    cardId: 'recharge:card-1', paidCurrency: 'MYR', paidAmount: '9.99' };
  assert.equal(validate(bank, settled), undefined);
  const historic = { ...bank, businessType: '首次开通', billingChannel: 'web',
    billingReceipt: 'tx-42', billingCountry: '马来西亚', billingCycle: 'month', autoRenew: 'on' };
  assert.equal(validate({ ...historic, appleIdId: '', notes: '补记说明' }, historic), undefined);
  assert.match(validate({ ...historic, billingReceipt: 'tx-43' }, historic), /原账单/);
  assert.match(validate({ ...historic, businessType: '续费', id: 'another', billingReceipt: ' TX-42 ',
    billingChannel: 'web_apple_pay' }, null, [historic]), /已登记/);
  const migrated = { ...grok, id: 'new-series', plan: 'The X Subscription Plus', subscriptionSeries: 'x_subscription',
    billingChannel: 'web_apple_pay', previousSubscriptionOrderId: settled.id, previousAutoRenew: 'off' };
  assert.equal(validate(migrated, null, [settled]), undefined);
  assert.match(validate({ ...migrated, xHandle: '@other' }, null, [settled]), /原 Grok 订阅/);
  assert.match(validate({ ...migrated, billingChannel: 'app_store', payment: '苹果内购' }, null, [settled]), /充值方式/);
  assert.match(validate({ ...migrated, appleIdId: 'apple-1' }, null, [settled]), /充值方式/);
  assert.match(validate({ ...migrated, billingChannel: 'app_store' }, null, [settled]), /购买渠道/);
});

test('注册通过明确库存编号消耗选定邮箱并留存原领取批次', () => {
  const before = makeInventory();
  const email = 'fixture@example.test';
  const selected = { id: 'selected', email, type: 'google', health: 'normal', status: '正常',
    inventoryState: 'claimed', claimId: 'claim-1', claimBatchId: 'batch-1' };
  before.mailboxes.push(selected, { id: 'other-source', email, type: 'google', inventoryState: 'available' });
  before.batches.push({ id: 'batch-1', kind: 'mail', actorId: actor.id, purpose: '注册 Gemini',
    items: [{ id: 'claim-1', assetId: selected.id, email, status: 'pending', claimedAt: '2026-11-09 09:00' }] });
  const next = structuredClone(before);
  next.accounts.push({ ...account, id: 'gemini-stock', type: 'gemini', loginMethod: 'google',
    email, xHandle: '', sourceMailboxId: selected.id, sourceClaimId: 'claim-1' });
  const review = inspectInventoryUsage(before, { orders: [] });
  assert.match(preparePersonalInventory(before, structuredClone(next), 'inventory_create',
    { ...actor, id: 'someone-else' }, at, review), /本人/);
  assert.match(preparePersonalInventory(before, { ...next, accounts: [{ ...next.accounts[0], sourceClaimId: 'wrong' }] },
    'inventory_create', actor, at, review), /原邮箱领用批次/);
  assert.equal(preparePersonalInventory(before, next, 'inventory_create', actor, at, review), undefined);
  const usage = inspectInventoryUsage(next, { orders: [apple] }, at.getTime());
  assert.equal(usage.get('other-source').status, 'review');
  assert.equal(usage.get(selected.id).evidence.accountId, 'gemini-stock');
  assert.equal(applyInventoryUsage(usage, actor, at), true);
  assert.equal(next.mailboxes[0].inventoryState, 'used');
  assert.equal(next.mailboxes[0].usageLinks[0].claimId, 'claim-1');
  assert.equal(next.batches[0].items[0].status, 'used');
  assert.equal(next.mailboxes[1].inventoryState, 'available');
  assert.equal(before.batches[0].items[0].status, 'pending');
  assert.match(preparePersonalInventory(next, { ...next, accounts: [...next.accounts,
    { ...next.accounts[0], id: 'second-stock', email: 'other@example.test' }] }, 'inventory_create', actor, at), /来源邮箱/);
  const withoutSource = { ...makeInventory(), mailboxes: next.mailboxes, accounts: [account] };
  assert.equal(preparePersonalInventory(next, withoutSource, 'inventory_create', actor, at), undefined);
  assert.equal(inspectInventoryUsage(withoutSource, { orders: [grok] }, at.getTime()).get('other-source').status, 'review');
});

test('成品先占用后交付，后续续费只追加同一账号的历史', () => {
  const before = { ...makeInventory(), accounts: [account] };
  const pending = { ...grok, businessType: '成品交付', accountId: account.id };
  const active = { ...pending, entitlementStatus: 'active', start: apple.start, expiry: apple.expiry };
  const original = { orders: [], customers };
  const reserved = { orders: [pending], customers };
  assert.equal(checkStockDeliveries(original, reserved, before, before, actor), undefined);
  assert.match(checkStockDeliveries(reserved, { orders: [pending, { ...pending, id: 'duplicate' }] }, before, before, actor), /不能重复交付/);
  assert.match(checkStockDeliveries(reserved, { orders: [active] }, before, before, actor), /使用记录一起保存/);
  const inventory = { ...before, accounts: [{ ...account, inventoryState: 'used', used: true,
    usageLinks: [{ kind: 'order-sale', orderId: active.id }] }] };
  const commerce = { orders: [active], customers };
  assert.equal(checkStockDeliveries(reserved, commerce, before, inventory, actor), undefined);
  assert.equal(applyAccountOrderLifecycle(reserved, commerce, inventory, actor, at), true);
  const renew = { ...active, id: 'renew', previousOrderId: active.id, businessType: '续费',
    expiry: '2028-11-10T08:00' };
  assert.equal(personalOrderError(renew, null, [active, renew], customers), undefined);
  assert.equal(checkInventoryRenewals(commerce, { orders: [active, renew] }, inventory), undefined);
  assert.match(checkInventoryRenewals(commerce, { orders: [active, { ...renew, customerId: 'different' }] },
    inventory), /归属/);
  assert.equal(applyAccountOrderLifecycle(commerce, { orders: [active, renew] }, inventory, actor, at), true);
  const summary = accountLifecycleSummary(inventory.accounts[0], { orders: [active, renew], customers }, at.getTime());
  assert.deepEqual(summary.orders.map(order => order.id).sort(), [active.id, renew.id].sort());
  assert.equal(summary.customerId, 'customer');
  assert.equal(summary.orders[0].plan, 'X Premium');
});

test('Apple 首配、同 ID 续费、余额不足、重复流水与到账恢复沿用账本', () => {
  const inventory = { mailboxes: ['apple-1', 'apple-2'].map(id => ({ id, type: 'apple', status: '正常' })) };
  const wallet = (balance, version) => ({ id: 'apple-1', currency: 'USD', balance, version });
  const movement = (id, kind, amount, before, after, versionAfter, extra) =>
    ({ id, appleIdId: 'apple-1', kind, amount, before, after, versionAfter, ...extra });
  const initial = { wallets: [wallet('30', 2)], allocations: [], refunds: [],
    movements: [movement('fund', 'manual', '30', '0', '30', 2)] };
  assert.equal(checkAppleOrder(apple, null, [], initial, inventory, [apple]), undefined);
  assert.match(checkAppleOrder({ ...apple, paidAmount: '31' }, null, [], initial, inventory, [apple]), /余额/);
  const legacy = { ...apple, businessType: '续费' };
  assert.match(checkAppleOrder(legacy, null, [], initial, inventory, [legacy]), /原订阅/);
  assert.equal(checkAppleOrder({ ...legacy, appleOriginalVerified: true, appleOriginalReceipt: 'receipt-before' }, null, [], initial, inventory, [legacy]), undefined);
  const allocation = { orderId: apple.id, appleIdId: apple.appleIdId, amount: apple.paidAmount, returned: '0' };
  const charge = movement('debit-1', 'order-charge', '-19.99', '30', '10.01', 3, { orderId: apple.id });
  const settled = { ...initial, wallets: [wallet('10.01', 3)], allocations: [allocation], movements: [...initial.movements, charge] };
  assert.equal(checkAppleLedger(initial, settled, inventory, { orders: [apple] }), undefined);
  assert.match(checkAppleLedger(initial, { ...settled, allocations: [] }, inventory, { orders: [apple] }), /扣款/);
  assert.match(checkAppleLedger(settled, { ...settled, wallets: [wallet('0.01', 4)],
    movements: [...settled.movements, movement('repeat', 'order-charge', '-10', '10.01', '0.01', 4, { orderId: apple.id })] },
    inventory, { orders: [apple] }), /扣款/);
  const renew = { ...apple, id: 'renewal', businessType: '续费', billingReceipt: 'new-receipt', paidAmount: '10' };
  assert.equal(checkAppleOrder(renew, null, [apple], settled, inventory, [apple, renew]), undefined);
  assert.match(checkAppleOrder({ ...renew, appleIdId: 'apple-2' }, null, [apple],
    { ...settled, wallets: [...settled.wallets, { ...wallet('20', 2), id: 'apple-2' }] }, inventory, [apple, renew]), /原订阅/);
  assert.match(checkAppleOrder({ ...renew, businessType: '成品交付' }, null, [apple], settled, inventory, [apple, renew]), /未用于订阅/);
  const refundedOrder = { ...apple, refunds: [{ id: 'refund-1', payment: '苹果内购', amount: '12' }] };
  const refund = { id: 'refund-1', appleIdId: apple.appleIdId, orderId: apple.id, amount: '6', status: 'pending' };
  const waiting = { ...settled, refunds: [refund] };
  assert.equal(checkAppleLedger(settled, waiting, inventory, { orders: [refundedOrder] }), undefined);
  assert.match(checkAppleLedger(waiting, { ...waiting, refunds: [{ ...refund, status: 'received' }] },
    inventory, { orders: [refundedOrder] }), /到账/);
  const received = { ...waiting, wallets: [wallet('16.01', 4)], refunds: [{ ...refund, status: 'received' }],
    allocations: [{ ...allocation, returned: '6' }], movements: [...waiting.movements,
      movement('refund-credit', 'apple-refund', '6', '10.01', '16.01', 4, { orderId: apple.id, refundId: refund.id })] };
  assert.equal(checkAppleLedger(waiting, received, inventory, { orders: [refundedOrder] }), undefined);
  assert.equal(checkAppleLedger(received, received, inventory, { orders: [refundedOrder,
    { ...grok, billingChannel: 'web_apple_pay', paidConfirmed: true }] }), undefined);
});

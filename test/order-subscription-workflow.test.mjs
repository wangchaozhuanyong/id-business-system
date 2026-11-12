import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { createCardManagementHandler } from '../server/card-management.mjs';
import { createLocalBusinessStore, handleLocalBusiness } from '../server/local-business.mjs';
import { applyInventoryUsage, inspectInventoryUsage } from '../server/inventory-usage.mjs';
import { preparePersonalInventory } from '../server/personal-subscriptions.mjs';
import { createSubscriptionHandler } from '../server/subscription-management.mjs';

const origin = 'https://workflow.example.test';
const actor = { id: 'qa-admin', name: '合成管理员', role: 'admin' };
const customer = { id: 'qa-customer', name: '合成客户', wechat: '', active: true, version: 1 };
const time = Date.parse('2026-11-12T04:00:00.000Z');
const blankCommerce = () => ({ orders: [], customers: [], tenants: [], operating: [], rentBatches: [], logs: [] });
function order(id, product, plan, extra = {}) {
  return { id, product, plan, source: '管理员手工', version: 1, customerId: customer.id,
    businessType: '续费', email: '', cardId: '', proMaterialMode: 'none',
    payment: '银行卡', paidAmount: '20', paidCurrency: 'USD', saleAmount: '130', saleCurrency: 'CNY',
    start: '2026-10-12T12:00', expiry: '2026-11-12T12:00', costBasis: 'standard', refunds: [], bankReturns: [],
    ...extra };
}

async function request(handler, route, body, method = 'POST') {
  const stream = Readable.from(body ? [Buffer.from(JSON.stringify(body))] : []);
  Object.assign(stream, { method, url: route, headers: { origin, 'content-type': 'application/json' } });
  let status, data;
  await handler(stream, { setHeader() {}, writeHead: code => { status = code; }, end: raw => { data = JSON.parse(raw); } },
    route, actor);
  return { status, data };
}

test('四个产品缺邮箱及银行卡仍能一次入单，空邮箱续费只更新选中的订阅', async t => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const commerce = (req, res, route, user) => handleLocalBusiness(req, res, route, store, user, { publicOrigin: origin });
  const subscriptions = createSubscriptionHandler({ store, publicOrigin: origin, clock: () => time });
  const list = () => request(subscriptions, '/api/local/subscriptions/list', { product: 'all', scope: 'all' });
  const save = async (entry, inlineCustomer = false) => {
    const { version, data } = store.load('commerce');
    const next = structuredClone(data || blankCommerce());
    if (inlineCustomer) next.customers.push(customer);
    next.orders.push(entry);
    return request(commerce, '/api/local/commerce', {
      version, data: next, action: inlineCustomer ? '新增订单并登记客户' : '新增独立订单'
    }, 'PUT');
  };
  const entries = [
    order('gpt-first', 'GPT', 'Plus'), order('gpt-second', 'GPT', 'Plus'),
    order('claude', 'Claude Max', 'Max 5x'),
    order('gemini', 'Gemini', 'Google AI Pro', { subscriptionSeries: 'google_ai', loginMethod: 'google' }),
    order('grok', 'Grok', 'X Premium', { subscriptionSeries: 'x_premium', loginMethod: 'email' }),
    order('apple-outside', 'Gemini', 'Google AI Pro', { subscriptionSeries: 'google_ai', loginMethod: 'google', payment: '苹果内购', proMaterialMode: '' }),
    order('bank-without-email', 'GPT', 'Plus', { proMaterialMode: 'manual_card', proCardNumber: '4000000000000002' })
  ];
  for (const [index, entry] of entries.entries()) {
    const result = await save(entry, index === 0);
    assert.equal(result.status, 200, JSON.stringify(result.data));
    const stored = result.data.data.orders.find(row => row.id === entry.id);
    assert.deepEqual([stored.paidConfirmed, stored.receiptConfirmed, stored.entitlementStatus], [true, true, 'active']);
    if (entry.id === 'apple-outside') assert.equal(stored.externalApplePayment, true);
  }
  assert.equal(store.load('appleBalance').data, null, '外部已付款不创建余额或扣款流水');
  const bank = createCardManagementHandler({ store, publicOrigin: origin, clock: () => time });
  const bankList = await request(bank, '/api/local/subscription-card-status', undefined, 'GET');
  assert.equal(bankList.data.items.find(item => item.id === 'bank-without-email').last4, '0002');
  const before = (await list()).data.items;
  assert.equal(before.length, entries.length);
  const original = before.find(row => row.series[0].sourceId === 'gpt-first');
  const second = before.find(row => row.series[0].sourceId === 'gpt-second');
  assert.notEqual(original.id, second.id);
  const renewal = order('renewal', 'GPT', 'Plus', {
    previousOrderId: 'gpt-first', renewalSourceVersion: 1, start: '2026-11-12T12:00', expiry: '2026-12-12T12:00'
  });
  const renewed = await save(renewal);
  assert.equal(renewed.status, 200, JSON.stringify(renewed.data));
  assert.equal((await save({ ...renewal, id: 'duplicate' })).status, 409);
  const after = (await list()).data.items;
  assert.equal(after.length, before.length);
  assert.equal(after.find(row => row.id === original.id).series[0].sourceId, 'renewal');
  assert.equal(after.find(row => row.id === second.id).series[0].sourceId, 'gpt-second');
});

test('续费用卡不改付款记录，复制确认锁定客户、订阅和最新绑定', async t => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  store.saveBatch([{ domain: 'commerce', version: 0, data: { ...blankCommerce(), customers: [{ ...customer, wechat: 'qa-only' }],
    orders: [
      order('qa-bank', 'GPT', 'Plus', { paidConfirmed: true, receiptConfirmed: true, entitlementStatus: 'active' }),
      order('qa-other', 'GPT', 'Plus', { paidConfirmed: true, receiptConfirmed: true, entitlementStatus: 'active' })
    ]
  } }]);
  const cards = createCardManagementHandler({ store, publicOrigin: origin, clock: () => time });
  const subscriptions = createSubscriptionHandler({ store, publicOrigin: origin, clock: () => time });
  const card = (action, args = {}, orderId = 'qa-bank') =>
    request(cards, '/api/local/subscription-renewal-card', { action, orderId, ...args });
  const first = await card('prepare');
  assert.equal(first.status, 200);
  assert.equal(first.data.hasCard, false);
  const before = store.load('commerce');
  const syntheticPan = '4242424242424242';
  assert.equal((await card('bind', { number: syntheticPan, version: first.data.version })).status, 200);
  assert.deepEqual(store.load('commerce'), before);
  const preview = await card('prepare');
  assert.equal(preview.data.customerName, '合成客户');
  assert.equal(preview.data.last4, '4242');
  assert.doesNotMatch(JSON.stringify(preview.data), new RegExp(syntheticPan));
  assert.equal((await card('copy')).status, 409);
  assert.equal((await card('copy', { confirmation: preview.data.confirmation }, 'qa-other')).status, 409);
  assert.equal((await card('copy', { confirmation: preview.data.confirmation })).data.text, syntheticPan);
  assert.equal((await card('bind', { number: '4000000000000002', version: preview.data.version })).status, 200);
  assert.equal((await card('copy', { confirmation: preview.data.confirmation })).status, 409);
  await request(subscriptions, '/api/local/subscriptions/renewal-settings', { suffix: '方便时请回复是否续费。' });
  const contact = await request(subscriptions, '/api/local/subscriptions/contact-copy', { orderId: 'qa-bank' });
  assert.match(contact.data.text, /微信：qa-only[\s\S]*到期时间：2026-11-12 12:00[\s\S]*方便时请回复是否续费/);
  assert.doesNotMatch(contact.data.text, /4242424242424242|账号：/);
});


test('购买账号独立统计，只有明确选择的注册邮箱记为已使用', () => {
  const email = 'purchase@example.test';
  const owned = 'self-registered@example.test';
  const mailbox = (id, email) => ({ id, email, type: 'google', health: 'normal', status: '正常',
    inventoryState: 'available', usageLinks: [] });
  const before = { accounts: [], mailboxes: [mailbox('unchanged-mail', email), mailbox('linked-mail', owned)],
    batches: [], registrationRecords: [] };
  const account = (id, email, acquisitionMethod) => ({ id, email, acquisitionMethod, type: 'gpt',
    source: acquisitionMethod === 'purchased' ? '线上购买' : '自己注册',
    health: 'normal', status: '正常', inventoryState: 'available', usageLinks: [] });
  const next = structuredClone(before);
  next.accounts.push(account('purchase', email, 'purchased'),
    { ...account('registered', owned, 'self_registered'), sourceMailboxId: 'linked-mail' });
  assert.equal(preparePersonalInventory(before, next, 'inventory_import', actor, new Date(time)), undefined);
  const usage = inspectInventoryUsage(next, blankCommerce(), time);
  assert.equal(usage.has('unchanged-mail'), false);
  assert.equal(usage.get('linked-mail')?.evidence.accountId, 'registered');
  applyInventoryUsage(usage, actor, new Date(time));
  assert.deepEqual(next.mailboxes.map(row => row.inventoryState), ['available', 'used']);
  assert.equal(next.accounts.length, 2);
  const replacement = structuredClone(next);
  replacement.accounts[1].sourceMailboxId = 'unchanged-mail';
  assert.match(preparePersonalInventory(next, replacement, 'inventory_edit', actor), /来源库存创建后须保留/);
});

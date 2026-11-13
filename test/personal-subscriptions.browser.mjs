import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { accountLifecycleSummaries, applyAccountOrderLifecycle, checkInventoryRenewals } from '../server/account-lifecycle.mjs';
import { applyInventoryUsage, inspectInventoryUsage } from '../server/inventory-usage.mjs';
import { checkAppleLedger, checkStockDeliveries } from '../server/local-business-integrity.mjs';
import { checkAppleOrder } from '../server/order-policy.mjs';
import { personalOrderError, preparePersonalInventory } from '../server/personal-subscriptions.mjs';
import { interceptDesign, origin, separatorSnapshot, settle, toggleDesignTheme } from './helpers/offline-design.mjs';

const { chromium } = await import(process.env.ID_RECHARGE_QA_PLAYWRIGHT
  ? pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href : 'playwright');

const actor = { id: 'personal-admin', name: '合成经办员', role: 'admin' };
const customer = { id: 'personal-customer', name: '合成续费客户', active: true };
const mailbox = { id: 'personal-google', email: 'selected@example.test', type: 'google', status: '正常',
  health: 'normal', inventoryState: 'available', usageLinks: [], inventoryHistory: [] };
const wallet = { id: 'personal-apple', email: 'wallet@example.test', type: 'apple', status: '正常',
  appStoreRegion: 'MY', health: 'normal', inventoryState: 'available', usageLinks: [], inventoryHistory: [] };
const priorTime = day => new Date(Date.now() + (8 + 24 * day) * 3600000).toISOString().slice(0, 16);
const adminUrl = resource => origin + '/api/local/' + resource;
const removedFields = ['platformAccountId', 'billingChannel', 'billingCountry', 'billingReceipt',
  'billingCycle', 'autoRenew', 'nextChargeAt'].map(field => '#commerce-' + field).join(', ');

async function offline(browser, { width = 1440, operator = actor } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
  const seed = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  const fixture = {
    settings: { ...seed.settings, data: { ...seed.settings.data, applePaidPrices: { Gemini: { 'Google AI Pro': { MY: '15' } } } } },
    commerce: { version: 1, data: { customers: [customer], tenants: [], orders: [], operating: [], rentBatches: [], logs: [] } },
    inventory: { version: 1, data: { mailboxes: [mailbox, wallet], accounts: [], batches: [], returnRecords: [],
      importRecords: [], registrationRecords: [], tableSettings: [], undo: [] } },
    appleBalance: { version: 1, data: { wallets: [{ id: wallet.id, currency: 'USD', balance: '30.0000', version: 2 }],
      movements: [{ id: 'fixture-opening', appleIdId: wallet.id, kind: 'manual', amount: '30.0000',
        before: '0.0000', after: '30.0000', versionAfter: 2 }], allocations: [], refunds: [] } },
    'order-cards': { items: [{ id: 'recharge:fixture-card', label: '合成银行卡', last4: '0042', active: true, usageCount: 0 }] }
  };
  const requests = await interceptDesign(context, { localFixtures: fixture, actor: operator, skipRechargeAssets: true });
  const accepted = [];
  let failNext = '';
  const view = domain => ({
    ...fixture[domain],
    ...(domain === 'inventory' && {
      usageReview: [],
      accountSummaries: accountLifecycleSummaries(fixture.inventory.data, fixture.commerce.data)
    })
  });
  const store = (route, writes, batch) => {
    const reject = (error, status = 409) => route.fulfill({ status, json: { error } });
    if (failNext && writes.some(write => write.domain === failNext)) {
      failNext = '';
      return reject('合成保存冲突，保留原输入');
    }
    if (operator.role === 'employee') return reject('无权保存', 403);
    if (writes.some(write => fixture[write.domain].version !== write.version)) return reject('合成版本冲突');
    const incoming = Object.fromEntries(writes.map(write => [write.domain, write]));
    const oldInventory = fixture.inventory.data;
    const oldCommerce = fixture.commerce.data;
    const oldLedger = fixture.appleBalance.data;
    const inventory = structuredClone(incoming.inventory?.data || oldInventory);
    const commerce = structuredClone(incoming.commerce?.data || oldCommerce);
    const ledger = incoming.appleBalance?.data || oldLedger;
    if (incoming.inventory) {
      const issue = preparePersonalInventory(oldInventory, inventory, incoming.inventory.action, operator,
        new Date(), inspectInventoryUsage(oldInventory, oldCommerce));
      if (issue) return reject(issue);
    }
    for (const order of commerce.orders) {
      const prior = oldCommerce.orders.find(row => row.id === order.id);
      if (JSON.stringify(prior) === JSON.stringify(order)) continue;
      const issue = personalOrderError(order, prior, commerce.orders, commerce.customers) ||
        checkAppleOrder(order, prior, oldCommerce.orders, oldLedger, inventory, commerce.orders);
      if (issue) return reject(issue);
    }
    const issue = checkInventoryRenewals(oldCommerce, commerce, inventory) ||
      checkStockDeliveries(oldCommerce, commerce, oldInventory, inventory, operator) ||
      checkAppleLedger(oldLedger, ledger, inventory, commerce);
    if (issue) return reject(issue);
    const consumed = applyInventoryUsage(inspectInventoryUsage(inventory, commerce), operator);
    const lifecycle = applyAccountOrderLifecycle(oldCommerce, commerce, inventory, operator);
    const update = (domain, data) => { fixture[domain] = { version: fixture[domain].version + 1, data }; };
    if (incoming.inventory || consumed || lifecycle) update('inventory', inventory);
    if (incoming.commerce) update('commerce', commerce);
    if (incoming.appleBalance) update('appleBalance', ledger);
    accepted.push(writes.map(write => write.domain));
    return route.fulfill({ json: batch ? writes.map(write => ({ domain: write.domain, ...view(write.domain) })) : view(writes[0].domain) });
  };
  for (const domain of ['inventory', 'commerce', 'appleBalance']) {
    await context.route(adminUrl(domain), route => {
      if (route.request().method() === 'GET') return route.fulfill({ json: view(domain) });
      return store(route, [{ domain, ...route.request().postDataJSON() }], false);
    });
  }
  await context.route(adminUrl('batch'), route => store(route, route.request().postDataJSON(), true));
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  return { page, context, fixture, accepted, errors, requests, failOnce: domain => { failNext = domain; } };
}

async function go(page, route) {
  await page.goto(origin + '/#/' + route);
  await page.locator('#main[data-layout-route="' + route + '"]').waitFor();
}

async function pick(page, field, value) {
  await page.locator('#commerce-' + field + '-picker').click();
  await page.locator('#commerce-' + field + '-popover [role="option"][data-value="' + value + '"]').click();
}

async function confirm(page, write) {
  await page.locator('#confirm-dialog[open]').waitFor();
  return saveTo(page, write, page.locator('#confirm-dialog [data-action="confirm-accept"]'));
}

async function saveTo(page, write, button) {
  const response = page.waitForResponse(entry => entry.request().method() === 'PUT' &&
    new URL(entry.url()).pathname === '/api/local/' + write);
  await button.click();
  return response;
}

async function fillSubscriptionPeriod(page, start = -3, expiry = 3) {
  await page.locator('#commerce-start').fill(priorTime(start));
  await page.locator('#commerce-expiry').fill(priorTime(expiry));
}

test('Gemini 从谷歌邮箱登记并交付，Apple 扣款与库存同批保存，续费沿用原 ID', { timeout: 60_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const { page, fixture, accepted, errors, requests } = await offline(browser);
  await go(page, 'mailboxes/google');
  await page.locator('#main [data-action="inventory-detail"][data-id="' + mailbox.id + '"]').first().click();
  await page.locator('#drawer [data-action="inventory-personal-registration"][data-type="gemini"]').click();
  const editor = page.locator('#drawer #inventory-asset-form');
  await editor.waitFor();
  assert.equal(await editor.locator('#inventory-sourceMailboxId').inputValue(), mailbox.id);
  assert.equal(await editor.locator('#inventory-email').inputValue(), mailbox.email);
  await page.locator('#drawer button[form="inventory-asset-form"][type="submit"]').click();
  assert.equal((await confirm(page, 'inventory')).status(), 200);
  const stock = fixture.inventory.data.accounts.find(row => row.type === 'gemini');
  assert.equal(stock.sourceMailboxId, mailbox.id);
  assert.equal(fixture.inventory.data.mailboxes.find(row => row.id === mailbox.id).inventoryState, 'used');
  assert.equal(fixture.inventory.data.registrationRecords[0].accountId, stock.id);

  await go(page, 'workspace/order/gemini');
  assert.deepEqual(await page.locator('#commerce-businessType option').evaluateAll(options => options.map(option => option.value)),
    ['续费', '成品交付']);
  assert.equal(await page.locator(removedFields).count(), 0);
  await page.locator('#commerce-businessType').selectOption('成品交付');
  await pick(page, 'customerId', customer.id);
  await pick(page, 'emailHistory', stock.id);
  assert.equal(await page.locator('#commerce-email').inputValue(), mailbox.email);
  assert.equal(await page.locator('#commerce-tenantId, #commerce-kyc, #commerce-verifierPhone').count(), 0);
  await page.locator('#commerce-plan').selectOption('Google AI Pro');
  await page.locator('#commerce-proCardSerial').fill('00017');
  await page.locator('#commerce-payment').selectOption('苹果内购');
  assert.equal(await page.locator('#commerce-proCardSerial').isVisible(), false);
  await page.locator('#commerce-appleStoreRegion').selectOption('MY');
  await pick(page, 'appleIdId', wallet.id);
  assert.equal(await page.locator('#commerce-appleGoogleVerified').count(), 0);
  await page.locator('#commerce-paidAmount').fill('15.00');
  await page.locator('#commerce-saleAmount').fill('120');
  await fillSubscriptionPeriod(page);
  const save = page.locator('button[form="commerce-order-form"][type="submit"]');
  const delivery = await saveTo(page, 'batch', save);
  assert.equal(delivery.status(), 200, (await delivery.json()).error);
  const prior = fixture.commerce.data.orders[0];
  assert.equal(prior.accountId, stock.id);
  assert.equal(prior.paidConfirmed, true);
  assert.equal(prior.receiptConfirmed, true);
  assert.equal(prior.entitlementStatus, 'active');
  assert.equal(prior.billingReceipt, undefined);
  assert.equal(prior.proCardSerial, undefined);
  assert.deepEqual(accepted.at(-1).sort(), ['appleBalance', 'commerce', 'inventory']);
  assert.equal(fixture.inventory.data.accounts[0].inventoryState, 'used');
  assert.equal(fixture.appleBalance.data.wallets[0].balance, '15.0000');
  await page.locator('#toast').filter({ hasText: '订单提交成功' }).waitFor();
  await go(page, 'orders/gemini');
  await page.locator('#main [data-action="commerce-order-detail"][data-id="' + prior.id + '"]').click();
  await page.getByRole('button', { name: '查看交付账号' }).waitFor();
  await page.getByRole('button', { name: '查看余额变动' }).waitFor();

  await go(page, 'workspace/order/gemini');
  await page.locator('#commerce-businessType').selectOption('续费');
  await pick(page, 'customerId', customer.id);
  assert.equal(await page.locator('#commerce-email').inputValue(), mailbox.email);
  assert.equal(await page.locator('[data-commerce-field="email"] #commerce-emailHistory-picker').isVisible(), true);
  await pick(page, 'emailHistory', prior.id);
  assert.equal(await page.locator('#commerce-accountId').inputValue(), stock.id);
  assert.equal(await page.locator('#commerce-appleIdId').inputValue(), wallet.id);
  const handoff = page.getByRole('button', { name: '前往续费管理', exact: true });
  await handoff.waitFor();
  await page.locator('#commerce-saleAmount').fill('120');
  await save.click();
  assert.equal(await handoff.evaluate(node => document.activeElement === node), true);
  assert.equal(fixture.commerce.data.orders.length, 1);
  assert.equal(fixture.appleBalance.data.wallets[0].balance, '15.0000');
  fixture.renewals = { version: 1, items: [], candidates: [{
    id: prior.id, version: prior.version, number: prior.orderNo, customer: customer.name,
    account: prior.email, product: prior.product, plan: prior.plan, expiry: prior.expiry, payment: prior.payment
  }] };
  await handoff.click();
  await page.waitForURL('**/#/workspace/renewals');
  const candidate = page.locator('tr[data-row-id="' + prior.id + '"]');
  await candidate.waitFor();
  assert.equal(await candidate.getByRole('checkbox').isChecked(), true);
  await go(page, 'workspace/order/gemini');
  assert.equal(await page.locator('#commerce-saleAmount').inputValue(), '120');
  assert.equal(fixture.commerce.data.orders.length, 1);
  assert.deepEqual(fixture.commerce.data.orders.find(row => row.id === prior.id), prior);
  assert.deepEqual(errors, []);
  assert.deepEqual(requests.external, []);
});

test('Grok 手机录单保留 X 标识、卡序列号、草稿和失败重试', { timeout: 60_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const { page, fixture, errors, requests, failOnce, accepted } = await offline(browser, { width: 390 });
  await go(page, 'workspace/order/grok');
  await toggleDesignTheme(page);
  assert.equal(await page.locator(removedFields).count(), 0);
  assert.equal(await page.locator('[data-commerce-field="loginMethod"], [data-commerce-field="xHandle"], [data-commerce-field="xLinkState"]').count(), 0);
  assert.equal(await page.locator('#commerce-previousSubscriptionOrderId, #commerce-previousAutoRenew').count(), 0);
  assert.equal(await page.locator('[data-commerce-field="email"] #commerce-emailHistory-picker').isVisible(), true);
  await pick(page, 'customerId', customer.id);
  await page.locator('#commerce-email').fill('@draft_account');
  assert.equal(await page.locator('#commerce-loginMethod').inputValue(), 'x');
  await page.locator('#commerce-email').fill('new@example.test');
  assert.equal(await page.locator('#commerce-loginMethod').inputValue(), 'email');
  assert.equal(await page.locator('#commerce-xHandle').inputValue(), '', '改填邮箱后清除前一个手填 X 账号');
  await page.locator('#commerce-plan').selectOption('X Premium');
  await page.locator('#commerce-email').fill('@invalid-handle!');
  await page.locator('button[form="commerce-order-form"][type="submit"]').click();
  assert.match(await page.locator('#commerce-email-error').innerText(), /有效的 X @账号/);
  assert(await page.locator('#commerce-email').evaluate(node => document.activeElement === node), 'X 标识格式有误时定位可见的账号输入框');
  assert.deepEqual(accepted, [], '不完整账号不提交');
  await page.locator('#commerce-email').fill('@fixture_grok');
  await page.locator('#commerce-plan').selectOption('The X Subscription Premium');
  assert.equal(await page.locator('#commerce-payment option[value="苹果内购"]').count(), 0);
  await page.locator('#commerce-proMaterialMode').selectOption('');
  await pick(page, 'cardId', 'recharge:fixture-card');
  assert.equal(await page.locator('#commerce-payment').inputValue(), '银行卡');
  assert.equal(await page.locator('#commerce-appleIdId-picker').isVisible(), false);
  assert.equal(await page.locator('#commerce-loginMethod').inputValue(), 'x');
  assert.equal(await page.locator('#commerce-loginMethod').isVisible(), false);
  assert.equal(await page.locator('#commerce-email').inputValue(), '@fixture_grok');
  await page.locator('#commerce-proCardSerial').fill('00042-G');
  await page.locator('#commerce-paidAmount').fill('9.99');
  await page.locator('#commerce-saleAmount').fill('120');
  await fillSubscriptionPeriod(page);
  assert.equal(await page.locator('[name="commerce-paidConfirmed"], [name="commerce-receiptConfirmed"], #commerce-entitlementStatus').count(), 0);
  await go(page, 'workspace/order/gemini');
  await go(page, 'workspace/order/grok');
  assert.equal(await page.locator('#commerce-email').inputValue(), '@fixture_grok');
  assert.equal(await page.locator('#commerce-proCardSerial').inputValue(), '00042-G');
  assert.equal(await page.locator('#commerce-cardId').inputValue(), 'recharge:fixture-card');
  await settle(page);
  assert.deepEqual((await separatorSnapshot(page)).findings, []);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  failOnce('commerce');
  const save = page.locator('button[form="commerce-order-form"][type="submit"]');
  assert.equal((await saveTo(page, 'commerce', save)).status(), 409);
  await page.locator('#toast').getByText(/合成保存冲突，保留原输入.*本次未保存/).waitFor();
  assert.equal(fixture.commerce.data.orders.length, 0);
  assert.equal(await page.locator('#commerce-proCardSerial').inputValue(), '00042-G');
  const submitted = await saveTo(page, 'commerce', save);
  assert.equal(submitted.status(), 200, (await submitted.json()).error);
  const [order] = fixture.commerce.data.orders;
  assert.equal(order.email, '');
  assert.equal(order.xHandle, '@fixture_grok');
  assert.equal(order.billingChannel, undefined);
  assert.equal(order.proCardSerial, '00042-G');
  assert.equal(order.cardId, 'recharge:fixture-card');
  assert.equal(order.appleIdId, '');
  assert.equal(order.paidConfirmed, true);
  assert.equal(order.receiptConfirmed, true);
  assert.equal(order.entitlementStatus, 'active');
  assert.equal(order.previousSubscriptionOrderId, undefined, '新单不再提交切换前订单');
  assert.equal(order.previousAutoRenew, 'unknown', '沿用默认未核验状态，不新增原订阅关系');
  assert.deepEqual(accepted, [['commerce']]);
  await page.locator('#toast').filter({ hasText: '订单提交成功' }).waitFor();
  await go(page, 'orders/grok');
  await page.locator('#commerce-order-filter-plan').selectOption(order.plan);
  await page.locator('#commerce-order-filter-payment').selectOption('已付款');
  await page.locator('#commerce-search').fill('@FIXTURE_GROK');
  await page.locator('#main [data-action="commerce-order-detail"][data-id="' + order.id + '"]').first().waitFor();
  await page.locator('#main [data-action="commerce-order-detail"][data-id="' + order.id + '"]').first().click();
  await page.getByText('00042-G', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  assert.deepEqual(requests.external, []);
});

test('Grok 编辑和续费沿用已登记账号资料，移除录入控件不清空历史关联', { timeout: 30_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const { page, fixture, errors, requests } = await offline(browser);
  const identity = { email: 'linked@example.test', loginMethod: 'google', xHandle: '@linked_grok', xLinkState: 'linked' };
  const prior = { id: 'linked-grok', orderNo: 'FIXTURE-GROK', product: 'Grok', plan: 'SuperGrok',
    businessType: '续费', customerId: customer.id, ...identity, subscriptionSeries: 'supergrok',
    entitlementStatus: 'active', payment: '银行卡', cardId: 'recharge:fixture-card', paymentId: '0042',
    paidConfirmed: true, receiptConfirmed: true, paidAmount: '9.99', paidCurrency: 'MYR',
    saleAmount: '120', saleCurrency: 'CNY', start: priorTime(-3), expiry: priorTime(3),
    version: 1, source: '管理员手工', refunds: [], bankReturns: [], corrections: [] };
  fixture.commerce.data.orders.push(prior);
  await go(page, 'orders/grok');
  await page.locator('[data-action="commerce-order-edit"][data-id="linked-grok"]').click();
  const form = page.locator('#drawer[open] #commerce-order-form');
  assert.equal(await form.locator('[data-commerce-field="loginMethod"], [data-commerce-field="xHandle"], [data-commerce-field="xLinkState"]').count(), 0);
  await form.locator('#commerce-notes').fill('保留原账号关联');
  const response = await saveTo(page, 'commerce', page.locator('#drawer button[form="commerce-order-form"][type="submit"]'));
  assert.equal(response.status(), 200, (await response.json()).error);
  const updated = fixture.commerce.data.orders.find(row => row.id === prior.id);
  for (const [key, value] of Object.entries(identity)) assert.equal(updated[key], value, key);
  await page.locator('#drawer[open]').waitFor({ state: 'hidden' });
  await go(page, 'workspace/order/renew/linked-grok');
  await page.getByRole('button', { name: '打开续费管理', exact: true }).waitFor();
  assert.equal(await page.locator('#main #commerce-order-form, #drawer[open] #commerce-order-form').count(), 0);
  await go(page, 'workspace/order/grok');
  const renewal = page.locator('#main #commerce-order-form');
  await renewal.locator('#commerce-plan').selectOption('SuperGrok');
  await pick(renewal, 'customerId', customer.id);
  await renewal.locator('#commerce-email').fill('different@example.test');
  assert.equal(await renewal.locator('#commerce-loginMethod').inputValue(), 'email');
  assert.equal(await renewal.locator('#commerce-xHandle').inputValue(), '');
  assert.equal(await renewal.locator('#commerce-xLinkState').inputValue(), 'unknown');
  await renewal.locator('#commerce-emailHistory-picker').click();
  await renewal.locator('#commerce-emailHistory-popover [data-value="linked-grok"]').click();
  for (const [key, value] of Object.entries(identity)) assert.equal(await renewal.locator('#commerce-' + key).inputValue(), value, key);
  await renewal.getByRole('button', { name: '前往续费管理', exact: true }).waitFor();
  assert.deepEqual(errors, []);
  assert.deepEqual(requests.external, []);
});

test('Grok 移除切换前订单录入项后，编辑旧单保留原关联及续费状态', { timeout: 20_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const { page, fixture, errors, requests } = await offline(browser);
  const source = { id: 'source-grok', orderNo: 'FIXTURE-SOURCE', product: 'Grok', plan: 'SuperGrok',
    businessType: '续费', customerId: customer.id, email: '', loginMethod: 'x', xHandle: '@prior_grok',
    xLinkState: 'linked', subscriptionSeries: 'supergrok', entitlementStatus: 'active',
    payment: '银行卡', cardId: 'recharge:fixture-card', paymentId: '0042',
    paidConfirmed: true, receiptConfirmed: true, paidAmount: '9.99', paidCurrency: 'MYR',
    saleAmount: '120', saleCurrency: 'CNY', start: priorTime(-3), expiry: priorTime(3),
    version: 1, source: '管理员手工', refunds: [], bankReturns: [], corrections: [] };
  const switched = { ...source, id: 'switched-grok', orderNo: 'FIXTURE-SWITCHED',
    plan: 'The X Subscription Plus', subscriptionSeries: 'x_subscription',
    previousSubscriptionOrderId: source.id, previousAutoRenew: 'off' };
  fixture.commerce.data.orders.push(source, switched);
  await go(page, 'orders/grok');
  await page.locator('[data-action="commerce-order-edit"][data-id="switched-grok"]').click();
  const form = page.locator('#drawer[open] #commerce-order-form');
  assert.equal(await form.locator('[data-commerce-field="previousSubscriptionOrderId"], [data-commerce-field="previousAutoRenew"]').count(), 0);
  await form.locator('#commerce-notes').fill('仅补充说明，保留历史切换关联');
  const response = await saveTo(page, 'commerce', page.locator('#drawer button[form="commerce-order-form"][type="submit"]'));
  assert.equal(response.status(), 200, (await response.json()).error);
  const saved = fixture.commerce.data.orders.find(row => row.id === switched.id);
  assert.equal(saved.previousSubscriptionOrderId, source.id);
  assert.equal(saved.previousAutoRenew, 'off');
  assert.deepEqual(fixture.commerce.data.orders.find(row => row.id === source.id), source);
  await page.locator('#drawer[open]').waitFor({ state: 'hidden' });
  await page.locator('[data-action="commerce-order-detail"][data-id="switched-grok"]').first().click();
  await page.locator('#drawer[open]').getByText('切换前订单及回款', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  assert.deepEqual(requests.external, []);
});

test('旧 Gemini 首次开通单可更正并保留原账单资料', { timeout: 20_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const { page, fixture, errors, requests } = await offline(browser);
  const bill = { billingChannel: 'web_apple_pay', billingCountry: '马来西亚', billingReceipt: 'legacy-fixture',
    billingCycle: 'month', autoRenew: 'on', nextChargeAt: priorTime(3), platformAccountId: 'legacy-platform' };
  const legacy = { id: 'legacy-gemini', orderNo: 'FIXTURE-1', product: 'Gemini', plan: 'Google AI Plus',
    businessType: '首次开通', customerId: customer.id, email: 'legacy@example.test', loginMethod: 'google',
    subscriptionSeries: 'google_ai', entitlementStatus: 'active', payment: '银行卡',
    cardId: 'recharge:fixture-card', paymentId: '0042', paidConfirmed: true, receiptConfirmed: true,
    paidAmount: '9.99', paidCurrency: 'MYR', saleAmount: '120', saleCurrency: 'CNY',
    start: priorTime(-3), expiry: priorTime(3), version: 1, source: '管理员手工',
    refunds: [], bankReturns: [], corrections: [], ...bill };
  fixture.commerce.data.orders.push(legacy);
  await go(page, 'orders/gemini');
  await page.locator('[data-action="commerce-order-edit"][data-id="' + legacy.id + '"]').click();
  const form = page.locator('#drawer[open] #commerce-order-form');
  assert.equal(await form.locator('#commerce-businessType').inputValue(), '首次开通');
  assert.equal(await form.locator('#commerce-businessType').isEditable(), false);
  assert.equal(await form.locator(removedFields).count(), 0);
  await form.locator('#commerce-notes').fill('补记说明');
  const response = await saveTo(page, 'commerce', page.locator('#drawer button[form="commerce-order-form"][type="submit"]'));
  assert.equal(response.status(), 200, (await response.json()).error);
  const saved = fixture.commerce.data.orders.find(row => row.id === legacy.id);
  assert.equal(saved.notes, '补记说明');
  assert.deepEqual(Object.fromEntries(Object.keys(bill).map(field => [field, saved[field]])), bill);
  await page.locator('#drawer').waitFor({ state: 'hidden' });
  await page.locator('#main [data-action="commerce-order-detail"][data-id="' + legacy.id + '"]').click();
  await page.getByText('legacy-fixture', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  assert.deepEqual(requests.external, []);
});

test('员工可查看两个产品列表，录入及库存修改入口按现有权限拦截', { timeout: 20_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const { page, requests, errors } = await offline(browser, { operator: { id: 'personal-viewer', name: '合成员工', role: 'employee' } });
  for (const product of ['gemini', 'grok']) {
    await go(page, 'accounts/' + product);
    assert.equal(await page.locator('#main [data-action="inventory-add"], #main [data-action="inventory-import"]').count(), 0);
    await go(page, 'orders/' + product);
    assert.equal(await page.locator('#main [data-action="commerce-new-product-order"]').count(), 0);
    assert.equal(await page.locator('#sidebar a[href="#/workspace/order/' + product + '"]').count(), 0);
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(requests.external, []);
});

test('Grok X 账号批量预检、提取和按标识归还保留原批次', { timeout: 30_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const { page, fixture, errors, requests } = await offline(browser);
  await go(page, 'accounts/grok');
  await page.locator('#main [data-action="inventory-import"]').click();
  const form = page.locator('#drawer #inventory-import-form');
  const csv = 'X账号,账号登录方式,X绑定状态,平台账号编号,2FA密钥\n@fixture_stock,X 登录,已绑定,synthetic-platform-11,fixture-not-a-secret';
  await form.locator('#inventory-import-content').fill(csv + '\n@fixture_stock,X 登录,已绑定,,');
  const precheck = page.getByRole('button', { name: '检查并预览', exact: true });
  await precheck.click();
  assert.equal(await page.locator('[data-action="inventory-import-confirm"]').isDisabled(), true);
  assert.equal(fixture.inventory.data.accounts.length, 0);
  await form.locator('#inventory-import-content').fill(csv);
  await precheck.click();
  const preview = page.locator('#inventory-import-results');
  assert.match(await preview.innerText(), /@fixture_stock/);
  assert.doesNotMatch(await preview.innerHTML(), /fixture-not-a-secret/);
  await page.locator('[data-action="inventory-import-confirm"]').click();
  assert.equal((await confirm(page, 'inventory')).status(), 200);
  const asset = fixture.inventory.data.accounts[0];
  assert.equal(asset.email, '');
  assert.equal(asset.xHandle, '@fixture_stock');
  assert.equal(asset.platformAccountId, 'synthetic-platform-11');

  await go(page, 'workspace/account-extract');
  await page.locator('#inventory-extract-type').selectOption('grok');
  await page.locator('#inventory-quantity').fill('1');
  await page.locator('#inventory-extract-form button[type="submit"]').click();
  assert.equal((await confirm(page, 'inventory')).status(), 200);
  const batch = fixture.inventory.data.batches[0];
  assert.equal(batch.items[0].status, 'pending');
  assert.equal(batch.items[0].xHandle, asset.xHandle);
  assert.equal(fixture.inventory.data.accounts[0].inventoryState, 'claimed');
  await page.locator('#main [data-action="inventory-item-return"]').click();
  await page.locator('#drawer button[form="inventory-return-form"][type="submit"]').click();
  assert.equal((await confirm(page, 'inventory')).status(), 200);
  assert.equal(fixture.inventory.data.batches[0].items[0].status, 'returned');
  assert.equal(fixture.inventory.data.returnRecords[0].batchId, batch.id);
  assert.equal(fixture.inventory.data.returnRecords[0].xHandle, asset.xHandle);
  assert.equal(fixture.inventory.data.accounts[0].inventoryState, 'available');
  assert.deepEqual(errors, []);
  assert.deepEqual(requests.external, []);
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';
import { accountLifecycleSummaries, applyAccountOrderLifecycle, checkInventoryRenewals } from '../server/account-lifecycle.mjs';
import { applyInventoryUsage, inspectInventoryUsage } from '../server/inventory-usage.mjs';
import { checkAppleLedger, checkStockDeliveries } from '../server/local-business-integrity.mjs';
import { checkAppleOrder } from '../server/order-policy.mjs';
import { personalOrderError, preparePersonalInventory } from '../server/personal-subscriptions.mjs';
import { interceptDesign, origin, separatorSnapshot, settle } from './helpers/offline-design.mjs';

const actor = { id: 'personal-admin', name: '合成经办员', role: 'admin' };
const customer = { id: 'personal-customer', name: '合成续费客户', active: true };
const mailbox = { id: 'personal-google', email: 'selected@example.test', type: 'google', status: '正常',
  health: 'normal', inventoryState: 'available', usageLinks: [], inventoryHistory: [] };
const wallet = { id: 'personal-apple', email: 'wallet@example.test', type: 'apple', status: '正常',
  health: 'normal', inventoryState: 'available', usageLinks: [], inventoryHistory: [] };
const priorTime = day => new Date(Date.now() + (8 + 24 * day) * 3600000).toISOString().slice(0, 16);
const adminUrl = resource => origin + '/api/local/' + resource;

async function offline(browser, { width = 1440, operator = actor } = {}) {
  const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
  const seed = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  const fixture = {
    settings: seed.settings,
    commerce: { version: 1, data: { customers: [customer], tenants: [], orders: [], operating: [], rentBatches: [], logs: [] } },
    inventory: { version: 1, data: { mailboxes: [mailbox, wallet], accounts: [], batches: [], returnRecords: [],
      importRecords: [], registrationRecords: [], tableSettings: [], undo: [] } },
    appleBalance: { version: 1, data: { wallets: [{ id: wallet.id, currency: 'USD', balance: '30.0000', version: 2 }],
      movements: [{ id: 'fixture-opening', appleIdId: wallet.id, kind: 'manual', amount: '30.0000',
        before: '0.0000', after: '30.0000', versionAfter: 2 }], allocations: [], refunds: [] } },
    'order-cards': { items: [{ id: 'recharge:fixture-card', label: '合成银行卡', last4: '0042', active: true, usageCount: 0 }] }
  };
  const requests = await interceptDesign(context, { localFixtures: fixture, actor: operator });
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
  const response = page.waitForResponse(entry => entry.request().method() === 'PUT' && new URL(entry.url()).pathname === '/api/local/' + write);
  await page.locator('#confirm-dialog [data-action="confirm-accept"]').click();
  return response;
}

async function completeEntitlement(page, start = -3, expiry = 3) {
  await page.locator('#commerce-entitlementStatus').selectOption('active');
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
  await editor.locator('#inventory-source-confirmed').check();
  await page.locator('#drawer button[form="inventory-asset-form"][type="submit"]').click();
  assert.equal((await confirm(page, 'inventory')).status(), 200);
  const stock = fixture.inventory.data.accounts.find(row => row.type === 'gemini');
  assert.equal(stock.sourceMailboxId, mailbox.id);
  assert.equal(fixture.inventory.data.mailboxes.find(row => row.id === mailbox.id).inventoryState, 'used');
  assert.equal(fixture.inventory.data.registrationRecords[0].accountId, stock.id);

  await go(page, 'workspace/order/gemini');
  await page.locator('#commerce-businessType').selectOption('成品交付');
  await pick(page, 'customerId', customer.id);
  await pick(page, 'accountId', stock.id);
  assert.equal(await page.locator('#commerce-email').inputValue(), mailbox.email);
  assert.equal(await page.locator('#commerce-tenantId, #commerce-kyc, #commerce-verifierPhone').count(), 0);
  await page.locator('#commerce-billingChannel').selectOption('app_store');
  await pick(page, 'appleIdId', wallet.id);
  await page.locator('#commerce-appleGoogleVerified').check();
  await page.locator('#commerce-billingCountry').fill('马来西亚');
  await page.locator('#commerce-billingReceipt').fill('gemini-fixture-original');
  await page.locator('#commerce-paidAmount').fill('15.00');
  await page.locator('[name="commerce-paidConfirmed"]').check();
  await completeEntitlement(page);
  await page.locator('button[form="commerce-order-form"][type="submit"]').click();
  assert.equal((await confirm(page, 'batch')).status(), 200);
  const prior = fixture.commerce.data.orders[0];
  assert.equal(prior.accountId, stock.id);
  assert.deepEqual(accepted.at(-1).sort(), ['appleBalance', 'commerce', 'inventory']);
  assert.equal(fixture.inventory.data.accounts[0].inventoryState, 'used');
  assert.equal(fixture.appleBalance.data.wallets[0].balance, '15.0000');
  await page.locator('#main [data-action="commerce-order-detail"][data-id="' + prior.id + '"]').click();
  const details = page.locator('main:visible, #drawer[open]').filter({ hasText: 'gemini-fixture-original' }).first();
  await details.getByRole('button', { name: '查看交付账号' }).waitFor();
  await details.getByRole('button', { name: '查看余额变动' }).waitFor();

  await go(page, 'workspace/order/gemini');
  await page.locator('#commerce-businessType').selectOption('续费');
  await pick(page, 'customerId', customer.id);
  await pick(page, 'personalHistoryId', prior.id);
  assert.equal(await page.locator('#commerce-accountId').inputValue(), stock.id);
  assert.equal(await page.locator('#commerce-appleIdId').inputValue(), wallet.id);
  await page.locator('#commerce-billingReceipt').fill('gemini-fixture-renewal');
  await page.locator('#commerce-paidAmount').fill('20.00');
  await page.locator('[name="commerce-paidConfirmed"]').check();
  await page.locator('button[form="commerce-order-form"][type="submit"]').click();
  await page.getByText(/可保存待核对并保留原账单/).waitFor();
  await page.getByRole('button', { name: '保存待核对', exact: true }).click();
  assert.equal((await confirm(page, 'commerce')).status(), 200);
  const pending = fixture.commerce.data.orders.find(row => row.id !== prior.id);
  assert.equal(pending.previousOrderId, prior.id);
  assert.equal(pending.billingReceipt, 'gemini-fixture-renewal');
  assert.equal(pending.paidConfirmed, false);
  assert.equal(pending.entitlementStatus, 'pending');
  assert.equal(fixture.appleBalance.data.wallets[0].balance, '15.0000');
  await go(page, 'workspace/renewals');
  await page.locator('#commerce-renewal-product').selectOption('Gemini');
  await page.locator('#main [data-action="commerce-renewal-open"][data-id="' + prior.id + '"]').waitFor();
  assert.equal(await page.locator('#main [data-action="commerce-renewal-open"][data-id="' + pending.id + '"]').count(), 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(requests.external, []);
});

test('Grok 手机录单保留 X 标识、网页 Apple Pay、草稿和失败重试', { timeout: 60_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const { page, fixture, errors, requests, failOnce, accepted } = await offline(browser, { width: 390 });
  await go(page, 'workspace/order/grok');
  await page.locator('#theme-toggle').click();
  await pick(page, 'customerId', customer.id);
  await page.locator('#commerce-email').fill('@fixture_grok');
  await page.locator('#commerce-plan').selectOption('The X Subscription Premium');
  await page.locator('#commerce-billingChannel').selectOption('web_apple_pay');
  await pick(page, 'cardId', 'recharge:fixture-card');
  assert.equal(await page.locator('#commerce-payment').inputValue(), '银行卡');
  assert.equal(await page.locator('#commerce-appleIdId-picker').isVisible(), false);
  assert.equal(await page.locator('#commerce-loginMethod').inputValue(), 'x');
  assert.equal(await page.locator('#commerce-email').inputValue(), '@fixture_grok');
  await page.locator('#commerce-billingCountry').fill('马来西亚');
  await page.locator('#commerce-billingReceipt').fill('grok-web-001');
  await page.locator('#commerce-paidAmount').fill('9.99');
  await page.locator('[name="commerce-paidConfirmed"]').check();
  await completeEntitlement(page);
  await go(page, 'workspace/order/gemini');
  await go(page, 'workspace/order/grok');
  assert.equal(await page.locator('#commerce-email').inputValue(), '@fixture_grok');
  assert.equal(await page.locator('#commerce-billingReceipt').inputValue(), 'grok-web-001');
  assert.equal(await page.locator('#commerce-cardId').inputValue(), 'recharge:fixture-card');
  await settle(page);
  assert.deepEqual((await separatorSnapshot(page)).findings, []);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  failOnce('commerce');
  const save = page.locator('button[form="commerce-order-form"][type="submit"]');
  await save.click();
  assert.equal((await confirm(page, 'commerce')).status(), 409);
  assert.equal(fixture.commerce.data.orders.length, 0);
  assert.equal(await page.locator('#commerce-billingReceipt').inputValue(), 'grok-web-001');
  await save.click();
  assert.equal((await confirm(page, 'commerce')).status(), 200);
  const [order] = fixture.commerce.data.orders;
  assert.equal(order.email, '');
  assert.equal(order.xHandle, '@fixture_grok');
  assert.equal(order.billingChannel, 'web_apple_pay');
  assert.equal(order.cardId, 'recharge:fixture-card');
  assert.equal(order.appleIdId, '');
  assert.deepEqual(accepted, [['commerce']]);
  await page.locator('#commerce-order-filter-plan').selectOption(order.plan);
  await page.locator('#commerce-order-filter-payment').selectOption('已付款');
  await page.locator('#commerce-search').fill('@FIXTURE_GROK');
  await page.locator('#main [data-action="commerce-order-detail"][data-id="' + order.id + '"]').first().waitFor();
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

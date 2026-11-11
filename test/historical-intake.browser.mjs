import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
const runtime = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
const { chromium } = await import(runtime ? pathToFileURL(runtime).href : 'playwright');
import { interceptDesign, origin, settle } from './helpers/offline-design.mjs';
import { planHistoricalIntake, historicalIntakePreview, requireHistoricalIntake, stageHistoricalIntake } from '../server/apple-relay/historical-intake.mjs';
import { applyInventoryUsage, inspectInventoryUsage } from '../server/inventory-usage.mjs';
import { accountLifecycleSummaries, applyAccountOrderLifecycle } from '../server/account-lifecycle.mjs';
import { checkInventoryEntryFields } from '../server/inventory-entry-fields.mjs';

const actor = { id: 'fixture-admin', name: '合成管理员', role: 'super' };
const customer = { id: 'fixture-customer', name: '合成旧客户', wechat: 'fixture-wechat', active: true };
const fixture = async () => JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));

test('Claude Pro 和 Max 通过实际表单保存独立空邮箱订单', { timeout: 30_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const local = await fixture();
  local.commerce.data.customers = [customer];
  local.commerce.data.orders = [];
  const requests = await interceptDesign(context, { localFixtures: local, actor });
  await context.route(origin + '/api/local/auth/order-owners', route => route.fulfill({ json: { items: [actor] } }));
  const saved = [];
  await context.route(origin + '/api/local/commerce', route => {
    if (route.request().method() === 'GET') return route.fallback();
    const input = route.request().postDataJSON();
    const order = input.data.orders.find(row => !local.commerce.data.orders.some(prior => prior.id === row.id));
    saved.push(order);
    local.commerce = { version: input.version + 1, data: input.data };
    return route.fulfill({ json: local.commerce });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  for (const [product, path] of [['Claude Pro', 'pro'], ['Claude Max', 'max']]) {
    await page.goto(origin + '/#/workspace/order/claude');
    await page.locator('#commerce-product').selectOption(product);
    const email = page.locator('#commerce-email');
    assert.equal(await email.getAttribute('aria-required'), 'false');
    await page.locator('#commerce-businessType').selectOption('成品交付');
    assert.equal(await email.getAttribute('aria-required'), 'true');
    await page.locator('#commerce-businessType').selectOption('续费');
    await page.locator('#commerce-customerId-picker').click();
    await page.locator('#commerce-customerId-popover [data-value="fixture-customer"]').click();
    if (product === 'Claude Pro') await page.locator('#commerce-proMaterialMode').selectOption('none');
    await page.locator('#commerce-start').fill('2025-02-01T09:12');
    await page.locator('#commerce-expiry').fill('2025-03-01T09:12');
    await email.fill('');
    await page.locator('#commerce-saleAmount').fill('');
    await page.locator('#commerce-paidAmount').fill('');
    await page.getByRole('button', { name: '保留待补全', exact: true }).click();
    await page.locator('#confirm-dialog [data-action="confirm-accept"]').click();
    await page.waitForURL(origin + '/#/orders/' + path);
    const order = saved.at(-1);
    assert.equal(order.product, product);
    assert.equal(order.email, '');
    assert.equal(order.customerId, customer.id);
    assert.equal(order.accountId, '');
    await page.locator(`[data-action="commerce-order-detail"][data-id="${order.id}"]`).first().click();
    assert.equal(await page.getByRole('tab', { name: '同账号订单', exact: true }).count(), 0);
    assert.equal(await page.getByText('账号待补充', { exact: false }).count(), 0);
  }
  assert.equal(new Set(saved.map(row => row.id)).size, 2);
  for (const order of local.commerce.data.orders) {
    order.paidConfirmed = true;
    order.paidAmount = '21';
  }
  local.commerce.data.orders.push({ ...local.commerce.data.orders.find(row => row.id === saved[0].id),
    id: 'tracked-claude', orderNo: 'QA-TRACKED', email: 'tracked@example.test' });
  await page.goto(origin + '/#/workspace/renewals');
  await page.reload();
  await page.getByRole('tab', { name: /^已到期/ }).click();
  await page.getByText('tracked@example.test', { exact: true }).first().waitFor();
  for (const order of saved) assert.equal(await page.getByText(order.orderNo, { exact: true }).count(), 0);
  await page.goto(origin + '/#/orders/exclusive');
  await page.getByText('tracked@example.test', { exact: true }).first().waitFor();
  assert.equal(await page.evaluate(() => window.IDDesignAPI.modules.commerce.getCurrentSubscription('')), null);
  assert.deepEqual(errors, []);
  assert.deepEqual(requests.external, []);
});

test('隐藏邮箱历史入库预检、冲突保留输入和刷新回读', { timeout: 30_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const local = await fixture();
  const parent = local.inventory.data.appleRelay.parents[0];
  const enteredCredentials = { password: 'offline-password-fixture', totp: 'OFFLINE-2FA-FIXTURE' };
  local.inventory.data.appleRelay.parents = [parent];
  local.inventory.data.mailboxes = [];
  local.inventory.data.accounts = [{ id: 'normal-account', email: 'available@example.test', type: 'gpt',
    health: 'normal', status: '正常', inventoryState: 'available', usageLinks: [] }];
  local.commerce.data.customers = [customer];
  local.commerce.data.orders = [];
  const requests = await interceptDesign(context, { localFixtures: local, actor });
  await context.route(origin + '/api/local/apple-relay/status', route =>
    route.fulfill({ json: { configured: true, parentIds: [parent.id], aliasIds: [] } }));
  const relay = origin + '/api/local/apple-relay/alias-intake-';
  await context.route(relay + 'preview', route => route.fulfill({ json: historicalIntakePreview(
    planHistoricalIntake(route.request().postDataJSON(), local.inventory, local.commerce)) }));
  let writes = 0;
  await context.route(relay + 'confirm', route => {
    writes += 1;
    if (writes === 1) return route.fulfill({ status: 409, json: { error: '合成资料版本冲突，请重新预检' } });
    const input = route.request().postDataJSON();
    const plan = planHistoricalIntake(input, local.inventory, local.commerce);
    requireHistoricalIntake(plan, input);
    const next = structuredClone(local.inventory.data);
    next.mailboxes = plan.pending.map((row, index) => ({ id: `history-alias-${index}`, email: row.email,
      type: 'relay', parentMailboxId: parent.id, relayStatus: 'ACTIVE', inventoryState: 'available', usageLinks: [] }));
    const priorCommerce = local.commerce.data;
    const nextCommerce = structuredClone(priorCommerce);
    const clock = new Date();
    const staged = stageHistoricalIntake(plan, next, nextCommerce, actor, clock.toISOString());
    applyInventoryUsage(inspectInventoryUsage(next, nextCommerce), actor, clock);
    applyAccountOrderLifecycle(priorCommerce, nextCommerce, next, actor, clock);
    staged.orders[0].orderNo = 'QA-HISTORY-01';
    local.inventory = { version: local.inventory.version + 1, data: next, accountSummaries: accountLifecycleSummaries(next, nextCommerce) };
    local.commerce = { version: local.commerce.version + 1, data: nextCommerce };
    return route.fulfill({ json: { inventory: local.inventory, processed: plan.pending.length, reused: 0,
      accountsCreated: staged.accountsCreated, ordersCreated: staged.orders.length } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/#/mailboxes/relay');
  await page.getByRole('tab', { name: '隐藏邮箱管理', exact: true }).click();
  await page.getByRole('button', { name: '历史入库', exact: true }).click();
  const editor = page.locator('#relay-intake-content');
  const header = (await editor.inputValue()).trimEnd();
  const content = header + '\nsold@example.test\t2025/1/12\tfixture-wechat\tPlus\t2025/2/1 12:34\t2025/3/1 12:34\t银行卡\t合成来源\nregistered@example.test\t2025/1/18';
  await editor.fill(content);
  const preview = page.getByRole('button', { name: '预检资料', exact: true });
  const pending = page.locator('#relay-intake-preview').getByText('新增待补全订单');
  await preview.click();
  await pending.waitFor();
  await editor.fill(content + '\t合成更改');
  await page.locator('button[form="relay-intake-form"][type="submit"]').click();
  assert.equal(writes, 0);
  assert.equal(await page.locator('#confirm-dialog[open]').count(), 0);
  await editor.fill(content);
  await page.setViewportSize({ width: 390, height: 900 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await preview.click();
  await pending.waitFor();
  await settle(page);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  const confirm = async () => {
    await page.locator('button[form="relay-intake-form"][type="submit"]').click();
    await page.locator('#confirm-dialog [data-action="confirm-accept"]').click();
  };
  await confirm();
  await page.getByText('合成资料版本冲突，请重新预检', { exact: true }).waitFor();
  assert.equal(await editor.inputValue(), content);
  await preview.click();
  await pending.waitFor();
  await confirm();
  await page.locator('#drawer[open]').waitFor({ state: 'hidden' });
  assert.equal(writes, 2);
  await page.reload();
  await page.getByRole('tab', { name: '隐藏邮箱管理', exact: true }).click();
  for (const address of ['sold@example.test', 'registered@example.test']) {
    const row = page.getByRole('row').filter({ hasText: address });
    await row.getByText('已实际使用', { exact: true }).waitFor();
    await row.getByText('已登记注册', { exact: true }).waitFor();
  }
  assert.equal(local.commerce.data.orders.length, 1);
  await page.goto(origin + '/#/accounts/gpt');
  const registeredRow = page.getByRole('row').filter({ hasText: 'registered@example.test' });
  await registeredRow.locator('[data-column="status"]').getByText('正常', { exact: true }).waitFor();
  await registeredRow.locator('[data-column="source"]').getByText('自己注册', { exact: true }).waitFor();
  for (const field of ['password', 'totp'])
    assert.equal(await registeredRow.locator(`[data-column="${field}"]`).textContent(), '未录入');

  let edits = 0;
  await context.route(origin + '/api/local/inventory', route => {
    if (route.request().method() !== 'PUT') return route.fallback();
    const input = route.request().postDataJSON();
    assert.equal(input.version, local.inventory.version);
    assert.equal(input.action, 'inventory_edit');
    assert.equal(checkInventoryEntryFields(local.inventory.data, input.data, input.action), undefined);
    const edited = input.data.accounts.find(row => row.email === 'registered@example.test');
    assert.equal(edited.password, enteredCredentials.password);
    assert.equal(edited.totp, enteredCredentials.totp);
    edits++;
    local.inventory = { ...local.inventory, version: input.version + 1, data: input.data };
    return route.fulfill({ json: local.inventory });
  });
  await page.setViewportSize({ width: 1440, height: 900 });
  await registeredRow.getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('#inventory-password').fill(enteredCredentials.password);
  await page.locator('#inventory-totp').fill(enteredCredentials.totp);
  await page.locator('button[form="inventory-asset-form"][type="submit"]').click();
  await page.locator('#confirm-dialog [data-action="confirm-accept"]').click();
  await page.locator('#drawer[open]').waitFor({ state: 'hidden' });
  assert.equal(edits, 1);

  const releaseRead = Promise.withResolvers();
  t.after(releaseRead.resolve);
  let inventoryReads = 0;
  await page.route(origin + '/api/local/inventory', async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    inventoryReads++;
    await releaseRead.promise;
    return route.fulfill({ json: local.inventory });
  });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText('正在读取本机库存', { exact: true }).waitFor();
  assert.equal(await registeredRow.count(), 0, '库存回执前不把空白显示成账号数据');
  releaseRead.resolve();
  await registeredRow.waitFor();
  const displayed = await registeredRow.evaluate(row => ({
    password: row.querySelector('[data-column="password"]').textContent,
    totp: row.querySelector('[data-column="totp"]').textContent
  }));
  assert.deepEqual(displayed, enteredCredentials, '同一批读取结果同时回显已保存的两项资料');
  assert.equal(inventoryReads, 1);
  await page.getByRole('tab', { name: /^已使用/ }).click();
  await page.getByRole('row').filter({ hasText: 'sold@example.test' }).getByText('合成旧客户', { exact: true }).waitFor();
  await page.goto(origin + '/#/orders/gpt');
  const order = page.getByRole('row').filter({ hasText: 'QA-HISTORY-01' });
  await order.getByText('2025-03-01T12:34', { exact: true }).waitFor();
  await order.getByText('待补全', { exact: true }).first().waitFor();
  await page.goto(origin + '/#/workspace/order/gpt');
  await page.locator('#commerce-businessType').selectOption('成品交付');
  await page.locator('#commerce-emailHistory option[value="available@example.test"]').waitFor({ state: 'attached' });
  assert.equal(await page.locator('#commerce-emailHistory option[value="registered@example.test"]').count(), 1);
  assert.equal(await page.locator('#commerce-emailHistory option[value="sold@example.test"]').count(), 0);
  assert.deepEqual(errors, []);
  assert.deepEqual(requests.external, []);
});

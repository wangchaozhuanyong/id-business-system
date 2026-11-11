import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
const runtime = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
const { chromium } = await import(runtime ? pathToFileURL(runtime).href : 'playwright');
import { accountLifecycleSummaries } from '../server/account-lifecycle.mjs';
import {
  claudeHistoricalSales, claudeHistoryPreview, planClaudeHistoryIntake, recordClaudeHistoricalSale, stageClaudeHistoryIntake
} from '../server/claude-history-intake.mjs';
import { projectSubscriptions } from '../server/subscription-management.mjs';
import { fillManualOrderDetails } from '../server/order-completion.mjs';
import { interceptDesign, origin, separatorSnapshot, toggleDesignTheme } from './helpers/offline-design.mjs';

const actor = { id: 'fixture-admin', name: '合成管理员', role: 'super' };
const at = new Date('2026-11-10T08:00:00Z');
const historyRows = [
  ['ready-history@example.test', '已开通', '', 'Max 20x', '2026-10-31 22:00', '2026-11-30 22:00', '马来西亚']
];

test('Claude 账号历史入口预检、冲突重试、保存和刷新回读', { timeout: 30_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const local = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  local.inventory.data.accounts = [];
  local.inventory.data.importRecords = [];
  local.commerce.data.orders = [];
  const requests = await interceptDesign(context, { localFixtures: local, actor, skipRechargeAssets: true });
  await context.route(origin + '/api/local/subscriptions/list', route => {
    const input = route.request().postDataJSON();
    const all = projectSubscriptions({ inventory: local.inventory, commerce: local.commerce,
      mailboxes: { version: 0, data: { items: [] } }, subscriptions: { version: 0, data: {} } }, at.getTime())
      .filter(row => row.product === input.product).map(({ _account, _records, ...row }) => row);
    const rows = all.filter(row => row.scope === input.scope);
    const counts = Object.fromEntries(['active', 'expired', 'pending', 'ended'].map(status =>
      [status, rows.filter(row => row.status === status).length]));
    return route.fulfill({ json: { items: rows, total: rows.length, accountCount: rows.length, counts, page: 1,
      pageSize: input.pageSize, revision: 'fixture-' + local.inventory.version, now: at.toISOString() } });
  });
  let confirmations = 0;
  await context.route(origin + '/api/local/claude-history-intake', route => {
    const { mode, ...input } = route.request().postDataJSON();
    const plan = planClaudeHistoryIntake(input, local.inventory, local.commerce, at.getTime());
    if (mode === 'preview') return route.fulfill({ json: claudeHistoryPreview(plan) });
    confirmations++;
    if (confirmations === 1) {
      local.inventory.version++;
      return route.fulfill({ status: 409, json: { error: '库存已变化' } });
    }
    const data = structuredClone(local.inventory.data);
    const result = stageClaudeHistoryIntake(plan, input.inventoryVersion, data, actor, at);
    local.inventory = { version: local.inventory.version + 1, data,
      accountSummaries: accountLifecycleSummaries(data, local.commerce.data) };
    return route.fulfill({ json: { ...result, inventory: local.inventory } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/#/subscriptions/claude');
  assert.equal(await page.getByRole('tab', { name: '客户订阅', exact: true }).getAttribute('aria-selected'), 'true');
  const open = page.getByRole('button', { name: '订阅历史入库', exact: true });
  await open.click();
  const content = page.locator('#inventory-claude-history-content');
  const header = (await content.inputValue()).trim();
  const input = header + '\n' + historyRows.map(row => row.join('\t')).join('\n');
  const preview = page.getByRole('button', { name: '预检资料', exact: true });
  const submit = page.getByRole('button', { name: '确认入库', exact: true });
  const confirm = () => page.locator('#confirm-dialog [data-action="confirm-accept"]').click();
  await content.fill(input);
  await preview.click();
  await page.locator('#inventory-claude-history-review').getByText('已开通', { exact: true }).waitFor();
  await content.fill(input + '\n');
  assert.equal(await submit.isDisabled(), true);
  await content.fill(input);
  await preview.click();
  await submit.click();
  await confirm();
  await page.getByText('库存已变化，请重新预检', { exact: true }).waitFor();
  assert.equal(await content.inputValue(), input);
  assert.equal(local.inventory.data.accounts.length, 0);
  await preview.click();
  await submit.click();
  await confirm();
  await page.locator('#drawer').waitFor({ state: 'hidden' });
  assert.equal(local.inventory.data.accounts.length, 1);
  assert.equal(confirmations, 2);
  assert.equal(local.commerce.data.orders.length, 0);

  await page.getByRole('tab', { name: '自有账号', exact: true }).click();
  await page.locator('#subscription-list').getByText('ready-history@example.test', { exact: true }).first().waitFor();
  await page.locator('#subscription-list').getByText('2026-11-30 22:00', { exact: true }).waitFor();
  await page.goto(origin + '/#/orders/claude');
  await page.getByText('暂无 Claude 订单', { exact: true }).waitFor();
  assert.equal(await page.locator('[data-table="commerce-orders-Claude"] tbody tr[data-row-id]').count(), 0);
  await page.getByRole('button', { name: '查看 Claude 订阅', exact: true }).click();
  await page.locator('#subscription-list').getByText('ready-history@example.test', { exact: true }).first().waitFor();
  // A pre-fix persisted record can still have an available flag.
  Object.assign(local.inventory.data.accounts[0], { inventoryState: 'available', used: false, status: '正常' });
  await page.goto(origin + '/#/accounts/claude');
  const used = page.getByRole('tab', { name: /^已使用/ });
  assert.match(await used.innerText(), /1/);
  await used.click();
  await page.getByText('ready-history@example.test', { exact: true }).first().waitFor();
  await page.getByRole('tab', { name: /^可用库存/ }).click();
  await page.locator('#main [data-page-region="accounts/claude"]')
    .getByText('ready-history@example.test', { exact: true }).waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#main').getByText('历史套餐', { exact: true }).count(), 0);
  const accountOpen = page.getByRole('button', { name: '历史账号入库', exact: true });
  await accountOpen.click();
  const accountHeader = (await content.inputValue()).trim();
  const accountInput = accountHeader + '\n' + [
    ['aging-history@example.test', '养号中', '2026-10-29'],
    ['dead-history@example.test', '死号', '']
  ].map(row => row.join('\t')).join('\n');
  await content.fill(accountInput);
  await preview.click();
  await page.locator('#inventory-claude-history-review').getByText('死号', { exact: true }).waitFor();
  assert.equal(await page.locator('#inventory-claude-history-review').getByText('到期时间', { exact: true }).count(), 0);
  await submit.click();
  await confirm();
  await page.locator('#drawer').waitFor({ state: 'hidden' });
  assert.equal(local.inventory.data.accounts.length, 3);
  await page.getByRole('tab', { name: /^死号/ }).click();
  await page.locator('#main').getByText('dead-history@example.test', { exact: true }).first().waitFor();
  assert.equal(await page.locator('#main').getByText('ready-history@example.test', { exact: true }).count(), 0);

  await page.setViewportSize({ width: 390, height: 844 });
  const mobileActions = page.locator('#main [data-action="mobile-list-actions"]:visible').first();
  await mobileActions.click();
  await page.getByRole('menuitem', { name: '历史账号入库', exact: true }).click();
  await content.fill(accountInput);
  await preview.click();
  const review = page.locator('#inventory-claude-history-review');
  await review.locator('[data-action="table-mobile-toggle"]').first().click();
  await review.getByText('已登记', { exact: true }).first().waitFor();
  assert.equal(await submit.isDisabled(), true);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth), true);
  assert.deepEqual(errors, []);
  assert.deepEqual(requests.external, []);
});

test('Claude 订单补录复用原账号，保留租户并在订阅显示来源订单', { timeout: 30_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const email = 'sold-history@example.test';
  const account = { id: 'historical-account', type: 'claude', email, emailType: 'google',
    inventoryState: 'used', status: '正常', health: 'normal',
    claudeHistory: { phase: 'opened', plan: 'Max 20x', start: '2026-10-31', expiry: '2026-11-30T22:00' } };
  const tenant = { id: 'supplier', name: '合成出租方', active: true };
  for (const [width, theme] of [[1440, 'light'], [390, 'dark']]) {
    const local = {
      inventory: { version: 1, data: { accounts: [account], mailboxes: [{ id: 'mailbox', email, type: 'google' }] } },
      commerce: { version: 1, data: { orders: [], customers: [], tenants: [tenant], logs: [] } }
    };
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const requests = await interceptDesign(context, { localFixtures: local, actor, skipRechargeAssets: true });
    await context.route(origin + '/api/local/claude-history-intake', route => {
      const { mode, ...input } = route.request().postDataJSON();
      if (mode === 'sales-candidates') return route.fulfill({ json: claudeHistoricalSales(local.inventory, local.commerce, at.getTime()) });
      assert.equal(mode, 'record-sale');
      const { order, created } = recordClaudeHistoricalSale(input, local.inventory, local.commerce, actor, at);
      assert.equal(created, true);
      local.commerce.data.orders.push(order);
      local.commerce.version++;
      return route.fulfill({ json: { orderId: order.id, orderNo: order.orderNo, created, version: local.commerce.version } });
    });
    await context.route(origin + '/api/local/order-completion', route => {
      assert.equal(route.request().method(), 'POST');
      const { order } = fillManualOrderDetails(local.commerce.data, local.inventory.data, actor,
        route.request().postDataJSON(), at.toISOString());
      local.commerce.data.orders = [order];
      local.commerce.version++;
      return route.fulfill({ json: { orderId: order.id, version: local.commerce.version } });
    });
    await context.route(origin + '/api/local/subscriptions/list', route => {
      const input = route.request().postDataJSON();
      const items = projectSubscriptions({ inventory: local.inventory, commerce: local.commerce,
        mailboxes: { data: { items: [] } } }, at.getTime()).filter(row => row.scope === input.scope)
        .map(({ _account, _records, ...row }) => row);
      return route.fulfill({ json: { items, total: items.length, accountCount: items.length, counts: { pending: items.length },
        page: 1, pageSize: input.pageSize, revision: 'fixture-' + local.commerce.version, now: at.toISOString() } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/#/orders/claude');
    await page.getByText('暂无 Claude 订单', { exact: true }).waitFor();
    if (theme === 'dark') await toggleDesignTheme(page);
    assert.deepEqual((await separatorSnapshot(page)).findings, []);
    const action = page.getByRole('button', { name: '补录历史销售', exact: true });
    if (await action.isVisible()) await action.click();
    else {
      await page.locator('#main [data-action="mobile-list-actions"]:visible').first().click();
      await page.getByRole('menuitem', { name: '补录历史销售', exact: true }).click();
    }
    const drawer = page.getByRole('dialog', { name: '补录 Claude 历史销售' });
    const titleHelp = drawer.locator('.drawer-title-row .title-help');
    const help = titleHelp.locator('summary');
    assert.equal(await titleHelp.getAttribute('open'), null);
    const bounds = await help.boundingBox();
    const titleBounds = await drawer.locator('#drawer-title').boundingBox();
    assert.ok(bounds.x >= titleBounds.x + titleBounds.width - 1 && Math.abs(bounds.y + bounds.height / 2 -
      titleBounds.y - titleBounds.height / 2) < 4);
    if (width < 600) assert.ok(bounds.width >= 44 && bounds.height >= 44);
    const form = drawer.locator('#commerce-claude-historical-sale-form');
    const before = await form.boundingBox();
    await help.click();
    assert.notEqual(await titleHelp.getAttribute('open'), null);
    const after = await form.boundingBox();
    assert.ok(Math.abs(before.y - after.y) < 1);
    await help.press('Escape');
    assert.equal(await titleHelp.getAttribute('open'), null);
    await drawer.getByLabel(/历史账号/).selectOption(account.id);
    await drawer.getByRole('combobox', { name: '租户*', exact: true }).selectOption(tenant.id);
    await drawer.getByLabel(/原开通方式/).selectOption('银行卡');
    await drawer.getByLabel(/^售价\*?$/).fill('1500');
    await drawer.getByRole('button', { name: '保存历史订单', exact: true }).click();
    await drawer.waitFor({ state: 'hidden' });
    const [order] = local.commerce.data.orders;
    assert.deepEqual([order.tenantId, order.customerId, order.actualCostAmount], [tenant.id, '', '']);
    assert.equal(order.start, '2026-10-31');
    const orderRow = page.locator(`[data-table="commerce-orders-Claude"] tbody tr[data-row-id="${order.id}"]`);
    await orderRow.waitFor();
    const number = orderRow.getByText(order.orderNo, { exact: true });
    if (!(await number.isVisible())) await orderRow.getByRole('button', { name: '更多资料', exact: true }).click();
    await number.waitFor();
    const detail = page.getByRole('dialog', { name: '订单详情', exact: true });
    const detailValue = name => detail.locator('.property-row')
      .filter({ has: page.getByText(name, { exact: true }) }).locator('strong');
    await orderRow.getByRole('button', { name: '详情', exact: true }).click();
    await detail.getByRole('button', { name: '补齐资料', exact: true }).click();
    const completion = page.getByRole('dialog', { name: '补齐原单资料', exact: true });
    await completion.getByLabel('实际总成本（退回前）', { exact: true }).fill('1350');
    await completion.getByLabel('成本核对依据', { exact: true }).fill('按原销售凭据核对');
    await completion.getByRole('button', { name: '保存到原单', exact: true }).click();
    await completion.waitFor({ state: 'hidden' });
    await detail.getByRole('tab', { name: '成本与汇率', exact: true }).click();
    assert.equal(await detailValue('原成本合计').textContent(), '1350.00 人民币 CNY');
    assert.equal(await detailValue('本单核算收益').textContent(), '待核算');
    const [updated] = local.commerce.data.orders;
    assert.deepEqual([updated.id, updated.actualCostAmount, updated.customerId, updated.paidAmount, updated.receiptConfirmed],
      [order.id, '1350', '', '', false]);
    await detail.getByRole('button', { name: '补齐资料', exact: true }).click();
    const fullReceipt = completion.getByRole('checkbox', { name: /已按原售价全额收款/ });
    assert.equal(await fullReceipt.isChecked(), false);
    await fullReceipt.check();
    await completion.getByRole('button', { name: '保存到原单', exact: true }).click();
    await completion.waitFor({ state: 'hidden' });
    await detail.getByRole('tab', { name: '成本与汇率', exact: true }).click();
    assert.equal(await detailValue('客户实收（退款前）').textContent(), '1500.00 人民币 CNY');
    assert.equal(await detailValue('本单核算收益').textContent(), '150.00 人民币 CNY');
    assert.equal(await detailValue('核算缺口').textContent(), '已确认');
    assert.equal(await detailValue('代付金额').textContent(), '未登记');
    await detail.getByText('本次按原币核算', { exact: true }).waitFor();
    const [received] = local.commerce.data.orders;
    assert.deepEqual([received.id, received.actualCostAmount, received.customerId, received.paidAmount, received.receiptConfirmed],
      [order.id, '1350', '', '', true]);
    await detail.getByRole('button', { name: '关闭抽屉', exact: true }).click();
    assert.equal(await orderRow.locator('[data-column="profit"]').textContent(), '150.00');
    await page.goto(origin + '/#/orders/statistics');
    await page.getByLabel('开通起日', { exact: true }).fill('2026-10-31');
    await page.getByLabel('开通止日', { exact: true }).fill('2026-10-31');
    const total = page.locator('#main [data-stat-metric="actual-profit"] .summary-number');
    assert.match(await total.textContent(), /^150\.00/);
    await page.getByLabel('统计币种', { exact: true }).selectOption('MYR');
    assert.equal(await total.textContent(), '—');
    await page.getByRole('tab', { name: '待核算', exact: true }).click();
    const missing = page.locator(`[data-table="commerce-stat-detail"] tr[data-row-id="${order.id}"] [data-column="reason"]`);
    assert.match(await missing.textContent(), /订单缺少有效汇率快照/);
    assert.doesNotMatch(await missing.textContent(), /代付结果待确认/);
    await page.goto(origin + '/#/subscriptions/claude');
    await page.getByRole('tab', { name: '客户订阅', exact: true }).click();
    const row = page.locator('#subscription-list tbody tr').filter({ hasText: email });
    await row.waitFor();
    assert.equal(await row.getByText('待确认', { exact: true }).count(), 1);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    assert.deepEqual(errors, []);
    assert.deepEqual(requests.external, []);
    await context.close();
  }
});

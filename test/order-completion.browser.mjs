import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { applyOrderCompletion, assignMissingManualOrderOwners, fillManualOrderDetails,
  readOrderCompletion, rechargePriceSnapshot } from '../server/order-completion.mjs';
import { interceptDesign, origin, settle, spacingSnapshot, toggleDesignTheme } from './helpers/offline-design.mjs';

const playwright = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
const { chromium } = await import(playwright ? pathToFileURL(playwright).href : 'playwright');
const path = '/api/local/order-completion';
const route = 'workspace/order-completion';
const now = '2026-11-10T06:40:00.000Z';
const a = { id: 'staff-a', name: '员工甲', role: 'employee' };
const b = { id: 'staff-b', name: '员工乙', role: 'employee' };
const admin = { id: 'admin', name: '管理员', role: 'admin' };
const superAdmin = { id: 'primary', name: '合成超级管理员', role: 'super' };
const owners = () => [a, b, admin, superAdmin];
const settings = { customerSources: ['网站', '客户推荐'], orderPrices: { GPT: { Plus: { CNY: '140.00' } } },
  gptPaidPrices: { Plus: { PHP: '100' } } };
const price = rechargePriceSnapshot({ version: 2, data: settings }, 'Plus', now);
function auto(id, owner) {
  return {
    id, orderNo: 'SYN-' + id, version: 1, source: '线上代充', taskId: 'job-' + id, product: 'GPT', plan: 'Plus',
    email: id + '@example.test', businessType: '续费', accountSource: '客户自有',
    start: '2026-11-10T14:40', expiry: '2026-12-10T14:40', rechargeCompletedAt: now, createdAt: now,
    entitlementStatus: 'active',
    rechargeOwnerId: owner, createdById: owner, createdBy: '自动充值', customerId: '', notes: '',
    saleAmount: price.saleAmount, saleCurrency: price.saleCurrency, rechargePriceSnapshot: price,
    paidAmount: '101', paidCurrency: 'PHP', paidConfirmed: true, receiptConfirmed: false, payment: '银行卡',
    refunds: [], bankReturns: [], corrections: []
  };
}
function model() {
  const commerce = { version: 1, data: {
    orders: [auto('own', a.id), auto('other', b.id), auto('unassigned', '')],
    customers: [{ id: 'known', name: '已有测试客户', phone: '123456', active: true, version: 1 }],
    logs: [], tenants: [], operating: [], rentBatches: []
  } };
  return { commerce, settings: { version: 2, data: settings } };
}

async function open(t, browser, model, actor, width, theme) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  t.after(() => context.close());
  const traffic = await interceptDesign(context, { localFixtures: model, actor });
  const writes = [];
  await context.route((url) => url.pathname === path, async (route) => {
    try {
      const request = route.request();
      const data = model.commerce.data;
      if (request.method() === 'GET')
        return route.fulfill({ json: readOrderCompletion(data, settings, actor, new URL(request.url()).searchParams, owners) });
      const command = request.postDataJSON();
      writes.push(command);
      if (command.action === 'assign-manual-owners') {
        const orders = assignMissingManualOrderOwners(data, actor, command, owners, now);
        data.orders = data.orders.map(row => orders.find(order => order.id === row.id) || row);
        return route.fulfill({ json: { assigned: orders.length, version: ++model.commerce.version } });
      }
      const { order, customer, createdCustomer, completion } = command.action === 'fill-manual-details'
        ? fillManualOrderDetails(data, model.inventory?.data, actor, command, now)
        : applyOrderCompletion(data, settings, actor, command, owners, now);
      data.orders = data.orders.map((row) => row.id === order.id ? order : row);
      if (customer) {
        data.customers = createdCustomer ? [customer, ...data.customers]
          : data.customers.map((row) => row.id === customer.id ? customer : row);
      }
      return route.fulfill({ json: { orderId: order.id, version: ++model.commerce.version, state: completion?.state } });
    } catch (error) {
      return route.fulfill({ status: error.status || 500, json: { error: error.message } });
    }
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.setDefaultTimeout(5000);
  await page.goto(origin + '/#/' + route);
  if (theme === 'dark') await toggleDesignTheme(page);
  await page.locator('table[data-table="订单补全"]').waitFor();
  return { page, errors, traffic, writes, drawer: page.locator('#drawer[open]') };
}

async function checkLayout(page, drawer) {
  await settle(page);
  const { findings } = await spacingSnapshot(page);
  assert.deepEqual(findings, []);
  const geometry = await drawer.evaluate((panel) => {
    const body = panel.querySelector('.drawer-body');
    const footer = panel.querySelector('.drawer-footer');
    const label = body.querySelector('.field > label')?.getBoundingClientRect();
    const input = body.querySelector('.field .field-control')?.getBoundingClientRect();
    const buttons = Array.from(footer.querySelectorAll('button')).map((node) => node.getBoundingClientRect());
    const { left, right } = panel.getBoundingClientRect();
    return {
      overflow: panel.scrollWidth > panel.clientWidth + 1 || body.scrollWidth > body.clientWidth + 1,
      labelAbove: !label || (label.left >= left + 14 && label.bottom <= input.top + 1),
      actionsInside: buttons.every((button) => button.left >= left + 14 && button.right <= right - 14)
    };
  });
  assert.deepEqual(geometry, { overflow: false, labelAbove: true, actionsInside: true });
  const help = drawer.locator('.drawer-title-row .title-help');
  assert.equal(await help.getAttribute('open'), null);
  const firstSection = drawer.locator('.form-section').first();
  const sectionTop = async () => firstSection.evaluate((element) => element.offsetTop);
  const top = await sectionTop();
  await help.locator('summary').click();
  assert.equal(await help.getAttribute('open'), '');
  assert.equal(await sectionTop(), top);
  await page.keyboard.press('Escape');
  assert.equal(await help.getAttribute('open'), null);
  assert.equal(await drawer.count(), 1);
}

test('员工桌面和窄屏可选客户、恢复草稿、核对冲突并写回同一订单', { timeout: 60_000 }, async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  for (const [width, theme] of [[1440, 'light'], [390, 'dark']]) {
    const data = model();
    const { page, drawer, errors, traffic, writes } = await open(t, browser, data, a, width, theme);
    assert.equal(await page.locator('table[data-table="订单补全"] tbody tr[data-row-id]').count(), 1);
    assert.equal(await page.getByText('SYN-other', { exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: '待分配', exact: true }).count(), 0);
    const pending = page.getByRole('button', { name: '补全资料', exact: true });
    await pending.click();
    await drawer.getByText('100 PHP', { exact: true }).waitFor();
    await drawer.getByText('101 PHP', { exact: true }).waitFor();
    await drawer.getByText('配置代付与实际扣款有差额', { exact: false }).waitFor();
    assert.equal(await drawer.locator('input[name*="paid"], input[name*="sale"]').count(), 0);
    assert.equal(await drawer.locator('#completion-receipt-amount').inputValue(), '');
    await drawer.locator('#completion-receipt-amount').fill('84.75');
    await drawer.locator('#completion-receipt-currency').selectOption('MYR');
    await checkLayout(page, drawer);
    const choose = async () => {
      await drawer.getByRole('searchbox', { name: '选择客户', exact: false }).fill('已有测试');
      await drawer.getByRole('button', { name: '选择客户 已有测试客户' }).click();
    };
    await choose();
    await drawer.locator('#completion-source').selectOption('网站');
    await drawer.locator('#completion-wechat').fill('customer-wechat');
    await drawer.locator('#completion-notes').fill('草稿保留');
    await drawer.getByRole('button', { name: '关闭', exact: true }).click();
    await pending.click();
    assert.equal(await drawer.locator('#completion-source').inputValue(), '网站');
    assert.equal(await drawer.locator('#completion-notes').inputValue(), '草稿保留');
    assert.equal(await drawer.locator('#completion-receipt-amount').inputValue(), '84.75');
    data.commerce.data.orders[0].version++;
    await drawer.getByRole('button', { name: '保存订单', exact: true }).click();
    await drawer.getByText('订单已更新', { exact: false }).waitFor();
    await drawer.getByRole('button', { name: '重新核对', exact: true }).click();
    await choose();
    assert.equal(await drawer.locator('#completion-wechat').inputValue(), 'customer-wechat');
    assert.equal(await drawer.locator('#completion-receipt-amount').inputValue(), '84.75');
    assert.equal(await drawer.locator('#completion-receipt-currency').inputValue(), 'MYR');
    await drawer.getByRole('button', { name: '保存订单', exact: true }).click();
    await page.getByText('暂无待补全订单', { exact: true }).waitFor();
    await page.locator('.completion-saved').getByRole('button', { name: '查看此订单', exact: true }).click();
    await drawer.getByText('已有测试客户', { exact: true }).waitFor();
    await drawer.getByText('网站', { exact: true }).waitFor();
    assert.equal(await drawer.getByRole('button', { name: '保存订单', exact: true }).count(), 0);
    assert.equal(writes.length, 2);
    assert.equal(writes[1].version, 2);
    assert.equal(data.commerce.data.orders.length, 3);
    const saved = data.commerce.data.orders[0];
    assert.equal(saved.orderNo, 'SYN-own');
    assert.equal(saved.entitlementStatus, 'active');
    assert.equal(saved.paidAmount, '101');
    assert.equal(saved.saleAmount, '84.75');
    assert.equal(saved.saleCurrency, 'MYR');
    assert.equal(saved.customerId, 'known');
    assert.equal(saved.customerPhone, '123456');
    assert.equal(saved.customerSource, '网站');
    assert.deepEqual(errors, []);
    assert.deepEqual(traffic.external, []);
  }
});

test('管理员待归属，归属员工可快捷新增客户并随原单保存', { timeout: 35_000 }, async (t) => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const data = model();
  const manager = await open(t, browser, data, admin, 1440, 'dark');
  await manager.page.getByRole('button', { name: '待分配', exact: true }).click();
  await manager.page.getByRole('button', { name: '补全资料', exact: true }).click();
  await manager.drawer.locator('#completion-owner').selectOption(b.id);
  await manager.drawer.locator('#completion-reason').fill('已核对合成领码记录');
  await manager.drawer.getByRole('button', { name: '保存订单', exact: true }).click();
  await manager.page.getByText('暂无待分配订单', { exact: true }).waitFor();

  const employee = await open(t, browser, data, b, 390, 'light');
  await employee.page.locator('tr[data-row-id="unassigned"]').getByRole('button', { name: '补全资料', exact: true }).click();
  await employee.drawer.locator('#completion-receipt-amount').fill('120');
  await employee.drawer.getByRole('button', { name: '新增客户', exact: true }).click();
  await employee.drawer.locator('#completion-name').fill('快捷录入客户');
  await employee.drawer.getByRole('button', { name: '选用此客户', exact: true }).click();
  await employee.drawer.getByText('快捷录入客户（待保存）', { exact: true }).waitFor();
  assert.equal(data.commerce.data.customers.length, 1);
  assert.equal(await employee.drawer.locator('#completion-receipt-amount').inputValue(), '120');
  await employee.drawer.locator('#completion-customerPhone').fill('789012');
  await checkLayout(employee.page, employee.drawer);
  await employee.drawer.getByRole('button', { name: '保存订单', exact: true }).click();
  await employee.page.getByRole('button', { name: '已补全', exact: true }).click();
  const completed = employee.page.locator('tr[data-row-id="unassigned"]');
  await completed.getByRole('button', { name: '更多资料', exact: true }).click();
  await completed.getByText('SYN-unassigned', { exact: true }).waitFor();
  await employee.drawer.waitFor({ state: 'hidden' });
  const saved = data.commerce.data.orders.find((row) => row.id === 'unassigned');
  const customer = data.commerce.data.customers.find((row) => row.id === saved.customerId);
  assert.equal(saved.ownerId, b.id);
  assert.equal(saved.rechargeOwnerAssignment.reason, '已核对合成领码记录');
  assert.equal(customer.name, '快捷录入客户');
  assert.equal(customer.phone, '789012');
  assert.equal(customer.source, undefined);
  assert.equal(saved.saleAmount, '120');
  await employee.page.locator('.completion-saved').getByRole('button', { name: '查看此订单' }).click();
  await employee.drawer.getByRole('button', { name: '补充资料', exact: true }).click();
  assert.equal(await employee.drawer.locator('#completion-receipt-amount').count(), 0);
  await employee.drawer.locator('#completion-card-last4').fill('2468');
  await employee.drawer.getByRole('button', { name: '保存订单', exact: true }).click();
  await employee.drawer.waitFor({ state: 'hidden' });
  const afterCard = data.commerce.data.orders.find(row => row.id === saved.id);
  assert.equal(afterCard.paymentId, '2468');
  assert.equal(afterCard.saleAmount, '120');
  assert.equal(afterCard.financialEvidence.filter(event => event.kind === 'receipt').length, 1);
  await manager.page.goto(origin + '/?verify=original#/orders/detail/unassigned');
  const original = manager.page.locator('#main .property-list');
  await original.getByText('快捷录入客户', { exact: true }).waitFor();
  await original.getByText('789012', { exact: true }).waitFor();
  assert.deepEqual(manager.errors, []);
  assert.deepEqual(employee.errors, []);
  assert.deepEqual(manager.traffic.external, []);
  assert.deepEqual(employee.traffic.external, []);
});

test('手工旧单从补全和续费提醒进入原单，独立补邮箱并保留实际收付款', { timeout: 35_000 }, async t => {
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  const data = model();
  const legacy = { ...auto('manual', ''), taskId: '', source: '历史入库', customerId: 'known', email: '',
    start: '2026-10-08T10:00', expiry: '2026-11-09T10:00', paidConfirmed: true, receiptConfirmed: false };
  data.commerce.data.orders.push(legacy);
  const { page, drawer, writes, errors, traffic } = await open(t, browser, data, admin, 1440, 'light');
  await page.clock.setFixedTime(new Date(now));
  await page.getByRole('button', { name: '手工与历史单', exact: true }).click();
  const row = page.locator('tr[data-row-id="manual"]');
  await row.getByText('SYN-manual', { exact: true }).waitFor();
  assert.match(await row.innerText(), /邮箱账号/);
  assert.doesNotMatch(await row.innerText(), /客户实收/);
  await page.getByRole('button', { name: '补齐空白归属', exact: true }).click();
  await page.locator('#confirm-dialog [data-action="confirm-accept"]').click();
  await row.getByText(superAdmin.name, { exact: true }).waitFor();
  await row.getByRole('button', { name: '查看原单', exact: true }).click();
  await page.waitForURL('**/#/orders/detail/manual');
  await page.getByRole('button', { name: '补齐资料', exact: true }).click();
  await drawer.getByRole('heading', { name: '补齐原单资料', exact: true }).waitFor();
  assert.equal(await drawer.locator('[name="commerce-completionFullReceipt"]').count(), 0);
  await drawer.getByRole('button', { name: '取消', exact: true }).click();

  await page.goto(origin + '/#/workspace/renewals');
  await page.getByRole('tab', { name: /^已到期/ }).click();
  await page.locator('[data-action="commerce-renewal-select"][data-id="manual"]').click();
  await page.getByRole('region', { name: '当前选中客户' }).getByRole('button', { name: '补邮箱', exact: true }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await drawer.getByLabel('邮箱账号', { exact: true }).fill('verified@example.test');
  const form = drawer.locator('#commerce-order-completion-form');
  assert.equal(await form.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
  await drawer.getByRole('button', { name: '保存到原单', exact: true }).click();
  await drawer.getByRole('heading', { name: '订单详情', exact: true }).waitFor();
  await drawer.getByText('verified@example.test', { exact: true }).waitFor();
  const order = data.commerce.data.orders.find(row => row.id === legacy.id);
  assert.equal(order.ownerId, superAdmin.id);
  assert.equal(order.email, 'verified@example.test');
  for (const field of ['paidAmount', 'paidConfirmed', 'saleAmount', 'receiptConfirmed', 'entitlementStatus', 'start', 'expiry'])
    assert.equal(order[field], legacy[field], field);
  assert.deepEqual(writes, [
    { action: 'assign-manual-owners' },
    { action: 'fill-manual-details', orderId: legacy.id, version: 2, details: { email: 'verified@example.test' } }
  ]);
  assert.deepEqual(errors, []);
  assert.deepEqual(traffic.external, []);
});

test('客户检索忽略新输入之前发出的迟到结果，组合输入不发请求', async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const { page, drawer, errors } = await open(t, browser, model(), a, 1440, 'light');
  await page.getByRole('button', { name: '补全资料', exact: true }).click();
  await page.clock.install({ time: new Date('2026-11-12T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-11-12T00:00:01Z'));
  let release, started, readCount = 0;
  const held = new Promise(resolve => { started = resolve; });
  await page.route('**/api/local/order-completion?*', async route => {
    const q = new URL(route.request().url()).searchParams.get('q');
    if (!q) return route.fallback();
    readCount++;
    if (q === '旧词') { started(); await new Promise(resolve => { release = resolve; }); }
    return route.fulfill({ json: { items: [{ id: q, name: q === '旧词' ? '迟到旧客户' : '当前新客户' }] } });
  });
  t.after(() => release?.());
  const search = drawer.locator('#completion-customer-query');
  await search.fill('旧词'); await page.clock.runFor(300); await held;
  await search.fill('新词');
  const response = page.waitForResponse(response => new URL(response.url()).searchParams.get('q') === '旧词');
  release(); await response; await page.clock.runFor(1);
  assert.equal(await drawer.getByRole('button', { name: '选择客户 迟到旧客户' }).count(), 0);
  await page.clock.runFor(299);
  await drawer.getByRole('button', { name: '选择客户 当前新客户' }).waitFor();
  assert.equal(readCount, 2);
  await search.evaluate(node => {
    node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    node.value = 'zuhe'; node.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
  });
  await page.clock.runFor(600); assert.equal(readCount, 2);
  await drawer.getByRole('button', { name: '关闭', exact: true }).click();
  await page.clock.runFor(600); assert.equal(readCount, 2, '关闭后的输入计时器不能继续检索');
  assert.deepEqual(errors, []);
});

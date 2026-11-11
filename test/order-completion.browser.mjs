import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { applyOrderCompletion, readOrderCompletion, rechargePriceSnapshot } from '../server/order-completion.mjs';
import { interceptDesign, origin, settle, spacingSnapshot, toggleDesignTheme } from './helpers/offline-design.mjs';

const playwright = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
const { chromium } = await import(playwright ? pathToFileURL(playwright).href : 'playwright');
const path = '/api/local/order-completion';
const route = 'workspace/order-completion';
const now = '2026-11-10T06:40:00.000Z';
const a = { id: 'staff-a', name: '员工甲', role: 'employee' };
const b = { id: 'staff-b', name: '员工乙', role: 'employee' };
const admin = { id: 'admin', name: '管理员', role: 'admin' };
const owners = () => [a, b, admin];
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
      const { order, customer, createdCustomer } = applyOrderCompletion(data, settings, actor, command, owners, now);
      data.orders = data.orders.map((row) => row.id === order.id ? order : row);
      if (customer) {
        data.customers = createdCustomer ? [customer, ...data.customers]
          : data.customers.map((row) => row.id === customer.id ? customer : row);
      }
      return route.fulfill({ json: { orderId: order.id, version: ++model.commerce.version } });
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
      labelLeft: !label || (label.left >= left + 14 && label.left < input.left),
      actionsInside: buttons.every((button) => button.left >= left + 14 && button.right <= right - 14)
    };
  });
  assert.deepEqual(geometry, { overflow: false, labelLeft: true, actionsInside: true });
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
    assert.equal(await page.getByRole('button', { name: '待归属', exact: true }).count(), 0);
    const pending = page.getByRole('button', { name: '补全资料', exact: true });
    await pending.click();
    await drawer.getByText('100 PHP', { exact: true }).waitFor();
    await drawer.getByText('101 PHP', { exact: true }).waitFor();
    await drawer.getByText('配置代付与实际扣款有差额', { exact: false }).waitFor();
    assert.equal(await drawer.locator('input[name*="paid"], input[name*="sale"]').count(), 0);
    await checkLayout(page, drawer);
    const choose = async () => {
      await drawer.getByLabel('选择客户', { exact: false }).fill('已有测试');
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
    data.commerce.data.orders[0].version++;
    await drawer.getByRole('button', { name: '保存补全', exact: true }).click();
    await drawer.getByText('订单已更新', { exact: false }).waitFor();
    await drawer.getByRole('button', { name: '重新核对', exact: true }).click();
    await choose();
    assert.equal(await drawer.locator('#completion-wechat').inputValue(), 'customer-wechat');
    await drawer.getByRole('button', { name: '保存补全', exact: true }).click();
    await page.getByText('暂无待补全订单', { exact: true }).waitFor();
    await page.getByRole('button', { name: '已补全', exact: true }).click();
    await page.getByRole('button', { name: '查看', exact: true }).click();
    await drawer.getByText('已有测试客户', { exact: true }).waitFor();
    await drawer.getByText('网站', { exact: true }).waitFor();
    assert.equal(await drawer.getByRole('button', { name: '保存补全', exact: true }).count(), 0);
    assert.equal(writes.length, 2);
    assert.equal(writes[1].version, 2);
    assert.equal(data.commerce.data.orders.length, 3);
    const saved = data.commerce.data.orders[0];
    assert.equal(saved.orderNo, 'SYN-own');
    assert.equal(saved.entitlementStatus, 'active');
    assert.equal(saved.paidAmount, '101');
    assert.equal(saved.saleAmount, '140.00');
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
  await manager.page.getByRole('button', { name: '待归属', exact: true }).click();
  await manager.page.getByRole('button', { name: '确认归属', exact: true }).click();
  await manager.drawer.locator('#completion-owner').selectOption(b.id);
  await manager.drawer.locator('#completion-reason').fill('已核对合成领码记录');
  await manager.drawer.getByRole('button', { name: '保存归属', exact: true }).click();
  await manager.page.getByText('暂无待归属订单', { exact: true }).waitFor();

  const employee = await open(t, browser, data, b, 390, 'light');
  await employee.page.locator('tr[data-row-id="unassigned"]').getByRole('button', { name: '补全资料', exact: true }).click();
  await employee.drawer.getByRole('button', { name: '新增客户', exact: true }).click();
  await employee.drawer.locator('#completion-name').fill('快捷录入客户');
  await employee.drawer.getByRole('button', { name: '选用此客户', exact: true }).click();
  await employee.drawer.getByText('快捷录入客户（待保存）', { exact: true }).waitFor();
  assert.equal(data.commerce.data.customers.length, 1);
  await employee.drawer.locator('#completion-source').selectOption('客户推荐');
  await employee.drawer.locator('#completion-customerPhone').fill('789012');
  await checkLayout(employee.page, employee.drawer);
  await employee.drawer.getByRole('button', { name: '保存补全', exact: true }).click();
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
  assert.equal(customer.source, '客户推荐');
  await manager.page.goto(origin + '/?verify=original#/orders/detail/unassigned');
  const original = manager.page.locator('#main .property-list');
  await original.getByText('快捷录入客户', { exact: true }).waitFor();
  await original.getByText('客户推荐', { exact: true }).waitFor();
  await original.getByText('789012', { exact: true }).waitFor();
  assert.deepEqual(manager.errors, []);
  assert.deepEqual(employee.errors, []);
  assert.deepEqual(manager.traffic.external, []);
  assert.deepEqual(employee.traffic.external, []);
});

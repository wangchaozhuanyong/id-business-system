import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { prepareTenantRenewalWrite, tenantRenewalHandledAction } from '../server/tenant-renewal-reminders.mjs';
import { interceptDesign, origin, settle, toggleDesignTheme } from './helpers/offline-design.mjs';

test('租户续费提醒、联系人、独立设置、保存失败和新周期', { timeout: 75_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const actor = { id: 'qa-admin', name: '合成管理员', role: 'admin', nicknameSet: true };
  const output = process.env.ID_LAYOUT_QA_OUTPUT;
  if (output) await mkdir(output, { recursive: true });
  const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  let at = new Date('2026-11-10T12:00:00Z');
  const order = (id, extra = {}) => ({
    id, orderNo: 'QA-' + id, product: 'Claude Pro', plan: 'Pro', businessType: '续费',
    email: 'shared@example.test', customerId: 'first', tenantId: 'a', source: '管理员手工',
    paidConfirmed: true, receiptConfirmed: true,
    start: '2026-11-01T20:00', expiry: '2026-11-13T20:00', version: 1, ...extra
  });
  let snapshot = { version: 1, data: {
    tenants: [
      { id: 'a', name: '合成租户甲', phone: '01012345670', version: 1, active: true },
      { id: 'b', name: '合成租户乙', phone: '01012345671', version: 1, active: false }
    ],
    customers: [
      { id: 'first', name: '合成客户一', wechat: 'synthetic_one', active: true, version: 1 },
      { id: 'second', name: '合成客户二', phone: '01012345672', active: true, version: 1 }
    ],
    orders: [order('first-cycle'), order('second-contact', { customerId: 'second', expiry: '2026-11-13T12:00:00Z' }),
      order('previous-cycle', { expiry: '2026-11-08T20:00' }),
      order('expired', { tenantId: 'b', email: 'expired@example.test', expiry: '2026-11-09T20:00' }),
      order('later', { email: 'later@example.test', expiry: '2026-11-14T20:00' }),
      order('unpaid', { email: 'unpaid@example.test', paidConfirmed: false, entitlementStatus: 'pending' }),
      order('missing-account', { email: '' }), order('cancelled', { email: 'cancelled@example.test', cancelled: true }),
      order('unlinked', { tenantId: '', email: 'unlinked@example.test' })],
    operating: [], rentBatches: [], logs: [], renewalWarningHours: 24
  } };
  const originalOrders = structuredClone(snapshot.data.orders);
  const traffic = await interceptDesign(context, { localFixtures: { ...fixture, commerce: snapshot }, actor });
  const requests = [];
  const receipts = new Map(), rejected = new Set();
  let nextReply, releaseWrite;
  await context.route('**/api/local/commerce', async route => {
    const request = route.request();
    if (request.method() === 'GET') return route.fulfill({ json: snapshot });
    const operationId = request.headers()['x-id-operation'];
    assert(operationId, '写入携带幂等操作编号');
    if (receipts.has(operationId)) return route.fulfill({ json: receipts.get(operationId) });
    if (rejected.has(operationId)) return route.fulfill({ status: 503, json: { error: '暂时无法保存' } });
    const { version, data, action } = request.postDataJSON();
    requests.push(action);
    if (version !== snapshot.version)
      return route.fulfill({ status: 409, json: { error: '订单已更新' } });
    const reply = nextReply;
    nextReply = undefined;
    if (reply === 'rejected') {
      rejected.add(operationId);
      return route.fulfill({ status: 503, json: { error: '暂时无法保存' } });
    }
    try {
      prepareTenantRenewalWrite(snapshot.data, data, action, actor, at);
      snapshot = { version: version + 1, data };
      receipts.set(operationId, snapshot);
      if (reply === 'lost') {
        await new Promise(resolve => { releaseWrite = resolve; });
        return route.fulfill({ status: 503, json: { error: '模拟回包丢失' } });
      }
      return route.fulfill({ json: snapshot });
    } catch (error) {
      return route.fulfill({ status: error.status || 500, json: { error: error.message } });
    }
  });
  await context.addInitScript(() => Object.defineProperty(navigator, 'clipboard', {
    value: { writeText: async value => { window.testCopiedContact = value; } }
  }));
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(6000);
  await page.clock.setFixedTime(at);
  await page.goto(origin + '/#/customers/tenants');
  const tab = (name, count) => {
    const item = page.getByRole('tab', { name, exact: true });
    return count === undefined ? item : item.filter({
      has: page.locator('.tab-count').filter({ hasText: new RegExp('^' + count + '$') })
    });
  };
  const drawer = page.locator('#drawer[open]');
  const pending = page.locator('table[data-table="commerce-tenant-renewals-pending"]');
  const processed = page.locator('table[data-table="commerce-tenant-renewals-processed"]');
  const filter = page.getByLabel('租户', { exact: true });
  const notice = page.locator('#toast');
  const details = pending.getByRole('row').filter({ hasText: 'shared@example.test' });
  const settings = page.getByRole('button', { name: '租户续费提醒设置', exact: true });
  const shared = 'shared@example.test';
  await tab('待处理', 2).waitFor();
  await page.getByRole('button', { name: '1 个待处理', exact: true }).click();
  assert.equal(await filter.inputValue(), 'a');
  assert.equal(await pending.locator('tbody tr[data-row-id]').count(), 1);
  await details.getByRole('button', { name: '详情', exact: true }).click();
  await drawer.getByRole('heading', { name: '租户续费详情' }).waitFor();
  for (const value of ['01012345670', '合成客户一', '合成客户二', '01012345672', 'synthetic_one'])
    await drawer.getByText(value).waitFor();
  await drawer.getByRole('button', { name: '复制微信', exact: true }).click();
  assert.equal(await page.evaluate(() => window.testCopiedContact), 'synthetic_one');
  await drawer.getByRole('button', { name: '标记已处理' }).click();
  await page.locator('#confirm-dialog').getByRole('button', { name: '取消', exact: true }).click();
  assert.equal(requests.length, 0);
  await drawer.getByRole('button', { name: '关闭', exact: true }).click();
  await filter.selectOption('');
  await pending.locator('tbody tr[data-row-id]').first().getByText(/^已到期 /).waitFor();
  assert.equal(await pending.locator('tbody tr[data-row-id]').count(), 2);
  for (const value of ['unpaid@example.test', 'later@example.test', 'cancelled@example.test', 'unlinked@example.test'])
    assert.equal(await pending.getByText(value, { exact: true }).count(), 0);
  if (output) {
    const dismiss = page.locator('.toast-dismiss:visible');
    if (await dismiss.count()) await dismiss.click();
    await page.screenshot({ path: join(output, 'tenant-renewals-desktop.png') });
  }

  await settings.click();
  const days = drawer.getByLabel('提前天数'), hours = drawer.getByLabel('提前小时数');
  const save = drawer.getByRole('button', { name: '保存设置' });
  assert.equal(await days.inputValue(), '3');
  assert.equal(await hours.inputValue(), '0');
  await days.fill('366');
  await save.click();
  await drawer.getByText('请填写 0 至 365 的整数', { exact: true }).waitFor();
  assert.equal(requests.length, 0);
  await days.fill('4');
  await drawer.getByRole('button', { name: '取消', exact: true }).click();
  await settings.click();
  assert.equal(await days.inputValue(), '4');
  nextReply = 'rejected';
  await save.click();
  await notice.getByText(/本次操作未登记/).waitFor();
  nextReply = undefined;
  assert.equal(await days.inputValue(), '4');
  assert.equal(snapshot.data.tenantRenewalWarningHours, undefined);
  snapshot.version++;
  await save.click();
  await notice.getByText(/本次未保存/).waitFor();
  assert.equal(await days.inputValue(), '4');
  await save.click();
  await drawer.waitFor({ state: 'hidden' });
  await pending.getByText('later@example.test', { exact: true }).waitFor();
  assert.equal(snapshot.data.tenantRenewalWarningHours, 96);
  assert.equal(snapshot.data.renewalWarningHours, 24);
  await page.goto(origin + '/#/workspace/renewals/reminders');
  await page.getByText('提前 1 天提醒', { exact: true }).waitFor();
  await page.goto(origin + '/#/customers/tenants');
  await pending.getByText('later@example.test', { exact: true }).waitFor();

  await details.getByRole('button', { name: '详情', exact: true }).click();
  const mark = drawer.getByRole('button', { name: '标记已处理' });
  nextReply = 'lost';
  await mark.click();
  await page.locator('#confirm-dialog').getByRole('button', { name: '确认已处理' }).click();
  await drawer.locator('[data-protect-drawer-dismiss][aria-busy="true"]').waitFor();
  assert.equal(await mark.isEnabled(), false);
  await page.keyboard.press('Escape');
  assert.equal(await drawer.count(), 1);
  assert.equal(typeof releaseWrite, 'function');
  releaseWrite();
  await drawer.waitFor({ state: 'hidden' });
  await pending.getByText(shared, { exact: true }).waitFor({ state: 'hidden' });
  await tab('已处理', 1).click();
  await processed.getByText(shared, { exact: true }).waitFor();
  await processed.getByText(actor.name, { exact: true }).waitFor();
  await processed.getByText('2026-11-10 20:00', { exact: true }).waitFor();
  assert.deepEqual(snapshot.data.orders, originalOrders);
  assert.equal(requests.filter(action => action === tenantRenewalHandledAction).length, 1);
  assert.deepEqual(snapshot.data.logs[0].tenantRenewal.orderIds, ['first-cycle', 'second-contact']);
  await tab('使用中').click();
  await page.locator('table[data-table="commerce-tenants"] tr[data-row-id="a"]')
    .getByRole('button', { name: '详情', exact: true }).click();
  await drawer.getByText(/2026-11-10 20:00 · 合成管理员 · 已标记处理本次到期提醒/).waitFor();
  await drawer.getByRole('button', { name: '关闭', exact: true }).click();

  at = new Date('2026-11-17T12:00:00Z');
  await page.clock.setFixedTime(at);
  snapshot.data.orders.push(order('new-cycle', { start: '2026-11-13T20:00', expiry: '2026-11-20T20:00' }));
  snapshot.version++;
  await page.reload();
  await tab('待处理', 3).click();
  await pending.getByText(shared, { exact: true }).waitFor();
  await pending.getByText('2026-11-20 20:00', { exact: true }).waitFor();
  await page.setViewportSize({ width: 390, height: 850 });
  await toggleDesignTheme(page);
  await settle(page);
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1));
  await details.getByRole('button', { name: '详情', exact: true }).click();
  await drawer.getByRole('heading', { name: '关联客户联系方式' }).waitFor();
  assert(await drawer.evaluate(el => el.getBoundingClientRect().width <= document.documentElement.clientWidth));
  if (output) await page.screenshot({ path: join(output, 'tenant-renewal-detail-mobile.png') });
  await drawer.getByRole('button', { name: '关闭', exact: true }).click();
  await tab('已处理', 1).click();
  await processed.getByText('2026-11-13 20:00', { exact: true }).waitFor();
  await page.getByRole('textbox', { name: '搜索当前列表' }).fill('不存在的测试账号');
  await processed.getByText('暂无符合条件的提醒', { exact: true }).waitFor();

  for (let index = 0; index < 22; index++)
    snapshot.data.orders.push(order(`extra-${index}`, { email: `extra-${index}@example.test` }));
  snapshot.version++;
  await page.reload();
  await tab('待处理', 25).click();
  const pagination = page.getByRole('navigation', { name: '分页', exact: true });
  await pagination.locator('select[data-pagination-size]').selectOption('10');
  assert.equal(await pending.locator('tbody tr[data-row-id]').count(), 10);
  const next = pagination.getByRole('button', { name: '下一页', exact: true });
  await next.click();
  await next.click();
  assert.equal(await pagination.getAttribute('data-page'), '3');
  assert.equal(await pagination.getAttribute('data-total'), '25');
  assert.equal(await pending.locator('tbody tr[data-row-id]').count(), 5);
  assert.equal(await next.isEnabled(), false);
  assert.deepEqual(errors, []);
  assert.deepEqual(traffic.external, []);
  assert.deepEqual(traffic.unavailable, []);
});

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { applyOrderCompletion } from '../server/order-completion.mjs';
import { interceptDesign, interceptRenewalWorktable, origin } from './helpers/offline-design.mjs';

test('充值码成功后原提醒进入已处理，并可补录实际到期时间', { timeout: 25000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const actor = { id: 'qa-admin', role: 'admin', name: '合成管理员' };
  const completedAt = '2026-11-12T06:00:00Z';
  const old = { id: 'qa-old', orderNo: 'QA-OLD', email: 'renewal@example.test', product: 'GPT', plan: 'Plus',
    customerId: 'qa-customer', businessType: '续费', source: '管理员手工', payment: '银行卡',
    start: '2026-10-12T14:00', expiry: '2026-11-12T12:00', version: 1, entitlementStatus: 'active' };
  const successor = { ...old, id: 'qa-new', orderNo: 'QA-NEW', source: '线上代充', taskId: 'qa-receipt',
    previousOrderId: old.id, start: '2026-11-12T14:00', rechargeCompletedAt: completedAt, expiry: '' };
  let data = { orders: [old], customers: [{ id: old.customerId, name: '合成客户' }], logs: [] }, version = 1;
  const offline = await interceptDesign(context, { localFixtures: {}, actor, skipRechargeAssets: true });
  await context.route('**/api/local/commerce', route => route.fulfill({ json: { version, data } }));
  const evaluationTime = new Date('2026-11-12T07:00:00Z');
  await interceptRenewalWorktable(context, { actor, clock: () => evaluationTime.getTime(),
    localFixtures: { get commerce() { return { version, data }; } } });
  const commands = [];
  await context.route('**/api/local/order-completion', async route => {
    const command = route.request().postDataJSON();
    commands.push(command);
    const { order } = applyOrderCompletion(data, {}, actor, command, () => [], completedAt);
    data = { ...data, orders: data.orders.map(row => row.id === order.id ? order : row) };
    await route.fulfill({ json: { orderId: order.id, version: ++version } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.setFixedTime(evaluationTime);
  await page.goto(origin + '/#/workspace/renewals');
  const periods = page.getByRole('group', { name: '订单状态' });
  const row = page.locator('tr[data-row-id="qa-old"]');
  await periods.getByRole('button', { name: /^已到期/ }).click();
  await row.getByText('已到期 3 小时', { exact: true }).waitFor();
  data = { ...data, orders: [successor, old] };
  version++;
  assert.equal(await page.evaluate(() => window.IDDesignAPI.modules.commerce.refreshAfterOrderSync()), true);
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await row.waitFor({ state: 'hidden' });
  await periods.getByRole('button', { name: /^已续费/ }).click();
  await row.getByRole('button', { name: '详情', exact: true }).click();
  const drawer = page.locator('#drawer[open]');
  const detail = drawer.locator('[data-renewal-order-preview]');
  await detail.getByText('2026-11-12 14:00', { exact: true }).waitFor();
  await detail.getByText('待核对', { exact: true }).waitFor();
  await drawer.getByRole('button', { name: '关闭抽屉', exact: true }).click();
  await row.getByRole('button', { name: '更多操作', exact: true }).click();
  await page.getByRole('menuitem', { name: '登记实际到期时间', exact: true }).click();
  const expiry = drawer.locator('#commerce-renewalActualExpiry');
  await expiry.fill('2026-11-12T11:00');
  await drawer.getByRole('button', { name: '保存到期时间' }).click();
  await drawer.getByText(/请填写晚于/).waitFor();
  assert.equal(commands.length, 0);
  await expiry.fill('2026-12-12T14:00');
  const saved = page.waitForResponse(response => response.request().method() === 'POST' &&
    new URL(response.url()).pathname === '/api/local/order-completion');
  await drawer.getByRole('button', { name: '保存到期时间' }).click();
  assert.equal((await saved).ok(), true);
  await expiry.waitFor({ state: 'hidden' });
  if (await drawer.isVisible()) await drawer.getByRole('button', { name: '关闭抽屉', exact: true }).click();
  await row.getByRole('button', { name: '详情', exact: true }).click();
  await detail.locator('.renewal-workbench-fields').getByText('2026-12-12 14:00', { exact: true }).waitFor();
  assert.deepEqual(commands, [{ action: 'confirm-renewal-expiry', orderId: successor.id, version: 1,
    expiry: '2026-12-12T14:00' }]);
  assert.equal(data.orders.find(order => order.id === old.id), old);
  assert.deepEqual(errors, []);
  assert.deepEqual(offline.external, []);
});

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { applyOrderCompletion } from '../server/order-completion.mjs';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

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
  await page.clock.setFixedTime(new Date('2026-11-12T07:00:00Z'));
  await page.goto(origin + '/#/workspace/renewals/reminders');
  const tab = name => page.getByRole('tab', { name });
  const row = page.locator('[data-renewal-scroll] button[data-id="qa-old"]');
  await tab(/^已到期/).click();
  await row.getByText('已到期 3 小时').waitFor();
  data = { ...data, orders: [successor, old] };
  version++;
  assert.equal(await page.evaluate(() => window.IDDesignAPI.modules.commerce.refreshAfterOrderSync()), true);
  await row.waitFor({ state: 'hidden' });
  await tab(/^已处理/).click();
  await row.click();
  const detail = page.getByRole('region', { name: '当前选中客户' });
  await detail.getByText('2026-11-12 14:00', { exact: true }).waitFor();
  await detail.getByText('待核对', { exact: true }).waitFor();
  await detail.getByRole('button', { name: '登记实际到期时间' }).click();
  const drawer = page.locator('#drawer[open]');
  const expiry = drawer.locator('#commerce-renewalActualExpiry');
  await expiry.fill('2026-11-12T11:00');
  await drawer.getByRole('button', { name: '保存到期时间' }).click();
  await drawer.getByText(/请填写晚于/).waitFor();
  assert.equal(commands.length, 0);
  await expiry.fill('2026-12-12T14:00');
  await drawer.getByRole('button', { name: '保存到期时间' }).click();
  await detail.locator('.renewal-workbench-fields').getByText('2026-12-12 14:00', { exact: true }).waitFor();
  assert.deepEqual(commands, [{ action: 'confirm-renewal-expiry', orderId: successor.id, version: 1,
    expiry: '2026-12-12T14:00' }]);
  assert.equal(data.orders.find(order => order.id === old.id), old);
  assert.deepEqual(errors, []);
  assert.deepEqual(offline.external, []);
});

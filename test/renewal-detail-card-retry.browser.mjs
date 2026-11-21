import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { accountLifecycleSummaries } from '../server/account-lifecycle.mjs';
import { interceptDesign, origin, settle } from './helpers/offline-design.mjs';

const { chromium } = await import(process.env.ID_RECHARGE_QA_PLAYWRIGHT
  ? pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href : 'playwright');
const actor = { id: 'synthetic-renewal-admin', name: '合成管理员', role: 'admin' };
const route = '/#/workspace/renewals';
const firstId = 'retry-first', secondId = 'retry-second', appleId = 'retry-apple';
const firstNumber = '4242424242424242', secondNumber = '5555555555554444';

function order(id, payment = '银行卡') {
  return {
    id, version: 1, orderNo: 'QA-' + id, ownerId: actor.id, customerId: id + '-customer',
    email: id + '@example.test', product: 'GPT', plan: 'Plus', payment, businessType: '续费',
    accountSource: '客户自有', start: '2026-10-15T15:00', expiry: '2026-11-15T15:00',
    source: '管理员手工', paidConfirmed: true, receiptConfirmed: true, entitlementStatus: 'active',
    paidAmount: '20', paidCurrency: 'USD', saleAmount: '180', saleCurrency: 'CNY',
    corrections: [], financialEvidence: []
  };
}

test('续费详情的用卡重试保留抽屉，校验迟到回执且只读取当前原单', { timeout: 25_000 }, async t => {
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  for (const [width, theme] of [[1440, 'light'], [320, 'dark']]) await t.test(width + 'px ' + theme, async t => {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    t.after(() => context.close());
    const orders = [order(firstId), order(secondId), order(appleId, '苹果内购')];
    const customers = orders.map(row => ({ id: row.customerId, name: '合成客户 ' + row.id, active: true }));
    const fixtures = {
      commerce: { version: 1, data: {
        orders, customers, tenants: [], operating: [], rentBatches: [], logs: []
      } },
      renewals: { version: 1, reminderHours: 72, items: [], candidates: orders.map((row, index) => ({
        ...row, number: row.orderNo, account: row.email, customer: customers[index].name, reminderState: 'upcoming'
      })) }
    };
    const traffic = await interceptDesign(context, { actor, localFixtures: fixtures, skipRechargeAssets: true });
    const requests = [];
    let hold;
    const attemptsFor = id => requests.filter(request => request.orderId === id).length;
    await context.route(origin + '/api/local/subscription-renewal-card', async route => {
      const request = route.request();
      const command = request.postDataJSON();
      assert.equal(request.method(), 'POST');
      assert.equal(request.headers()['x-id-operation'], undefined);
      assert.deepEqual(command, { action: 'prepare', orderId: command.orderId });
      requests.push(command);
      const { orderId } = command, retry = attemptsFor(orderId) > 1;
      if (retry && hold?.id === orderId) {
        hold.started.resolve();
        await hold.release.promise;
      }
      if (!retry || (orderId === firstId && attemptsFor(firstId) === 2))
        return route.fulfill({ status: 503, json: { error: '合成用卡读取失败' } });
      return route.fulfill({ json: { orderId, hasCard: true, number: orderId === firstId ? firstNumber : secondNumber,
        estimate: { usd: orderId === firstId ? '22.30' : '98.00' } } });
    });

    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.clock.setFixedTime(new Date('2026-11-14T02:00:00Z'));
    await page.goto(origin + route);
    await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
    const drawer = page.locator('#drawer[open]');
    const panel = drawer.locator('[data-renewal-order-preview]');
    const notice = panel.locator('[data-renewal-preview-notice]');
    const retry = notice.getByRole('button', { name: '重读用卡资料', exact: true });
    const number = panel.locator('[data-renewal-preview-number]');
    const funding = panel.locator('[data-renewal-preview-funding]');
    const open = async id => {
      await page.locator('[data-renewal-list] tr[data-row-id="' + id + '"]')
        .getByRole('button', { name: '详情', exact: true }).click();
      await panel.getByRole('heading', { name: '合成客户 ' + id, exact: true }).waitFor();
    };
    const close = async () => {
      await drawer.getByRole('button', { name: '关闭抽屉', exact: true }).click();
      await drawer.waitFor({ state: 'hidden' });
    };
    const holdRead = id => {
      hold = { id, started: Promise.withResolvers(), release: Promise.withResolvers() };
      return hold;
    };

    await open(firstId);
    await retry.waitFor();
    assert.equal(attemptsFor(firstId), 1);
    assert.equal(await funding.textContent(), '未核算');
    assert.equal(await panel.getByRole('heading', { name: '历史订阅', exact: true }).isVisible(), true);
    const pending = holdRead(firstId);
    try {
      await retry.press('Enter');
      await pending.started.promise;
      assert.equal(await panel.getAttribute('aria-busy'), 'true');
      assert.equal(await retry.isDisabled(), true);
      assert.equal(await funding.textContent(), '未核算');
      assert.equal(page.url(), origin + route);
    } finally {
      pending.release.resolve();
      hold = undefined;
    }
    await page.waitForFunction(() => !document.querySelector('[data-renewal-preview-notice] button').disabled);
    assert.equal(await retry.isVisible(), true);
    assert.equal(await retry.evaluate(node => node === document.activeElement), true);
    await retry.press('Enter');
    await panel.getByText(firstNumber, { exact: true }).waitFor();
    await notice.waitFor({ state: 'hidden' });
    assert.equal(await funding.textContent(), '22.30 USD');
    assert.equal(await number.evaluate(node => node === document.activeElement), true);
    assert.equal(attemptsFor(firstId), 3);
    await close();

    await open(secondId);
    await retry.waitFor();
    const late = holdRead(secondId);
    try {
      await retry.click();
      await late.started.promise;
      await close();
      await open(firstId);
      await panel.getByText(firstNumber, { exact: true }).waitFor();
      const received = page.waitForResponse(response => response.url().endsWith('/subscription-renewal-card') &&
        response.request().postDataJSON().orderId === secondId);
      late.release.resolve();
      await received;
      await settle(page);
      assert.equal(await number.textContent(), firstNumber);
      assert.equal(await funding.textContent(), '22.30 USD');
      assert.equal(await retry.isVisible(), false);
    } finally {
      late.release.resolve();
      hold = undefined;
    }
    await close();
    await open(appleId);
    assert.equal(await retry.count(), 0);
    assert.equal(attemptsFor(appleId), 0);
    assert.deepEqual(errors, []);
    assert.deepEqual(traffic.external, []);
  });
});

test('库存账号已解封或死号时，两个补登入口和直接进入表单共用实际开通时间校验', { timeout: 25_000 }, async t => {
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  t.after(() => context.close());
  const original = { ...order(firstId), accountSource: '库存', accountId: 'stock-for-renewal' };
  const customer = { id: original.customerId, name: '合成续费客户', active: true };
  const stock = { id: original.accountId, type: 'gpt', email: original.email, source: '自行注册',
    inventoryState: 'used', used: true, status: '正常', health: 'unlocking', healthChangedAt: '2026-11-13 09:00',
    inventoryHistory: [{ action: '健康状态变化', detail: 'unlocking', time: '2026-11-13 09:00' }] };
  const commerce = { orders: [original], customers: [customer], tenants: [], operating: [], rentBatches: [], logs: [] };
  const inventory = { accounts: [stock], mailboxes: [], batches: [], registrationRecords: [], returnRecords: [], importRecords: [] };
  const inventoryDoc = version => ({ version, data: inventory, accountSummaries: accountLifecycleSummaries(inventory, commerce) });
  const fixtures = {
    commerce: { version: 1, data: commerce },
    inventory: inventoryDoc(1),
    'auth/order-owners': { items: [actor] },
    renewals: { version: 1, reminderHours: 72, items: [], candidates: [{
      ...original, number: original.orderNo, account: original.email, customer: customer.name, reminderState: 'upcoming'
    }] }
  };
  const traffic = await interceptDesign(context, { actor, localFixtures: fixtures, changeEvents: true,
    dataVersions: { inventory: '1' }, skipRechargeAssets: true });
  let cardUnavailable = false;
  await context.route(origin + '/api/local/subscription-card-details', request => request.fulfill(cardUnavailable
    ? { status: 503, json: { error: '合成用卡资料暂不可读' } } : { json: {
    order: { id: original.id, version: original.version, orderNo: original.orderNo, payment: original.payment,
      account: { email: original.email, source: '库存账号', status: '解封中', canRenew: false }, card: {} }
  } }));
  const writes = [];
  await context.route(origin + '/api/local/commerce', request => {
    if (request.request().method() === 'GET') return request.fallback();
    writes.push(request.request().postDataJSON());
    return request.fulfill({ status: 409, json: { error: '合成写入响应' } });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(6000);
  await page.clock.setFixedTime(new Date('2026-11-14T02:00:00Z'));
  const selectAction = async name => {
    await page.locator(`[data-renewal-list] tr[data-row-id="${original.id}"]`)
      .getByRole('button', { name: '更多操作', exact: true }).click();
    await page.getByRole('menuitem', { name, exact: true }).click();
  };
  const entry = origin + '/#/workspace/order/renew/' + original.id;
  const timing = page.locator('[data-completed-renewal-time]');
  await page.goto(origin + route);
  await selectAction('用卡详情');
  const drawer = page.locator('#drawer[open]');
  const record = drawer.getByRole('button', { name: '登记已完成续费', exact: true });
  await drawer.getByText('解封中', { exact: true }).waitFor();
  assert.equal(await record.isEnabled(), true);
  await record.click();
  await page.waitForURL(entry);
  await timing.filter({ hasText: '2026-11-13 09:00' }).waitFor();

  await page.goto(origin + route);
  cardUnavailable = true;
  await selectAction('用卡详情');
  await drawer.locator('[data-renewal-card-error]').waitFor();
  assert.equal(await record.isEnabled(), true, '本次用卡读取失败不改变已完成续费的原单准入');
  await drawer.getByRole('button', { name: '关闭抽屉', exact: true }).click();
  await selectAction('登记已完成续费');
  await page.waitForURL(entry);
  await timing.filter({ hasText: '2026-11-13 09:00' }).waitFor();

  await page.reload();
  await timing.filter({ hasText: '2026-11-13 09:00' }).waitFor();
  Object.assign(stock, { health: 'normal', healthChangedAt: '2026-11-14 08:00' });
  stock.inventoryHistory.push({ action: '健康状态变化', detail: 'normal', time: stock.healthChangedAt });
  fixtures.inventory = inventoryDoc(2);
  await page.evaluate(() => window.IDLocalData.acceptChangeVersions({ inventory: '2' }));
  await timing.waitFor({ state: 'hidden' });
  const form = page.locator('#commerce-order-form');
  const start = form.locator('#commerce-start');
  await start.fill('2026-11-14T09:30');
  await form.locator('#commerce-expiry').fill('2026-12-14T10:00');
  await form.locator('#commerce-paidAmount').fill('21');
  await form.locator('#commerce-saleAmount').fill('105');
  await form.locator('#commerce-notes').fill('离线保留的续费草稿');
  Object.assign(stock, { health: 'dead', healthChangedAt: '2026-11-14 09:00' });
  stock.inventoryHistory.push({ action: '健康状态变化', detail: 'dead', time: stock.healthChangedAt });
  fixtures.inventory = inventoryDoc(3);
  await page.evaluate(() => window.IDLocalData.acceptChangeVersions({ inventory: '3' }));
  await timing.filter({ hasText: '2026-11-14 09:00' }).waitFor();
  assert.equal(await start.inputValue(), '2026-11-14T09:30');
  assert.equal(await form.locator('#commerce-notes').inputValue(), '离线保留的续费草稿');
  await page.getByRole('button', { name: '提交订单', exact: true }).click();
  await form.locator('#commerce-start-error').filter({ hasText: '实际开通时间须早于异常时间' }).waitFor();
  assert.equal(writes.length, 0);
  await start.fill('2026-11-10T08:00');
  await page.getByRole('button', { name: '提交订单', exact: true }).click();
  await page.getByText('合成写入响应', { exact: false }).waitFor();
  assert.equal(writes.length, 1);
  assert.deepEqual(errors, []);
  assert.deepEqual(traffic.external, []);
});

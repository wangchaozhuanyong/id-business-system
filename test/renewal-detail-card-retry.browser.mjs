import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
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

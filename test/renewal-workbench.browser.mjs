import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { startPreview } from '../server/preview.mjs';

test('renewal workbench persists decisions, creates a new order and projects customer loss', { timeout: 45000 }, async () => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const { server, url } = await startPreview(0, { databasePath: ':memory:' });
  let browser;
  try {
    browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.setDefaultTimeout(5500);
    const api = url + 'api/local/commerce';
    const origin = new URL(url).origin;
    const write = async (version, data) => {
      const response = await page.request.put(api, { headers: { Origin: origin }, data: { version, data } });
      assert.equal(response.status(), 200, await response.text());
    };
    const read = async () => (await page.request.get(api)).json();
    const order = (id, customerId, expiry, extra = {}) => ({
      id, orderNo: id, customerId, expiry, email: id + '@example.test',
      product: 'GPT', plan: 'Plus', businessType: '续费', start: '2026-10-07T16:00',
      paidConfirmed: true, payment: '银行卡', paidAmount: '20', paidCurrency: 'USD',
      paymentId: '123456', cardId: 'qa-card', saleAmount: '180', saleCurrency: 'CNY', version: 1,
      ...extra
    });
    await write(0, {
      customers: [
        { id: 'qa-renew', name: '续费客户甲', phone: '01012345678', active: true, version: 1 },
        { id: 'qa-refuse', name: '拒续客户乙', phone: '01012345679', active: true, version: 1 },
        { id: 'qa-rejoin', name: '换号客户丙', wechat: 'qa-rejoin-chat', active: true, version: 1 }
      ],
      orders: [
        order('QA-EXPIRED', 'qa-renew', '2026-11-05T14:35'),
        order('QA-REFUSE', 'qa-refuse', '2026-11-07T17:00'),
        order('QA-LOST', 'qa-rejoin', '2026-11-01T16:00')
      ],
      tenants: [], operating: [], rentBatches: [], logs: [], renewalWarningDays: 1
    });
    await page.clock.setFixedTime(new Date('2026-11-06T08:00:00Z'));
    await page.route('**/*', (route) =>
      new URL(route.request().url()).origin === origin ? route.continue() : route.abort());
    await page.goto(url + '#/workspace/renewals');
    const drawer = page.locator('#drawer');
    const confirm = page.locator('#confirm-dialog');
    const list = page.locator('table[data-table="commerce-renewals"]');
    const loss = page.locator('table[data-table="commerce-customer-loss"]');
    const row = (id) => list.getByRole('row').filter({ hasText: id });
    const tab = (name) => page.getByRole('tab', { name }).click();
    const completed = async () => {
      await tab(/^已处理/);
      await row('QA-EXPIRED').getByText('已续费', { exact: true }).waitFor();
    };
    await tab(/^即将到期/);
    await page.getByText('提前 1 天提醒', { exact: true }).waitFor();
    assert.equal(await row('QA-REFUSE').count(), 0);
    await page.getByRole('button', { name: '提醒设置' }).click();
    const days = drawer.getByLabel('提前天数');
    const hours = drawer.getByLabel('提前小时数');
    assert.equal(await days.inputValue(), '1');
    assert.equal(await hours.inputValue(), '0');
    await hours.fill('1');
    await drawer.getByRole('button', { name: '保存设置' }).click();
    await row('QA-REFUSE').getByRole('button', { name: '拒续费' }).click();
    await confirm.getByRole('button', { name: '确认', exact: true }).click();
    await row('QA-REFUSE').waitFor({ state: 'hidden' });
    await tab(/^已处理/);
    await row('QA-REFUSE').getByText('已拒续', { exact: true }).waitFor();
    assert.equal((await read()).data.renewalWarningHours, 25);
    await row('QA-REFUSE').getByRole('button', { name: '恢复提醒' }).click();
    await confirm.getByRole('button', { name: '确认', exact: true }).click();
    await row('QA-REFUSE').waitFor({ state: 'hidden' });
    await tab(/^即将到期/);
    await row('QA-REFUSE').getByRole('button', { name: '拒续费' }).waitFor();
    await tab(/^已到期/);
    await row('QA-EXPIRED').getByRole('button', { name: '续费', exact: true }).click();
    const form = page.locator('#commerce-order-form');
    await form.waitFor();
    assert.equal(await form.locator('#commerce-customerId').inputValue(), 'qa-renew');
    assert.equal(await form.locator('#commerce-email').inputValue(), 'QA-EXPIRED@example.test');
    const period = async (start, end) => {
      const input = form.locator('#commerce-start');
      await input.fill(start);
      await input.dispatchEvent('change');
      assert.equal(await form.locator('#commerce-expiry').inputValue(), end);
    };
    await period('2026-10-13T14:35', '2026-11-13T14:35');
    await period('2028-01-31T14:35', '2028-02-29T14:35');
    await period('2026-11-06T15:59', '2026-12-06T15:59');
    await page.getByRole('button', { name: '保留待补全' }).click();
    await confirm.getByRole('button', { name: '确认保存' }).click();
    await page.waitForURL('**/#/workspace/renewals', { timeout: 5500 }).catch(async (error) => {
      throw new Error(`待补全保存未返回续费管理：${await page.locator('#toast').textContent()}`, { cause: error });
    });
    await row('QA-EXPIRED').getByRole('button', { name: '续费', exact: true }).click();
    await period('2026-11-06T15:59', '2026-12-06T15:59');
    await form.locator('#commerce-cardId').fill('qa-card');
    await form.locator('#commerce-paymentId').fill('123456');
    await form.locator('#commerce-paidAmount').fill('20');
    await form.locator('#commerce-saleAmount').fill('180');
    await form.getByLabel('代付已确认').check();
    await page.getByRole('button', { name: '核对并保存' }).click();
    await confirm.getByRole('button', { name: '确认保存' }).click();
    await page.waitForURL('**/#/workspace/renewals', { timeout: 5500 });
    await completed();
    const snapshot = await read();
    const newOrder = snapshot.data.orders.find((item) => item.orderNo.startsWith('OD-LOCAL-') && item.paidConfirmed);
    assert.equal(newOrder.expiry, '2026-12-06T15:59');
    assert.equal(snapshot.data.orders.find((item) => item.id === 'QA-EXPIRED').expiry, '2026-11-05T14:35');
    await page.getByRole('link', { name: '客户流失' }).click();
    await loss.getByText('换号客户丙', { exact: true }).waitFor();
    assert.equal(await loss.getByText(/续费客户甲|拒续客户乙/).count(), 0);
    await loss.getByRole('button', { name: '历史订单' }).click();
    await drawer.getByText('QA-LOST', { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    snapshot.data.orders.push(order('QA-REJOIN', '', '2026-12-06T16:00', {
      start: '2026-11-06T15:30', wechat: 'qa-rejoin-chat', product: 'Claude Pro', plan: 'Pro'
    }));
    await write(snapshot.version, snapshot.data);
    await page.reload();
    await loss.waitFor();
    assert.equal(await loss.getByText('换号客户丙', { exact: true }).count(), 0);
    await page.getByRole('link', { name: /^续费管理/ }).click();
    await page.getByText('提前 1 天 1 小时提醒', { exact: true }).waitFor();
    await completed();
    await tab(/^即将到期/);
    await page.getByLabel('产品', { exact: true }).selectOption('Gemini');
    await page.getByText('订单待接入', { exact: true }).waitFor();
    for (const [dayCount, hourCount, label] of [[0, 23, '23 小时'], [3, 12, '3 天 12 小时']]) {
      await page.getByRole('button', { name: '提醒设置' }).click();
      await days.fill(String(dayCount));
      await hours.fill(String(hourCount));
      await drawer.getByRole('button', { name: '保存设置' }).click();
      await page.getByText(`提前 ${label}提醒`, { exact: true }).waitFor();
      assert.equal((await read()).data.renewalWarningHours, dayCount * 24 + hourCount);
    }
    await page.setViewportSize({ width: 390, height: 850 });
    await page.locator('#theme-toggle').click();
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
  } finally {
    await browser?.close();
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

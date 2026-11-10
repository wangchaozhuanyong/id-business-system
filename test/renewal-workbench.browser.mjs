import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createLocalBusinessStore, handleLocalBusiness } from '../server/local-business.mjs';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

test('renewal workbench persists decisions, creates a new order and projects customer loss', { timeout: 45000 }, async () => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const store = createLocalBusinessStore(':memory:');
  const actor = { id: 'renewal-qa', name: '合成管理员', role: 'admin' };
  const api = '/api/local/commerce';
  const commerceRequest = async (method, data) => {
    const request = Object.assign(Readable.from(data ? [Buffer.from(JSON.stringify(data))] : []), {
      method, url: api, headers: { origin, 'content-type': 'application/json' }
    });
    let status, json;
    const response = {
      setHeader() {},
      writeHead(code) { status = code; },
      end(body) { json = JSON.parse(body); }
    };
    await handleLocalBusiness(request, response, api, store, actor, { publicOrigin: origin });
    return { status, json };
  };
  let browser;
  try {
    browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const offline = await interceptDesign(context, { localFixtures: {}, actor });
    await context.route('**' + api, async route => {
      const request = route.request();
      await route.fulfill(await commerceRequest(request.method(), request.postDataJSON()));
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5500);
    const write = async (version, data) => {
      const response = await commerceRequest('PUT', { version, data });
      assert.equal(response.status, 200, JSON.stringify(response.json));
    };
    const read = async () => (await commerceRequest('GET')).json;
    const order = (id, customerId, expiry, extra = {}) => ({
      id, orderNo: id, customerId, expiry, email: id + '@example.test',
      product: 'GPT', plan: 'Plus', businessType: '续费', start: '2026-10-07T16:00',
      paidConfirmed: true, payment: '银行卡', paidAmount: '20', paidCurrency: 'USD',
      paymentId: '', cardId: '', saleAmount: '180', saleCurrency: 'CNY', version: 1,
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
    await page.goto(origin + '/#/workspace/renewals');
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
    await page.locator('#toast').filter({ hasText: '订单提交成功' }).waitFor();
    assert(new URL(page.url()).hash.startsWith('#/workspace/order/renew/'));
    await page.getByRole('button', { name: '返回续费管理', exact: true }).click();
    await form.waitFor({ state: 'hidden' });
    await row('QA-EXPIRED').getByRole('button', { name: '续费', exact: true }).click();
    await period('2026-11-06T15:59', '2026-12-06T15:59');
    assert.equal(await form.locator('#commerce-cardId').inputValue(), '');
    await form.locator('#commerce-paidAmount').fill('20');
    await form.locator('#commerce-saleAmount').fill('180');
    await form.getByLabel('代付已确认').check();
    await page.getByRole('button', { name: '核对并保存' }).click();
    await confirm.getByRole('button', { name: '确认保存' }).click();
    await page.locator('#toast').filter({ hasText: '订单提交成功' }).waitFor();
    assert(new URL(page.url()).hash.startsWith('#/workspace/order/renew/'));
    await page.getByRole('button', { name: '返回续费管理', exact: true }).click();
    await form.waitFor({ state: 'hidden' });
    await completed();
    const snapshot = await read();
    const newOrder = snapshot.data.orders.find((item) => item.id !== 'QA-EXPIRED' && item.customerId === 'qa-renew' && item.paidConfirmed);
    assert.equal(newOrder.expiry, '2026-12-06T15:59');
    assert.equal(newOrder.cardId, '');
    assert.equal(newOrder.issueFeeSnapshot.pending, true);
    assert.equal(snapshot.data.orders.find((item) => item.id === 'QA-EXPIRED').expiry, '2026-11-05T14:35');
    const sidebar = page.locator('#sidebar');
    await sidebar.getByRole('button', { name: '数据管理', exact: true }).click();
    await sidebar.locator('[data-group="数据管理"] + .nav-children')
      .getByRole('link', { name: '客户流失', exact: true }).click();
    await loss.getByText('换号客户丙', { exact: true }).waitFor();
    assert.equal(await page.locator('#breadcrumbs').innerText(), '数据管理');
    assert.equal(await loss.getByText(/续费客户甲|拒续客户乙/).count(), 0);
    await loss.getByRole('button', { name: '订阅历史' }).click();
    const lostOrder = snapshot.data.orders.find(item => item.id === 'QA-LOST');
    await drawer.getByText(lostOrder.orderNo, { exact: true }).waitFor();
    await page.keyboard.press('Escape');
    snapshot.data.orders.push(order('QA-REJOIN', '', '2026-12-06T16:00', {
      start: '2026-11-06T15:30', wechat: 'qa-rejoin-chat', product: 'Claude Pro', plan: 'Pro', proMaterialMode: 'none'
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
    assert.deepEqual(offline.external, []);
  } finally {
    await browser?.close();
    store.close();
  }
});

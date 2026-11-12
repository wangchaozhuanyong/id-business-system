import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createLocalBusinessStore, handleLocalBusiness } from '../server/local-business.mjs';
import { createCardManagementHandler } from '../server/card-management.mjs';
import { createSubscriptionHandler } from '../server/subscription-management.mjs';
import { interceptDesign, origin, toggleDesignTheme } from './helpers/offline-design.mjs';

test('renewal workbench persists decisions, creates a new order and projects customer loss', { timeout: 45000 }, async () => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const store = createLocalBusinessStore(':memory:');
  const actor = { id: 'renewal-qa', name: '合成管理员', role: 'admin' };
  const api = '/api/local/commerce';
  const clock = () => Date.parse('2026-11-06T08:00:00Z');
  const cards = createCardManagementHandler({ store, publicOrigin: origin, clock });
  const subscriptions = createSubscriptionHandler({ store, publicOrigin: origin, clock });
  const commerce = (req, res, path, user) => handleLocalBusiness(req, res, path, store, user, { publicOrigin: origin });
  const commerceRequest = async (method, data, path = api, handler = commerce) => {
    const request = Object.assign(Readable.from(data ? [Buffer.from(JSON.stringify(data))] : []), {
      method, url: path, headers: { origin, 'content-type': 'application/json' }
    });
    let status, json;
    const response = {
      setHeader() {},
      writeHead(code) { status = code; },
      end(body) { json = JSON.parse(body); }
    };
    await handler(request, response, path, actor);
    return { status, json };
  };
  let browser;
  try {
    browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const offline = await interceptDesign(context, { localFixtures: {}, actor, skipRechargeAssets: true });
    await context.grantPermissions(['clipboard-read', 'clipboard-write'], { origin });
    for (const [pattern, handler] of [[api, commerce], ['/api/local/subscriptions/*', subscriptions],
      ['/api/local/subscription-renewal-card', cards], ['/api/local/subscription-card-status', cards]]) {
      await context.route('**' + pattern, async route => {
        const request = route.request();
        await route.fulfill(await commerceRequest(request.method(), request.postDataJSON(), new URL(request.url()).pathname, handler));
      });
    }
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(5500);
    const responses = [];
    page.on('response', async response => {
      if (response.url().endsWith(api) && response.request().method() === 'PUT')
        responses.push({ status: response.status(), error: (await response.json()).error });
    });
    const write = async (version, data) => {
      const response = await commerceRequest('PUT', { version, data });
      assert.equal(response.status, 200, JSON.stringify(response.json));
    };
    const read = async () => (await commerceRequest('GET')).json;
    const order = (id, customerId, expiry, extra = {}) => ({
      id, orderNo: id, customerId, expiry, email: id + '@example.test',
      product: 'GPT', plan: 'Plus', source: '历史入库', businessType: '续费', start: '2026-10-07T16:00',
      paidConfirmed: true, receiptConfirmed: true, entitlementStatus: 'active',
      payment: '银行卡', paidAmount: '20', paidCurrency: 'USD',
      paymentId: '', cardId: '', saleAmount: '180', saleCurrency: 'CNY', version: 1,
      ...extra
    });
    await write(0, {
      customers: [
        { id: 'qa-renew', name: '续费客户甲', phone: '01012345678', telegram: '@qa_customer', active: true, version: 1 },
        { id: 'qa-refuse', name: '拒续客户乙', phone: '01012345679', active: true, version: 1 },
        { id: 'qa-rejoin', name: '换号客户丙', wechat: 'qa-rejoin-chat', active: true, version: 1 }
      ],
      orders: [
        order('QA-EXPIRED', 'qa-renew', '2026-11-05T14:35', { telegram: '@qa_order_old' }),
        order('QA-REFUSE', 'qa-refuse', '2026-11-07T17:00', { telegram: '@qa_order_only' }),
        order('QA-SOON', 'qa-refuse', '2026-11-06T16:30'),
        order('QA-LOST', 'qa-rejoin', '2026-11-01T16:00'),
        order('QA-NO-EMAIL', 'qa-renew', '2026-12-22T16:00', {
          email: '', paymentId: '0002', proMaterialMode: 'manual_card', proCardNumber: '4000000000000002'
        })
      ],
      tenants: [], operating: [], rentBatches: [], logs: [], renewalWarningDays: 1
    });
    await page.clock.setFixedTime(new Date('2026-11-06T08:00:00Z'));
    await page.goto(origin + '/#/workspace/renewals');
    const drawer = page.locator('#drawer');
    const confirm = page.locator('#confirm-dialog');
    const list = page.locator('[data-renewal-scroll]');
    const detail = page.getByRole('region', { name: '当前选中客户' });
    const loss = page.locator('table[data-table="commerce-customer-loss"]');
    const row = (id) => list.locator(`button[data-id="${id}"]`);
    const select = async id => {
      await row(id).click();
      await detail.getByRole('heading', { name: /客户/ }).waitFor();
      assert.equal(await row(id).getAttribute('aria-pressed'), 'true');
    };
    const tab = (name) => page.getByRole('tab', { name }).click();
    const completed = async () => {
      await tab(/^已处理/);
      await row('QA-EXPIRED').getByText('已续费', { exact: true }).waitFor();
    };
    await tab(/^即将到期/);
    await page.getByText('提前 1 天提醒', { exact: true }).waitFor();
    assert.equal(await row('QA-REFUSE').count(), 0);
    assert.equal(await page.locator('table[data-table="commerce-renewals"]').count(), 0);
    assert.equal(await detail.getByRole('button', { name: '续费', exact: true }).count(), 0);
    await row('QA-SOON').getByText('剩余不足 1 小时', { exact: true }).waitFor();
    await page.getByRole('button', { name: '提醒设置' }).click();
    const days = drawer.getByLabel('提前天数');
    const hours = drawer.getByLabel('提前小时数');
    assert.equal(await days.inputValue(), '1');
    assert.equal(await hours.inputValue(), '0');
    await hours.fill('1');
    await drawer.getByRole('button', { name: '保存设置' }).click();
    await row('QA-REFUSE').getByText('剩余 1 天 1 小时', { exact: true }).waitFor();
    const search = page.locator('#commerce-search');
    await search.fill('@qa_order_only');
    await row('QA-SOON').waitFor({ state: 'hidden' });
    await select('QA-REFUSE');
    await detail.getByText('@qa_order_only').waitFor();
    await search.fill('');
    await select('QA-SOON');
    assert.equal(await detail.getByText('@qa_order_only').count(), 0);
    await select('QA-REFUSE');
    await detail.getByRole('button', { name: '拒续费' }).click();
    await confirm.getByRole('button', { name: '确认', exact: true }).click();
    await row('QA-REFUSE').waitFor({ state: 'hidden' });
    await tab(/^已处理/);
    await row('QA-REFUSE').getByText('已拒续', { exact: true }).waitFor();
    assert.equal((await read()).data.renewalWarningHours, 25);
    await select('QA-REFUSE');
    await detail.getByRole('button', { name: '恢复提醒' }).click();
    await confirm.getByRole('button', { name: '确认', exact: true }).click();
    await row('QA-REFUSE').waitFor({ state: 'hidden' });
    await tab(/^即将到期/);
    await row('QA-REFUSE').waitFor();
    assert.equal(await detail.getByRole('button', { name: '拒续费' }).count(), 0, '切换不会自动选中下一笔');
    await tab(/^已到期/);
    await row('QA-EXPIRED').getByText('已过期 1 天 1 小时', { exact: true }).waitFor();
    await select('QA-EXPIRED');
    await detail.getByText('@qa_customer').waitFor();
    await page.getByRole('button', { name: '续费联系后缀' }).click();
    await drawer.getByLabel('后缀文字').fill('合成续费询问。');
    await drawer.getByRole('button', { name: '保存后缀' }).click();
    await detail.getByRole('button', { name: '复制联系资料' }).click();
    await page.locator('#toast').getByText(/已复制.*续费资料/).waitFor();
    assert.match(await page.evaluate(() => navigator.clipboard.readText()), /客户：续费客户甲[\s\S]*合成续费询问/);
    const bind = detail.getByRole('button', { name: '绑定银行卡' });
    assert.equal(await detail.getByRole('button', { name: '复制银行卡' }).count(), 0);
    await bind.click();
    await drawer.getByLabel('或输入银行卡号').fill('4242424242424242');
    await drawer.getByRole('button', { name: '保存绑定' }).click();
    await detail.getByRole('button', { name: '复制银行卡' }).click();
    await confirm.getByText(/续费客户甲.*QA-EXPIRED@example.test.*卡尾号 4242/i).waitFor();
    assert.equal((await page.evaluate(() => navigator.clipboard.readText())).includes('4242424242424242'), false);
    await confirm.getByRole('button', { name: '确认复制' }).click();
    await page.locator('#toast').getByText(/已复制.*银行卡/).waitFor();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '4242424242424242');
    await detail.getByRole('button', { name: '续费', exact: true }).click();
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
    assert.equal(await page.getByRole('button', { name: '保留待补全' }).count(), 0);
    assert.equal(await form.locator('#commerce-cardId').inputValue(), '');
    await form.locator('#commerce-paidAmount').fill('20');
    await form.locator('#commerce-saleAmount').fill('180');
    assert.equal(await form.locator('[name="commerce-paidConfirmed"], [name="commerce-receiptConfirmed"]').count(), 0);
    await page.getByRole('button', { name: '确认提交', exact: true }).click();
    assert.equal(await page.locator('#confirm-dialog[open]').count(), 0);
    await page.locator('#toast').filter({ hasText: '订单提交成功' }).waitFor().catch(async issue => {
      const fieldErrors = await form.locator('.field-error:not([hidden])').allTextContents();
      throw new Error(JSON.stringify({ responses, fieldErrors, toast: await page.locator('#toast').textContent(), errors }), { cause: issue });
    });
    assert(new URL(page.url()).hash.startsWith('#/workspace/order/renew/'));
    await page.getByRole('button', { name: '返回续费管理', exact: true }).click();
    await form.waitFor({ state: 'hidden' });
    await completed();
    const snapshot = await read();
    const newOrder = snapshot.data.orders.find((item) => item.id !== 'QA-EXPIRED' && item.customerId === 'qa-renew' && item.paidConfirmed);
    assert.equal(newOrder.expiry, '2026-12-06T15:59');
    assert.equal(newOrder.receiptConfirmed, true);
    assert.equal(newOrder.cardId, '');
    assert.equal(newOrder.previousOrderId, 'QA-EXPIRED');
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
    await sidebar.getByRole('button', { name: '快速操作', exact: true }).click();
    await sidebar.getByRole('link', { name: /^续费管理/ }).click();
    await page.getByText('提前 1 天 1 小时提醒', { exact: true }).waitFor();
    await completed();
    await tab(/^即将到期/);
    await page.getByLabel('产品', { exact: true }).selectOption('Gemini');
    assert.equal(await list.locator('button[data-id]').count(), 0);
    for (const [dayCount, hourCount, label] of [[0, 23, '23 小时'], [3, 12, '3 天 12 小时']]) {
      await page.getByRole('button', { name: '提醒设置' }).click();
      await days.fill(String(dayCount));
      await hours.fill(String(hourCount));
      await drawer.getByRole('button', { name: '保存设置' }).click();
      await page.getByText(`提前 ${label}提醒`, { exact: true }).waitFor();
      assert.equal((await read()).data.renewalWarningHours, dayCount * 24 + hourCount);
    }
    await page.setViewportSize({ width: 390, height: 850 });
    await toggleDesignTheme(page);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    await page.getByLabel('产品', { exact: true }).selectOption('');
    await row('QA-REFUSE').getByText('剩余 1 天 1 小时', { exact: true }).waitFor();
    await select('QA-REFUSE');
    await detail.getByText('2026-11-07 17:00', { exact: true }).waitFor();
    await detail.getByText('@qa_order_only').waitFor();
    await detail.getByRole('button', { name: '返回待办' }).click();
    await row('QA-REFUSE').waitFor();
    await page.clock.setFixedTime(new Date('2026-11-06T08:30:00Z'));
    await tab(/^已到期/);
    await row('QA-SOON').getByText('已过期不足 1 小时', { exact: true }).waitFor();
    await page.goto(origin + '/#/data-management/bank-cards');
    await page.waitForURL('**/#/subscriptions/bank-cards');
    const groupedCard = page.locator('table[data-table="commerce-bank-card-groups"] tr[data-row-id]')
      .filter({ hasText: '尾号 0002' });
    await groupedCard.getByRole('button', { name: '查看订阅及余额', exact: true }).click();
    const storedNoEmail = (await read()).data.orders.find(order => order.id === 'QA-NO-EMAIL');
    const linked = drawer.locator('tr[data-row-id="QA-NO-EMAIL"] [data-column="account"]');
    await linked.waitFor({ state: 'attached' });
    assert.equal((await linked.textContent()).trim(), storedNoEmail.orderNo);
    assert.deepEqual(errors, []);
    assert.deepEqual(offline.external, []);
  } finally {
    await browser?.close();
    store.close();
  }
});

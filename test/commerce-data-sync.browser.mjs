import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

const actor = { id: 'sync-test-admin', name: '合成管理员', role: 'admin' };
const instant = Date.parse('2026-11-10T12:00:00Z');

test('银行卡与续费资料跟随版本通知更新，同时保留订单价格更新', { timeout: 60_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());

  for (const [width, theme] of [[1440, 'light'], [390, 'dark']]) {
    await t.test(`${width}px ${theme}`, async () => {
      const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
      const { customers, orders } = fixture.commerce.data;
      const order = { ...orders[0], id: 'sync-test-order', orderNo: 'SYNC-TEST-ORDER',
        customerId: customers[0].id, email: 'sync-test@example.test', cardId: 'recharge:7',
        payment: '银行卡', paymentId: '4242', product: 'GPT', plan: 'Plus', businessType: '续费',
        accountSource: '客户自有', paidConfirmed: true, paidAmount: '10000', paidCurrency: 'PHP',
        start: new Date(instant - 48 * 3600_000).toISOString(),
        expiry: new Date(instant + 24 * 3600_000).toISOString(), version: 1,
        cancelled: false, corrections: [], financialEvidence: [] };
      fixture.commerce.data.orders = [order];
      fixture.commerce.data.renewalWarningHours = 72;
      fixture.settings.data.orderPrices = { GPT: { Plus: { CNY: '101' } } };
      fixture['card-types'] = { version: 1, items: [{ id: 'sync-card', name: '原银行卡类型', active: true }],
        assignments: { 'recharge:7': 'sync-card' } };
      fixture['subscription-card-estimates'] = { items: [{ id: order.id, version: 1, amount: '10000',
        currency: 'PHP', usd: '175.92', fixedFee: '0.30', bufferUsd: '2.00',
        expiresAt: new Date(instant + 48 * 3600_000).toISOString() }] };
      const context = await browser.newContext({ viewport: { width, height: 900 }, locale: 'zh-CN' });
      try {
        const mock = await interceptDesign(context, { localFixtures: fixture, actor, changeEvents: true, skipRechargeAssets: true });
        await context.addInitScript(() => {
          const fetchOriginal = window.fetch.bind(window);
          window.emitRevision = versions => window.changeController.enqueue(new TextEncoder().encode(
            `event: change\ndata: ${JSON.stringify({ schema: 1, versions })}\n\n`));
          window.fetch = (input, options) => {
            if (new URL(String(input), location.href).pathname !== '/api/local/change-events')
              return fetchOriginal(input, options);
            return Promise.resolve(new Response(new ReadableStream({ start(controller) {
              window.changeController = controller;
              controller.enqueue(new TextEncoder().encode('event: snapshot\ndata: ' + JSON.stringify({
                schema: 1, versions: { settings: '1', 'card-types': '1', 'finance-rates': '1' }
              }) + '\n\n'));
              options.signal.addEventListener('abort', () => {
                try { controller.error(new DOMException('aborted', 'AbortError')); } catch {}
              }, { once: true });
            } }), { headers: { 'content-type': 'text/event-stream' } }));
          };
        });
        let detailAmount = '22.30';
        let detailReads = 0;
        let workbenchAmount = '20.10', workbenchReads = 0, workbenchDelay, failWorkbench = false;
        let failEstimates = false;
        await context.route(/\/api\/local\/subscription-card-estimates(?:\?|$)/, route => failEstimates
          ? route.fulfill({ status: 503, json: { error: '合成读取失败' } }) : route.fallback());
        await context.route('**/api/local/subscription-renewal-card', async route => {
          const input = route.request().postDataJSON();
          assert.equal(input.action, 'prepare');
          if (input.orderId !== order.id)
            return route.fulfill({ status: 404, json: { error: '合成订单不存在' } });
          workbenchReads++;
          const usd = workbenchAmount;
          const delay = workbenchDelay;
          if (delay) { workbenchDelay = undefined; delay.started.resolve(); await delay.release.promise; }
          return failWorkbench ? route.fulfill({ status: 503, json: { error: '合成用卡资料读取失败' } }) :
            route.fulfill({ json: { orderId: order.id, hasCard: true, last4: '4242', estimate: { usd } } });
        });
        await context.route('**/api/local/subscription-card-details', route => {
          assert.deepEqual(route.request().postDataJSON(), { orderId: order.id });
          detailReads++;
          return route.fulfill({ json: { order: { id: order.id, version: 1, orderNo: order.orderNo,
            payment: '银行卡', account: { email: order.email, source: '客户自有', status: '由客户管理' },
            card: { source: '充值卡池', typeName: fixture['card-types'].items[0].name,
              last4: '4242', status: '可用', canReveal: false,
              estimate: { amount: '20', currency: 'USD', fixedFee: '0.30', bufferUsd: '2.00', usd: detailAmount } }
          }, renewal: null } });
        });
        const page = await context.newPage();
        page.setDefaultTimeout(6000);
        await page.clock.setFixedTime(new Date(instant));
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(origin + '/#/workspace/order/gpt');
        await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
        await page.waitForFunction(() => document.querySelector('#commerce-saleAmount')?.value === '101');
        const go = async route => {
          await page.evaluate(value => window.IDDesignAPI.go(value), route);
          await page.locator(`#main[data-layout-route="${route}"]`).waitFor();
        };
        const idle = () => page.waitForFunction(() => {
          const state = window.IDChangeSync?.status();
          return state?.connected && state.snapshots > 0 && !state.refreshing && !state.pending;
        });
        await go('subscriptions/bank-cards');
        await page.locator('[data-action="commerce-subscription-card-tab"][data-tab="orders"]').click();
        await idle();
        const card = page.locator('table[data-table="commerce-subscription-cards"] [data-row-id="sync-test-order"]');
        const cardData = async label => {
          const cell = card.getByText(label, { exact: true });
          await cell.waitFor({ state: 'attached' });
          if (!await cell.isVisible()) await card.getByRole('button', { name: '更多资料', exact: true }).click();
          await cell.waitFor();
        };
        await cardData('175.92 USD');
        assert.equal(await card.getByText('原银行卡类型', { exact: true }).count(), 1);

        fixture.settings.version = 2;
        fixture.settings.data.orderPrices.GPT.Plus.CNY = '202';
        fixture['card-types'].version = 2;
        fixture['card-types'].items[0].name = '更新后的银行卡类型';
        fixture['subscription-card-estimates'].items[0].usd = '188.88';
        await page.evaluate(() => window.emitRevision({ settings: '2', 'card-types': '2', 'finance-rates': '2' }));
        await cardData('188.88 USD');
        await cardData('更新后的银行卡类型');
        await idle();

        failEstimates = true;
        fixture['subscription-card-estimates'].items[0].usd = '199.99';
        await page.evaluate(() => window.emitRevision({ 'finance-rates': '3' }));
        await page.waitForFunction(() => window.IDChangeSync.status().pending > 0 &&
          !window.IDChangeSync.status().refreshing);
        await page.getByText('部分银行卡类型或预计金额暂时无法读取').waitFor();
        failEstimates = false;
        await page.evaluate(() => window.emitRevision({ 'finance-rates': '4' }));
        await cardData('199.99 USD');
        await idle();

        await go('workspace/order/gpt');
        await page.locator('#commerce-order-form').getByRole('button', { name: '选择售卖金额', exact: true }).click();
        await page.getByRole('menu', { name: '选择售卖金额', exact: true })
          .getByRole('menuitem', { name: '使用预设 202 CNY', exact: true }).waitFor();
        await page.keyboard.press('Escape');

        await go('workspace/renewals');
        await page.locator('[data-action="commerce-renewal-select"][data-id="sync-test-order"]').click();
        const workbench = page.locator('.renewal-workbench-detail');
        await workbench.getByText('20.10 USD', { exact: true }).waitFor();
        await workbench.getByRole('button', { name: '用卡详情', exact: true }).click();
        const panel = page.locator('#drawer[open] #commerce-renewal-card-panel');
        await panel.getByText('22.30 USD', { exact: true }).waitFor();
        const previousReads = detailReads, previousWorkbench = workbenchReads;
        detailAmount = '33.40';
        workbenchAmount = '24.70';
        await page.evaluate(() => window.emitRevision({ 'finance-rates': '5' }));
        await panel.getByText('33.40 USD', { exact: true }).waitFor();
        await workbench.getByText('24.70 USD', { exact: true }).waitFor();
        await idle();
        assert.ok(detailReads > previousReads, '汇率更新后重新读取当前订单的银行卡详情');
        assert.equal(workbenchReads, previousWorkbench + 1);
        await page.locator('#drawer[open] [data-action="drawer-close"]').first().click();
        failWorkbench = true;
        await page.evaluate(() => window.emitRevision({ 'finance-rates': '6' }));
        await workbench.getByText('续费用卡资料读取失败。已保留上次读取的资料。').waitFor();
        assert.equal(await workbench.getByText('24.70 USD', { exact: true }).isVisible(), true);
        failWorkbench = false;
        const delayed = workbenchDelay = { started: Promise.withResolvers(), release: Promise.withResolvers() };
        workbenchAmount = '25.00';
        await page.evaluate(() => window.emitRevision({ 'finance-rates': '7' }));
        await delayed.started.promise;
        workbenchAmount = '26.30';
        await page.evaluate(() => window.emitRevision({ 'finance-rates': '8' }));
        delayed.release.resolve();
        await workbench.getByText('26.30 USD', { exact: true }).waitFor();
        await idle();
        assert.equal(await workbench.getByText('25.00 USD', { exact: true }).count(), 0);
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
        assert.deepEqual(errors, []);
        assert.deepEqual(mock.external, []);
        await page.evaluate(() => window.IDChangeSync.stop());
      } finally { await context.close(); }
    });
  }
});

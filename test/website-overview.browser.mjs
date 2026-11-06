import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { startPreview } from '../server/preview.mjs';
import { createOrderSnapshot } from '../modules/finance/accounting.mjs';

test('网站总览真实汇总、失败恢复、入口、占位、权限和响应式', { timeout: 90_000 }, async t => {
  assert(process.env.ID_RECHARGE_QA_PLAYWRIGHT, '请指定已有 Playwright 模块');
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const host = await startPreview(0, { databasePath: ':memory:' });
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(async () => {
    await browser.close();
    host.server.closeAllConnections();
    await new Promise(resolve => host.server.close(resolve));
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.setDefaultTimeout(6000);
  const errors = [];
  const writes = [];
  const origin = new URL(host.url).origin;
  page.on('pageerror', error => errors.push(error.message));
  await page.route('**/*', route => {
    const request = route.request();
    if (!['GET', 'HEAD'].includes(request.method())) writes.push(request.url());
    return new URL(request.url()).origin === origin && ['GET', 'HEAD'].includes(request.method())
      ? route.continue() : route.abort();
  });
  const clock = Date.now();
  const instant = offset => new Date(clock + offset * 86_400_000).toISOString();
  const order = {
    id: 'overview-order', product: 'GPT', customerId: 'overview-customer', email: 'fixture@example.test',
    payment: '银行卡', paymentId: '000000', cardId: 'fixture-card',
    paidAmount: '1000', paidCurrency: 'PHP', saleAmount: '250', saleCurrency: 'CNY',
    createdAt: instant(0), start: instant(-1), expiry: instant(1), costBasis: 'standard',
    receiptConfirmed: true, paidConfirmed: true, costConfirmed: true,
    costSettings: { version: 1, cardPercent: '0.008', cardPerPaymentUsd: '0.3', cardIssueUsd: '0.5' },
    issueFeeSnapshot: { applied: true, amountUsd: '0.5' },
    refunds: [{ id: 'refund-a', amount: '50', currency: 'CNY', at: instant(0) }], bankReturns: []
  };
  order.fxSnapshot = createOrderSnapshot({
    source: '隔离测试凭据', at: instant(-2), expiresAt: instant(0), rates: { MYR: '1.6', USD: '7.2', PHP: '0.125' }
  }, order, clock);
  const previous = { ...order, id: 'previous-order', customerId: 'previous-customer',
    email: 'previous@example.test', createdAt: instant(-1), start: instant(-32), expiry: instant(-2),
    saleCurrency: 'MYR', saleAmount: '0.33', refunds: [], fxSnapshot: null };
  const commerceData = {
    customers: [{ id: order.customerId, createdAt: instant(0) }, { id: previous.customerId, createdAt: instant(-1) }],
    orders: [order, previous, { ...order, id: 'cancelled', cancelled: true, refunds: [] }]
  };
  let mode = 'success';
  const releaseRefresh = Promise.withResolvers();
  await page.route('**/api/local/commerce', async route => {
    if (mode === 'delay') {
      await releaseRefresh.promise;
      return route.fulfill({ status: 503, json: {} });
    }
    return route.fulfill({ json: { version: 1, data: commerceData } });
  });
  await page.route('**/api/local/inventory', route => route.fulfill({ json: { version: 1, data: {
    mailboxes: [{ id: 'a', type: 'google' }, { id: 'b', type: 'google', inventoryState: 'claimed' },
      { id: 'c', type: 'relay', health: 'dead' }],
    accounts: [{ id: 'gpt', type: 'gpt' }, { id: 'claude', type: 'claude', registered: instant(0) }],
    batches: [{ id: 'batch', kind: 'mail', items: [{ id: 'claim', assetId: 'b', status: 'pending' }] }]
  } } }));
  await page.route('**/api/local/appleBalance', route => route.fulfill({ json: { version: 1, data: {
    refunds: [{ id: 'pending-refund', status: 'pending' }, { id: 'closed-refund', status: 'received' }]
  } } }));
  const refresh = page.locator('[data-action="overview-refresh"]');
  const settled = () => page.locator('[data-action="overview-refresh"]:enabled').waitFor();
  const go = async route => {
    await page.evaluate(route => { location.hash = '#/' + route; }, route);
    await page.locator(`#main[data-layout-route="${route}"]`).waitFor();
  };
  await page.goto(host.url + '#/overview');
  await settled();
  assert.equal(await page.getByRole('heading', { name: '网站总览', exact: true }).count(), 1);
  assert.equal(await page.locator('#sidebar a[href="#/overview"]').innerText(), '网站总览');
  const values = () => page.locator('.overview-metric-value strong').allTextContents();
  assert.deepEqual(await values(), ['2', '250.00 CNY / 0.33 MYR', '68.24', '2']);
  assert.deepEqual(await page.locator('.overview-task-count').allTextContents(), ['2', '0', '1', '1']);
  assert.deepEqual(await page.locator('.overview-customer-summary strong').allTextContents(), ['1', '2', '1']);
  assert.deepEqual(await page.locator('.overview-stock-table tbody tr').first().locator('td').allTextContents(), ['1', '1', '0']);
  assert.deepEqual(await page.locator('.overview-stock-table tbody tr').nth(1).locator('td').allTextContents(), ['需核验', '0', '1']);
  assert.match(await page.locator('.overview-metric-footer').nth(1).innerText(), /退款 50.00 CNY/);
  assert.match(await page.locator('.overview-metric-footer').nth(2).innerText(), /待核算 1 笔/);
  await page.getByRole('button', { name: '今日', exact: true }).click();
  assert.deepEqual(await values(), ['1', '250.00 CNY', '68.24', '1']);
  assert.equal(await page.locator('.overview-chart-data g').count(), 1);
  mode = 'delay';
  const metricsBox = await page.locator('.overview-metrics').boundingBox();
  try {
    await refresh.click();
    const progress = page.locator('[data-overview-progress]');
    await progress.waitFor();
    assert.equal(await progress.textContent(), '');
    assert((await progress.boundingBox()).height <= 3);
    assert.equal(await refresh.textContent(), '刷新数据');
    assert(await refresh.isDisabled());
    assert.deepEqual(await page.locator('.overview-metrics').boundingBox(), metricsBox);
    assert.deepEqual(await values(), ['1', '250.00 CNY', '68.24', '1']);
  } finally { releaseRefresh.resolve(); }
  await settled();
  assert.match(await page.locator('.overview-design-label').innerText(), /订单与客户 读取失败 · 保留/);
  mode = 'success';
  await page.getByRole('button', { name: '刷新数据', exact: true }).click();
  await settled();
  assert.doesNotMatch(await page.locator('.overview-design-label').innerText(), /读取失败/);
  assert.equal(await page.locator('[data-action="overview-plan"]').count(), 9);
  assert.equal(await page.getByText('中转脚本', { exact: true }).count(), 0);
  await page.getByRole('button', { name: '近 30 天', exact: true }).click();
  await page.locator('.overview-shortcuts a[href="#/customers/new"]').click();
  await page.locator('#commerce-contact-form').waitFor();
  await page.locator('#commerce-contact-name').fill('总览切页保留测试');
  await go('overview');
  await settled();
  assert.equal(await page.getByRole('button', { name: '近 30 天', exact: true }).getAttribute('aria-pressed'), 'true');
  await page.getByRole('button', { name: /Google 表格同步/ }).click();
  assert(await page.locator('#drawer').getByRole('heading', { name: 'Google 表格同步', exact: true }).isVisible());
  assert(await page.locator('#drawer').getByText('同步表格与范围', { exact: true }).isVisible());
  const box = await page.locator('#drawer').boundingBox();
  await page.mouse.click(box.x / 2, 500);
  await page.locator('#drawer').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '指标口径', exact: true }).click();
  await page.locator('#drawer').getByRole('heading', { name: '指标口径', exact: true }).waitFor();
  assert.match(await page.locator('#drawer').innerText(), /缺少或失效快照/);
  await page.keyboard.press('Escape');
  await page.locator('#drawer').waitFor({ state: 'hidden' });
  await go('customers/new');
  assert.equal(await page.locator('#commerce-contact-name').inputValue(), '总览切页保留测试');
  await go('overview');
  await settled();
  const knownRoutes = await page.evaluate(() => window.IDDesignAPI.navigation.flatMap(group => group[2].map(item => item[1])));
  for (const href of await page.locator('.website-overview a').evaluateAll(nodes => nodes.map(node => node.getAttribute('href'))))
    assert(knownRoutes.includes(href.slice(2)), `未知入口 ${href}`);

  for (const width of [1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width}/${theme} 横向溢出`);
      const alignment = await page.locator('.overview-columns').evaluateAll(nodes => nodes.every(node => {
        const cards = [...node.children].map(child => child.getBoundingClientRect());
        return cards[0].left === cards[1].left || Math.abs(cards[0].top - cards[1].top) < 1;
      }));
      assert(alignment, `${width}/${theme} 并排模块未对齐`);
      const before = await page.locator('.overview-metrics').boundingBox();
      await page.getByRole('button', { name: '今日', exact: true }).click();
      const after = await page.locator('.overview-metrics').boundingBox();
      assert.equal(after.width, before.width, '时间范围切换改变框架宽度');
      await page.locator('.overview-metric-label .title-help summary').first().click();
      await page.locator('.title-description:popover-open').waitFor();
      const bounds = await page.locator('.title-description:popover-open').boundingBox();
      assert(bounds.x >= 0 && bounds.x + bounds.width <= width, '指标说明越过视口');
      await page.keyboard.press('Escape');
    }
  }
  await page.evaluate(() => {
    window.IDLocalData = { ...window.IDLocalData, authRequired: true };
    window.IDDesignAPI.state.actor = { id: 'fixture-employee', role: 'employee' };
    window.IDDesignAPI.render();
  });
  assert.equal(await page.getByRole('heading', { name: '订单实收', exact: true }).count(), 0);
  assert.equal(await page.getByRole('heading', { name: '客户经营', exact: true }).count(), 0);
  assert.equal(await page.locator('.website-overview a[href="#/orders/statistics"]').count(), 0);
  assert.equal(await page.getByRole('button', { name: /Google 表格同步/ }).count(), 0);
  const inaccessible = await page.locator('.website-overview a').evaluateAll(nodes => nodes
    .filter(node => !window.IDDesignAPI.canVisit(node.getAttribute('href').slice(2))).length);
  assert.equal(inaccessible, 0);
  assert.deepEqual(writes, [], '总览设计不执行任何写入');
  assert.deepEqual(errors, []);

  const empty = await browser.newPage();
  await empty.goto(host.url + '#/overview');
  await empty.getByText('该时间范围没有订单记录', { exact: true }).waitFor();
  assert.deepEqual(await empty.locator('.overview-metric-value strong').allTextContents(), ['0', '0', '0.00', '0']);
});

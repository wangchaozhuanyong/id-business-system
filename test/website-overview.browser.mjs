import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { createOrderSnapshot } from '../modules/finance/accounting.mjs';
import { interceptDesign, origin, settle } from './helpers/offline-design.mjs';

const clock = Date.parse('2026-11-10T10:40:00+08:00');
const beijing = time => new Date(time + '+08:00').toISOString();
const refundAt = beijing('2026-11-10T08:30:00');
const base = {
  product: 'GPT', plan: 'Plus', customerId: 'customer-a', payment: '银行卡',
  paymentId: '000000', paidAmount: '1000', paidCurrency: 'PHP',
  saleAmount: '250', saleCurrency: 'CNY', start: beijing('2026-11-09T08:00:00'),
  expiry: beijing('2026-11-11T08:00:00'), costBasis: 'standard',
  receiptConfirmed: true, paidConfirmed: true, costConfirmed: true,
  costSettings: { version: 1, cardPercent: '0.008', cardPerPaymentUsd: '0.3', cardIssueUsd: '0.5' },
  issueFeeSnapshot: { applied: true, amountUsd: '0.5' }, refunds: [], bankReturns: []
};
const order = (id, createdAt, options = {}) => ({
  ...base, id, orderNo: id, email: id + '@example.test', createdAt: beijing(createdAt),
  cardId: id + '-card', issueFeeSnapshot: { ...base.issueFeeSnapshot, cardId: id + '-card' }, ...options
});
const expired = {
  start: beijing('2026-10-08T08:00:00'), expiry: beijing('2026-11-08T08:00:00')
};
const current = order('gpt-now', '2026-11-10T09:30:00', {
  refunds: [{ id: 'refund-a', amount: '50', currency: 'CNY', at: refundAt }]
});
current.fxSnapshot = createOrderSnapshot({
  source: '隔离测试凭据', at: beijing('2026-11-08T08:00:00'), expiresAt: new Date(clock).toISOString(),
  rates: { MYR: '1.6', USD: '7.2', PHP: '0.125' }
}, current, clock);
const commerceFixture = {
  customers: [
    { id: 'customer-a', createdAt: beijing('2026-11-10T00:00:00') },
    { id: 'customer-a', createdAt: beijing('2026-11-10T00:00:00') },
    { id: 'customer-b', createdAt: beijing('2026-11-09T10:40:00') },
    { id: 'prior-late-customer', createdAt: beijing('2026-11-03T10:41:00') },
    { id: 'future-customer', createdAt: beijing('2026-11-10T10:40:00.001') }
  ],
  orders: [
    current,
    order('cancelled', '2026-11-10T00:20:00', { cancelled: true }),
    order('same-time', '2026-11-09T10:40:00', {
      ...expired, product: 'Claude Max', plan: 'Max 5x', customerId: 'customer-b',
      saleAmount: '0.33', saleCurrency: 'MYR'
    }),
    order('after-yesterday-cutoff', '2026-11-09T10:40:00.001', {
      ...expired, product: 'Claude Pro', plan: 'Pro', customerId: '',
      saleAmount: '0.10', saleCurrency: 'MYR'
    }),
    order('prior-week', '2026-11-03T10:40:00', { ...expired, saleAmount: '100', customerId: '' }),
    order('after-week-cutoff', '2026-11-03T10:40:00.001', { ...expired, customerId: '' }),
    order('large-amount', '2026-10-15T08:00:00', {
      ...expired, saleAmount: '1234567890.0001', saleCurrency: 'MYR', customerId: ''
    }),
    order('outside-range', '2026-09-01T09:00:00', {
      ...expired, saleAmount: '10', saleCurrency: 'MYR', customerId: '',
      refunds: [{ id: 'historical-order-refund', amount: '1.2345', currency: 'MYR', at: refundAt }]
    }),
    order('future-in-same-hour', '2026-11-10T10:40:00.001', {
      start: beijing('2026-11-10T11:00:00'), customerId: 'future-customer', saleAmount: '777'
    })
  ]
};
const inventoryFixture = {
  mailboxes: [
    { id: 'a', type: 'google' },
    { id: 'b', type: 'google', inventoryState: 'claimed' },
    { id: 'c', type: 'relay', health: 'dead', relayStatus: 'DISABLED' },
    { id: 'relay-disabled', type: 'relay', relayStatus: 'DISABLED' },
    { id: 'd', type: 'microsoft' }
  ],
  accounts: [
    { id: 'gpt', type: 'gpt', email: 'stock-gpt@example.test' },
    { id: 'claude', type: 'claude', email: 'stock-claude@example.test', registered: new Date(clock).toISOString() },
    { id: 'claude-dead', type: 'claude', health: 'dead', status: '冻结', inventoryState: 'used' },
    { id: 'claude-unlocking', type: 'claude', health: 'unlocking', status: '封控中' },
    { id: 'claude-frozen', type: 'claude', status: '冻结' },
    { id: 'claude-restricted', type: 'claude', status: '封控中' },
    { id: 'claude-review', type: 'claude', status: '待核对' }
  ],
  batches: [{ id: 'batch', kind: 'mail', items: [{ id: 'claim', assetId: 'b', status: 'pending' }] }]
};
const appleFixture = {
  refunds: [{ id: 'pending-refund', status: 'pending' }, { id: 'closed-refund', status: 'received' }]
};

test('网站总览的经营、库存与客户统计', { timeout: 120_000 }, async t => {
  assert(process.env.ID_RECHARGE_QA_PLAYWRIGHT, '请指定已有 Playwright 模块');
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const open = async (actor, localFixtures = {}) => {
    const context = await browser.newContext({
      viewport: { width: 1440, height: 1000 }, timezoneId: 'America/Los_Angeles'
    });
    const intercepted = await interceptDesign(context, { localFixtures, actor });
    const page = await context.newPage();
    await page.clock.setFixedTime(clock);
    page.setDefaultTimeout(6000);
    const errors = [];
    const requests = [];
    page.on('pageerror', error => errors.push(error.stack));
    page.on('request', request => requests.push({ method: request.method(), path: new URL(request.url()).pathname }));
    return { page, context, errors, requests, intercepted };
  };
  const metric = (page, id) => page.locator('[data-overview-metric="' + id + '"]');
  const value = (page, id) => metric(page, id).locator('.overview-metric-value strong').innerText();
  const range = (page, label) => page.getByRole('group', { name: '统计时间范围' })
    .getByRole('button', { name: label, exact: true });
  const trend = (page, label) => page.getByRole('group', { name: '趋势指标' })
    .getByRole('button', { name: label, exact: true });
  const refreshed = page => page.locator('[data-action="overview-refresh"]:enabled').waitFor({ state: 'attached' });
  const go = async (page, route) => {
    await page.evaluate(route => { location.hash = '#/' + route; }, route);
    await page.locator('#main[data-layout-route="' + route + '"]').waitFor();
  };
  const checkTransport = ({ requests, errors, intercepted }) => {
    assert.deepEqual(requests.filter(request => !['GET', 'HEAD'].includes(request.method)), []);
    assert.deepEqual(intercepted.external, []);
    assert.deepEqual(intercepted.unavailable, []);
    assert.deepEqual(errors, []);
  };

  await t.test('区间边界、多币种、待核算、明细和分区失败', async () => {
    const session = await open();
    const { page, context } = session;
    let commerce = structuredClone(commerceFixture);
    let inventory = inventoryFixture;
    let slowCommerce;
    let failed = new Set();
    const serve = (scope, read) => page.route('**/api/local/' + scope, async route => {
      if (scope === 'commerce' && slowCommerce) await slowCommerce.promise;
      return failed.has(scope) ? route.fulfill({ status: 503, json: {} })
        : route.fulfill({ json: { version: 1, data: read() } });
    });
    await serve('commerce', () => commerce);
    await serve('inventory', () => inventory);
    await serve('appleBalance', () => appleFixture);
    await page.goto(origin + '/#/overview');
    await page.locator('.overview-chart-data').waitFor();
    await refreshed(page);
    assert.equal(await page.getByRole('heading', { name: '网站总览', exact: true }).count(), 1);
    assert.equal(await page.locator('#sidebar a[href="#/overview"]').innerText(), '网站总览');
    assert.equal(await page.locator('.website-overview').getByText('常用入口', { exact: true }).count(), 0);
    assert.equal(await page.locator('[data-action="overview-plan"]').count(), 0);
    assert.equal(await range(page, '近 7 天').getAttribute('aria-pressed'), 'true');
    assert.equal(await value(page, 'orders'), '3');
    assert.match(await metric(page, 'orders').innerText(), /较上期增加 2 笔/);
    assert.equal(await value(page, 'customers'), '2');
    assert.match(await metric(page, 'customers').innerText(), /较上期增加 2 位/);
    assert.deepEqual(await metric(page, 'receipts').locator('dt').allTextContents(), ['CNY', 'MYR']);
    assert.deepEqual(await metric(page, 'receipts').locator('dd strong').allTextContents(), ['250.00', '0.43']);
    assert.match(await metric(page, 'receipts').innerText(), /退款 50.00 CNY · 1.2345 MYR/);
    assert.equal(await value(page, 'profit'), '68.24');
    assert.match(await metric(page, 'profit').innerText(), /环比待核算 · 上期待核算 1 笔/);
    assert.match(await metric(page, 'profit').innerText(), /已核算 1 笔 · 待核算 2 笔/);
    assert.match(await metric(page, 'profit').innerText(), /含参考核算 1 笔/);
    assert.match(await page.locator('.overview-insight').innerText(), /Claude Pro（增加 1 笔）/);
    assert.equal(await page.locator('.overview-chart-data g').count(), 7);
    assert.equal(await page.locator('.overview-bar-cancelled').count(), 7);
    const productRows = page.locator('.overview-product-table tbody tr');
    assert.deepEqual(await productRows.first().locator('td').allTextContents(), ['1', '33.3%', '68.24', '0']);
    assert.deepEqual(await productRows.nth(1).locator('td').allTextContents(), ['1', '33.3%', '—', '1']);
    const stock = page.locator('.overview-stock-table tbody tr');
    assert.deepEqual(await page.locator('.overview-stock-table thead th').allTextContents(), ['类型', '可提取', '已领用', '状态明细']);
    assert.deepEqual(await stock.first().locator('td').allTextContents(), ['1', '1', '无']);
    assert.match(await stock.nth(1).innerText(), /已登记 1 条/);
    assert.deepEqual(await stock.nth(2).locator('td').allTextContents(), ['提取时核验', '0', '死号 1 邮箱停用 1']);
    const claudeStock = stock.filter({ has: page.getByRole('link', { name: 'Claude 账号', exact: true }) });
    const claudeIssues = ['死号 1', '解封中 1', '冻结 1', '封控中 1', '资料待核对 1'];
    assert.deepEqual(await claudeStock.locator('td').allTextContents(), ['0', '0', claudeIssues.join(' ')]);
    assert.deepEqual(await claudeStock.locator('.overview-stock-issues .tag').allTextContents(), claudeIssues);
    const customerPanel = page.locator('[aria-labelledby="overview-customers"].panel');
    assert.match(await customerPanel.innerText(), /待核对订单 [1-9]/);
    assert.deepEqual(await customerPanel.locator('.overview-customer-summary a').evaluateAll(links =>
      links.map(link => [link.textContent, link.getAttribute('href')])), [
      ['客户列表', '#/customers/list'], ['续费管理', '#/workspace/renewals'], ['流失明细', '#/workspace/customer-loss']
    ]);
    const taskCounts = () => page.locator('.overview-task-count').allTextContents();
    const beforeTasks = await taskCounts();
    assert(beforeTasks.includes('1'));
    assert.equal(await page.getByRole('link', { name: /Claude Pro.*笔/ }).getAttribute('href'), '#/orders/claude');

    await range(page, '今日').click();
    assert.equal(await value(page, 'orders'), '1');
    assert.match(await metric(page, 'orders').innerText(), /较上期持平/);
    assert.equal(await value(page, 'customers'), '1');
    assert.match(await metric(page, 'profit').innerText(), /上期待核算 1 笔/);
    assert.deepEqual(await taskCounts(), beforeTasks);
    assert.equal(await page.locator('.overview-chart-data g').count(), 11);
    const detail = page.locator('[data-overview-details]');
    await detail.getByText('查看每小时数据', { exact: true }).click();
    assert.match(await detail.locator('li').first().innerText(), /00:00\s+订单 0 笔 · 撤单 1 笔/);
    assert.match(await detail.locator('li').last().innerText(), /10:00/);
    await trend(page, '已核算利润').click();
    assert.equal(await detail.getAttribute('open'), '');
    assert.match(await detail.innerText(), /09:00\s+68.24 CNY/);
    await go(page, 'customers/new');
    await page.locator('#commerce-contact-name').fill('总览切页保留测试');
    await go(page, 'overview');
    await refreshed(page);
    assert.equal(await range(page, '今日').getAttribute('aria-pressed'), 'true');
    assert.equal(await trend(page, '已核算利润').getAttribute('aria-pressed'), 'true');
    await go(page, 'customers/new');
    assert.equal(await page.locator('#commerce-contact-name').inputValue(), '总览切页保留测试');
    await go(page, 'overview');

    const refresh = page.locator('[data-action="overview-refresh"]');
    const oldMetrics = await page.locator('.overview-metrics').boundingBox();
    failed.add('commerce');
    slowCommerce = Promise.withResolvers();
    try {
      await refresh.click();
      const progress = page.locator('[data-overview-progress]');
      await progress.waitFor();
      assert((await progress.boundingBox()).height <= 3);
      assert.deepEqual(await page.locator('.overview-metrics').boundingBox(), oldMetrics);
      assert.equal(await value(page, 'orders'), '1');
    } finally { slowCommerce.resolve(); slowCommerce = undefined; }
    await refreshed(page);
    assert.match(await page.locator('.overview-design-label').innerText(), /读取失败 · 保留/);
    assert.equal(await value(page, 'profit'), '68.24');
    failed.clear();

    commerce.orders.push(order('apple-new', '2026-11-10T09:45:00', {
      payment: '苹果内购', paidCurrency: 'USD', saleAmount: '80', customerId: ''
    }));
    failed.add('appleBalance');
    await refresh.click();
    await refreshed(page);
    assert.equal(await value(page, 'orders'), '2');
    assert.equal(await value(page, 'profit'), '68.24');
    assert.match(await metric(page, 'profit').innerText(), /读取失败 · 保留/);
    assert.match(await page.locator('.overview-task-list').innerText(), /苹果待回款\s+读取失败 · 保留/);
    failed.clear();

    inventory = { ...inventoryFixture, mailboxes: [...inventoryFixture.mailboxes, { id: 'e', type: 'microsoft' }] };
    failed.add('inventory');
    await refresh.click();
    await refreshed(page);
    assert.doesNotMatch(await metric(page, 'profit').innerText(), /读取失败/);
    assert.match(await stock.nth(1).innerText(), /已登记 1 条/);
    assert.deepEqual(await claudeStock.locator('.overview-stock-issues .tag').allTextContents(), claudeIssues);
    assert.match(await page.locator('[aria-labelledby="overview-inventory"].panel').innerText(), /读取失败 · 保留/);
    assert.match(await page.locator('[aria-labelledby="overview-customers"].panel').innerText(), /读取失败 · 保留/);
    failed.clear();
    await refresh.click();
    await refreshed(page);
    assert.match(await stock.nth(1).innerText(), /已登记 2 条/);
    assert.doesNotMatch(await page.locator('.website-overview').innerText(), /读取失败/);

    commerce.orders.push(order('same-card-loss', '2026-11-10T10:00:00', {
      cardId: current.cardId, issueFeeSnapshot: { cardId: current.cardId, applied: false },
      saleAmount: '10', fxSnapshot: current.fxSnapshot
    }));
    await refresh.click();
    await refreshed(page);
    assert.equal(await value(page, 'profit'), '-49.92');
    assert.match(await metric(page, 'profit').innerText(), /含参考核算 2 笔/);
    assert.equal(await page.locator('.overview-bar-loss').count(), 1);
    await page.getByRole('link', { name: '查看订单统计', exact: true }).click();
    await page.getByRole('heading', { name: '订单统计', exact: true }).waitFor();
    assert(await page.getByText('-49.92', { exact: true }).count() > 0);
    await go(page, 'overview');
    await refreshed(page);
    assert.equal(await value(page, 'profit'), '-49.92');

    await page.getByRole('button', { name: '指标口径', exact: true }).click();
    const drawer = page.locator('#drawer[open]');
    assert.match(await drawer.innerText(), /网站访问量、全量代充任务/);
    await page.keyboard.press('Escape');
    await drawer.waitFor({ state: 'hidden' });
    const known = await page.evaluate(() => window.IDDesignAPI.navigation.flatMap(group => group[2].map(item => '#/' + item[1])));
    for (const href of await page.locator('.website-overview a').evaluateAll(nodes => nodes.map(node => node.getAttribute('href'))))
      assert(known.includes(href), '无对应业务页的链接 ' + href);

    const output = process.env.ID_LAYOUT_QA_OUTPUT;
    if (output) await mkdir(output, { recursive: true });
    for (const width of [1440, 1024, 901, 900, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await range(page, '近 30 天').click();
        await trend(page, '订单量').click();
        await settle(page);
        assert.equal(await page.locator('.overview-chart-data g').count(), 30);
        assert.match(await metric(page, 'receipts').innerText(), /1,234,567,890.4301/);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), width + '/' + theme);
        const headingsAlign = await page.locator('.overview-columns').evaluateAll(rows =>
          rows.every(row => {
            const panels = [...row.children].map(el => el.getBoundingClientRect());
            const titles = [...row.querySelectorAll(':scope > section h2')].map(el => el.getBoundingClientRect());
            return panels[0].left === panels[1].left ||
              (Math.abs(panels[0].top - panels[1].top) < 1 && Math.abs(titles[0].top - titles[1].top) < 1);
          }));
        assert(headingsAlign, width + '/' + theme + ' 并排模块标题错位');
        const help = metric(page, 'orders').locator('.title-help summary');
        await help.scrollIntoViewIfNeeded();
        await settle(page);
        const before = await page.locator('.overview-metrics').boundingBox();
        await help.click();
        const popover = page.locator('.title-description:popover-open');
        await popover.waitFor();
        const box = await popover.boundingBox();
        assert(box.x >= 0 && box.x + box.width <= width, '指标说明越过视口');
        assert.deepEqual(await page.locator('.overview-metrics').boundingBox(), before);
        await page.keyboard.press('Escape');
        if (output && [1440, 390].includes(width)) {
          if (await detail.getAttribute('open') != null) await detail.locator('summary').click();
          const dismiss = page.getByRole('button', { name: '关闭提示', exact: true });
          if (await dismiss.isVisible()) await dismiss.click();
          await range(page, '近 7 天').click();
          await page.evaluate(() => {
            document.activeElement?.blur();
            window.scrollTo(0, 0);
          });
          await settle(page);
          await page.screenshot({ path: output + '/overview-' + width + '-' + theme + '.png', fullPage: true });
        }
      }
    }
    commerce = structuredClone(commerceFixture);
    const unlinked = commerce.orders.find(item => item.id === current.id);
    unlinked.cardId = '';
    unlinked.source = '管理员手工';
    delete unlinked.issueFeeSnapshot;
    await range(page, '近 7 天').click();
    await page.locator('.overview-toolbar [data-action="mobile-list-actions"]').click();
    await page.getByRole('menuitem', { name: '刷新数据', exact: true }).click();
    await refreshed(page);
    assert.equal(await value(page, 'profit'), '71.84');
    assert.match(await metric(page, 'profit').innerText(), /1 笔开卡费未分摊/);

    checkTransport(session);
    await context.close();
  });

  await t.test('成功空集与首次失败的显示不同', async () => {
    const session = await open();
    const { page, context } = session;
    let fail = true;
    await page.route('**/api/local/commerce', route => fail
      ? route.fulfill({ status: 503, json: {} })
      : route.fulfill({ json: { version: 0, data: null } }));
    await page.route('**/api/local/inventory', route => fail
      ? route.fulfill({ status: 503, json: {} })
      : route.fulfill({ json: { version: 0, data: null } }));
    await page.goto(origin + '/#/overview');
    await page.locator('.overview-design-label').getByText(/读取失败/).waitFor();
    const stock = page.locator('.overview-stock-table tbody tr');
    await page.locator('section[aria-labelledby="overview-inventory"]').getByText('读取失败 · 可重试', { exact: true }).waitFor();
    assert.deepEqual(await stock.first().locator('td').allTextContents(), ['—', '—', '—']);
    assert.deepEqual(await stock.nth(2).locator('td').allTextContents(), ['—', '—', '—']);
    assert.equal(await value(page, 'orders'), '—');
    assert.equal(await value(page, 'profit'), '—');
    assert.equal(await page.getByText('当前没有待处理事项').count(), 0);
    fail = false;
    await page.getByRole('button', { name: '刷新数据', exact: true }).click();
    await page.getByText('该时间范围没有订单记录', { exact: true }).waitFor();
    assert.deepEqual(await stock.first().locator('td').allTextContents(), ['0', '0', '无']);
    assert.deepEqual(await stock.nth(2).locator('td').allTextContents(), ['提取时核验', '0', '无']);
    assert.equal(await value(page, 'orders'), '0');
    assert.equal(await value(page, 'receipts'), '0');
    assert.equal(await value(page, 'profit'), '0.00');
    assert.equal(await value(page, 'customers'), '0');
    assert.equal(await page.getByText('当前没有待处理事项').count(), 1);
    checkTransport(session);
    await context.close();
  });

  await t.test('员工只读取并显示获准的库存', async () => {
    const session = await open({ id: 'employee-fixture', name: '测试员工', role: 'employee' }, {
      inventory: { version: 1, data: inventoryFixture },
      commerce: { version: 1, data: commerceFixture },
      appleBalance: { version: 1, data: appleFixture }
    });
    const { page, context, requests } = session;
    await page.goto(origin + '/#/overview');
    await page.getByText('已登记 1 条', { exact: true }).waitFor();
    await refreshed(page);
    assert.equal(await page.locator('.overview-metrics, .overview-chart-tools, #overview-customers, #overview-tasks').count(), 0);
    assert.equal(await page.getByRole('link', { name: '苹果隐藏邮箱', exact: true }).count(), 0);
    assert.deepEqual(await page.locator('.overview-stock-table tbody th a').evaluateAll(nodes =>
      nodes.map(node => node.getAttribute('href'))), [
      '#/mailboxes/google', '#/mailboxes/microsoft', '#/accounts/gpt', '#/accounts/claude',
      '#/accounts/gemini', '#/accounts/grok'
    ]);
    assert.deepEqual(requests.filter(({ path }) => ['/api/local/commerce', '/api/local/appleBalance'].includes(path)), []);
    checkTransport(session);
    await context.close();
  });
});

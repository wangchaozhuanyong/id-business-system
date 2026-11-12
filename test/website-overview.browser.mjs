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
  start: beijing(createdAt), cardId: id + '-card', issueFeeSnapshot: { ...base.issueFeeSnapshot, cardId: id + '-card' }, ...options
});
const expired = {
  start: beijing('2026-10-08T08:00:00'), expiry: beijing('2026-11-08T08:00:00')
};
const current = order('gpt-now', '2026-11-10T09:30:00', {
  source: '管理员手工', paidConfirmed: false, receiptConfirmed: false,
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
      expiry: beijing('2026-11-09T11:40:00'), product: 'Claude Max', plan: 'Max 5x', customerId: 'customer-b',
      saleAmount: '0.33', saleCurrency: 'MYR'
    }),
    order('after-yesterday-cutoff', '2026-11-09T10:40:00.001', {
      expiry: beijing('2026-11-09T11:40:00'), product: 'Claude Pro', plan: 'Pro', customerId: '',
      saleAmount: '0.10', saleCurrency: 'MYR'
    }),
    order('prior-week', '2026-11-03T10:40:00', { expiry: expired.expiry, saleAmount: '100', customerId: '' }),
    order('after-week-cutoff', '2026-11-03T10:40:00.001', { expiry: expired.expiry, customerId: '' }),
    order('large-amount', '2026-10-15T08:00:00', {
      expiry: expired.expiry, saleAmount: '1234567890.0001', saleCurrency: 'MYR', customerId: ''
    }),
    order('outside-range', '2026-09-01T09:00:00', {
      expiry: expired.expiry, saleAmount: '10', saleCurrency: 'MYR', customerId: '',
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
  const output = process.env.ID_LAYOUT_QA_OUTPUT;
  if (output) await mkdir(output, { recursive: true });
  const open = async (actor, localFixtures = {}, { changeEvents = false, hasTouch = false, width = 1440 } = {}) => {
    const context = await browser.newContext({
      viewport: { width, height: 1000 }, timezoneId: 'America/Los_Angeles', hasTouch
    });
    const intercepted = await interceptDesign(context, { localFixtures, actor, changeEvents });
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
  const selectRange = async (page, label) => {
    const compact = page.getByRole('combobox', { name: '统计时间范围' });
    if (await compact.isVisible()) await compact.selectOption({ label });
    else await range(page, label).click();
  };
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
  const checkMetricLayout = async page => {
    const layout = await page.locator('.overview-metrics').evaluate(grid => {
      const box = node => node.getBoundingClientRect().toJSON();
      const textBoxes = node => {
        const range = document.createRange();
        range.selectNodeContents(node);
        return [...range.getClientRects()].map(rect => rect.toJSON());
      };
      return {
        width: innerWidth,
        toolbar: box(document.querySelector('.overview-toolbar')),
        period: box(document.querySelector('.overview-period')),
        controls: [...document.querySelectorAll('.overview-toolbar button, .overview-toolbar select')]
          .filter(node => node.checkVisibility()).map(box),
        cards: [...grid.children].map(card => ({
          id: card.dataset.overviewMetric,
          bounds: box(card),
          title: box(card.querySelector('h2')),
          help: box(card.querySelector('.title-help summary')),
          amount: box(card.querySelector('.overview-metric-value strong')),
          footer: box(card.querySelector('.overview-metric-footer')),
          note: textBoxes(card.querySelector('.overview-metric-footer > span'))[0],
          fonts: [...card.querySelectorAll('.overview-metric-value strong')].map(node => getComputedStyle(node).fontSize),
          units: [...card.querySelectorAll('.overview-metric-value')].flatMap(node => {
            const unit = node.querySelector(':scope > span, dt');
            return unit ? [{ amount: box(node.querySelector('strong')), unit: box(unit) }] : [];
          }),
          text: [...card.querySelectorAll('h2, .overview-metric-value strong, .overview-metric-value > span, .overview-receipts dt, .overview-metric-footer > span')].flatMap(textBoxes)
        }))
      };
    });
    assert.equal(layout.cards.length, 4);
    assert(Math.abs(layout.period.left - layout.cards[0].bounds.left) <= 1, '时间栏与首张卡片左边缘对齐');
    assert(layout.cards[0].bounds.top - layout.toolbar.bottom >= 12, '工具栏与卡片保留间距');
    for (const control of layout.controls) {
      assert(Math.abs((control.top + control.bottom) / 2 - (layout.toolbar.top + layout.toolbar.bottom) / 2) <= 1,
        `${layout.width}px 区间栏控件必须在同一行`);
      assert(control.left >= layout.toolbar.left - 1 && control.right <= layout.toolbar.right + 1,
        `${layout.width}px 区间栏控件溢出`);
      if (layout.width <= 560) assert(control.height >= 44, '手机工具栏保留触控高度');
    }
    const expectedColumns = layout.width > 1150 ? 4 : layout.width > 560 ? 2 : 1;
    const rows = Map.groupBy(layout.cards, card => Math.round(card.bounds.top));
    for (const cards of rows.values()) {
      assert.equal(cards.length, expectedColumns, layout.width + 'px 卡片列数');
      for (const card of cards) {
        for (const key of ['title', 'amount', 'footer', 'note'])
          assert(Math.abs(card[key].top - cards[0][key].top) <= 1, `${layout.width}px ${card.id} 的 ${key} 与同排卡片错位：${card[key].top} / ${cards[0][key].top}`);
        assert.equal(card.fonts.every(font => font === cards[0].fonts[0]), true, '四项指标的数值字号统一');
        assert(card.footer.top > card.amount.bottom, '辅助信息必须位于数值下方');
        for (const { amount, unit } of card.units)
          assert(unit.left >= amount.right - 1 || unit.top >= amount.bottom - 1, '单位应在数值右侧，窄屏可移到下一行');
        assert(card.title.right <= card.help.left && card.help.left - card.title.right <= 10, '说明紧邻标题右侧');
        if (layout.width <= 900) assert(card.help.width >= 44 && card.help.height >= 44, '手机说明触控区');
        for (const rect of card.text)
          assert(rect.left >= card.bounds.left + 8 && rect.right <= card.bounds.right - 8 && rect.bottom <= card.bounds.bottom - 8,
            `${layout.width}px ${card.id} 的实际文字溢出卡片`);
      }
    }
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '页面横向溢出');
  };
  const checkStockLayout = async page => {
    const viewport = page.locator('.overview-stock-viewport');
    await viewport.evaluate(node => { node.scrollLeft = 0; });
    await settle(page);
    const geometry = await viewport.evaluate(node => {
      const box = element => element.getBoundingClientRect().toJSON();
      const table = node.querySelector('table');
      const panel = node.closest('.panel');
      const customer = panel.parentElement.querySelector('.overview-customer-section');
      return {
        panel: box(panel), page: box(panel.closest('.website-overview')),
        title: box(panel.querySelector('h2')), footer: box(panel.querySelector('.panel-body > .overview-section-note')),
        customer: customer && {
          panel: box(customer), title: box(customer.querySelector('h2')),
          content: box(customer.querySelector('.overview-customer-content')),
          footer: box(customer.querySelector('.panel-body > .overview-section-note')),
          controls: [...customer.querySelectorAll('.overview-customer-details > li')].map(row => ({
            row: box(row), control: box(row.firstElementChild)
          })),
          text: [...customer.querySelectorAll('dt, .overview-customer-count, .overview-customer-detail > span')].flatMap(element => {
            const range = document.createRange(); range.selectNodeContents(element);
            return [...range.getClientRects()].map(rect => rect.toJSON());
          })
        },
        viewport: box(node), first: box(table.querySelector('th')),
        help: box(panel.querySelector('.title-help summary')),
        scrolls: node.scrollWidth > node.clientWidth,
        columns: [...table.rows].map(row => row.cells.length),
        clipped: [...table.querySelectorAll('th, td')].flatMap(cell => {
          const text = document.createRange(); text.selectNodeContents(cell);
          const bounds = box(cell);
          return [...text.getClientRects()].filter(rect => rect.left < bounds.left + 3 || rect.right > bounds.right - 3)
            .map(() => cell.textContent);
        })
      };
    });
    if (geometry.customer && geometry.page.width >= 1440) {
      const customer = geometry.customer;
      assert(Math.abs(geometry.panel.top - customer.panel.top) <= 1 && Math.abs(geometry.panel.bottom - customer.panel.bottom) <= 1,
        '宽屏库存与客户卡片的上下边界对齐');
      assert(Math.abs(geometry.title.top - customer.title.top) <= 1, '两侧实际标题文字对齐');
      assert(Math.abs(geometry.viewport.top - customer.content.top) <= 1, '两侧内容起点对齐');
      assert(Math.abs(geometry.footer.top - customer.footer.top) <= 1, '两侧更新时间对齐');
      assert(!geometry.scrolls, '并排时应为库存多列保留完整宽度');
    } else assert(Math.abs(geometry.panel.width - geometry.page.width) <= 1, '空间不足时库存表占满内容行');
    if (geometry.customer) {
      const customer = geometry.customer;
      assert(customer.text.every(rect => rect.left >= customer.panel.left + 8 && rect.right <= customer.panel.right - 8),
        '客户统计标签和数值不能越过卡片');
      for (const { row, control } of customer.controls) {
        assert(control.top - row.top >= 8 && row.bottom - control.bottom >= 8, '客户操作到分隔线保持 8px');
        if (page.viewportSize().width <= 900) assert(control.height >= 44, '手机客户入口触控高度');
      }
    }
    assert(geometry.columns.every(columns => columns === 10), '每行保留类型及九项独立统计，不能合并状态列');
    assert.deepEqual(geometry.clipped, [], '表格标题和实际文字不得裁切');
    assert(geometry.viewport.top - geometry.help.bottom >= 8, '说明按钮与表头分隔线保持间距');
    if (geometry.scrolls) {
      await viewport.scrollIntoViewIfNeeded();
      await viewport.focus();
      await page.keyboard.press('ArrowRight');
      await page.waitForFunction(() => document.querySelector('.overview-stock-viewport').scrollLeft > 0);
      await viewport.evaluate(node => { node.scrollLeft = node.scrollWidth; });
      await settle(page);
      const end = await viewport.evaluate(node => {
        const box = element => element.getBoundingClientRect().toJSON();
        return { viewport: box(node), first: box(node.querySelector('thead th')), last: box(node.querySelector('thead th:last-child')),
          labels: [...node.querySelectorAll('tbody th')].map(box) };
      });
      assert(Math.abs(end.first.left - end.viewport.left) <= 1, '表头类型列固定');
      assert(end.labels.every(label => Math.abs(label.left - end.viewport.left) <= 1), '所有库存类型在滚动后仍可见');
      assert(end.last.left >= end.first.right && end.last.right <= end.viewport.right + 1, '末列可完整滚动到类型列右侧');
      await viewport.evaluate(node => { node.scrollLeft = 0; });
    }
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '库存表不能撑宽整页');
  };

  await t.test('趋势浮层支持悬停、零值、键盘、触屏及指标切换', async () => {
    const fixtures = {
      commerce: { version: 1, data: commerceFixture },
      inventory: { version: 1, data: inventoryFixture },
      appleBalance: { version: 1, data: appleFixture }
    };
    const session = await open(undefined, fixtures);
    const { page, context } = session;
    const points = page.locator('.overview-plot [data-chart-point]');
    const tip = page.locator('#overview-trend-tooltip');
    const hover = async point => point.hover({ position: { x: 2, y: 150 } });
    const tipFits = async () => {
      const bounds = await tip.boundingBox();
      const plot = await page.locator('.overview-plot').boundingBox();
      assert(bounds && bounds.x >= plot.x && bounds.x + bounds.width <= plot.x + plot.width + 1,
        '图表左右边缘的浮层完整显示');
      assert(bounds.y >= plot.y && bounds.y + bounds.height <= plot.y + plot.height,
        '浮层在图表内，不遮挡上方控件');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    };
    await page.goto(origin + '/#/overview');
    await refreshed(page);
    await points.first().waitFor();
    assert(await tip.isHidden());
    await hover(points.first());
    assert.match(await tip.innerText(), /2026-11-04（北京时间）\s+订单量：0 笔\s+撤单：0 笔/);
    const before = await page.locator('.overview-columns').boundingBox();
    await tip.hover();
    assert(await tip.isVisible(), '指针移到浮层上仍可阅读');
    await page.keyboard.press('Escape');
    await settle(page);
    assert(await tip.isHidden(), '只有悬停、没有键盘焦点时也能用 Escape 关闭');
    await hover(points.last());
    assert.match(await tip.innerText(), /2026-11-10（北京时间）\s+订单量：1 笔\s+撤单：1 笔/);
    assert.deepEqual(await page.locator('.overview-columns').boundingBox(), before, '显示浮层不挤动布局');
    await page.mouse.move(0, 0);
    assert(await tip.isHidden());
    await points.first().focus();
    await page.keyboard.press('ArrowRight');
    assert(await points.nth(1).evaluate(node => node === document.activeElement));
    assert.match(await tip.innerText(), /2026-11-05/);
    await page.keyboard.press('End');
    assert.match(await tip.innerText(), /2026-11-10/);
    await page.keyboard.press('Home');
    assert.match(await tip.innerText(), /2026-11-04/);
    await page.keyboard.press('Escape');
    assert(await tip.isHidden());
    await trend(page, '已核算利润').click();
    assert(await tip.isHidden(), '切换指标后不显示旧提示');
    await hover(points.nth(5));
    assert.match(await tip.innerText(), /2026-11-09（北京时间）\s+利润待核算\s+已核算：0 笔\s+待核算：2 笔/);
    assert.doesNotMatch(await tip.innerText(), /0\.00 CNY/);
    await hover(points.last());
    assert.match(await tip.innerText(), /已核算利润：68\.24 CNY\s+已核算：1 笔\s+待核算：0 笔/);
    await range(page, '今日').click();
    assert(await tip.isHidden());
    await hover(points.nth(9));
    assert.match(await tip.innerText(), /2026-11-10 09:00（北京时间）\s+已核算利润：68\.24 CNY/);
    for (const width of [1440, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await selectRange(page, '近 30 天');
        assert.equal(await points.count(), 30);
        for (const point of [points.first(), points.last()]) {
          await hover(point);
          await tipFits();
        }
        if (output) await page.locator('[aria-labelledby="overview-trend"]').screenshot({
          path: output + '/trend-tooltip-' + width + '-' + theme + '.png'
        });
      }
    }
    await page.setViewportSize({ width: 1440, height: 1000 });
    await go(page, 'orders/statistics');
    const statistics = page.locator('.statistics-visual [data-chart-point]').first();
    await statistics.waitFor();
    await statistics.focus();
    assert.match(await page.locator('.statistics-visual [role="tooltip"]').innerText(), /已核算.*待核算/);
    await page.keyboard.press('Escape');
    assert(await page.locator('.statistics-visual [role="tooltip"]').isHidden());
    await go(page, 'overview');
    await refreshed(page);
    assert(await tip.isHidden(), '返回页面不保留旧浮层');
    await hover(points.last());
    await tipFits();
    checkTransport(session);
    await context.close();

    for (const width of [390, 320]) {
      const touch = await open(undefined, fixtures, { hasTouch: true, width });
      const { page: mobile } = touch;
      await mobile.goto(origin + '/#/overview');
      await refreshed(mobile);
      const point = mobile.locator('.overview-plot [data-chart-point]').last();
      const tooltip = mobile.locator('#overview-trend-tooltip');
      await point.tap({ position: { x: 2, y: 150 } });
      assert.match(await tooltip.innerText(), /2026-11-10（北京时间）\s+订单量：1 笔/);
      await tooltip.tap();
      assert(await tooltip.isVisible(), '触屏点按浮层后保持可读');
      await mobile.locator('#overview-trend').tap();
      assert(await tooltip.isHidden(), '触屏点按外部关闭');
      await point.tap({ position: { x: 2, y: 150 } });
      await trend(mobile, '已核算利润').tap();
      assert(await tooltip.isHidden());
      await point.tap({ position: { x: 2, y: 150 } });
      assert.match(await tooltip.innerText(), /68\.24 CNY/);
      checkTransport(touch);
      await touch.context.close();
    }
  });

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
    const receiptsProgress = page.locator('[data-overview-progress-group="receipts"]');
    assert.equal(await receiptsProgress.locator('progress').getAttribute('value'), '3');
    assert.equal(await receiptsProgress.locator('progress').getAttribute('max'), '3');
    assert.equal(await page.locator('[data-overview-progress-group="accounting"] progress').getAttribute('value'), '1');
    assert.equal(await page.locator('[data-overview-progress-group="accounting"] progress').getAttribute('max'), '3');
    assert.match(await page.locator('.overview-insight').innerText(), /Claude Pro（增加 1 笔）/);
    assert.equal(await page.locator('.overview-chart-data g').count(), 7);
    assert.equal(await page.locator('.overview-bar-cancelled').count(), 7);
    const productRows = page.locator('.overview-product-table tbody tr');
    assert.deepEqual(await productRows.first().locator('td').allTextContents(), ['1', '33.3%', '68.24', '0']);
    assert.deepEqual(await productRows.nth(1).locator('td').allTextContents(), ['1', '33.3%', '—', '1']);
    const stock = page.locator('.overview-stock-table tbody tr');
    assert.deepEqual(await page.locator('.overview-stock-table thead th').allTextContents(),
      ['类型', '已登记', '可提取', '已领用', '死号', '解封中', '邮箱停用', '冻结', '封控中', '资料待核对']);
    assert.deepEqual(await stock.first().locator('td').allTextContents(), ['2', '1', '1', '0', '0', '—', '0', '0', '0']);
    assert.deepEqual(await stock.nth(1).locator('td').allTextContents(), ['1', '—', '—', '0', '0', '—', '0', '0', '0']);
    assert.deepEqual(await stock.nth(2).locator('td').allTextContents(), ['2', '提取时核验', '0', '1', '0', '1', '0', '0', '0']);
    const claudeStock = stock.filter({ has: page.getByRole('link', { name: 'Claude 账号', exact: true }) });
    const claudeCounts = ['6', '0', '0', '1', '1', '—', '1', '1', '1'];
    assert.deepEqual(await claudeStock.locator('td').allTextContents(), claudeCounts);
    assert.equal(await claudeStock.locator('[data-stock-column="dead"] .tag.danger').innerText(), '1');
    const customerPanel = page.locator('[aria-labelledby="overview-customers"].panel');
    assert.match(await customerPanel.innerText(), /资料问题订单\s+[1-9]/);
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
    await settle(page);
    await checkMetricLayout(page);
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
      payment: '苹果内购', appleIdId: 'fixture-wallet', paidCurrency: 'USD', saleAmount: '80', customerId: ''
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
    assert.equal(await stock.nth(1).locator('[data-stock-column="registered"]').innerText(), '1');
    assert.deepEqual(await claudeStock.locator('td').allTextContents(), claudeCounts);
    assert.match(await page.locator('[aria-labelledby="overview-inventory"].panel').innerText(), /读取失败 · 保留/);
    assert.match(await page.locator('[aria-labelledby="overview-customers"].panel').innerText(), /读取失败 · 保留/);
    failed.clear();
    await refresh.click();
    await refreshed(page);
    assert.equal(await stock.nth(1).locator('[data-stock-column="registered"]').innerText(), '2');
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
    await page.locator('.overview-bar-loss').locator('..').focus();
    assert.match(await page.locator('#overview-trend-tooltip').innerText(), /已核算利润：-119\.96 CNY/);
    await page.keyboard.press('Escape');
    await page.getByRole('link', { name: '查看订单统计', exact: true }).click();
    await page.getByRole('heading', { name: '订单统计', exact: true }).waitFor();
    assert.equal((await page.locator('[data-stat-metric="profit"] .summary-number').innerText()).replace(/\s/g, ''), '-49.92CNY');
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

    for (const width of [2048, 1721, 1720, 1719, 1440, 1151, 1150, 1024, 901, 900, 768, 560, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await selectRange(page, '近 30 天');
        await trend(page, '订单量').click();
        await settle(page);
        assert.equal(await page.locator('.overview-chart-data g').count(), 30);
        assert.match(await metric(page, 'receipts').innerText(), /1,234,567,890.4301/);
        if (output && width === 2048) await page.screenshot({ path: output + '/overview-wide-' + theme + '.png', fullPage: true });
        await checkMetricLayout(page);
        await checkStockLayout(page);
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), width + '/' + theme);
        const headingsAlign = await page.locator('.overview-columns, .overview-business-grid').evaluateAll(rows =>
          rows.every(row => {
            const panels = [...row.children].map(el => el.getBoundingClientRect());
            const titles = [...row.querySelectorAll(':scope > section h2')].map(el => el.getBoundingClientRect());
            return panels[0].left === panels[1].left ||
              (Math.abs(panels[0].top - panels[1].top) < 1 && Math.abs(titles[0].top - titles[1].top) < 1);
          }));
        assert(headingsAlign, width + '/' + theme + ' 并排模块标题错位');
        const analysis = await page.locator('.overview-business-grid').evaluate(grid => {
          const cards = [...grid.children].map(node => node.getBoundingClientRect());
          return { width: grid.getBoundingClientRect().width, cards: cards.map(box => ({ width: box.width, top: box.top, bottom: box.bottom })) };
        });
        if (analysis.width >= 1100) {
          assert(Math.abs(analysis.cards[0].width - analysis.cards[1].width) <= 1, '业务构成与收款核算各占一半');
          assert(Math.abs(analysis.cards[0].bottom - analysis.cards[1].bottom) <= 1, '业务构成与收款核算底部对齐');
        } else assert(analysis.cards[1].top >= analysis.cards[0].bottom, '窄屏上下排列');
        const help = metric(page, 'orders').locator('.title-help summary');
        await help.scrollIntoViewIfNeeded();
        await settle(page);
        const before = await page.locator('.overview-metrics').boundingBox();
        assert.equal(await help.locator('..').getAttribute('open'), null, '指标说明默认收起');
        if (theme === 'dark') {
          await help.focus();
          await page.keyboard.press('Enter');
        } else await help.click();
        const popover = page.locator('.title-description:popover-open');
        await popover.waitFor();
        const box = await popover.boundingBox();
        assert(box.x >= 0 && box.x + box.width <= width, '指标说明越过视口');
        assert.deepEqual(await page.locator('.overview-metrics').boundingBox(), before);
        await page.keyboard.press('Escape');
        if ([1440, 390].includes(width)) {
          const stockPanel = page.locator('[aria-labelledby="overview-inventory"].panel');
          const stockHelp = stockPanel.locator('.title-help summary');
          await stockHelp.scrollIntoViewIfNeeded();
          await settle(page);
          const before = await stockPanel.boundingBox();
          await stockHelp.click();
          const note = stockPanel.locator('.title-description:popover-open');
          await note.waitFor();
          assert.match(await note.innerText(), /各列不可直接相加/);
          const bounds = await note.boundingBox();
          assert(bounds.x >= 0 && bounds.x + bounds.width <= width, '库存口径说明不能超出视口');
          assert.deepEqual(await stockPanel.boundingBox(), before, '说明不推动库存表');
          await page.keyboard.press('Escape');
          await page.evaluate(() => document.activeElement?.blur());
          if (output) await stockPanel.screenshot({ path: output + '/stock-' + width + '-' + theme + '.png' });
        }
        if (output && [1440, 390].includes(width)) {
          if (await detail.getAttribute('open') != null) await detail.locator('summary').click();
          const dismiss = page.getByRole('button', { name: '关闭提示', exact: true });
          if (await dismiss.isVisible()) await dismiss.click();
          await selectRange(page, '近 7 天');
          await page.evaluate(() => {
            document.activeElement?.blur();
            window.scrollTo(0, 0);
          });
          await settle(page);
          await page.screenshot({ path: output + '/overview-' + width + '-' + theme + '.png', fullPage: true });
          if (width === 1440) {
            const toolbar = await page.locator('.overview-toolbar').boundingBox();
            const metrics = await page.locator('.overview-metrics').boundingBox();
            await page.screenshot({ path: output + '/overview-summary-' + theme + '.png', clip: {
              x: toolbar.x - 8, y: toolbar.y - 8, width: toolbar.width + 16,
              height: metrics.y + metrics.height - toolbar.y + 16
            } });
          }
        }
      }
    }
    commerce = structuredClone(commerceFixture);
    const unlinked = commerce.orders.find(item => item.id === current.id);
    unlinked.cardId = '';
    unlinked.source = '管理员手工';
    delete unlinked.issueFeeSnapshot;
    await selectRange(page, '近 7 天');
    await page.getByRole('button', { name: '查看统计区间与更新时间' }).click();
    const period = page.locator('#drawer[open]');
    await period.getByText('北京时间', { exact: true }).waitFor();
    assert.match(await period.innerText(), /本期[\s\S]*上期[\s\S]*更新于/);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: '刷新数据', exact: true }).click();
    await refreshed(page);
    assert.equal(await value(page, 'profit'), '71.84');
    assert.match(await metric(page, 'profit').innerText(), /1 笔开卡费未分摊/);

    commerce.orders.push(
      order('equal-current-myr', '2026-11-10T09:00:00', { saleAmount: '0.33', saleCurrency: 'MYR' }),
      order('equal-prior-cny', '2026-11-09T09:00:00')
    );
    await selectRange(page, '今日');
    await page.getByRole('button', { name: '刷新数据', exact: true }).click();
    await refreshed(page);
    assert.deepEqual(await metric(page, 'receipts').locator('.overview-metric-footer > span').allTextContents(),
      ['较上期持平 CNY', '较上期持平 MYR', '退款 50.00 CNY · 1.2345 MYR']);

    checkTransport(session);
    await context.close();
  });

  await t.test('自定义日期覆盖两个自然月，校验起止并保留筛选', async () => {
    const template = commerceFixture.orders.find(row => !row.cancelled);
    const orders = ['2026-08-31 23:59', '2026-09-01 00:00', '2026-10-31 23:59', '2026-11-01 00:00']
      .map((createdAt, index) => ({ ...template, id: 'overview-date-' + index, createdAt, start: createdAt }));
    const { context, page, errors } = await open(undefined, {
      commerce: { version: 1, data: { ...commerceFixture, orders } },
      inventory: { version: 1, data: inventoryFixture }, appleBalance: { version: 1, data: appleFixture }
    });
    try {
      await page.goto(origin + '/#/overview');
      const custom = page.getByRole('button', { name: '自定义日期', exact: true });
      await custom.click();
      const drawer = page.locator('#drawer[open]');
      await drawer.getByRole('heading', { name: '选择统计日期' }).waitFor();
      await page.keyboard.press('Escape');
      await drawer.waitFor({ state: 'hidden' });
      await page.setViewportSize({ width: 390, height: 900 });
      const compact = page.getByRole('combobox', { name: '统计时间范围' });
      await selectRange(page, '自定义日期');
      assert.equal(await compact.inputValue(), 'week');
      await drawer.locator('#overview-date-from').fill('2026-10-01');
      await drawer.locator('#overview-date-to').fill('2026-09-01');
      const apply = drawer.getByRole('button', { name: '应用日期', exact: true });
      await apply.click();
      await drawer.getByText('结束日期不能早于开始日期', { exact: true }).waitFor();
      await drawer.locator('#overview-date-from').fill('2026-09-01');
      await drawer.locator('#overview-date-to').fill('2026-10-31');
      await apply.click();
      await drawer.waitFor({ state: 'hidden' });
      const period = page.getByRole('button', { name: '查看统计区间与更新时间' });
      await period.getByText(/09\/01.*10\/31/).waitFor();
      assert.equal(await value(page, 'orders'), '2');
      assert.equal(await compact.inputValue(), 'custom');
      await period.click();
      assert.match(await drawer.innerText(), /上期[\s\S]*08\/31/);
      await page.keyboard.press('Escape');
      assert.equal(await page.locator('.overview-chart-data g').count(), 21);
      await page.getByText('每 3 天汇总', { exact: true }).waitFor();
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await selectRange(page, '自定义日期');
      assert.equal(await drawer.locator('#overview-date-from').inputValue(), '2026-09-01');
      assert.equal(await drawer.locator('#overview-date-to').inputValue(), '2026-10-31');
      await page.keyboard.press('Escape');
      await selectRange(page, '近 7 天');
      assert.equal(await compact.inputValue(), 'week');
      assert.deepEqual(errors, []);
    } finally { await context.close(); }
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
    await page.waitForFunction(() => document.querySelector('#overview-toolbar-status')?.textContent.includes('读取失败'));
    const stock = page.locator('.overview-stock-table tbody tr');
    await page.locator('section[aria-labelledby="overview-inventory"]').getByText('读取失败 · 可重试', { exact: true }).waitFor();
    assert.deepEqual(await stock.first().locator('td').allTextContents(), Array(9).fill('—'));
    assert.deepEqual(await stock.nth(2).locator('td').allTextContents(), Array(9).fill('—'));
    assert.equal(await value(page, 'orders'), '—');
    assert.equal(await value(page, 'profit'), '—');
    assert.deepEqual(await page.locator('.overview-progress-counts dd').allTextContents(), Array(4).fill('—笔'));
    assert.equal(await page.locator('.overview-progress-group progress').count(), 0);
    assert.deepEqual(await page.locator('.overview-customer-detail-count strong').allTextContents(), Array(4).fill('—'));
    assert.equal(await page.getByText('当前没有待处理事项').count(), 0);
    await checkMetricLayout(page);
    fail = false;
    await page.getByRole('button', { name: '刷新数据', exact: true }).click();
    await page.getByText('该时间范围没有订单记录', { exact: true }).waitFor();
    assert.deepEqual(await stock.first().locator('td').allTextContents(), ['0', '0', '0', '0', '0', '—', '0', '0', '0']);
    assert.deepEqual(await stock.nth(2).locator('td').allTextContents(), ['0', '提取时核验', '0', '0', '0', '0', '0', '0', '0']);
    assert.equal(await value(page, 'orders'), '0');
    assert.equal(await value(page, 'receipts'), '0');
    assert.equal(await value(page, 'profit'), '0.00');
    assert.equal(await value(page, 'customers'), '0');
    assert.deepEqual(await page.locator('.overview-progress-counts dd').allTextContents(), Array(4).fill('0笔'));
    assert.equal(await page.locator('.overview-progress-group progress').count(), 0, '没有订单时不伪造确认率或核算率');
    assert.deepEqual(await page.locator('.overview-customer-detail-count strong').allTextContents(), Array(4).fill('0'));
    assert.equal(await page.getByText('当前没有待处理事项').count(), 1);
    for (const width of [2048, 1440, 768, 390, 320]) {
      await page.setViewportSize({ width, height: 1000 });
      for (const theme of ['light', 'dark']) {
        await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
        await settle(page);
        await checkMetricLayout(page);
        await checkStockLayout(page);
      }
    }
    checkTransport(session);
    await context.close();
  });

  await t.test('已录入实收无需再次确认，缺金额、自动预填价和读取失败分别显示', async () => {
    const fixtures = { commerce: { version: 1, data: { ...commerceFixture, orders: [
      current,
      order('legacy-recorded', '2026-11-10T08:00:00', { source: '管理员手工', receiptConfirmed: false, saleAmount: '190' }),
      order('missing-amount', '2026-11-10T08:00:00', { receiptConfirmed: false, saleAmount: '' }),
      order('auto-price', '2026-11-10T08:00:00', { source: '线上代充', taskId: 'synthetic-task', receiptConfirmed: false }),
      order('cancelled-receipt', '2026-11-10T08:00:00', { cancelled: true }),
      order('future-receipt', '2026-11-10T10:40:00.001')
    ] } }, inventory: { version: 1, data: inventoryFixture }, appleBalance: { version: 1, data: appleFixture } };
    const session = await open(undefined, fixtures);
    const { page, context } = session;
    await page.goto(origin + '/#/overview'); await refreshed(page);
    const progress = page.locator('[data-overview-progress-group="receipts"]');
    assert.equal(await progress.locator('progress').getAttribute('value'), '2');
    assert.equal(await progress.locator('progress').getAttribute('max'), '4');
    assert.deepEqual(await progress.locator('dd').allTextContents(), ['2笔', '2笔']);
    assert.match(await progress.innerText(), /50%/);
    assert.match(await progress.innerText(), /已录入实收/);
    assert.doesNotMatch(await progress.innerText(), /待确认实收|实收确认/);
    assert.equal(await value(page, 'receipts'), '440.00');
    await page.route('**/api/local/commerce', route => route.fulfill({ status: 503, json: {} }));
    await page.getByRole('button', { name: '刷新数据', exact: true }).click(); await refreshed(page);
    assert.deepEqual(await progress.locator('dd').allTextContents(), ['2笔', '2笔']);
    assert.match(await progress.innerText(), /读取失败 · 保留/);
    checkTransport(session); await context.close();
  });

  await t.test('充值码申请和 Claude 付租按未处理事项计数，跳转并随版本更新', async () => {
    const session = await open({ id: 'admin-fixture', name: '测试管理员', role: 'admin' }, {}, { changeEvents: true });
    const { page, context } = session;
    const rentBatches = [
      { id: 'RENT-1', items: [{ status: '待发放' }, { status: '已发放' }, { status: '发放失败' }] },
      { id: 'RENT-2', items: [{ status: '已发放' }, { status: '已取消' }] }
    ];
    const requests = [
      { id: 'request-review', plan: 'plus', count: 40, status: 'pending' },
      { id: 'request-check', plan: 'pro100', count: 2, status: 'issuing' }
    ];
    let commerceVersion = 1, rechargeVersion = 1, fail = false, requestDetails = 0;
    await page.route('**/api/local/commerce', route =>
      route.fulfill({ json: { version: commerceVersion, data: { rentBatches } } }));
    await page.route(url => url.pathname === '/api/local/recharge-codes', route => {
      const view = new URL(route.request().url()).searchParams.get('view');
      if (view === 'pending-summary') return fail ? route.fulfill({ status: 503, json: {} })
        : route.fulfill({ json: { version: rechargeVersion,
          pending: requests.filter(row => ['pending', 'issuing'].includes(row.status)).length } });
      requestDetails++;
      return route.fulfill({ json: { canApprove: true, requests, items: [], stock: { plus: 40 } } });
    });
    await page.goto(origin + '/#/overview');
    const tasks = page.locator('[aria-labelledby="overview-tasks"]');
    const recharge = tasks.getByRole('link', { name: /充值码申请待处理/ });
    const rent = tasks.getByRole('link', { name: /Claude 付租待发放/ });
    const taskCount = row => row.locator('.overview-task-count').innerText();
    await recharge.getByText('待审核或待发码核对', { exact: true }).waitFor();
    assert.equal(await taskCount(recharge), '2');
    assert.equal(await taskCount(rent), '2');
    assert.equal(requestDetails, 0);
    await range(page, '今日').click();
    assert.equal(await taskCount(recharge), '2');
    assert.equal(await taskCount(rent), '2');

    await recharge.click();
    await page.locator('[data-request-id="request-review"]').getByText('待审核', { exact: true }).waitFor();
    await page.locator('[data-request-id="request-check"]').getByText('待发码核对', { exact: true }).waitFor();
    await go(page, 'overview');
    await rent.click();
    await page.getByRole('heading', { name: '付租批次', exact: true }).waitFor();
    await page.getByText('RENT-1', { exact: true }).waitFor();
    await go(page, 'overview');
    await refreshed(page);

    fail = true;
    await page.getByRole('button', { name: '刷新数据', exact: true }).click();
    await recharge.getByText(/读取失败 · 保留/).waitFor();
    assert.equal(await taskCount(recharge), '2');
    assert.equal(await taskCount(rent), '2');

    await page.setViewportSize({ width: 390, height: 844 });
    await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
    await settle(page);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const help = tasks.locator('.title-help summary');
    assert.equal(await page.locator('.title-description:popover-open').count(), 0);
    await help.scrollIntoViewIfNeeded();
    await settle(page);
    const before = await tasks.boundingBox();
    await help.click();
    await page.locator('.title-description:popover-open').getByText(/充值码按申请笔数计数/).waitFor();
    assert.deepEqual(await tasks.boundingBox(), before);
    await page.keyboard.press('Escape');
    await page.locator('.title-description:popover-open').waitFor({ state: 'hidden' });

    fail = false;
    requests.forEach(row => { row.status = 'issued'; });
    const emit = (scope, version) => page.evaluate(([scope, version]) =>
      window.IDLocalData.acceptChangeVersions({ [scope]: String(version) }), [scope, version]);
    await emit('recharge-codes', ++rechargeVersion);
    await recharge.waitFor({ state: 'hidden' });
    assert.equal(await taskCount(rent), '2');
    rentBatches[0].items.forEach(item => { item.status = '已发放'; });
    await emit('commerce', ++commerceVersion);
    await rent.waitFor({ state: 'hidden' });
    assert.equal(await tasks.getByText('当前没有待处理事项', { exact: true }).count(), 1);
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
    await page.locator('[data-stock-type="microsoft"] [data-stock-column="registered"]').getByText('1', { exact: true }).waitFor();
    await refreshed(page);
    assert.equal(await page.locator('.overview-metrics, .overview-chart-tools, #overview-customers, #overview-tasks').count(), 0);
    assert.equal(await page.getByRole('link', { name: '苹果隐藏邮箱', exact: true }).count(), 0);
    assert.deepEqual(await page.locator('.overview-stock-table tbody th a').evaluateAll(nodes =>
      nodes.map(node => node.getAttribute('href'))), [
      '#/mailboxes/google', '#/mailboxes/microsoft', '#/accounts/gpt', '#/accounts/claude',
      '#/accounts/gemini', '#/accounts/grok'
    ]);
    assert.deepEqual(requests.filter(({ path }) => ['/api/local/commerce', '/api/local/appleBalance', '/api/local/recharge-codes'].includes(path)), []);
    checkTransport(session);
    await context.close();
  });
});

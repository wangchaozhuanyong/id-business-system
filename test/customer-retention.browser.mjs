import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { interceptDesign, origin, settle } from './helpers/offline-design.mjs';

const at = new Date('2026-11-09T02:00:00Z');
const admin = { id: 'qa-retention-admin', name: '合成管理员', role: 'admin' };
const lossUrl = origin + '/#/workspace/customer-loss';
const order = (id, customerId, start, expiry, extra = {}) => ({
  id, orderNo: id, customerId, start, expiry, email: id.toLowerCase() + '@example.test',
  product: 'GPT', plan: 'Plus', businessType: '续费', payment: '银行卡', paidAmount: '20',
  source: '管理员手工', paidCurrency: 'USD', paidConfirmed: true, receiptConfirmed: true,
  refunds: [], corrections: [], bankReturns: [],
  ...extra
});
function fixtures() {
  const customer = (id, name, extra = {}) => ({ id, name, active: true, ...extra });
  const customers = [
    customer('main', '合成复购客户', { wechat: 'layout-customer' }),
    customer('active', '仍有有效服务'), customer('incomplete', '周期缺失客户'),
    customer('shared-a', '共享联系甲', { phone: '01000000001' }),
    customer('shared-b', '共享联系乙', { phone: '01000000001' }),
    customer('scheduled', '等待生效客户'), customer('released', '账号回收客户'),
    customer('new-owner', '账号接手客户'), customer('ended', '终止时间缺失客户')
  ];
  const expired = (id, owner, extra) => order(id, owner, '2026-09-01T10:00', '2026-10-01T10:00', extra);
  const active = (id, owner, extra) => order(id, owner, '2026-11-01T10:00', '2026-12-01T10:00', extra);
  const automatic = { source: '线上代充', paidConfirmed: false, paidAmount: '', rechargeCompletedAt: '2026-10-09T02:00:00Z' };
  const success = order('QA-GPT-RENEW', 'main', '2026-10-09T10:00', '2026-11-08T10:00', {
    ...automatic, taskId: 'qa-duplicated-task', plan: 'Pro 100', email: 'gpt@example.test'
  });
  const stock = { accountId: 'qa-stock', email: 'stock@example.test', businessType: '成品交付' };
  const orders = [
    expired('QA-GPT-LEGACY', '', { plan: 'Pro 5x', email: success.email, wechat: 'layout-customer' }),
    success, { ...success, id: 'QA-SYNC-RETRY', orderNo: 'QA-SYNC-RETRY' },
    order('QA-CLAUDE-MAX', 'main', '2026-10-08T10:00', '2026-11-05T10:00', {
      product: 'Claude Max', plan: 'Max 5x', refunds: [{ amount: '5' }]
    }),
    ...Array.from({ length: 11 }, (_, i) => active('QA-DRAFT-' + i, 'main', { draft: true, paidConfirmed: false, paidAmount: '' })),
    expired('QA-OLD-ACTIVE', 'active'),
    active('QA-ACTIVE-CLAUDE', 'active', { product: 'Claude Pro', plan: 'Pro' }),
    active('QA-UNKNOWN-PLAN', 'active', { plan: '旧资料缺标签' }),
    expired('QA-INCOMPLETE-OLD', 'incomplete'),
    active('QA-PERIOD', 'incomplete', { expiry: '' }),
    expired('QA-SHARED-OLD', 'shared-a'),
    active('QA-AMBIGUOUS', '', { customerPhone: '01000000001' }),
    expired('QA-UNBOUND', '', { ...automatic, taskId: 'qa-unbound', email: success.email, rechargeCompletedAt: '2026-09-01T02:00:00Z' }),
    expired('QA-SCHEDULED-OLD', 'scheduled'),
    order('QA-SCHEDULED', 'scheduled', '2026-11-11T10:00', '2026-12-11T10:00'),
    active('QA-RELEASED', 'released', stock),
    order('QA-REUSE', 'new-owner', '2026-11-07T10:00', '2026-12-07T10:00', stock),
    active('QA-END-UNKNOWN', 'ended', { subscriptionEnded: true }),
    active('QA-CONFLICT-A', 'active', { ...automatic, taskId: 'qa-conflict', rechargeCompletedAt: '2026-11-01T02:00:00Z' }),
    active('QA-CONFLICT-B', 'active', { ...automatic, taskId: 'qa-conflict', plan: 'Pro 500', rechargeCompletedAt: '2026-11-01T02:00:00Z' }),
    active('QA-NO-COMPLETION', 'active', { ...automatic, taskId: 'qa-no-completion', rechargeCompletedAt: '' })
  ];
  for (let i = 1; i <= 11; i++) {
    customers.push(customer('older-' + i, '较早停用客户 ' + i));
    orders.push(expired('QA-OLDER-' + i, 'older-' + i));
  }
  return {
    commerce: { version: 1, data: { customers, orders, tenants: [], rentBatches: [], operating: [], logs: [
      { type: '关联续费订单', entityId: 'QA-GPT-LEGACY', relatedOrderId: 'QA-GPT-RENEW' },
      { type: '拒续费', entityId: 'QA-OLD-ACTIVE' }
    ] } },
    inventory: { version: 1, data: { mailboxes: [], accounts: [{ id: 'qa-stock', type: 'gpt', email: stock.email }] },
      accountSummaries: [{ assetId: 'qa-stock', systemOwned: true,
        orders: [{ id: 'QA-RELEASED', released: true }, { id: 'QA-REUSE', released: false }],
        events: [{ action: 'release', time: '2026-11-06 15:00', orderIds: ['QA-RELEASED'] }]
      }] }
  };
}
const summary = page => page.locator('.retention-overview .summary-number').allTextContents();
const mainPager = page => page.locator('#main [data-pagination="main-list"]');
const list = page => page.locator('table[data-table="commerce-customer-loss"]');
const tab = (page, name) => page.getByRole('tab', { name }).click();
const drawer = page => page.locator('#drawer');
const search = page => page.getByRole('textbox', { name: '搜索当前列表' });
const waitForList = page => page.getByRole('region', { name: '客户流失概览' }).waitFor();
const overviewMetric = (page, label) => page.locator('.overview-customer-summary > div')
  .filter({ has: page.getByText(label, { exact: true }) });
const loadedMetrics = ['13位客户', '2位客户', '8笔', '1位客户'];

async function openFixture(browser, data, actor = admin) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 960 }, serviceWorkers: 'block' });
  const requests = await interceptDesign(context, { localFixtures: data, actor, skipRechargeAssets: true });
  const page = await context.newPage();
  page.setDefaultTimeout(6500);
  await page.clock.setFixedTime(at);
  const errors = [], writes = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('request', request => {
    if (/\/api\/local\/(commerce|inventory)$/.test(request.url()) &&
        !['GET', 'HEAD'].includes(request.method())) writes.push(request.method());
  });
  return { context, requests, page, errors, writes };
}

test('客户流失归集、订阅历史、数据核对与响应式离线验收', { timeout: 120_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const data = fixtures();
  const { context, page, requests, errors, writes } = await openFixture(browser, data);
  t.after(() => context.close());
  const output = process.env.ID_LAYOUT_QA_OUTPUT;
  if (output) await mkdir(output, { recursive: true });

  await t.test('导航、订阅次数、停用天数与首页共用统计', async () => {
    await page.goto(origin + '/#/overview');
    await overviewMetric(page, '已确认流失').getByText('13位', { exact: true }).waitFor();
    assert.equal(await overviewMetric(page, '有效服务').locator('dd').textContent(), '2位');
    await page.locator('#sidebar').getByRole('button', { name: '数据管理', exact: true }).click();
    await page.locator('#sidebar').getByRole('link', { name: '客户流失', exact: true }).click();
    await waitForList(page);
    assert.equal(await page.locator('#breadcrumbs').innerText(), '数据管理');
    assert.deepEqual(await summary(page), loadedMetrics);
    const main = list(page).getByRole('row').filter({ hasText: '合成复购客户' });
    assert.match(await main.innerText(), /3 次.*GPT · Pro 100 2 次.*Claude Max · Max 5x 1 次/s);
    const recovered = list(page).getByRole('row').filter({ hasText: '账号回收客户' });
    assert.match(await recovered.innerText(), /2026-11-06 15:00.*3 天/s);
    assert.doesNotMatch(await list(page).innerText(), /仍有有效服务|账号接手客户|周期缺失客户|共享联系甲|等待生效客户/);
    assert.equal(await mainPager(page).getAttribute('data-page-size'), '20');
    await mainPager(page).getByLabel('每页条数').selectOption('10');
    await mainPager(page).getByRole('button', { name: '下一页' }).click();
    assert.equal(await mainPager(page).getAttribute('data-page'), '2');
    assert.equal(await list(page).locator('tbody tr[data-row-id]').count(), 3);
    await page.getByLabel('产品和套餐', { exact: true }).selectOption(JSON.stringify(['GPT', 'Pro 100']));
    await page.getByLabel('订阅次数', { exact: true }).selectOption('few');
    await page.getByLabel('排序方式', { exact: true }).selectOption('count');
    await search(page).fill('QA-GPT-LEGACY');
    assert.equal(await mainPager(page).getAttribute('data-total'), '1');
    assert.equal(await mainPager(page).getAttribute('data-page'), '1');
    await main.getByRole('button', { name: '订阅历史', exact: true }).click();
    const history = drawer(page).locator('[data-retention-history]');
    await drawer(page).getByRole('heading', { name: '客户订阅历史' }).waitFor();
    assert.deepEqual(await drawer(page).locator('.summary-number').allTextContents(), ['3次', '0项', '2个', '0笔']);
    assert.match(await drawer(page).locator('.property-list').innerText(), /已关联原单的续费\s+1 次/);
    assert.equal(await history.locator('nav').getAttribute('data-total'), '14');
    assert.match(await history.innerText(), /开通待确认/);
    assert.equal(await history.locator('nav').getAttribute('data-page-size'), '20');
    await history.getByLabel('每页条数').selectOption('10');
    await history.getByRole('button', { name: '下一页' }).click();
    assert.equal(await history.locator('nav').getAttribute('data-page'), '2');
    await history.getByRole('button', { name: '查看订单 QA-GPT-LEGACY', exact: true }).click();
    await drawer(page).getByRole('heading', { name: '订单详情', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    assert.equal(await search(page).inputValue(), 'QA-GPT-LEGACY');
    assert.equal(await page.getByLabel('订阅次数', { exact: true }).inputValue(), 'few');
    await search(page).fill('');
    await page.getByLabel('产品和套餐', { exact: true }).selectOption('');
    await page.getByLabel('订阅次数', { exact: true }).selectOption('');
    await page.getByLabel('排序方式', { exact: true }).selectOption('recent');
  });

  await t.test('明确待核对原因，未来服务单列，刷新失败保留上次资料', async () => {
    await tab(page, /^待核对/);
    const text = await list(page).innerText();
    for (const issue of ['客户归属待核对', '订阅周期缺失或无效', '联系方式匹配多个客户',
      '实际终止时间待核对', '重复订单或代充任务资料冲突', '套餐待核对', '代充开通证据待核对'])
      assert(text.includes(issue), issue);
    await list(page).getByRole('row').filter({ hasText: 'QA-PERIOD' })
      .getByRole('button', { name: '查看订单', exact: true }).click();
    await drawer(page).getByRole('button', { name: '编辑资料', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await tab(page, /^待生效/);
    await list(page).getByText('等待生效客户', { exact: true }).waitFor();
    assert.match(await list(page).innerText(), /2026-11-11 10:00/);
    const gate = Promise.withResolvers();
    const commerceUrl = origin + '/api/local/commerce';
    await context.route(commerceUrl, async route => {
      await gate.promise;
      return route.fulfill({ status: 503, json: {} });
    }, { times: 1 });
    try {
      await page.getByRole('button', { name: '刷新', exact: true }).click();
      await page.locator('[data-retention-progress]').waitFor();
      assert.deepEqual(await summary(page), loadedMetrics);
    } finally { gate.resolve(); }
    await page.getByText(/部分资料读取失败/).waitFor();
    assert.deepEqual(await summary(page), loadedMetrics);
    data.commerce.version++;
    data.commerce.data.orders.find(row => row.id === 'QA-PERIOD').expiry = '2026-10-30T10:00';
    data.commerce.data.orders.find(row => row.id === 'QA-PERIOD').start = '2026-10-01T10:00';
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await page.getByText(/部分资料读取失败/).waitFor({ state: 'hidden' });
    assert.deepEqual(await summary(page), ['14位客户', '2位客户', '7笔', '1位客户']);
    await page.goto(origin + '/#/overview');
    await overviewMetric(page, '已确认流失').getByText('14位', { exact: true }).waitFor();
    await page.getByRole('link', { name: '查看客户流失', exact: true }).click();
    await tab(page, /^已流失/);
  });

  await t.test('宽窄屏深浅主题、分隔线、操作与空状态', async () => {
    for (const width of [1440, 1024, 901, 900, 768, 390, 320]) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 960 });
      await page.evaluate(value => { document.documentElement.dataset.theme = value; }, theme);
      await settle(page);
      const geometry = await page.locator('.customer-retention-list .list-controls').evaluate(region => {
        const box = region.getBoundingClientRect();
        const controls = [...region.querySelectorAll('.toolbar :is(input,select,button)')].filter(el => el.checkVisibility());
        const controlsFit = controls.every(el => {
          const rect = el.getBoundingClientRect();
          return rect.left >= box.left - 1 && rect.right <= box.right + 1 && box.bottom - rect.bottom >= 7.5;
        });
        return { controlsFit, pageOverflow: document.documentElement.scrollWidth > innerWidth + 1 };
      });
      assert.deepEqual(geometry, { controlsFit: true, pageOverflow: false }, `${width}/${theme}`);
      if ([1440, 390, 320].includes(width)) {
        const row = width <= 760 ? page.locator('[data-retention-card="main"]') :
          list(page).getByRole('row').filter({ hasText: '合成复购客户' });
        const action = row.getByRole('button', { name: '订阅历史', exact: true });
        if (width <= 760) assert((await action.boundingBox()).height >= 44);
        await action.click();
        await drawer(page).getByRole('heading', { name: '客户订阅历史' }).waitFor();
        const box = await drawer(page).boundingBox();
        assert(Math.abs(box.x + box.width - width) <= 1);
        assert(await drawer(page).evaluate(el => el.scrollWidth <= el.clientWidth + 1));
        if (output && [1440, 390].includes(width))
          await page.screenshot({ path: join(output, `history-${width}-${theme}.png`) });
        await page.keyboard.press('Escape');
      }
      if (output && [1440, 390].includes(width)) await page.screenshot({ path: join(output, `list-${width}-${theme}.png`) });
      await search(page).fill('不存在的客户');
      await page.getByText('暂无符合条件的记录', { exact: true }).filter({ visible: true }).waitFor();
      assert.equal(await mainPager(page).getAttribute('data-total'), '0');
      await search(page).fill('');
    }
  });

  await t.test('首次读取失败可恢复，员工旧链接继续受限', async () => {
    const first = await openFixture(browser, data);
    const inventoryGate = Promise.withResolvers();
    try {
      await first.context.route(origin + '/api/local/commerce', route =>
        route.fulfill({ status: 503, json: {} }), { times: 1 });
      await first.context.route(origin + '/api/local/inventory', async route => {
        await inventoryGate.promise;
        return route.fulfill({ json: data.inventory });
      }, { times: 1 });
      await first.page.goto(lossUrl);
      await first.page.getByText('无法读取业务资料', { exact: true }).waitFor();
      assert.equal(await first.page.locator('.retention-overview .summary-number').count(), 0);
      await first.page.getByRole('button', { name: '重试', exact: true }).click();
      await first.page.getByText('正在核对库存使用关系', { exact: true }).waitFor();
      assert.equal(await first.page.locator('.retention-overview .summary-number').count(), 0);
      inventoryGate.resolve();
      await waitForList(first.page);
      assert.equal(await first.page.locator('#breadcrumbs').innerText(), '数据管理');
    } finally {
      inventoryGate.resolve();
      await first.context.close();
    }
    const staff = await openFixture(browser, data, { id: 'qa-staff', name: '合成员工', role: 'employee' });
    try {
      await staff.page.goto(lossUrl);
      await staff.page.getByRole('heading', { name: '访问受限' }).waitFor();
      assert.equal(await staff.page.locator('.retention-overview').count(), 0);
      assert.equal(await staff.page.getByRole('button', { name: '数据管理', exact: true }).count(), 0);
    } finally { await staff.context.close(); }
  });

  assert.deepEqual(errors, []);
  assert.deepEqual(writes, []);
  assert.deepEqual(requests.external, []);
  assert.deepEqual(requests.unavailable, []);
});

test('已确认开通的人工订阅按周期统计流失，财务或邮箱缺项可后补', { timeout: 90_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const customers = Array.from({ length: 43 }, (_, i) => ({ id: `manual-${i}`, name: `合成到期客户 ${i + 1}`, active: true }));
  const products = [['GPT', 'Plus'], ['Claude Pro', 'Pro'], ['Claude Max', 'Max 5x']];
  const orders = customers.map((customer, i) => order(`QA-MANUAL-${i}-ROW`, customer.id, '2026-10-08T10:00', '2026-11-08T10:00', {
    product: products[i % 3][0], plan: products[i % 3][1], email: '', source: '管理员手工',
    entitlementStatus: 'active', paidConfirmed: false, receiptConfirmed: false, costConfirmed: false
  }));
  const data = {
    commerce: { version: 1, data: { customers, orders, tenants: [], operating: [], rentBatches: [], logs: [] } },
    inventory: { version: 1, data: { accounts: [], mailboxes: [] }, accountSummaries: [] }
  };
  const { context, page, writes, errors, requests } = await openFixture(browser, data);
  t.after(() => context.close());
  await page.goto(lossUrl);
  await waitForList(page);
  const output = process.env.ID_LAYOUT_QA_OUTPUT;
  if (output) {
    await mkdir(output, { recursive: true });
    await page.screenshot({ path: join(output, 'manual-expired-43.png') });
  }
  assert.deepEqual(await summary(page), ['43位客户', '43位客户', '0笔', '0位客户']);
  assert.equal(await mainPager(page).getAttribute('data-total'), '43');
  await mainPager(page).getByRole('button', { name: '下一页' }).click();
  await mainPager(page).getByRole('button', { name: '下一页' }).click();
  assert.equal(await list(page).locator('tbody tr[data-row-id]').count(), 3);
  await search(page).fill('QA-MANUAL-0-ROW');
  await list(page).getByRole('button', { name: '订阅历史', exact: true }).click();
  assert.deepEqual(await drawer(page).locator('.summary-number').allTextContents(), ['1次', '0项', '0个', '0笔']);
  await drawer(page).getByRole('button', { name: '查看订单 QA-MANUAL-0-ROW', exact: true }).click();
  await drawer(page).getByRole('heading', { name: '订单详情', exact: true }).waitFor();
  assert.match(await drawer(page).innerText(), /付款状态\s+付款待核对/);
  await page.keyboard.press('Escape');
  await search(page).fill('');

  // Follow-up reads use the same customers with active, future, invalid and cancelled renewals.
  // No write request is sent; only the isolated read fixture changes.
  data.commerce.version++;
  orders[8].paidAmount = '';
  data.commerce.data.orders.push(
    order('QA-RENEWED-OTHER-ACCOUNT', 'manual-0', '2026-11-08T10:00', '2026-12-08T10:00', {
      product: 'Claude Max', plan: 'Max 5x', entitlementStatus: 'active', paidConfirmed: false, email: 'different@example.test'
    }),
    order('QA-RENEWED-NO-AMOUNT', 'manual-1', '2026-11-08T10:00', '2026-12-08T10:00', {
      entitlementStatus: 'active', paidAmount: '', paidConfirmed: false, email: ''
    }),
    order('QA-RENEWED-FUTURE', 'manual-2', '2026-11-11T10:00', '2026-12-11T10:00', { entitlementStatus: 'active', paidConfirmed: false }),
    { ...orders[3] },
    ...['cancelled', 'failed', 'draft'].map((status, i) =>
      order('QA-NOT-OPENED-' + status, `manual-${i + 4}`, '2026-11-01T10:00', '2026-12-01T10:00', { status })),
    order('QA-MISSING-EXPIRY', 'manual-7', '2026-11-08T10:00', '', { paidConfirmed: false, paidAmount: '' })
  );
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByRole('tab', { name: '已流失 39', exact: true }).waitFor();
  assert.deepEqual(await summary(page), ['39位客户', '39位客户', '1笔', '1位客户']);
  for (const id of ['QA-MANUAL-0-ROW', 'QA-MANUAL-1-ROW', 'QA-MANUAL-2-ROW', 'QA-MANUAL-7-ROW']) {
    await search(page).fill(id);
    assert.equal(await mainPager(page).getAttribute('data-total'), '0', id + '不应误判流失');
  }
  for (const id of ['QA-MANUAL-3-ROW', 'QA-MANUAL-4-ROW', 'QA-MANUAL-5-ROW', 'QA-MANUAL-6-ROW', 'QA-MANUAL-8-ROW']) {
    await search(page).fill(id);
    assert.equal(await mainPager(page).getAttribute('data-total'), '1', id + '应按到期订阅统计');
    assert.match(await list(page).innerText(), /1 次/);
  }
  await search(page).fill('');
  await tab(page, /^待核对/);
  assert.equal(await mainPager(page).getAttribute('data-total'), '1');
  assert.match(await list(page).innerText(), /QA-MISSING-EXPIRY.*订阅周期缺失或无效/s);
  assert.doesNotMatch(await list(page).innerText(), /开通凭据待核对/);
  await tab(page, /^待生效/);
  assert.match(await list(page).innerText(), /合成到期客户 3/);
  await page.goto(origin + '/#/overview');
  await overviewMetric(page, '已确认流失').getByText('39位', { exact: true }).waitFor();
  assert.equal(await overviewMetric(page, '有效服务').locator('dd').textContent(), '2位');
  await page.clock.setFixedTime(new Date('2026-12-08T02:00:00Z'));
  await page.goto(lossUrl);
  await waitForList(page);
  assert.deepEqual(await summary(page), ['41位客户', '2位客户', '1笔', '0位客户']);
  await page.clock.setFixedTime(new Date('2026-12-12T02:00:00Z'));
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByRole('tab', { name: '已流失 42', exact: true }).waitFor();
  assert.deepEqual(await summary(page), ['42位客户', '3位客户', '1笔', '0位客户']);
  assert.equal(data.commerce.data.orders[0].paidConfirmed, false);
  assert.equal(data.commerce.data.orders[0].receiptConfirmed, false);
  assert.equal(data.commerce.data.orders[0].costConfirmed, false);
  assert.deepEqual(writes, []);
  assert.deepEqual(errors, []);
  assert.deepEqual(requests.external, []);
  assert.deepEqual(requests.unavailable, []);
});

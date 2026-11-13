import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { interceptDesign, origin, settle, separatorSnapshot } from './helpers/offline-design.mjs';

const { chromium } = await import(process.env.ID_RECHARGE_QA_PLAYWRIGHT
  ? pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href : 'playwright');
const at = Date.parse('2026-11-13T06:00:00Z');
const diagnostic = '01234567-1234-4123-8abc-123456789abc';
const groups = {
  browser: { total: 32, successes: 30, failed: 2, p95: 750, activities: [
    { activity: 'customer-search', total: 32, failed: 2, blocked: 0, p95: 750 }
  ], trend: [{ at, p95: 750 }] },
  server: { total: 34, successes: 30, failed: 3, p95: 200, activities: [
    { activity: 'order-save', total: 34, failed: 3, blocked: 1, p95: 200 }
  ], trend: [{ at, p95: 200 }] }
};
const sources = [{ key: 'orders', state: 'watch', lastSuccessAt: at - 2_000, pending: 3, problem: '有订单资料等待读回' }];

async function environment(browser, role) {
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, acceptDownloads: true });
  const access = await interceptDesign(context, { skipRechargeAssets: true, localFixtures: {}, siteTelemetry: true,
    actor: { id: 'site-fixture-' + role, name: '合成用户', role } });
  const reads = [], writes = [];
  let breakPerformance = false, slowHealth = false;
  await context.route('**/api/local/site-management**', async route => {
    const request = route.request(), params = new URL(request.url()).searchParams, view = params.get('view');
    if (request.method() === 'POST') {
      if (new URL(request.url()).pathname.endsWith('/timing')) return route.fulfill({ status: 204 });
      writes.push(request.postDataJSON());
      return route.fulfill({ contentType: 'text/csv; charset=utf-8', headers: { 'X-ID-Export-Count': '1' },
        body: '订单编号,产品\nOD-LOCAL-0094,GPT\n' });
    }
    reads.push(view);
    if (view === 'performance') return breakPerformance
      ? route.fulfill({ status: 503, json: { error: '隐藏的测试错误' } })
      : route.fulfill({ json: { at, hours: +params.get('hours'), storageAvailable: true, groups } });
    if (view === 'diagnostic') return route.fulfill({ json: { item: params.get('id') === diagnostic ?
      { id: diagnostic, at, activity: 'order-save', result: 'failed', channel: 'server', version: 'f'.repeat(40) } : null } });
    if (view === 'resources') return route.fulfill({ json: { latest: { at, cpu: 5, disk: 72, memory: 32 },
      trend: [{ at, cpu: 5, disk: 72, memory: 32 }], sources, externalProbe: { state: 'disabled' } } });
    if (view === 'backups') return route.fulfill({ json: { sampledAt: at, collector: 'connected', databases: [
      { key: 'business', state: 'verified', capturedAt: at - 500, verifiedAt: at, exercise: null },
      { key: 'recharge', state: 'stale', capturedAt: at - 500_000, verifiedAt: at - 450_000,
        exercise: { capturedAt: at - 500_000, finishedAt: at - 510, durationMs: 4000 } }
    ] } });
    if (view === 'information') return route.fulfill({ json: {
      official: true, domain: 'id.example.test', timeZone: '北京时间（UTC+8）', version: 'f'.repeat(40), updatedAt: at
    } });
    if (view === 'health') {
      if (slowHealth) await new Promise(resolve => setTimeout(resolve, 250));
      const empty = params.get('kind') === 'duplicate';
      const page = +(params.get('page') || 1);
      return route.fulfill({ json: { at, total: empty ? 0 : 26, page: empty ? 1 : page, pageSize: 20,
        coverage: { inventory: true, synchronization: true }, items: empty ? [] :
          Array.from({ length: page === 2 ? 6 : 20 }, (_, index) => ({
            at, type: 'inventory', orderId: 'order-fixture-' + index, orderNo: 'OD-LOCAL-00' + index, product: 'GPT'
          })), sources } });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  return { page, context, reads, writes, errors, access, fail: () => { breakPerformance = true; },
    delayHealth: () => { slowHealth = true; } };
}

test('admin can diagnose a report, navigate through data, and download only the selected fields', { timeout: 35_000 }, async t => {
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const { page, reads, writes, errors, access, fail, delayHealth, context } = await environment(browser, 'admin');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto(origin + '/#/monitor/performance');
  await page.getByRole('heading', { name: '性能与错误' }).waitFor();
  await page.getByRole('heading', { name: '哪些页面操作较慢' }).waitFor();
  assert.equal(await page.getByLabel('查看时段').inputValue(), '24');
  await page.getByLabel('查看内容').selectOption('server');
  await page.getByRole('heading', { name: '哪些操作在服务器处理较慢' }).waitFor();
  assert.deepEqual(reads, ['performance']);
  await page.getByLabel('查看时段').selectOption('168');
  await page.waitForFunction(() => document.querySelector('[data-site-content]').dataset.siteKey === '{"hours":168}');
  const field = page.getByLabel('诊断编号', { exact: true });
  await field.fill(diagnostic);
  await page.locator('#site-diagnostic-form').getByRole('button', { name: '查询' }).click();
  await page.getByText('先到订单列表确认是否已有这笔订单，再决定是否提交。', { exact: true }).waitFor();
  fail();
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByText('暂时无法更新。这里显示的是上次取得的资料。').waitFor();
  assert.equal(await field.inputValue(), diagnostic);

  await page.evaluate(() => window.IDDesignAPI.go('data/health'));
  const region = page.locator('[data-site-section="health"]');
  await region.getByRole('link', { name: '查看订单', exact: true }).first().waitFor();
  assert.equal(await region.getByRole('link', { name: '查看订单', exact: true }).first().getAttribute('href'), '#/orders/detail/order-fixture-0');
  await region.getByRole('button', { name: '下一页', exact: true }).click();
  await page.waitForFunction(() => document.querySelector('[data-site-section="health"] [data-site-content]').dataset.siteKey.includes('"page":2'));
  await page.getByLabel('问题类型').selectOption('duplicate');
  await page.getByText('当前检查范围内没有发现问题', { exact: true }).waitFor();
  delayHealth();
  await page.getByRole('button', { name: '刷新', exact: true }).click();
  await page.getByRole('link', { name: '备份与恢复', exact: true }).click();
  await page.getByRole('heading', { name: '网站业务资料', exact: true }).waitFor();
  await page.getByText('尚无通过记录', { exact: true }).waitFor();
  await page.getByText('4 秒', { exact: true }).waitFor();
  for (const width of [1440, 900, 390, 320]) for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await settle(page);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true, width + ' ' + theme);
    const spacing = await separatorSnapshot(page);
    assert.deepEqual(spacing.findings, [], width + ' ' + theme);
  }
  await page.getByRole('link', { name: '导出与保留', exact: true }).click();
  await page.getByLabel('资料类型').selectOption('orders');
  await page.getByLabel('录入日期从').fill('2026-11-12');
  await page.getByLabel('至', { exact: true }).fill('2026-11-13');
  await page.getByLabel('产品', { exact: true }).selectOption('GPT');
  await page.getByLabel('状态', { exact: true }).selectOption('recorded');
  const [download] = await Promise.all([page.waitForEvent('download'),
    page.getByRole('button', { name: '下载表格', exact: true }).click()]);
  assert.equal(download.suggestedFilename(), '订单-脱敏.csv');
  assert.match(await readFile(await download.path(), 'utf8'), /OD-LOCAL-0094,GPT/);
  assert.deepEqual(writes, [{ collection: 'orders', start: '2026-11-12', end: '2026-11-13',
    status: 'recorded', product: 'GPT' }]);
  await page.evaluate(() => window.IDDesignAPI.go('settings/information'));
  await page.getByText('id.example.test', { exact: true }).waitFor();
  assert.equal(await page.getByRole('link', { name: '查看操作记录' }).getAttribute('href'), '#/settings/audit');
  assert.deepEqual(errors, []);
  assert.deepEqual(access.external, []);
});

test('ordinary employee can open business pages while administrative views remain protected', { timeout: 15_000 }, async t => {
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const { page, reads, errors } = await environment(browser, 'employee');
  await page.goto(origin + '/#/monitor/performance');
  await page.getByRole('heading', { name: '访问受限' }).waitFor();
  for (const route of ['data/health', 'data/backups', 'data/export', 'settings/information']) {
    await page.evaluate(value => window.IDDesignAPI.go(value), route);
    await page.locator('[data-page-region="' + route + '"]').getByText('当前账号无权打开此页面').waitFor();
  }
  assert.deepEqual(reads, []);
  assert.deepEqual(errors, []);
});

test('customer query errors copy a diagnostic number and leave customer input out of measurements', { timeout: 15_000 }, async t => {
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const { page, context, errors } = await environment(browser, 'admin');
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await context.route('**/api/local/customer-query/search', route => route.fulfill({ status: 503,
    headers: { 'X-ID-Diagnostic': diagnostic }, json: { error: '客户资料暂时无法读取' } }));
  await page.goto(origin + '/#/workspace/customer-query');
  await page.getByRole('searchbox', { name: '客户姓名或微信' }).fill('合成客户标记');
  const timing = page.waitForRequest(request => new URL(request.url()).pathname === '/api/local/site-management/timing');
  await page.locator('#customer-query-search').getByRole('button', { name: '查询', exact: true }).click();
  const sample = (await timing).postDataJSON();
  assert.deepEqual(Object.keys(sample).sort(), ['activity', 'elapsed', 'id', 'result']);
  assert.equal(sample.id, diagnostic);
  assert.equal(sample.result, 'failed');
  await page.getByRole('button', { name: '复制编号', exact: true }).click();
  assert.equal(await page.evaluate(() => navigator.clipboard.readText()), diagnostic);
  assert.deepEqual(errors, []);
});

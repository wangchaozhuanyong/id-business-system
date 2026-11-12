import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { interceptDesign, origin, root, settle } from './helpers/offline-design.mjs';

const sources = new Map([
  ['flashcast.com.my', 1234],
  ['damatong.net', 321],
  ['moyaoai.com', 654],
  ['shop.flashcast.com.my', 987]
]);
const admin = { id: 'fixture-admin', name: '验收管理员', role: 'admin' };
const today = new Date('2026-11-12T03:10:00Z');
const fetchedAt = '2026-11-12T03:09:41Z';
const format = new Intl.NumberFormat('zh-CN');

function report(site, days, state) {
  const common = { status: state, site, days };
  if (state === 'unconfigured') return { ...common, summary: null, daily: [] };
  const renovation = site === 'flashcast.com.my';
  const traffic = renovation ? { sessions: 458, visitors: 306 } : { visits: 458 };
  return {
    ...common,
    timeZone: renovation ? 'Asia/Kuala_Lumpur' : 'UTC',
    fetchedAt,
    summary: state === 'ready' ? { pageViews: sources.get(site), ...traffic } : null,
    daily: Array.from({ length: days }, (_, index) => ({
      date: new Date(Date.UTC(2026, 10, 12 - days + 1 + index)).toISOString().slice(0, 10),
      metrics: state === 'ready' && index !== 1
        ? { pageViews: 170 + (index * 39) % 138, ...(renovation ? { sessions: 31, visitors: 20 } : { visits: 31 }) }
        : null
    }))
  };
}

test('data center navigation, four website reports, reporting dates and responsive layout', { timeout: 45_000 }, async t => {
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const { external, unavailable } = await interceptDesign(context, { localFixtures: {}, actor: admin, skipRechargeAssets: true });
  const requests = [];
  let mode = 'ready';
  await context.route('**/api/local/tools/website-analytics?*', route => {
    const request = route.request();
    const params = new URL(request.url()).searchParams;
    const site = params.get('site'), days = Number(params.get('days'));
    requests.push([request.method(), site, days]);
    return mode === 'error' ? route.fulfill({ status: 503, json: { error: '合成内部错误' } })
      : route.fulfill({ json: report(site, days, mode) });
  });
  await context.route('**/api/local/tools/sheets-status', route => route.fulfill({ json: {
    state: 'no_receipt', reportedAt: null, verifiedAt: null, failures: null, tabs: []
  } }));
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  await page.clock.setFixedTime(today);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/#/overview');
  const side = page.locator('#sidebar');
  const groups = await side.locator('.nav-heading').allTextContents();
  const pluginIndex = groups.indexOf('插件管理');
  assert(pluginIndex >= 0);
  assert.deepEqual(groups.slice(pluginIndex, pluginIndex + 3), ['插件管理', '数据中心', '监控中心']);
  await side.getByRole('button', { name: '插件管理', exact: true }).click();
  assert.deepEqual(await side.locator('.nav-children a').allTextContents(), ['邮箱查询与邮箱池', '网站监控']);
  await side.getByRole('link', { name: '数据中心', exact: true }).click();
  const tabs = page.getByRole('navigation', { name: '数据中心栏目', exact: true });
  assert.deepEqual(await tabs.getByRole('link').allTextContents(), ['网站统计', '谷歌表格同步']);
  assert.equal(await tabs.getByRole('link', { name: '网站统计', exact: true }).getAttribute('aria-current'), 'page');
  const workspace = page.locator('[data-traffic]');
  const select = workspace.getByLabel('网站', { exact: true });
  const refresh = workspace.getByRole('button', { name: '刷新统计', exact: true });
  const metrics = workspace.locator('.summary-label');
  const overview = workspace.locator('[data-traffic-summary]');
  const waitForViews = (value) => overview.locator('.summary-number').first()
    .filter({ hasText: new RegExp('^' + format.format(value) + '次$') }).waitFor();
  await waitForViews(1234);
  assert.equal(await select.inputValue(), 'flashcast.com.my');
  assert.equal(await workspace.getByRole('button', { name: '最近 7 天' }).getAttribute('aria-pressed'), 'true');
  assert.deepEqual(await select.locator('option').allTextContents(), ['FLASH CAST 装修站', '大马通', '模钥商城', '闪铸商城']);
  assert.match(await overview.innerText(), /2026-11-06 至 2026-11-12/);
  assert.match(await overview.innerText(), /马来西亚时间.*上次读取 2026-11-12 11:09/s);
  await overview.getByText('今日数据仍在更新', { exact: true }).waitFor();
  assert.deepEqual(await metrics.allTextContents(), ['浏览量', '访问次数', '访客数']);

  const output = join(root, '.runtime', 'data-center-review');
  await mkdir(output, { recursive: true });
  for (const width of [1440, 1024, 901, 900, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await settle(page);
      const geometry = await workspace.evaluate(node => {
        const rect = element => element.getBoundingClientRect();
        const heading = node.querySelector('.data-traffic-heading');
        const select = rect(node.querySelector('select'));
        const period = rect(node.querySelector('.data-traffic-period'));
        const panel = rect(heading);
        const chart = rect(node.querySelector('.design-chart-plot'));
        return {
          overflow: document.documentElement.scrollWidth > innerWidth || chart.right > panel.right,
          gaps: [...heading.querySelectorAll('button,select,summary')].map(control => panel.bottom - 1 - rect(control).bottom),
          heights: [...heading.querySelectorAll('button,select,summary')].map(control => rect(control).height),
          aligned: Math.abs(select.top + select.height / 2 - (period.top + period.height / 2)) <= 1,
          stacked: select.bottom < period.top
        };
      });
      const context = JSON.stringify({ width, theme, geometry });
      assert(!geometry.overflow && geometry.gaps.every(gap => gap >= 8), context);
      if (width === 1440) assert(geometry.aligned, context);
      if (width <= 390) assert(geometry.stacked && geometry.heights.every(height => height >= 44), context);
      if ([1440, 390].includes(width)) await page.screenshot({ path: join(output, `traffic-${width}-${theme}.png`), fullPage: true });
    }
  }

  const help = workspace.locator('.data-traffic-heading .title-help summary');
  const bounds = await overview.boundingBox();
  assert.equal(await help.locator('..').getAttribute('open'), null);
  await help.click();
  await page.locator('#traffic-overview-help').waitFor();
  assert.deepEqual(await overview.boundingBox(), bounds);
  await page.keyboard.press('Escape');
  await page.locator('#traffic-overview-help').waitFor({ state: 'hidden' });
  const details = workspace.locator('.data-traffic-daily');
  await details.locator('summary').press('Enter');
  const rows = details.locator('tbody tr');
  await rows.first().waitFor();
  assert.equal(await rows.count(), 7);
  assert.deepEqual(await rows.nth(1).locator('td').allTextContents(), ['—', '—', '—']);
  assert.equal(await workspace.locator('.design-chart-bar').count(), 6);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 320);

  for (const [site, pageViews] of [...sources].slice(1)) {
    await select.selectOption(site);
    await waitForViews(pageViews);
    assert.deepEqual(await metrics.allTextContents(), ['浏览量', '访问次数']);
    assert.match(await overview.innerText(), /世界标准时间（UTC）.*2026-11-12 03:09/s);
  }
  await workspace.getByRole('button', { name: '最近 30 天' }).click();
  await overview.getByText('2026-10-14 至 2026-11-12', { exact: true }).waitFor();
  await tabs.getByRole('link', { name: '谷歌表格同步' }).click();
  await page.getByText('未收到有效回执', { exact: true }).waitFor();
  await tabs.getByRole('link', { name: '网站统计' }).click();
  await waitForViews(987);
  assert.equal(await select.inputValue(), 'shop.flashcast.com.my');
  assert.equal(await workspace.getByRole('button', { name: '最近 30 天' }).getAttribute('aria-pressed'), 'true');

  mode = 'empty';
  await refresh.click();
  await overview.getByText('该时段暂无访问数据。', { exact: true }).waitFor();
  assert.match(await overview.innerText(), /2026-10-14 至 2026-11-12/);
  assert.equal(await metrics.count(), 0);
  assert.equal(await details.count(), 0);
  mode = 'unconfigured';
  await refresh.click();
  await overview.getByText('该网站尚未接入统计。', { exact: true }).waitFor();
  assert.equal(await metrics.count(), 0);
  assert.doesNotMatch(await overview.innerText(), /2026-10-14/);
  mode = 'error';
  await select.selectOption('damatong.net');
  await workspace.getByText('暂时读不到访问数据，请刷新统计。', { exact: true }).waitFor();
  assert.equal(await metrics.count(), 0);
  assert.deepEqual(requests, [
    ...[...sources.keys()].map(site => ['GET', site, 7]),
    ['GET', 'shop.flashcast.com.my', 30], ['GET', 'shop.flashcast.com.my', 30],
    ['GET', 'shop.flashcast.com.my', 30], ['GET', 'damatong.net', 30]
  ]);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.deepEqual(unavailable, []);
});

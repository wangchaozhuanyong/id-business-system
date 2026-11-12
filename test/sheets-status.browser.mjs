import assert from 'node:assert/strict';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { chromium } from 'playwright';
import { reportColumns } from '../server/backup/sheets-source.mjs';
import { sheetsStatusRoute } from '../server/tools/sheets-status.mjs';
import { interceptDesign, origin, root, settle } from './helpers/offline-design.mjs';

const tabs = Object.entries(reportColumns).map(([name, columns]) => ({ name, columns }));
const verifiedAt = Date.parse('2026-11-12T03:06:41Z');
const healthy = { state: 'healthy', verifiedAt, reportedAt: verifiedAt + 30_000, failures: 0, tabs };
const missing = { state: 'no_receipt', verifiedAt: null, reportedAt: null, failures: null, tabs };
const admin = { id: 'fixture-admin', name: '验收管理员', role: 'admin' };

test('the Sheets bookmark opens the data center and displays status and columns without writes', { timeout: 45_000 }, async t => {
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const { external, unavailable } = await interceptDesign(context, { localFixtures: {}, actor: admin, skipRechargeAssets: true });
  let result = missing;
  const methods = [];
  await context.route(origin + sheetsStatusRoute, route => {
    methods.push(route.request().method());
    return result ? route.fulfill({ json: result }) : route.fulfill({ status: 503, json: { error: '合成错误' } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5_000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/#/plugins/sheets');
  const workspace = page.locator('[data-sheets-workspace]');
  const status = phase => workspace.locator(`[data-sheets-state="${phase}"]`).waitFor();
  const metrics = workspace.locator('[data-sheets-metrics] dd');
  const refresh = workspace.getByRole('button', { name: '刷新状态', exact: true });
  await status('no_receipt');
  assert.deepEqual(await metrics.allTextContents(), ['—', '—', '—']);
  assert.equal(new URL(page.url()).hash, '#/data/sheets');
  assert.equal(await page.getByRole('heading', { name: '数据中心', exact: true }).count(), 1);
  assert.equal(await page.getByRole('link', { name: '谷歌表格同步', exact: true }).getAttribute('aria-current'), 'page');
  assert(!/待开发/.test(await workspace.innerText()));
  assert.equal(await page.locator('#drawer').isVisible(), false);
  assert.deepEqual(await workspace.locator('.sheets-report h3').allTextContents(), tabs.map(row => row.name));

  result = healthy;
  await refresh.click();
  await status('healthy');
  assert.deepEqual(await metrics.allTextContents(), ['2026-11-12 11:06:41', '2026-11-12 11:07:11', '0 次']);
  await refresh.evaluate(button => button.blur());

  const output = join(root, '.runtime', 'data-center-review');
  await mkdir(output, { recursive: true });
  for (const width of [1440, 1024, 901, 900, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const theme of ['light', 'dark']) {
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await settle(page);
      const geometry = await workspace.evaluate(node => {
        const rect = element => element.getBoundingClientRect();
        const head = node.querySelector('.sheets-section-head'), bottom = rect(head).bottom - 1;
        const fields = [...node.querySelectorAll('.sheets-report-fields summary')];
        return {
          overflow: document.documentElement.scrollWidth > innerWidth,
          cardsOverflow: [...node.querySelectorAll('.sheets-report')].some(card => card.scrollWidth > card.clientWidth + 1),
          gaps: [...head.querySelectorAll('button, summary')].map(control => bottom - rect(control).bottom),
          fieldInsets: fields.map(field => rect(field).top - rect(field.parentElement).top - 1),
          fieldHeights: fields.map(field => rect(field).height),
          fieldRows: Object.values(Object.groupBy(fields, field => Math.round(rect(field).top))).map(row => row.length)
        };
      });
      const where = JSON.stringify({ width, theme, geometry });
      assert(!geometry.overflow && !geometry.cardsOverflow, where);
      assert([...geometry.gaps, ...geometry.fieldInsets].every(gap => gap >= 8), where);
      assert(geometry.fieldHeights.every(height => height >= (width <= 900 ? 44 : 36)), where);
      assert.deepEqual(geometry.fieldRows, width === 1440 ? [4] : width <= 390 ? [1, 1, 1, 1] : [2, 2], where);
      if ([1440, 390].includes(width)) await page.screenshot({ path: join(output, `sheets-${width}-${theme}.png`), fullPage: true });
    }
  }

  const title = workspace.locator('#sheets-status-title');
  const help = title.locator('..').locator('summary');
  const statusLine = workspace.locator('[data-sheets-status]');
  const before = await statusLine.boundingBox();
  assert.equal(await help.locator('..').getAttribute('open'), null);
  const helpBox = await help.boundingBox(), titleBox = await title.boundingBox();
  assert(helpBox.width >= 44 && helpBox.height >= 44 && helpBox.x >= titleBox.x + titleBox.width);
  assert(Math.abs(helpBox.y + helpBox.height / 2 - (titleBox.y + titleBox.height / 2)) <= 1);
  await help.focus();
  await page.keyboard.press('Enter');
  await page.locator('#sheets-status-title-help').waitFor();
  assert.deepEqual(await statusLine.boundingBox(), before, 'opening title help must not move content');
  await page.keyboard.press('Escape');
  await page.locator('#sheets-status-title-help').waitFor({ state: 'hidden' });
  assert.deepEqual(await statusLine.boundingBox(), before);

  const fields = workspace.locator('.sheets-report-fields').filter({ has: page.locator('summary[aria-label="查看订单管理同步字段"]') });
  await fields.locator('summary').press('Enter');
  await fields.locator('ol').waitFor();
  assert.deepEqual(await fields.locator('li').allTextContents(), reportColumns.订单管理);
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth), 320);

  result = null;
  await refresh.click();
  await status('error');
  assert.deepEqual(await metrics.allTextContents(), ['2026-11-12 11:06:41', '2026-11-12 11:07:11', '0 次']);
  assert(await fields.locator('ol').isVisible(), 'a status failure must not collapse the field list');
  result = { ...healthy, state: 'stale' };
  await refresh.click();
  await status('stale');
  assert.deepEqual(methods, ['GET', 'GET', 'GET', 'GET']);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
  assert.deepEqual(unavailable, []);
});

test('the data center preserves the employee route restriction', { timeout: 15_000 }, async t => {
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext();
  await interceptDesign(context, { localFixtures: {}, actor: { ...admin, role: 'employee' }, skipRechargeAssets: true });
  const page = await context.newPage();
  const reads = [];
  page.on('request', req => {
    const route = new URL(req.url()).pathname;
    if ([sheetsStatusRoute, '/api/local/tools/website-analytics'].includes(route)) reads.push(route);
  });
  for (const route of ['data', 'plugins/sheets']) {
    await page.goto(origin + '/#/' + route);
    await page.getByRole('heading', { name: '访问受限', exact: true }).waitFor();
    assert.equal(await page.locator('.data-center-workspace').count(), 0);
  }
  assert.deepEqual(reads, []);
});

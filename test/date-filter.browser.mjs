import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

const clock = Date.parse('2027-01-01T00:15:00+08:00');

test('共享时间筛选支持完整预设、键盘应用、焦点返回和嵌套抽屉', async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
  await interceptDesign(context, { skipRechargeAssets: true });
  const page = await context.newPage();
  await page.goto(origin + '/#/overview');
  const overviewPeriod = page.locator('[data-date-filter="overview-date"] [data-date-choice="week"]');
  await overviewPeriod.focus();
  await page.evaluate(() => window.IDDesignAPI.render());
  assert(await overviewPeriod.evaluate(node => node === document.activeElement));

  const dates = await page.evaluate(now => [
    window.IDDateFilter.range('yesterday', now),
    window.IDDateFilter.range('three', now),
    window.IDDateFilter.range('fifteen', now),
    window.IDDateFilter.range('today', now, 'UTC')
  ], clock);
  assert.deepEqual(dates, [
    { from: '2026-12-31', to: '2026-12-31' },
    { from: '2026-12-30', to: '2027-01-01' },
    { from: '2026-12-18', to: '2027-01-01' },
    { from: '2026-12-31', to: '2026-12-31' }
  ]);

  await page.evaluate(now => {
    const host = document.createElement('div');
    host.id = 'date-filter-test-host';
    document.body.prepend(host);
    window.dateFilterSelections = [];
    const render = ({ preset, from, to }) => {
      host.innerHTML = window.IDDateFilter.render({
        id: 'date-filter-test', value: preset, from, to, now, min: '2026-11-01',
        max: '2027-01-01', maxDays: 30, all: true, onSelect: selected => {
          window.dateFilterSelections.push(selected);
          render(selected);
        }
      });
    };
    render({ preset: 'week' });
  }, clock);
  const host = page.locator('#date-filter-test-host');
  const today = host.getByRole('button', { name: '今日', exact: true });
  const yesterday = host.getByRole('button', { name: '昨日', exact: true });
  const custom = host.getByRole('button', { name: '自定义日期', exact: true });
  const picker = page.locator('#date-filter-drawer');
  const start = picker.locator('#date-filter-test-from');
  const end = picker.locator('#date-filter-test-to');

  await today.focus();
  await page.keyboard.press('ArrowRight');
  assert(await yesterday.evaluate(node => node === document.activeElement));
  await page.keyboard.press('Enter');
  assert.equal(await yesterday.getAttribute('aria-pressed'), 'true');
  assert(await yesterday.evaluate(node => node === document.activeElement));
  await page.keyboard.press('End');
  assert(await custom.evaluate(node => node === document.activeElement));
  await page.keyboard.press('Space');
  await picker.getByRole('heading', { name: '选择统计日期' }).waitFor();
  const drawerBox = await picker.boundingBox();
  assert.equal(Math.round(drawerBox.x + drawerBox.width), 1280);
  assert(await start.evaluate(node => node === document.activeElement));
  assert.equal(await start.inputValue(), '2026-12-31');
  await start.fill('2027-01-01');
  await page.keyboard.press('Enter');
  await picker.getByText('结束日期不能早于开始日期', { exact: true }).waitFor();
  assert(await end.evaluate(node => node === document.activeElement));
  await end.fill('2027-01-01');
  await page.keyboard.press('Enter');
  await picker.waitFor({ state: 'hidden' });
  assert.equal(await custom.getAttribute('aria-pressed'), 'true');
  assert(await custom.evaluate(node => node === document.activeElement));

  await custom.click();
  assert.equal(await start.inputValue(), '2027-01-01');
  await start.fill('2026-12-10');
  await page.keyboard.press('Escape');
  await picker.waitFor({ state: 'hidden' });
  assert(await custom.evaluate(node => node === document.activeElement));
  assert.deepEqual(await page.evaluate(() => window.dateFilterSelections), [
    { preset: 'yesterday', from: '2026-12-31', to: '2026-12-31' },
    { preset: 'custom', from: '2027-01-01', to: '2027-01-01' }
  ]);

  await page.setViewportSize({ width: 390, height: 844 });
  const compact = host.getByRole('combobox', { name: '时间范围' });
  await compact.selectOption({ label: '自定义日期' });
  assert.equal(await compact.inputValue(), 'custom');
  await picker.waitFor();
  assert.equal(Math.round((await picker.boundingBox()).width), 390);
  await page.keyboard.press('Escape');

  await page.evaluate(now => {
    const dates = window.IDDateFilter;
    window.IDDesignAPI.openDrawer('现有工具', '', dates.render({
      id: 'nested-date-filter', value: 'all', all: true, allowOpen: true, now,
      onSelect: ({ from, to }) => {
        document.getElementById('nested-date-result').textContent = JSON.stringify({ from, to });
      }
    }) + '<output id="nested-date-result"></output>');
  }, clock);
  const outer = page.locator('#drawer');
  const nested = outer.getByRole('combobox', { name: '时间范围' });
  await nested.selectOption({ label: '自定义日期' });
  assert(await outer.evaluate(node => node.open));
  await picker.locator('#nested-date-filter-from').fill('');
  await picker.locator('#nested-date-filter-to').fill('2026-12-25');
  await picker.getByRole('button', { name: '应用日期' }).click();
  assert(await outer.evaluate(node => node.open));
  assert.equal(await outer.locator('#nested-date-result').textContent(), '{"from":"","to":"2026-12-25"}');
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { toggleDesignTheme, root, origin, interceptDesign, settle, spacingSnapshot } from './helpers/offline-design.mjs';
const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
const output = process.env.ID_LAYOUT_QA_OUTPUT || root + '/.runtime/dropdown-settings-20261110';

test('下拉设置三页签在深浅主题和宽窄屏保持对齐，可键盘切换并保留输入', { timeout: 60_000 }, async t => {
  await mkdir(output, { recursive: true });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  fixture.settings.data.customerTags = [];
  fixture.settings.data.customerSources = ['微信', '网站', '客户推荐', '门店咨询与老客户再次推荐的合作项目'];
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const traffic = await interceptDesign(context, { localFixtures: fixture, skipRechargeAssets: true });
  const page = await context.newPage(), errors = [], measurements = [];
  page.setDefaultTimeout(5000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/#/settings/costs');
  await page.locator('#ops-cost-form').waitFor();
  for (const width of [1920, 1440, 1024, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    for (const theme of ['light', 'dark']) {
      if (await page.locator('html').getAttribute('data-theme') !== theme) await toggleDesignTheme(page);
      for (const [key, label] of [['costs', '费用规则'], ['sources', '来源设置'], ['tags', '标签设置']]) {
        await page.getByRole('tab', { name: label, exact: true }).click();
        await settle(page);
        const spacing = await spacingSnapshot(page);
        assert.deepEqual(spacing.findings, [], `${width} ${theme} ${key} 间距`);
        assert.equal(spacing.overflow, false);
        const geometry = await page.locator('.dropdown-settings').evaluate(panel => {
          const rect = panel.getBoundingClientRect();
          const tabs = [...panel.querySelectorAll('[role="tab"]')].map(node => node.getBoundingClientRect().toJSON());
          const labels = [...panel.querySelectorAll('.field')].filter(node => node.checkVisibility()).map(field => {
            const label = field.querySelector(':scope > label')?.getBoundingClientRect();
            const control = field.querySelector(':scope > .field-control')?.getBoundingClientRect();
            return !label || !control || label.right <= control.left + 1;
          });
          return { x: rect.x, width: rect.width, tabsSameLine: tabs.every(tab => Math.abs(tab.y - tabs[0].y) < 1), labelsLeft: labels.every(Boolean), nestedPanels: panel.querySelectorAll('.panel').length };
        });
        assert(geometry.tabsSameLine, '三个导航页签应在同一行');
        assert(geometry.labelsLeft, '表单标签位于控件左侧');
        assert.equal(geometry.nestedPanels, 0, '设置内容不再嵌套面板外框');
        measurements.push({ width, theme, key, ...geometry, separatorChecks: spacing.separators.measurements });
        if (width === 1440 || (width === 390 && key === 'sources'))
          await page.screenshot({ path: `${output}/${key}-${width}-${theme}.png`, fullPage: true });
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  const selected = page.getByRole('tab', { name: '标签设置', exact: true });
  await selected.focus(); await page.keyboard.press('Home');
  assert.equal(await page.getByRole('tab', { name: '费用规则', exact: true }).getAttribute('aria-selected'), 'true');
  await page.locator('#ops-cost-gmailCostCny').fill('0.125');
  await page.getByRole('tab', { name: '费用规则', exact: true }).focus(); await page.keyboard.press('ArrowRight');
  await page.getByPlaceholder('请输入来源').fill('未完成的来源');
  await page.getByRole('tab', { name: '来源设置', exact: true }).focus(); await page.keyboard.press('End');
  await page.getByPlaceholder('请输入标签').fill('未完成的标签');
  const panelBefore = await page.locator('.dropdown-settings').boundingBox();
  await page.locator('#page-title .title-help summary').click();
  await page.keyboard.press('Escape');
  const panelAfter = await page.locator('.dropdown-settings').boundingBox();
  assert.deepEqual(panelAfter, panelBefore, '标题说明不推动内容');
  await page.evaluate(() => { location.hash = '#/customers/new'; });
  await page.locator('#commerce-contact-form').waitFor();
  assert.equal(await page.getByRole('button', { name: /^(来源设置|标签设置)$/ }).count(), 0);
  await page.screenshot({ path: `${output}/customer-after.png`, fullPage: true });
  await page.evaluate(() => { location.hash = '#/settings/costs'; });
  assert.equal(await page.getByPlaceholder('请输入标签').inputValue(), '未完成的标签');
  await page.getByRole('tab', { name: '来源设置', exact: true }).click();
  assert.equal(await page.getByPlaceholder('请输入来源').inputValue(), '未完成的来源');
  await page.getByRole('tab', { name: '费用规则', exact: true }).click();
  assert.equal(await page.locator('#ops-cost-gmailCostCny').inputValue(), '0.125');
  assert.deepEqual(errors, []); assert.deepEqual(traffic.external, []);
  await writeFile(output + '/layout.json', JSON.stringify(measurements, null, 2));
});

test('设置读取失败可重试，刷新失败保留当前来源编辑', { timeout: 15_000 }, async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await interceptDesign(context, { localFixtures: {}, skipRechargeAssets: true });
  let fail = true, hold, started;
  await context.route('**/api/local/settings', async route => {
    started?.resolve();
    if (hold) await hold.promise;
    return fail ? route.fulfill({ status: 503, json: { error: '合成读取失败' } })
      : route.fulfill({ json: { version: 0, data: null } });
  });
  const page = await context.newPage(); page.setDefaultTimeout(5000);
  await page.goto(origin + '/#/settings/costs');
  await page.getByRole('heading', { name: '设置读取失败', exact: true }).waitFor();
  assert.equal(await page.getByRole('tab').count(), 3);
  fail = false;
  await page.getByRole('button', { name: '重新读取', exact: true }).click();
  await page.locator('#ops-cost-form').waitFor();
  await page.getByRole('tab', { name: '来源设置', exact: true }).click();
  await page.getByPlaceholder('请输入来源').fill('刷新失败也要保留');
  fail = true;
  await page.getByRole('button', { name: '重新读取', exact: true }).click();
  await page.locator('#confirm-dialog[open] [data-action="confirm-accept"]').click();
  await page.getByText('读取失败，已保留当前设置草稿', { exact: true }).waitFor();
  assert.equal(await page.getByPlaceholder('请输入来源').inputValue(), '刷新失败也要保留');
  assert(await page.getByRole('button', { name: '重新读取', exact: true }).isEnabled());
  fail = false; hold = Promise.withResolvers(); started = Promise.withResolvers();
  t.after(() => hold.resolve());
  await page.getByRole('tab', { name: '费用规则', exact: true }).click();
  await page.getByRole('button', { name: '重新读取', exact: true }).click();
  await started.promise;
  await page.getByRole('tab', { name: '标签设置', exact: true }).click();
  await page.getByPlaceholder('请输入标签').fill('迟到刷新保留的新输入');
  const current = await page.locator('#ops-customer-tags-form').elementHandle();
  hold.resolve();
  await page.getByText('费用规则已重新读取', { exact: true }).waitFor();
  assert.equal(await page.getByPlaceholder('请输入标签').inputValue(), '迟到刷新保留的新输入');
  assert(await page.locator('#ops-customer-tags-form').evaluate((node, expected) => node === expected, current));
  await current.dispose();
});

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { interceptDesign, origin, toggleDesignTheme } from './helpers/offline-design.mjs';

test('网站监控的访问记录与检测页签共享布局，并保留统计入口和草稿', { timeout: 90_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const phase = process.env.ID_WEBSITE_QA_PHASE || 'after';
  assert(['before', 'after'].includes(phase));
  const evidence = new URL('../.runtime/data-center-review/monitor-layout/', import.meta.url);
  await mkdir(evidence, { recursive: true });
  const measured = [];
  for (const width of [1440, 1024, 390, 320]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: 'zh-CN' });
    await interceptDesign(context, { localFixtures: {}, actor: { id: 'website-qa', name: '合成管理员', role: 'admin' } });
    const errors = [], checks = [];
    const daily = Array.from({ length: 15 }, (_, i) => ({ date: `2026-10-${String(i + 10).padStart(2, '0')}`, metrics: { pageViews: 100 + i, visitors: 40 + i, sessions: 60 + i } }));
    await context.route('**/api/local/tools/website-visits/search', route => {
      const { page, pageSize } = route.request().postDataJSON();
      return route.fulfill({ json: { page, pageSize, total: 41, summary: { pageViews: 456, visitors: 123 }, daily,
        items: Array.from({ length: Math.min(pageSize, 41 - (page - 1) * pageSize) }, (_, i) => ({ id: `synthetic-visit-${i}`, path: '/synthetic-page/' + i, occurredAt: '2026-11-01T10:30:00Z', ipMasked: '203.0.*.*' })) } });
    });
    await context.route('**/api/local/tools/website-visits/reveal', route => route.fulfill({ json: { ip: '203.0.113.1' } }));
    await context.route('**/api/local/tools/website-monitor', route => {
      checks.push(route.request().postDataJSON());
      return route.fulfill({ json: { status: 'reachable', effectiveUrl: 'https://example.test/synthetic', statusCode: 200, latencyMs: 42, tls: 'valid' } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(5000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/#/plugins/websites');
    if (theme === 'dark') await toggleDesignTheme(page);
    const host = page.locator('#plugin-tool-host');
    const entry = host.getByRole('tab', { name: '访问统计', exact: true });
    await entry.waitFor();
    await host.getByRole('button', { name: '每日统计', exact: true }).waitFor();
    const tabs = [['访问记录与 IP', 'ops-website-visits'], ['网站检测', 'ops-website-check']];
    const titlePositions = [];
    for (const [label, id] of tabs) {
      await host.getByRole('tab', { name: label, exact: true }).click();
      const panel = host.locator('#' + id);
      const geometry = await panel.evaluate(panel => {
        const rect = node => node.getBoundingClientRect().toJSON();
        const header = panel.querySelector('.tool-panel-header, .panel-heading');
        const title = header.querySelector('h3');
        const nav = document.querySelector('#plugin-tool-host .tool-header-row');
        const buttons = [...panel.querySelectorAll('button,a.button')].filter(node => node.checkVisibility()).map(node => ({ text: node.textContent, ...rect(node) }));
        const controls = [...panel.querySelectorAll('input,select')].filter(node => node.checkVisibility()).map(rect);
        const fieldsLeft = [...panel.querySelectorAll('.field')].filter(node => node.checkVisibility()).every(node => {
          const label = node.querySelector(':scope > label'), control = node.querySelector('.field-control');
          return !label || !control || rect(label).right <= rect(control).left + 1;
        });
        const textBounds = node => {
          const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect().toJSON();
        };
        const numericRows = [...panel.querySelectorAll('tbody tr')].filter(row => row.checkVisibility()).map(row =>
          [...row.querySelectorAll('.tool-data-number')].map(cell => ({ text: cell.textContent, box: rect(cell), textBox: textBounds(cell), align: getComputedStyle(cell).textAlign })));
        const filters = panel.querySelector('.tool-filter-grid');
        return { panel: rect(panel), title: rect(title), titleText: textBounds(title), nav: rect(nav), buttons, controls, fieldsLeft,
          numericRows, filterColumns: filters ? getComputedStyle(filters).gridTemplateColumns.split(' ').length : null,
          overflow: document.documentElement.scrollWidth > innerWidth, headerPadding: getComputedStyle(header).paddingLeft,
          panelTitleGap: rect(title).top - rect(panel).top };
      });
      measured.push({ width, theme, label, geometry });
      titlePositions.push(geometry.titleText.top);
      if (phase === 'after') {
        if (id === 'ops-website-visits') assert.equal(geometry.filterColumns, width === 1440 ? 4 : width === 1024 ? 2 : 1, '筛选必须均匀成行');
        if (geometry.numericRows.length) for (const cells of geometry.numericRows) cells.forEach((cell, i) => assert(Math.abs(cell.textBox.right - geometry.numericRows[0][i].textBox.right) <= 1, JSON.stringify({ width, theme, label, numericRows: geometry.numericRows })));
        assert(geometry.fieldsLeft && !geometry.overflow, JSON.stringify({ width, theme, label, geometry }));
        assert(geometry.panel.top - geometry.nav.bottom >= 16, '导航和内容至少间隔 16px');
        assert(Math.abs(geometry.title.x - geometry.panel.x) <= 1, '页签标题与内容左边界一致');
        assert(geometry.buttons.every(button => button.left >= geometry.panel.left && button.right <= geometry.panel.right + 1));
        for (const control of geometry.controls) assert(geometry.buttons.every(button => button.bottom <= control.top + 1 || button.top >= control.bottom - 1 || button.right <= control.left + 1 || button.left >= control.right - 1), '按钮与控件不得重叠');
      }
      if ([1440, 390].includes(width) && (phase === 'after' || theme === 'light'))
        await page.screenshot({ path: fileURLToPath(new URL(`${phase}-${id}-${width}${theme === 'dark' ? '-dark' : ''}.png`, evidence)), fullPage: true });
    }
    if (phase === 'after') {
      assert(titlePositions.every(top => Math.abs(top - titlePositions[0]) <= 1), '页签实际标题文字垂直位置一致');
      await host.getByRole('tab', { name: '网站检测', exact: true }).click();
      await page.locator('#ops-monitor-url').fill('https://example.test/synthetic');
      await host.getByRole('button', { name: '检测网站', exact: true }).click();
      await host.getByText('证书有效', { exact: true }).waitFor();
      assert.equal(checks.length, 1);
      await host.getByRole('tab', { name: '访问记录与 IP', exact: true }).click();
      await page.locator('#ops-visits-days').selectOption('30');
      await page.locator('#ops-visits-sort').selectOption('oldest');
      await host.getByRole('button', { name: '查询明细', exact: true }).click();
      await host.getByRole('button', { name: 'IP 明细', exact: true }).click();
      const pathButton = host.getByRole('button', { name: '查看完整页面路径', exact: true })
        .filter({ hasText: /^\/synthetic-page\/0$/ });
      await pathButton.click();
      const fullPath = host.getByRole('region', { name: '完整页面路径', exact: true });
      assert.equal(await fullPath.textContent(), '/synthetic-page/0');
      await page.keyboard.press('Escape');
      await fullPath.waitFor({ state: 'hidden' });
      const pager = host.locator('[data-pagination="operations-website-visits"]');
      const nextPage = pager.getByRole('button', { name: '下一页', exact: true });
      assert.equal(await pager.getAttribute('data-page-size'), '20');
      for (let pageNumber = 2; pageNumber <= 3; pageNumber++) {
        await nextPage.click();
        await host.locator(`[data-pagination="operations-website-visits"][data-page="${pageNumber}"]`).waitFor();
      }
      assert(await nextPage.isDisabled());
      await host.getByRole('tab', { name: '网站检测', exact: true }).click();
      assert.equal(await page.locator('#ops-monitor-url').inputValue(), 'https://example.test/synthetic');
      await host.getByRole('tab', { name: '访问记录与 IP', exact: true }).click();
      assert.equal(await page.locator('#ops-visits-sort').inputValue(), 'oldest');
      await entry.click();
      await page.getByRole('heading', { name: '数据中心', exact: true }).waitFor();
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  await writeFile(new URL(`${phase}-geometry.json`, evidence), JSON.stringify(measured, null, 2));
});

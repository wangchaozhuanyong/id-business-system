import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { interceptDesign, origin, separatorSnapshot, toggleDesignTheme } from './helpers/offline-design.mjs';

test('网站监控三个页签共享标题、工具栏、筛选和结果布局，保留业务与草稿', { timeout: 90_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const phase = process.env.ID_WEBSITE_QA_PHASE || 'after';
  assert(['before', 'after'].includes(phase));
  const evidence = new URL('../.runtime/website-traffic-dashboard/', import.meta.url);
  await mkdir(evidence, { recursive: true });
  const measured = [];
  for (const width of [1440, 1024, 390, 320]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: 'zh-CN' });
    await interceptDesign(context, { localFixtures: {}, actor: { id: 'website-qa', name: '合成管理员', role: 'admin' } });
    let mode = 'filled';
    const errors = [], checks = [];
    const daily = Array.from({ length: 15 }, (_, i) => ({ date: `2026-10-${String(i + 10).padStart(2, '0')}`, metrics: { pageViews: 100 + i, visitors: 40 + i, sessions: 60 + i } }));
    const storefrontDaily = Array.from({ length: 30 }, (_, index) => ({
      date: new Date(Date.UTC(2026, 9, 14 + index)).toISOString().slice(0, 10),
      metrics: index === 29 ? null : { pageViews: 12 + index * 3 % 37, visits: 6 + index * 5 % 20 }
    }));
    await context.route('**/api/local/tools/website-analytics?*', route => {
      const { searchParams } = new URL(route.request().url());
      if (searchParams.get('site') === 'shop.flashcast.com.my') {
        const rows = storefrontDaily.slice(-Number(searchParams.get('days')));
        return route.fulfill({ json: {
          timeZone: 'UTC', utcOffset: 'GMT+00:00',
          summary: rows.reduce((sum, { metrics }) => ({
            pageViews: sum.pageViews + (metrics?.pageViews || 0), visits: sum.visits + (metrics?.visits || 0)
          }), { pageViews: 0, visits: 0 }),
          daily: rows,
          reportUrl: 'https://dash.cloudflare.com/example/web-analytics/overview/page-views?host=shop.flashcast.com.my'
        } });
      }
      return route.fulfill(mode === 'error'
        ? { status: 503, json: { error: '合成统计读取失败' } }
        : { json: { timeZone: 'Asia/Kuala_Lumpur', utcOffset: 'GMT+08:00', summary: mode === 'empty' ? null : { pageViews: 1234, visitors: 567, sessions: 789 }, daily: mode === 'empty' ? [] : daily.slice(0, 7) } });
    });
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
    await host.locator('.summary-number').filter({ hasText: /^1,234次$/ }).waitFor();
    const tabs = [['访问统计', 'ops-website-analytics'], ['访问记录与 IP', 'ops-website-visits'], ['网站检测', 'ops-website-check']];
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
        assert(Math.abs(geometry.title.x - geometry.panel.x) <= 1, '三个页签标题与内容左边界一致');
        assert(geometry.buttons.every(button => button.left >= geometry.panel.left && button.right <= geometry.panel.right + 1));
        for (const control of geometry.controls) assert(geometry.buttons.every(button => button.bottom <= control.top + 1 || button.top >= control.bottom - 1 || button.right <= control.left + 1 || button.left >= control.right - 1), '按钮与控件不得重叠');
        if (id === 'ops-website-analytics') {
          const sites = panel.getByRole('group', { name: '统计站点' });
          assert.equal(await sites.getByRole('button').count(), 4);
          assert.equal(await sites.getByRole('button', { pressed: true }).count(), 1);
          const siteCards = await sites.getByRole('button').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()));
          assert.equal(new Set(siteCards.map(rect => Math.round(rect.x))).size, geometry.panel.width > 640 ? 4 : 2);
          assert(siteCards.every(rect => rect.height >= 44 && rect.left >= geometry.panel.left && rect.right <= geometry.panel.right + 1));
          assert(await sites.locator('.website-analytics-host').evaluateAll(nodes =>
            nodes.every(node => node.scrollWidth <= node.clientWidth)));
          assert.deepEqual((await separatorSnapshot(page, '#' + id)).findings, []);
          const trigger = panel.getByLabel('查看流量概览说明');
          const result = panel.locator('[data-website-analytics-result]');
          const beforeHelp = await result.boundingBox();
          assert.equal(await trigger.evaluate(node => node.parentElement.open), false);
          assert((await trigger.boundingBox()).height >= (width <= 900 ? 44 : 36));
          await trigger.press('Enter');
          await panel.getByText(/最近 7 天或 30 天包含今天/).waitFor();
          assert.deepEqual(await result.boundingBox(), beforeHelp, '说明浮层不推开统计内容');
          await page.keyboard.press('Escape');
          await panel.getByText(/最近 7 天或 30 天包含今天/).waitFor({ state: 'hidden' });
          await panel.getByRole('heading', { name: '流量概览', exact: true }).click();
        }
      }
      if ([1440, 390].includes(width) && (phase === 'after' || theme === 'light'))
        await page.screenshot({ path: fileURLToPath(new URL(`${phase}-${id}-${width}${theme === 'dark' ? '-dark' : ''}.png`, evidence)), fullPage: true });
    }
    if (phase === 'after') {
      assert(titlePositions.every(top => Math.abs(top - titlePositions[0]) <= 1), '三个页签实际标题文字垂直位置一致');
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
      await host.getByRole('tab', { name: '访问统计', exact: true }).click();
      assert.match(await host.getByText(/统计时区/).textContent(), /Asia\/Kuala_Lumpur/);
      mode = 'empty';
      await host.getByRole('button', { name: '刷新统计', exact: true }).click();
      await host.getByText('该时间段没有访问统计', { exact: true }).waitFor();
      mode = 'error';
      await host.getByRole('button', { name: '刷新统计', exact: true }).click();
      await host.getByText(/合成统计读取失败/).waitFor();
      assert(await host.getByText('该时间段没有访问统计', { exact: true }).isVisible(), '刷新失败保留最后成功内容');
      await host.getByRole('tab', { name: '网站检测', exact: true }).click();
      assert.equal(await page.locator('#ops-monitor-url').inputValue(), 'https://example.test/synthetic');
      await host.getByRole('tab', { name: '访问记录与 IP', exact: true }).click();
      assert.equal(await page.locator('#ops-visits-sort').inputValue(), 'oldest');
      await host.getByRole('tab', { name: '访问统计', exact: true }).click();
      await host.getByRole('button', { name: /闪铸商城/ }).click();
      await host.getByRole('button', { name: '最近 30 天', exact: true }).click();
      const report = host.locator('[data-website-analytics-result]');
      const table = report.getByRole('table', { name: '每日明细' });
      await table.getByText('2026-10-14').waitFor();
      assert.equal(await table.locator('tbody tr').count(), 30);
      assert.match(await report.getByText(/Cloudflare Web Analytics/).textContent(), /统计时区 UTC/);
      const tableLayout = await table.evaluate(node => {
        const container = node.parentElement;
        const top = node.querySelector('thead th').getBoundingClientRect().top;
        container.scrollTop = container.scrollHeight;
        const headerFixed = node.querySelector('thead th').getBoundingClientRect().top === top;
        const lastRowVisible = node.rows[node.rows.length - 1].getBoundingClientRect().bottom <= container.getBoundingClientRect().bottom;
        container.scrollTop = 0;
        return { headerFixed, lastRowVisible, pageFits: document.documentElement.scrollWidth <= innerWidth };
      });
      assert.deepEqual(tableLayout, { headerFixed: true, lastRowVisible: true, pageFits: true });
      if ([1440, 390].includes(width)) {
        await page.screenshot({ path: fileURLToPath(new URL(`after-storefront-${width}-${theme}.png`, evidence)), fullPage: true });
      }
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  await writeFile(new URL(`${phase}-geometry.json`, evidence), JSON.stringify(measured, null, 2));
});

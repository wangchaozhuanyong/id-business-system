import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { interceptDesign, origin, settle, toggleDesignTheme } from './helpers/offline-design.mjs';

test('网站监控的访问记录与检测共用页签，网站统计从数据中心进入', { timeout: 90_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const phase = process.env.ID_WEBSITE_QA_PHASE || 'after';
  assert(['before', 'after'].includes(phase));
  const evidence = new URL('../.runtime/data-center-review/monitor-layout/', import.meta.url);
  await mkdir(evidence, { recursive: true });
  const measured = [];
  for (const width of [1920, 1440, 1024, 390, 320]) for (const theme of ['light', 'dark']) {
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
    await host.getByRole('button', { name: '每日统计', exact: true }).waitFor();
    const navigation = host.getByRole('tablist', { name: '网站监控功能' });
    if (phase === 'after')
      assert.deepEqual(await navigation.getByRole('tab').allTextContents(), ['运行状态', '告警记录', '访问记录与 IP', '网站检测']);
    const tabs = [['访问记录与 IP', 'ops-website-visits'], ['网站检测', 'ops-website-check']];
    const titlePositions = [];
    for (const [label, id] of tabs) {
      await host.getByRole('tab', { name: label, exact: true }).click();
      const panel = host.locator('#' + id);
      const geometry = await panel.evaluate(panel => {
        const rect = node => node.getBoundingClientRect().toJSON();
        const header = panel.querySelector('.tool-panel-header, .panel-heading');
        const title = header.querySelector('h3');
        const nav = document.querySelector('#plugin-tool-host > :is(.content-toolbar, .tool-header-row)');
        const buttons = [...panel.querySelectorAll('button,a.button')].filter(node => node.checkVisibility()).map(node => ({ text: node.textContent, ...rect(node) }));
        const controls = [...panel.querySelectorAll('input,select')].filter(node => node.checkVisibility()).map(rect);
        const fieldsLeft = [...panel.querySelectorAll('.field')].filter(node => node.checkVisibility()).every(node => {
          const label = node.querySelector(':scope > label'), control = node.querySelector('.field-control');
          return !label || !control || rect(label).bottom <= rect(control).top + 1;
        });
        const textBounds = node => {
          const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect().toJSON();
        };
        const numericRows = [...panel.querySelectorAll('tbody tr')].filter(row => row.checkVisibility()).map(row =>
          [...row.querySelectorAll('.tool-data-number')].map(cell => ({ text: cell.textContent, box: rect(cell), textBox: textBounds(cell), align: getComputedStyle(cell).textAlign })));
        const filters = panel.querySelector('.tool-filter-grid');
        const form = panel.querySelector('form');
        const formStyle = getComputedStyle(form);
        return { panel: rect(panel), title: rect(title), titleText: textBounds(title), nav: rect(nav), buttons, controls, fieldsLeft,
          numericRows, filterColumns: filters ? getComputedStyle(filters).gridTemplateColumns.split(' ').length : null,
          formContentWidth: form.clientWidth - parseFloat(formStyle.paddingLeft) - parseFloat(formStyle.paddingRight),
          overflow: document.documentElement.scrollWidth > innerWidth, headerPadding: getComputedStyle(header).paddingLeft,
          panelTitleGap: rect(title).top - rect(panel).top };
      });
      measured.push({ width, theme, label, geometry });
      titlePositions.push(geometry.titleText.top);
      if (phase === 'after') {
        if (id === 'ops-website-visits') {
          const expected = geometry.formContentWidth >= 1100 ? 4 : geometry.formContentWidth >= 600 ? 2 : 1;
          assert.equal(geometry.filterColumns, expected, JSON.stringify({ width, theme, expected, formWidth: geometry.formContentWidth }));
        }
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
      if (width <= 900) await page.locator('#nav-toggle').click();
      await page.locator('#sidebar').getByRole('link', { name: '数据中心', exact: true }).click();
      await page.getByRole('heading', { name: '数据中心', exact: true }).waitFor();
      const statistics = page.getByRole('navigation', { name: '数据中心栏目' }).getByRole('link', { name: '网站统计', exact: true });
      assert.equal(await statistics.getAttribute('aria-current'), 'page');
    }
    assert.deepEqual(errors, []);
    await context.close();
  }
  await writeFile(new URL(`${phase}-geometry.json`, evidence), JSON.stringify(measured, null, 2));
});

test('网站监控四个页签在切换、加载、长记录、空结果和失败时共用全宽边界', { timeout: 90_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ ignoreDefaultArgs: ['--hide-scrollbars'] });
  t.after(() => browser.close());
  const output = new URL('../.runtime/monitor-tab-width/', import.meta.url);
  await mkdir(output, { recursive: true });
  const evidence = [];
  const at = Date.parse('2026-11-13T02:35:49Z');
  const long = '合成告警与检查记录，包含需要保留的检测依据和服务恢复信息。'.repeat(4);
  const visitPath = '/synthetic/monitor/' + 'long-record-segment/'.repeat(18);
  const checks = [{ code: 'fixture-service', title: '合成服务检查', category: '运行', status: 'watch', detail: long, at }];
  const incidents = Array.from({ length: 20 }, (_, index) => ({
    id: 'width-incident-' + index, label: index === 0 ? long : '合成服务告警 ' + (index + 1),
    priority: 'P1', deliveryStatus: 'no_record', kind: 'incident', at
  }));
  for (const width of [2048, 1440, 901, 900, 390, 320]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 940 }, locale: 'zh-CN' });
    try {
      const traffic = await interceptDesign(context, { localFixtures: {}, skipRechargeAssets: true,
        scrollbarSelector: 'html', actor: { id: 'monitor-width', name: '合成管理员', role: 'super' } });
      let emptyIncidents = false, emptyVisits = false, failVisits = false, failCheck = false, releaseVisits;
      const firstVisits = new Promise(resolve => { releaseVisits = resolve; });
      let waitForFirstVisit = true;
      await context.route('**/api/local/system-monitoring*', route => route.fulfill({ json: {
        page: 1, pageSize: 20, total: emptyIncidents ? 0 : incidents.length, items: emptyIncidents ? [] : incidents,
        generatedAt: at, checks, notifications: { status: 'disabled', verified: 0, total: 4 }
      } }));
      await context.route('**/api/local/tools/website-visits/search', async route => {
        if (waitForFirstVisit) { waitForFirstVisit = false; await firstVisits; }
        if (failVisits) return route.fulfill({ status: 503, json: { error: '合成访问记录读取失败' } });
        return route.fulfill({ json: { page: 1, pageSize: 20, total: emptyVisits ? 0 : 20, daily: [],
          items: emptyVisits ? [] : Array.from({ length: 20 }, (_, index) => ({
            id: 'width-visit-' + index, path: visitPath + index, occurredAt: new Date(at).toISOString(), ipMasked: '203.0.*.*'
          })) } });
      });
      await context.route('**/api/local/tools/website-monitor', route => route.fulfill(failCheck
        ? { status: 503, json: { error: '合成网站检测失败' } }
        : { json: { status: 'reachable', effectiveUrl: 'https://example.test/synthetic', statusCode: 200, latencyMs: 42, tls: 'valid' } }));
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.setDefaultTimeout(6000);
      await page.goto(origin + '/#/monitor');
      if (theme === 'dark') await toggleDesignTheme(page);
      await page.getByText('合成服务检查', { exact: true }).waitFor();

      const tabs = page.getByRole('tablist', { name: '网站监控功能', exact: true });
      assert.deepEqual(await tabs.getByRole('tab').allTextContents(), ['运行状态', '告警记录', '访问记录与 IP', '网站检测']);
      const select = async name => {
        await tabs.getByRole('tab', { name, exact: true }).click();
        await tabs.getByRole('tab', { name, exact: true, selected: true }).waitFor();
        await settle(page);
      };
      const frame = () => page.evaluate(() => {
        const main = document.querySelector('#main');
        const region = main.querySelector(':scope > [data-page-region]:not([hidden])');
        const shell = region.querySelector(':scope > .panel');
        const nav = shell.querySelector(':scope > .content-toolbar');
        const bar = nav.querySelector('.monitor-navigation');
        const tab = bar.querySelector('[aria-selected="true"]');
        const box = node => { const { left, right, top, height } = node.getBoundingClientRect(); return { left, right, top, height }; };
        const mainStyle = getComputedStyle(main);
        const mainBox = box(main);
        const labelTop = [...bar.children].map(button => {
          const label = document.createRange();
          label.selectNodeContents(button);
          return box(label).top;
        });
        return { shell: box(shell), nav: box(nav), firstTab: box(bar.firstElementChild), labelTop, tab: tab.textContent,
          line: parseFloat(getComputedStyle(nav).borderBottomWidth), overflow: document.documentElement.scrollWidth > document.documentElement.clientWidth + 1,
          workspace: [mainBox.left + parseFloat(mainStyle.paddingLeft), mainBox.right - parseFloat(mainStyle.paddingRight)] };
      });
      const original = await frame();
      const capture = async state => {
        const actual = await frame();
        const close = (a, b) => Math.abs(a - b) <= 1;
        assert(close(actual.shell.left, actual.workspace[0]) && close(actual.shell.right, actual.workspace[1]) &&
          close(actual.nav.left, original.nav.left) && close(actual.nav.right, original.nav.right) &&
          close(actual.nav.top, original.nav.top) && close(actual.nav.height, original.nav.height) &&
          actual.labelTop.every((top, index) => close(top, original.labelTop[index])) && actual.line === 1 && !actual.overflow,
        JSON.stringify({ width, theme, state, original, actual }));
        if (width >= 1440) assert(close(actual.firstTab.left, original.firstTab.left),
          JSON.stringify({ width, theme, state, original: original.firstTab, actual: actual.firstTab }));
        evidence.push({ width, theme, state, ...actual });
        if (theme === 'light' && [2048, 390].includes(width)) {
          const shot = ['运行状态', '告警记录有数据', '访问记录有数据', '网站检测有结果'].indexOf(state);
          if (shot >= 0) await page.screenshot({ path: fileURLToPath(new URL(`monitor-${width}-${shot + 1}.png`, output)) });
        }
      };
      await capture('运行状态');
      await select('告警记录');
      await page.locator('[data-row-id="width-incident-0"]:visible, [data-monitor-card="width-incident-0"]:visible').waitFor();
      await capture('告警记录有数据');
      emptyIncidents = true;
      await page.getByRole('button', { name: '刷新', exact: true }).click();
      await page.getByRole('heading', { name: '暂无符合条件的告警', exact: true }).filter({ visible: true }).waitFor();
      await capture('告警空结果');

      await select('访问记录与 IP');
      await capture('访问记录加载中');
      releaseVisits();
      const visits = page.locator('#ops-website-visits');
      const path = visits.getByRole('button', { name: '查看完整页面路径' }).first();
      await path.waitFor();
      await capture('访问记录有数据');
      assert.equal(await path.textContent(), visitPath + '0');
      failVisits = true;
      await visits.getByRole('button', { name: '刷新记录', exact: true }).click();
      await visits.getByText(/合成访问记录读取失败/).waitFor();
      await path.waitFor();
      await capture('访问记录刷新失败');
      failVisits = false;
      emptyVisits = true;
      await visits.getByRole('button', { name: '刷新记录', exact: true }).click();
      await visits.getByRole('heading', { name: '没有匹配的访问记录', exact: true }).waitFor();
      await capture('访问记录空结果');

      await select('网站检测');
      const check = page.locator('#ops-website-check');
      await check.locator('#ops-monitor-url').fill('https://example.test/synthetic');
      await check.getByRole('button', { name: '检测网站', exact: true }).click();
      await check.getByText('证书有效', { exact: true }).waitFor();
      await capture('网站检测有结果');
      failCheck = true;
      await check.getByRole('button', { name: '检测网站', exact: true }).click();
      await check.getByText(/合成网站检测失败/).waitFor();
      await capture('网站检测失败');

      // Record frames across both route boundaries so a transient width change cannot pass on final screenshots.
      await page.evaluate(() => {
        const probe = { running: true, frames: [] };
        window.monitorWidthProbe = probe;
        function measure() {
          if (!probe.running) return;
          const shell = document.querySelector('#main > [data-page-region]:not([hidden]) > .panel');
          const nav = shell?.querySelector(':scope > .content-toolbar');
          if (nav) {
            const { left, right, top, height } = nav.getBoundingClientRect();
            probe.frames.push({ left, right, top, height });
          }
          requestAnimationFrame(measure);
        }
        requestAnimationFrame(measure);
      });
      for (const name of ['运行状态', '访问记录与 IP', '告警记录', '网站检测', '运行状态']) {
        await select(name);
        await capture('连续切换：' + name);
      }
      const frames = await page.evaluate(() => {
        window.monitorWidthProbe.running = false;
        return window.monitorWidthProbe.frames;
      });
      assert(frames.length >= 5 && frames.every(sample =>
        Object.keys(sample).every(key => Math.abs(sample[key] - original.nav[key]) <= 1)),
      JSON.stringify({ width, theme, original: original.nav, frames }));
      evidence.push({ width, theme, state: '连续切换帧', frames });
      assert.deepEqual(errors, []);
      assert.deepEqual(traffic.external, []);
    } finally {
      await context.close();
    }
  }
  await writeFile(new URL('switch-geometry.json', output), JSON.stringify(evidence, null, 2));
});

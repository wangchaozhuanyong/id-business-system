import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin, settle, toggleDesignTheme } from './helpers/offline-design.mjs';
import { readOrdersPage, readInventoryPage } from '../server/business-lists.mjs';

const entry = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
const { chromium } = await import(entry ? pathToFileURL(entry).href : 'playwright');
const actor = { id: 'loading-layout-super', name: '加载布局验收', role: 'super' };
const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
const output = process.env.ID_LAYOUT_QA_OUTPUT;
const workspaces = [
  ...['gpt', 'claude', 'gemini', 'grok'].map(product => ['workspace/order/' + product, 'commerce', '#commerce-order-form']),
  ['customers/new', 'commerce', '#commerce-contact-form'],
  ['customers/new/tenant', 'commerce', '#commerce-contact-form'],
  ...['mail-submit', 'account-submit', 'mail-extract', 'account-extract'].map(route => ['workspace/' + route, 'inventory', '#inventory-extract-form']),
  ['workspace/renewals/reminders', 'commerce', '.renewal-workbench-items']
];
const shapes = [
  ['.commerce-entry-columns', ['.form-panel', '.entry-records']],
  ['.inventory-workspace-columns', ['.inventory-submission-panel', '.inventory-extraction-panel']],
  ['.renewal-workbench', ['.renewal-workbench-queue', '.renewal-workbench-detail']]
];

function trackFrames(shapes) {
  window.loadingLayoutFrames = [];
  window.loadingLayoutSnapshot = () => {
    const region = document.querySelector('#main > [data-page-region]:not([hidden])');
    const shape = shapes.find(([selector]) => region?.querySelector(selector));
    if (!shape) return null;
    const grid = region.querySelector(shape[0]);
    const box = node => {
      if (!node) return null;
      const rect = node.getBoundingClientRect();
      return { x: rect.x, y: rect.y, width: rect.width, height: rect.height, visible: node.checkVisibility() };
    };
    return { route: region.dataset.pageRegion, grid: box(grid),
      pending: Boolean(grid.querySelector('[data-initial-state]')),
      fixedHeight: grid.dataset.paginationLayout === 'workspace' &&
        (shape[0] === '.renewal-workbench' || shape[0] === '.commerce-entry-columns' && getComputedStyle(grid).gridTemplateColumns.split(' ').length > 1),
      columns: getComputedStyle(grid).gridTemplateColumns.split(' ').length,
      panels: shape[1].map(selector => box(grid.querySelector(':scope > ' + selector))),
      headings: shape[1].map(selector => box(grid.querySelector(':scope > ' + selector + ' .panel-heading h2'))) };
  };
  const sample = () => {
    const snapshot = window.loadingLayoutSnapshot();
    if (snapshot) window.loadingLayoutFrames.push(snapshot);
    if (!window.loadingLayoutDone) requestAnimationFrame(sample);
  };
  requestAnimationFrame(sample);
}

function comparePanels(before, after, label) {
  assert(before && after, label + ': 工作台必须从首屏存在');
  assert.equal(after.panels.length, 2, label);
  assert(after.panels.every(Boolean), label + ': 两个业务面板必须始终存在');
  assert.equal(after.columns, before.columns, label + ': 加载前后列数一致');
  for (const [i, panel] of after.panels.entries()) {
    const initial = before.panels[i];
    assert.equal(panel.visible, initial.visible, label + ': 保留移动端当前视图');
    if (!panel.visible) continue;
    // Fixed viewport workspaces keep their height. Flow layouts may grow with
    // real forms/records; all of them must retain their columns and top anchors.
    const stableHeight = before.fixedHeight && after.fixedHeight || before.pending && after.pending;
    for (const key of ['x', 'width', ...(after.columns > 1 || i === 0 ? ['y'] : []), ...(stableHeight ? ['height'] : [])])
      assert(Math.abs(panel[key] - initial[key]) <= 1, `${label}: 面板 ${i} 的 ${key} ${initial[key]} → ${panel[key]}`);
    if (before.headings[i]?.visible && after.headings[i]?.visible) {
      assert(Math.abs(before.headings[i].x - after.headings[i].x) <= 1, label + ': 标题实际左边缘稳定');
      if (after.columns > 1 || i === 0)
        assert(Math.abs(before.headings[i].y - after.headings[i].y) <= 1, label + ': 标题实际顶边稳定');
    }
  }
}

test('录入、提取与续费工作台在首读、失败、重试及成功之间保留实际双栏框架', { timeout: 180_000 }, async t => {
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  if (output) await mkdir(output, { recursive: true });
  const results = [];
  for (const [width, dark, populated] of [[2062, false, true], [1440, true, true], [1280, false, false],
    [1024, true, false], [901, false, true], [900, true, false], [768, false, true], [390, true, true], [320, false, false]]) {
    await t.test(`${width}px ${dark ? 'dark' : 'light'} ${populated ? '有资料' : '空资料'}`, async () => {
      for (const [routeName, scope, readySelector] of workspaces) {
        const context = await browser.newContext({ viewport: { width, height: 900 } });
        const traffic = await interceptDesign(context, { actor, localFixtures: populated ? fixture : {}, skipRechargeAssets: true });
        await context.addInitScript(trackFrames, shapes);
        let gate = Promise.withResolvers(), fail = true;
        const writes = [], errors = [];
        await context.route('**/api/local/' + scope, async route => {
          if (route.request().method() !== 'GET') { writes.push(route.request().method()); return route.abort(); }
          const current = gate;
          await current.promise;
          return fail ? route.fulfill({ status: 503, json: { error: '隔离慢加载测试' } }) : route.fallback();
        });
        const page = await context.newPage();
        page.setDefaultTimeout(6000);
        page.on('pageerror', error => errors.push(error.message));
        const snapshot = async () => { await settle(page); return page.evaluate(() => window.loadingLayoutSnapshot()); };
        const capture = async phase => {
          if (output && width === 1440 && ['workspace/order/gpt', 'customers/new', 'workspace/mail-extract', 'workspace/renewals/reminders'].includes(routeName))
            await page.screenshot({ path: join(output, `${routeName.replaceAll('/', '-')}-${phase}.png`) });
        };
        try {
          await page.goto(origin + '/#/' + routeName);
          await page.locator('#main [data-initial-state="loading"]').first().waitFor();
          if (dark) await toggleDesignTheme(page);
          const loading = await snapshot();
          assert.equal(await page.locator('#main [data-initial-state="loading"]').count(), 2, routeName);
          assert.equal(await page.locator('#main .id-pagination').count(), 0, '未读取时不显示虚构总数');
          assert.equal(await page.locator('#main form').count(), 0, '资料就绪前不挂载可提交表单');
          await capture('loading');
          gate.resolve();
          await page.locator('#main [data-initial-state="error"]').first().waitFor();
          const failed = await snapshot();
          comparePanels(loading, failed, routeName + ' 失败');
          await capture('error');
          gate = Promise.withResolvers(); fail = false;
          await page.locator('#main [data-initial-state="error"] button:visible').first().click();
          await page.locator('#main [data-initial-state="loading"]').first().waitFor();
          const retrying = await snapshot();
          comparePanels(loading, retrying, routeName + ' 重试');
          gate.resolve();
          await page.waitForFunction(() => !document.querySelector('#main [data-initial-state]'));
          await page.locator(readySelector).waitFor();
          const ready = await snapshot();
          comparePanels(loading, ready, routeName + ' 成功');
          await capture('ready');
          assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), routeName + ': 无整页横向溢出');
          const frames = await page.evaluate(() => { window.loadingLayoutDone = true; return window.loadingLayoutFrames; });
          for (const frame of frames) {
            assert(frame.panels.every(Boolean), routeName + ': 不得出现只有左栏的一帧');
            for (const panel of frame.panels.filter(p => p.visible)) {
              assert(panel.width > 0 && panel.x >= frame.grid.x - 1 && panel.x + panel.width <= frame.grid.x + frame.grid.width + 1,
                routeName + ': 每帧面板均在工作区内');
            }
          }
          results.push({ route: routeName, width, dark, populated, loading, failed, retrying, ready, frames: frames.length });
          assert.deepEqual(errors, [], routeName);
          assert.deepEqual(writes, [], '布局验证不得写业务资料');
          assert.deepEqual(traffic.external, []);
          assert.deepEqual(traffic.unavailable, []);
        } finally { gate.resolve(); await context.close(); }
      }
    });
  }
  if (output) await writeFile(join(output, 'initial-loading-layout.json'), JSON.stringify(results, null, 2));
});

test('首读期间连续切换产品仍保留双栏，迟到响应不改变当前路由，重读失败保留表单草稿', async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await interceptDesign(context, { actor, localFixtures: {}, skipRechargeAssets: true });
  const gate = Promise.withResolvers(); let fail = false;
  await context.route('**/api/local/commerce', async route => {
    assert.equal(route.request().method(), 'GET');
    await gate.promise;
    return fail ? route.fulfill({ status: 503, json: { error: '隔离重读失败' } }) : route.fallback();
  });
  const page = await context.newPage();
  await page.goto(origin + '/#/workspace/order/gpt');
  for (const [label, product] of [['Claude', 'claude'], ['Gemini', 'gemini'], ['Grok', 'grok']]) {
    await page.getByRole('navigation', { name: '订单提交业务切换' }).getByRole('link', { name: label, exact: true }).click();
    assert.equal(await page.locator('#main').getAttribute('data-layout-route'), 'workspace/order/' + product);
    assert.equal(await page.locator('.commerce-entry-columns > .form-panel, .commerce-entry-columns > .entry-records').count(), 2);
  }
  gate.resolve();
  await page.locator('#commerce-order-form').waitFor();
  assert.equal(await page.locator('#main').getAttribute('data-layout-route'), 'workspace/order/grok');
  await page.locator('#commerce-notes').fill('合成草稿保持原位');
  const form = await page.locator('#commerce-order-form').elementHandle();
  fail = true;
  await page.getByRole('button', { name: '刷新最近录入记录' }).click();
  await page.locator('[data-entry-error]:visible').waitFor();
  assert(await form.evaluate(node => node.isConnected));
  assert.equal(await page.locator('#commerce-notes').inputValue(), '合成草稿保持原位');
  assert.equal(await page.locator('#main [data-initial-state]').count(), 0);
});

test('订单、库存和订单补全首读及失败保留表头，未知总数不显示为零', { timeout: 90_000 }, async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const routes = [
    ...['gpt', 'claude', 'gemini', 'grok'].map(product => ['orders/' + product, 'commerce/page']),
    ...['gpt', 'claude', 'gemini', 'grok'].map(product => ['accounts/' + product, 'inventory/page']),
    ...['google', 'microsoft'].map(type => ['mailboxes/' + type, 'inventory/page']),
    ['workspace/order-completion', 'order-completion']
  ];
  for (const width of [1440, 390]) {
    for (const [routeName, resource] of routes) {
      const context = await browser.newContext({ viewport: { width, height: 900 } });
      const traffic = await interceptDesign(context, { actor, localFixtures: fixture, businessLists: true, skipRechargeAssets: true });
      let gate = Promise.withResolvers(), fail = true;
      await context.route('**/api/local/' + resource, async route => {
        assert.equal(route.request().method(), resource.endsWith('/page') ? 'POST' : 'GET');
        await gate.promise;
        if (fail) return route.fulfill({ status: 503, json: { error: '隔离首读失败' } });
        const input = route.request().postDataJSON();
        const body = resource === 'commerce/page'
          ? readOrdersPage(input, { snapshot: fixture.commerce, managers: true, inventory: fixture.inventory.data, at: Date.now() })
          : resource === 'inventory/page' ? readInventoryPage(input, fixture.inventory, fixture.commerce.data, Date.now())
            : { items: [], manualItems: [], canAssign: true };
        return route.fulfill({ json: body });
      });
      const page = await context.newPage(), errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.setDefaultTimeout(6000);
      try {
        await page.goto(origin + '/#/' + routeName);
        const table = page.locator('#main .table-viewport').first();
        await table.waitFor();
        if (width === 390) await toggleDesignTheme(page);
        const before = await table.boundingBox();
        assert(await table.locator('thead th').count() > 0, routeName + ': 首读保留实际表头');
        assert.equal(await page.locator('#main .id-pagination').count(), 0, routeName + ': 不把未知总数展示为零');
        assert.equal(await table.locator('[data-row-id]').count(), 0, routeName + ': 不显示虚构记录');
        gate.resolve();
        await page.locator('#main').getByText(resource === 'inventory/page' ? '库存暂时无法读取' : resource === 'order-completion' ? '暂时无法读取订单' : '订单暂时无法读取', { exact: true }).waitFor();
        await settle(page);
        const failed = await table.boundingBox();
        for (const key of ['x', 'y', 'width']) assert(Math.abs(before[key] - failed[key]) <= 1, routeName + ': 错误不替换列表框架');
        gate = Promise.withResolvers(); fail = false;
        await page.locator('#main').getByRole('button', { name: resource === 'order-completion' ? '刷新' : '重试', exact: true }).click();
        assert(await table.locator('thead th').count() > 0, routeName + ': 重试仍保留表头');
        gate.resolve();
        await page.locator('#main .id-pagination').first().waitFor();
        await settle(page);
        const ready = await table.boundingBox();
        for (const key of ['x', 'width']) assert(Math.abs(before[key] - ready[key]) <= 1, routeName + ': 成功列表与加载占位等宽');
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), routeName);
        assert.deepEqual(errors, [], routeName);
        assert.deepEqual(traffic.external, []);
        assert.deepEqual(traffic.unavailable, []);
      } finally { gate.resolve(); await context.close(); }
    }
  }
});

test('整页刷新保留双栏，手机最近订单视图也可原位重试', async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    await interceptDesign(context, { actor, localFixtures: {}, skipRechargeAssets: true });
    let gate = Promise.withResolvers(), fail = false;
    gate.resolve();
    await context.route('**/api/local/commerce', async route => {
      assert.equal(route.request().method(), 'GET');
      await gate.promise;
      return fail ? route.fulfill({ status: 503, json: { error: '隔离刷新失败' } }) : route.fallback();
    });
    const page = await context.newPage();
    try {
      await page.goto(origin + '/#/workspace/order/gpt');
      await page.locator('#commerce-order-form').waitFor();
      gate = Promise.withResolvers(); fail = true;
      await page.reload();
      await page.locator('#main [data-initial-state="loading"]').first().waitFor();
      assert.equal(await page.locator('.commerce-entry-columns > .form-panel, .commerce-entry-columns > .entry-records').count(), 2);
      if (width === 390) await page.getByRole('button', { name: '最近订单', exact: true }).click();
      const panel = page.locator(width === 390 ? '.entry-records' : '.form-panel');
      await panel.locator('[data-initial-state="loading"]').waitFor();
      gate.resolve();
      await panel.locator('[data-initial-state="error"]').waitFor();
      gate = Promise.withResolvers(); fail = false;
      await panel.getByRole('button', { name: '重新读取' }).click();
      await panel.locator('[data-initial-state="loading"]').waitFor();
      gate.resolve();
      await page.locator('.entry-record-list .id-pagination').waitFor({ state: 'attached' });
      if (width === 390) {
        assert(await page.locator('.entry-records').isVisible());
        await page.getByRole('button', { name: '返回填写', exact: true }).click();
      }
      await page.locator('#commerce-order-form').waitFor();
    } finally { gate.resolve(); await context.close(); }
  }
});

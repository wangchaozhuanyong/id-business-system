#!/usr/bin/env node
/* global document, window, requestAnimationFrame, innerWidth, location, MutationObserver */
import assert from 'node:assert/strict';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import {
  customer,
  offlineAdminContext,
  OFFLINE_ORIGIN,
  navigateOffline
} from './lib/v2-offline-admin.mjs';
const root = fileURLToPath(new URL('..', import.meta.url));
const output = path.join(root, '.runtime/interaction-performance-20261102/browser');
mkdirSync(output, { recursive: true });
const browser = await chromium.launch({ headless: true });
const checks = [],
  errors = [];
const record = (scenario, extra = {}) => checks.push({ scenario, ...extra });
const ready = (page) =>
  page.locator('#v2-main .v2-async-region[data-v2-query-phase="ready"]').first().waitFor();
const frames = (page) =>
  page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
const field = (drawer, label) =>
  drawer
    .locator('.el-form-item')
    .filter({ hasText: new RegExp(`^\\s*${label}`) })
    .locator('input,textarea')
    .first();
let activePage;
const failureMode = process.argv.includes('--failures');
try {
  if (failureMode) {
    await failureScenarios();
  } else if (process.argv.includes('--benchmark')) {
    for (const [label, dist] of [
      ['before', path.join(output, 'before-source/apps/admin/dist')],
      ['after', path.join(root, 'apps/admin/dist')]
    ])
      await benchmark(label, dist);
  } else {
    for (const theme of ['light', 'dark'])
      for (const width of [1440, 1024, 901, 900, 768, 390]) await matrix(theme, width);
  }
  assert.deepEqual(errors, []);
  writeFileSync(
    path.join(
      output,
      failureMode
        ? 'failure-checks.json'
        : process.argv.includes('--benchmark')
          ? 'benchmark-checks.json'
          : 'matrix-checks.json'
    ),
    JSON.stringify(
      { ok: true, checks, errors, webServerStarted: false, realApiRequests: 0, businessWrites: 0 },
      null,
      2
    )
  );
  console.log(
    JSON.stringify({
      ok: true,
      checks: checks.length,
      webServerStarted: false,
      realApiRequests: 0,
      businessWrites: 0,
      output
    })
  );
} catch (error) {
  writeFileSync(
    path.join(output, failureMode ? 'failure-scenarios-error.json' : 'failure.json'),
    JSON.stringify(
      {
        error: error.message,
        checks,
        runtimeErrors: activePage
          ? await activePage.evaluate(() => window.__offlineErrors ?? []).catch(() => [])
          : [],
        body: activePage
          ? await activePage
              .locator('body')
              .innerText()
              .catch(() => null)
          : null
      },
      null,
      2
    )
  );
  await activePage
    ?.screenshot({ path: path.join(output, 'failure.png'), fullPage: true })
    .catch(() => {});
  throw error;
} finally {
  await browser.close();
}

async function failureScenarios() {
  const dist = path.join(root, 'apps/admin/dist');
  const open = async (target = '/v2/customers') => {
    const fixture = await offlineAdminContext(browser, dist);
    const page = (activePage = await fixture.context.newPage());
    page.setDefaultTimeout(10000);
    await page.goto(`${OFFLINE_ORIGIN}${target}`, { waitUntil: 'domcontentloaded' });
    await ready(page);
    return { ...fixture, page };
  };
  const finish = async ({ context, control }) => {
    errors.push(...control.errors, ...control.blocked);
    await context.close();
  };
  {
    const fixture = await open('/v2/orders');
    const { page, control } = fixture;
    const reads = () =>
      [...control.readCounts]
        .filter(([key]) => /\/orders(?:\/bootstrap)?$/.test(key))
        .reduce((sum, [, count]) => sum + count, 0);
    const initialReads = reads();
    const search = page.getByRole('textbox', { name: '搜索订单' });
    await search.fill('保留条件');
    await navigateOffline(page, '/v2/customers');
    await navigateOffline(page, '/v2/orders');
    assert.equal(await search.inputValue(), '保留条件');
    assert.equal(reads(), initialReads);
    await page
      .getByRole('region', { name: '订单筛选' })
      .getByRole('button', { name: '刷新', exact: true })
      .click();
    await ready(page);
    assert.equal(reads(), initialReads + 1);
    record('remote-scenario-order-search-draft-and-toolbar-refresh');
    await finish(fixture);
  }
  {
    const fixture = await offlineAdminContext(browser, dist);
    const { context, control } = fixture;
    control.failRead = true;
    const page = (activePage = await context.newPage());
    page.setDefaultTimeout(10000);
    await page.goto(`${OFFLINE_ORIGIN}/v2/customers`, { waitUntil: 'domcontentloaded' });
    const region = page.locator('#v2-main .v2-async-region').first();
    await region.locator('.v2-page-state--error').waitFor();
    assert.equal(await page.getByText('暂无客户资料', { exact: true }).count(), 0);
    control.failRead = false;
    await region.getByRole('button', { name: '重新加载', exact: true }).click();
    await ready(page);
    assert.equal(await page.locator('[data-table-schema="customers.main"]').count(), 1);
    record('initial-read-failure-is-not-empty-and-retries');
    await finish(fixture);
  }
  {
    const fixture = await open();
    const { page } = fixture;
    let releaseSlow, observedSlow, completedSlow;
    const release = new Promise((resolve) => {
      releaseSlow = resolve;
    });
    const observed = new Promise((resolve) => {
      observedSlow = resolve;
    });
    const completed = new Promise((resolve) => {
      completedSlow = resolve;
    });
    await page.route('**/api/id-business-v2/customers?**', async (route) => {
      const keyword = new URL(route.request().url()).searchParams.get('keyword');
      if (!['slow-a', 'fast-b'].includes(keyword)) return route.fallback();
      if (keyword === 'slow-a') {
        observedSlow();
        await release;
      }
      await route.fulfill({
        json: {
          success: true,
          data: {
            items: [
              {
                ...customer(keyword === 'slow-a' ? 91 : 92),
                name: keyword === 'slow-a' ? '迟到的旧结果' : '最新筛选结果'
              }
            ],
            total: 1,
            page: 1,
            pageSize: 20
          }
        }
      });
      if (keyword === 'slow-a') completedSlow();
    });
    const search = page.getByRole('textbox', { name: '搜索客户' });
    await search.fill('slow-a');
    await page.getByRole('button', { name: '查询客户', exact: true }).click();
    await observed;
    const oldActions = page.locator('.el-table__body .v2-table-actions button');
    assert.ok(await oldActions.count());
    assert.equal(
      await oldActions.evaluateAll((buttons) => buttons.every((button) => button.disabled)),
      true
    );
    await search.fill('fast-b');
    await page.getByRole('button', { name: '查询客户', exact: true }).click();
    await page.getByText('最新筛选结果', { exact: true }).waitFor();
    await ready(page);
    releaseSlow();
    await completed;
    await frames(page);
    assert.equal(await page.getByText('迟到的旧结果', { exact: true }).count(), 0);
    assert.equal(await search.inputValue(), 'fast-b');
    assert.equal(await page.locator('.el-table__body tbody tr').count(), 1);
    assert.equal(
      await oldActions.evaluateAll((buttons) => buttons.every((button) => !button.disabled)),
      true
    );
    record('out-of-order-filter-results-and-stale-action-guard');
    await finish(fixture);
  }
  {
    const fixture = await open();
    const { page, control } = fixture;
    let releaseChunk, observedChunk;
    const release = new Promise((resolve) => {
      releaseChunk = resolve;
    });
    const observed = new Promise((resolve) => {
      observedChunk = resolve;
    });
    const response = page.waitForResponse((r) =>
      /V2AccountsView-[^/]+\.js$/.test(new URL(r.url()).pathname)
    );
    await page.route(/V2AccountsView-[^/]+\.js$/, async (route) => {
      observedChunk();
      await release;
      await route.fallback();
    });
    const initialReads = control.readCounts.get('/api/id-business-v2/customers/bootstrap');
    await page
      .locator('a[href="/v2/accounts"]')
      .first()
      .evaluate((link) => link.click());
    await observed;
    assert.equal(await page.locator('[data-table-schema="customers.main"]').count(), 1);
    await page
      .locator('a[href="/v2/customers"]')
      .first()
      .evaluate((link) => link.click());
    releaseChunk();
    await response;
    await ready(page);
    await frames(page);
    assert.equal(new URL(page.url()).pathname, '/v2/customers');
    assert.equal(await page.locator('[data-table-schema="accounts.main"]').count(), 0);
    assert.equal(await page.locator('#v2-main .v2-page-layout').count(), 1);
    assert.equal(control.readCounts.get('/api/id-business-v2/customers/bootstrap'), initialReads);
    assert.equal(await page.locator('.v2-route-error').count(), 0);
    record('rapid-a-b-a-keeps-current-content-after-late-chunk');
    await finish(fixture);
  }
  {
    const fixture = await open('/v2/accounts');
    const { context, page, control } = fixture;
    let attempts = 0;
    await page.route(/V2CustomersView-[^/]+\.js$/, async (route) => {
      attempts++;
      if (attempts === 1) return route.abort('failed');
      return route.fallback();
    });
    await page
      .locator('a[href="/v2/customers"]')
      .first()
      .evaluate((link) => link.click());
    await page.locator('.v2-route-error').waitFor();
    assert.equal(new URL(page.url()).pathname, '/v2/accounts');
    assert.equal(await page.locator('[data-table-schema="accounts.main"]').count(), 1);
    assert.equal(await page.locator('.v2-shell').count(), 1);
    assert.equal(await page.locator('.app-route-error').count(), 0);
    await page
      .locator('.v2-route-error')
      .getByRole('button', { name: '重新加载', exact: true })
      .click();
    await page.waitForURL('**/v2/customers');
    await ready(page);
    assert.equal(attempts, 2);
    assert.equal(await page.locator('.v2-route-error').count(), 0);
    assert.deepEqual(
      control.errors.filter(
        (message) =>
          !/Failed to fetch dynamically imported module|Couldn't resolve component "default"/.test(
            message
          )
      ),
      []
    );
    errors.push(...control.blocked);
    record('navigation-chunk-failure-retains-current-page-and-retries');
    await context.close();
  }
  for (const repeated of [false, true]) {
    const fixture = await offlineAdminContext(browser, dist);
    const { context, control } = fixture;
    const page = (activePage = await context.newPage());
    page.setDefaultTimeout(10000);
    let attempts = 0,
      documents = 0,
      block = true;
    page.on('request', (request) => {
      if (request.isNavigationRequest() && request.frame() === page.mainFrame()) documents++;
    });
    await page.route(/V2CustomersView-[^/]+\.js$/, async (route) => {
      attempts++;
      if (block && (repeated || attempts === 1)) return route.abort('failed');
      return route.fallback();
    });
    await page
      .goto(`${OFFLINE_ORIGIN}/v2/customers`, { waitUntil: 'domcontentloaded' })
      .catch(() => null);
    if (repeated) {
      await page.getByText('页面资源加载失败', { exact: true }).waitFor();
      assert.equal(documents, 2);
      assert.equal(attempts, 2);
      block = false;
      await page.getByRole('button', { name: '重新连接', exact: true }).click();
    }
    await ready(page);
    assert.equal(documents, repeated ? 3 : 2);
    assert.equal(attempts, repeated ? 3 : 2);
    const unexpected = control.errors.filter(
      (message) =>
        !/Failed to fetch dynamically imported module|Couldn't resolve component "default"/.test(
          message
        )
    );
    assert.deepEqual(unexpected, []);
    errors.push(...control.blocked);
    record(
      repeated
        ? 'repeated-initial-chunk-failure-stops-and-manual-retry-recovers'
        : 'initial-chunk-failure-reloads-only-once'
    );
    await context.close();
  }
}

async function matrix(theme, width) {
  const { context, control } = await offlineAdminContext(
    browser,
    path.join(root, 'apps/admin/dist'),
    { viewport: { width, height: 1000 }, colorScheme: theme }
  );
  const page = (activePage = await context.newPage());
  page.setDefaultTimeout(10000);
  await page.goto(`${OFFLINE_ORIGIN}/v2/customers`, { waitUntil: 'domcontentloaded' });
  await ready(page);
  await frames(page);
  assert.equal(await page.locator('.app-route-error').count(), 0);
  await page.evaluate(() => {
    window.__offlineErrors = [];
    const app = document.querySelector('#app').__vue_app__;
    const original = app.config.errorHandler;
    app.config.errorHandler = (reason, instance, info) => {
      window.__offlineErrors.push({ message: reason?.message, stack: reason?.stack });
      return original?.(reason, instance, info);
    };
  });
  const geometry = await page.evaluate(() => ({
    width: innerWidth,
    scroll: document.documentElement.scrollWidth,
    main: document.querySelector('#v2-main').getBoundingClientRect().toJSON()
  }));
  assert.ok(geometry.scroll <= width + 1, `全页横向溢出 ${theme}/${width}`);
  const layout = await layoutEvidence(page);
  record('theme-and-viewport-and-text-alignment', { theme, width, geometry, layout });
  if ([1440, 390].includes(width))
    await page.screenshot({
      path: path.join(output, `customers-first-${theme}-${width}.png`),
      fullPage: true,
      animations: 'disabled'
    });
  const customerReads = () =>
    [...control.readCounts]
      .filter(([key]) => /\/customers(?:\/bootstrap)?$/.test(key))
      .reduce((total, [, count]) => total + count, 0);
  const search = page.getByRole('textbox', { name: '搜索客户' });
  const readsBeforeTyping = customerReads();
  await search.pressSequentially('synthetic', { delay: 15 });
  await frames(page);
  assert.equal(customerReads(), readsBeforeTyping, '未提交搜索触发了列表请求');
  await navigateOffline(page, '/v2/system/roles');
  await navigateOffline(page, '/v2/customers');
  assert.equal(await search.inputValue(), 'synthetic', '切页丢失未提交搜索');
  assert.equal(customerReads(), readsBeforeTyping, '未提交搜索在切页返回时触发读取');
  await page.getByRole('button', { name: '查询客户', exact: true }).click();
  await ready(page);
  assert.equal(customerReads(), readsBeforeTyping + 1, '显式查询未合并为一次读取');
  await search.fill('');
  await page.getByRole('button', { name: '查询客户', exact: true }).click();
  await ready(page);
  record('typing-does-not-query-until-explicit-submit', { theme, width });
  if (width === 1440) {
    const readsBeforeResize = customerReads();
    for (const nextWidth of [901, 900, 901, width]) {
      await page.setViewportSize({ width: nextWidth, height: 1000 });
      const desktop = nextWidth > 900;
      await page
        .locator(
          desktop
            ? '[data-table-schema="customers.main"]'
            : '.v2-records-mobile-list[data-mobile-for="customers.main"]'
        )
        .waitFor();
      await frames(page);
      assert.equal(
        await page.locator('[data-table-schema="customers.main"]').count(),
        desktop ? 1 : 0
      );
      assert.equal(
        await page.locator('.v2-records-mobile-list[data-mobile-for="customers.main"]').count(),
        desktop ? 0 : 1
      );
      await layoutEvidence(page);
    }
    assert.equal(customerReads(), readsBeforeResize, '响应式切换触发列表读取');
    record('live-breakpoint-switch-rebinds-current-variant', { theme, width });
  }
  const list = page.locator('.v2-records-list');
  const height = await list.evaluate((el) => el.getBoundingClientRect().height);
  const region = page.locator('#v2-main .v2-async-region').first();
  let releaseRefresh;
  control.holdRead = new Promise((resolve) => {
    releaseRefresh = resolve;
  });
  try {
    await page.getByRole('button', { name: '刷新', exact: true }).first().click();
    await region.locator('.v2-async-region__progress').waitFor({ state: 'visible' });
    assert.equal(await list.isVisible(), true);
    assert.equal(await region.locator('.v2-page-state--loading').count(), 0);
  } finally {
    control.holdRead = null;
    releaseRefresh();
  }
  await ready(page);
  control.failRead = true;
  await page.getByRole('button', { name: '刷新', exact: true }).first().click();
  await region.locator('.v2-async-region__refresh-error').waitFor();
  assert.equal(await list.isVisible(), true);
  control.failRead = false;
  await region.getByRole('button', { name: '重试', exact: true }).click();
  await ready(page);
  record('refresh-retains-content-and-error-retry', { theme, width });
  const next = page.locator('.v2-records-pagination .btn-next').first();
  await next.click();
  await ready(page);
  await next.click();
  await ready(page);
  await frames(page);
  const lastHeight = await list.evaluate((el) => el.getBoundingClientRect().height);
  assert.ok(lastHeight >= height - 2, `末页框架缩小 ${theme}/${width}: ${height}/${lastHeight}`);
  record('last-page-frame-retained', { theme, width, height, lastHeight });
  await page.getByRole('button', { name: '新增客户', exact: true }).first().click();
  let drawer = page.locator('.el-drawer:visible');
  await field(drawer, '客户名称').fill('合成草稿保留');
  await field(drawer, '备注').fill('仅用于离线验收');
  const formGeometry = await field(drawer, '客户名称').evaluate((input) => {
    const label = input.closest('.el-form-item').querySelector('.el-form-item__label');
    return {
      label: label.getBoundingClientRect().toJSON(),
      input: input.getBoundingClientRect().toJSON()
    };
  });
  assert.ok(formGeometry.label.right <= formGeometry.input.left + 1, '表单标签未在控件左侧');
  assert.ok(Math.abs(formGeometry.label.top - formGeometry.input.top) <= 2, '表单首行控件未对齐');
  record('drawer-label-and-input-alignment', { theme, width, formGeometry });
  await drawer.getByRole('button', { name: '关闭', exact: true }).click();
  await drawer.waitFor({ state: 'hidden' });
  await navigateOffline(page, '/v2/system/roles');
  await navigateOffline(page, '/v2/customers');
  await page.getByRole('button', { name: '新增客户', exact: true }).first().click();
  drawer = page.locator('.el-drawer:visible');
  assert.equal(await field(drawer, '客户名称').inputValue(), '合成草稿保留');
  await drawer.getByRole('button', { name: '确认新增', exact: true }).click();
  await page.getByText('合成保存失败', { exact: false }).first().waitFor();
  assert.equal(await field(drawer, '客户名称').inputValue(), '合成草稿保留');
  await drawer.getByRole('button', { name: '关闭', exact: true }).click();
  await drawer.waitFor({ state: 'hidden' });
  record('close-navigation-and-save-failure-preserve-draft', { theme, width });
  await navigateOffline(page, '/v2/accounts');
  await frames(page);
  assert.equal(
    await page
      .locator(
        width > 900
          ? '[data-table-schema="accounts.main"]'
          : '.v2-records-mobile-list[data-mobile-for="accounts.main"]'
      )
      .count(),
    1
  );
  const more = page
    .locator('#v2-main')
    .getByRole('button', { name: '更多操作', exact: true })
    .first();
  for (let attempt = 0; attempt < 2; attempt++) {
    await more.click();
    await page.getByRole('menuitem', { name: '停用 ID', exact: true }).waitFor();
    await page.keyboard.press('Escape');
    await page.getByRole('menuitem', { name: '停用 ID', exact: true }).waitFor({ state: 'hidden' });
  }
  record('deferred-row-menu-reopens-and-closes', { theme, width });
  await navigateOffline(page, '/v2/orders');
  await frames(page);
  const edit = page
    .locator('#v2-main')
    .getByRole('button', { name: width > 900 ? '修改订单' : '修改', exact: true })
    .filter({ visible: true })
    .first();
  await edit.click();
  drawer = page.locator('.el-drawer:visible');
  await drawer.getByRole('button', { name: '关闭', exact: true }).waitFor();
  await drawer.getByRole('button', { name: '关闭', exact: true }).click();
  await drawer.waitFor({ state: 'hidden' });
  record('first-deferred-order-editor-opens-and-closes', { theme, width });
  await navigateOffline(page, '/v2/customers');
  // Navigation remounts the list: compare empty state with the current mount,
  // while first-to-last-page stability is checked above within the same mount.
  const beforeEmptyHeight = await list.evaluate((el) => el.getBoundingClientRect().height);
  control.empty = true;
  await page.getByRole('textbox', { name: '搜索客户' }).fill('synthetic-empty-result');
  await page.getByRole('button', { name: '查询客户', exact: true }).click();
  await page.getByText('暂无客户资料', { exact: true }).filter({ visible: true }).first().waitFor();
  await ready(page);
  await frames(page);
  assert.ok(
    (await list.evaluate((el) => el.getBoundingClientRect().height)) >= beforeEmptyHeight - 2,
    '空列表框架缩小'
  );
  record('empty-state-frame-retained', {
    theme,
    width,
    beforeEmptyHeight,
    emptyHeight: await list.evaluate((el) => el.getBoundingClientRect().height)
  });
  if ([1440, 390].includes(width))
    await page.screenshot({
      path: path.join(output, `customers-${theme}-${width}.png`),
      fullPage: true,
      animations: 'disabled'
    });
  errors.push(...control.errors, ...control.blocked);
  await context.close();
}

async function layoutEvidence(page) {
  const evidence = await page.evaluate(() => {
    const textBounds = (element) => {
      const range = document.createRange();
      range.selectNodeContents(element);
      return range.getBoundingClientRect().toJSON();
    };
    const metrics = [...document.querySelectorAll('.v2-overview-metric')].map((element) => {
      const label = element.querySelector('.v2-overview-metric__label');
      const value = element.querySelector('.v2-overview-metric__value');
      return {
        box: element.getBoundingClientRect().toJSON(),
        label: textBounds(label),
        value: textBounds(value)
      };
    });
    const actions = [...document.querySelectorAll('.el-table__body .v2-table-actions button')]
      .filter((element) => element.getBoundingClientRect().width > 0)
      .map((element) => ({
        button: element.getBoundingClientRect().toJSON(),
        cell: element.closest('td').getBoundingClientRect().toJSON()
      }));
    return { metrics, actions };
  });
  assert.equal(evidence.metrics.length, 4, '缺少总览文字测量');
  for (const { label, value } of evidence.metrics)
    assert.ok(
      Math.abs(label.y + label.height / 2 - value.y - value.height / 2) <= 1.5,
      '总览标题与值的实际文字未对齐'
    );
  for (const { button, cell } of evidence.actions)
    assert.ok(
      button.left >= cell.left - 2 && button.right <= cell.right + 2,
      '操作按钮被单元格裁切'
    );
  return evidence;
}
async function benchmark(label, dist) {
  const { context, control } = await offlineAdminContext(browser, dist, {
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'light'
  });
  const page = (activePage = await context.newPage());
  page.setDefaultTimeout(15000);
  await page.goto(`${OFFLINE_ORIGIN}/v2/customers`, { waitUntil: 'domcontentloaded' });
  await ready(page);
  const routes = [
    ['/v2/accounts', 'accounts.main'],
    ['/v2/orders', 'orders.main'],
    ['/v2/customers', 'customers.main']
  ];
  for (const [target] of routes) await navigateOffline(page, target);
  const search = page.getByRole('textbox', { name: '搜索客户' });
  const businessReads = () =>
    [...control.readCounts]
      .filter(([key]) => /\/(customers|accounts|orders)(?:\/bootstrap)?$/.test(key))
      .reduce((total, [, count]) => total + count, 0);
  const initialReads = businessReads();
  await search.pressSequentially('synthetic', { delay: 25 });
  await ready(page);
  const inputReads = businessReads() - initialReads;
  await search.fill('');
  await page.getByRole('button', { name: '查询客户', exact: true }).click();
  await ready(page);
  record('typing-read-audit', { label, characters: 9, inputReads });
  if (label === 'after') assert.equal(inputReads, 0, '新版本未提交搜索仍触发读取');
  const samples = [];
  for (let round = 0; round < 20; round++)
    for (const [target, table] of routes) {
      const beforeReads = businessReads();
      await page.evaluate(
        ({ target, table }) => {
          const started = performance.now();
          let feedback = null,
            readyAt = null,
            blank = 0;
          window.__offlineProbe = null;
          const complete = () => {
            if (readyAt !== null) return;
            const element = document.querySelector(`[data-table-schema="${table}"]`);
            const phase = element?.closest('.v2-async-region')?.getAttribute('data-v2-query-phase');
            if (
              location.pathname !== target ||
              phase !== 'ready' ||
              element.querySelectorAll('.el-table__body tbody tr').length !== 20
            )
              return;
            readyAt = performance.now();
            observer.disconnect();
            requestAnimationFrame(() =>
              requestAnimationFrame(() => {
                window.__offlineProbe = {
                  paintMs: performance.now() - started,
                  feedbackMs: feedback ?? performance.now() - started,
                  blankFrames: blank,
                  dataSource: performance
                    .getEntriesByName('v2:route-data-ready')
                    .filter((e) => e.detail?.path === target && e.startTime >= started)
                    .at(-1)?.detail?.source,
                  tableMeasurements: performance
                    .getEntriesByName('v2:table-measure')
                    .filter((e) => e.startTime >= started)
                    .map((e) => e.duration)
                };
              })
            );
          };
          // Observe the content commit without a geometry read: probing layout in
          // every frame forces work that the application itself does not request.
          const observer = new MutationObserver(complete);
          observer.observe(document.querySelector('#v2-main'), {
            childList: true,
            subtree: true,
            attributes: true,
            attributeFilter: ['data-v2-query-phase']
          });
          const tick = () => {
            const main = document.querySelector('#v2-main');
            if (!main?.children.length) blank++;
            if (
              feedback === null &&
              (main?.getAttribute('aria-busy') === 'true' || location.pathname === target)
            )
              feedback = performance.now() - started;
            complete();
            if (readyAt === null && performance.now() - started < 10000)
              requestAnimationFrame(tick);
          };
          document.querySelector(`a[href="${target}"]`).click();
          requestAnimationFrame(tick);
        },
        { target, table }
      );
      await page.waitForFunction(() => window.__offlineProbe !== null);
      const sample = await page.evaluate(() => window.__offlineProbe);
      assert.equal(sample.dataSource, 'memory-cache', `${label} 未命中缓存 ${target}`);
      assert.equal(sample.blankFrames, 0, `${label} 切页出现空框架`);
      const afterReads = businessReads();
      assert.equal(afterReads, beforeReads, `${label} 缓存回访产生 API 读取`);
      samples.push({ path: target, ...sample });
    }
  await page.screenshot({
    path: path.join(output, `comparison-${label}.png`),
    fullPage: true,
    animations: 'disabled'
  });
  const conditions = {
    browser: browser.version(),
    viewport: '1440x1000',
    theme: 'light',
    data: 'synthetic-45-rows-v1',
    network: 'all requests fulfilled in browser; no server',
    measurement:
      'same test-owned 20-row DOM commit observer plus two-rAF probe; no layout reads; warm routes'
  };
  writeFileSync(
    path.join(output, `metrics-${label}.json`),
    JSON.stringify({ conditions, samples, inputReads }, null, 2)
  );
  errors.push(...control.errors, ...control.blocked);
  await context.close();
  record('cache-benchmark', { label, samples: samples.length });
}

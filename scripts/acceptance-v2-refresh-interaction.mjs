#!/usr/bin/env node
/* global document, getComputedStyle, requestAnimationFrame */
import assert from 'node:assert/strict';
import { execFileSync, spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const quickActionMigrationOnly = process.argv.includes('--quick-action-migration-only');
const configuredUrl = process.env.V2_INTERACTION_ADMIN_URL;
const baseUrl = new URL(configuredUrl || 'http://127.0.0.1:5390');
assert.ok(['localhost', '127.0.0.1', '::1'].includes(baseUrl.hostname), '仅允许本机验收');
const output = path.resolve(
  root,
  process.argv.slice(2).find((arg) => !arg.startsWith('--')) ??
    '.runtime/refresh-interaction-consistency-20261001/browser'
);
const commonGitDirectory = execFileSync(
  'git',
  ['rev-parse', '--path-format=absolute', '--git-common-dir'],
  { cwd: root, encoding: 'utf8' }
).trim();
const projectRoot =
  path.basename(commonGitDirectory) === '.git' ? path.dirname(commonGitDirectory) : root;
assert.ok(!path.relative(projectRoot, output).startsWith('..'), '验收产物必须位于当前项目');
mkdirSync(output, { recursive: true });
const checks = [];
const errors = [];
let simulatedWrites = 0;
let browser;
let server;

try {
  if (!configuredUrl)
    server = spawn(
      process.execPath,
      [
        path.join(root, 'node_modules/vite/bin/vite.js'),
        '--host',
        baseUrl.hostname,
        '--port',
        baseUrl.port,
        '--strictPort'
      ],
      {
        cwd: path.join(root, 'apps/admin'),
        env: {
          ...process.env,
          VITE_API_BASE_URL: '/api',
          VITE_V2_REALTIME_CHANGES_ENABLED: 'false'
        },
        stdio: 'ignore'
      }
    );
  const deadline = Date.now() + 30_000;
  while (
    !(
      await fetch(
        new URL(quickActionMigrationOnly ? '/login' : '/async-consistency-fixture.html', baseUrl)
      ).catch(() => null)
    )?.ok
  ) {
    assert.ok(Date.now() < deadline && server?.exitCode == null, '验收服务器未启动');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await chromium.launch();
  if (quickActionMigrationOnly) {
    for (const theme of ['light', 'dark'])
      for (const width of [1440, 390]) {
        await verifyQuickActionMigration(theme, width, false);
        await verifyQuickActionMigration(theme, width, true);
      }
  } else {
    for (const theme of ['light', 'dark']) {
      for (const width of [1440, 901, 900, 768, 390]) await verifyFixture(theme, width);
    }
    await verifyRealRoutes();
  }
  assert.deepEqual(errors, []);
  writeFileSync(
    path.join(output, 'checks.json'),
    JSON.stringify(
      {
        ok: true,
        checks,
        errors,
        simulatedWrites,
        businessWrites: 0,
        data: quickActionMigrationOnly
          ? 'actual local product route; synthetic data; every API read/write intercepted'
          : 'local synthetic fixtures and intercepted read responses'
      },
      null,
      2
    )
  );
  console.log(
    JSON.stringify({
      ok: true,
      checks: checks.length,
      themes: 2,
      widths: quickActionMigrationOnly ? 2 : 5,
      simulatedWrites,
      businessWrites: 0,
      output
    })
  );
} catch (error) {
  writeFileSync(
    path.join(output, 'failure.json'),
    JSON.stringify({ checks, errors, error: error.message, businessWrites: 0 }, null, 2)
  );
  throw error;
} finally {
  await browser?.close();
  server?.kill('SIGTERM');
}

async function verifyQuickActionMigration(theme, width, databaseConfirmed) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  page.setDefaultTimeout(10_000);
  page.on('pageerror', (error) => errors.push(error.message));
  const user = {
    id: '11111111-1111-4111-8111-111111111111',
    username: 'quick-action-fixture',
    displayName: '便捷操作验收管理员',
    roles: ['admin'],
    permissions: [],
    mustResetPassword: false
  };
  const ids = ['22222222-2222-4222-8222-222222222222', '33333333-3333-4333-8333-333333333333'];
  const now = '2026-10-09T00:00:00.000Z';
  const rows = ids.map((id, index) => ({
    id,
    title: `本地合成回复${index + 1}`,
    content: `用于取消与重试验收的合成正文${index + 1}`,
    createdAt: now,
    updatedAt: now
  }));
  const legacyKey = `id-business-v2:quick-action-order:${encodeURIComponent(user.id)}`;
  await page.addInitScript(
    ({ user, theme, legacyKey, ids }) => {
      localStorage.setItem('apple_business_access_token', 'local-quick-action-fixture');
      localStorage.setItem('apple_business_current_user', JSON.stringify(user));
      localStorage.setItem('id-business-v2-theme', theme);
      localStorage.setItem(legacyKey, JSON.stringify([...ids].reverse()));
    },
    { user, theme, legacyKey, ids }
  );
  let customOrder = false;
  let writeCount = 0;
  let releaseWrite;
  const firstWrite = new Promise((resolve) => (releaseWrite = resolve));
  const record = (scenario, detail = {}) =>
    checks.push({ theme, width, databaseConfirmed, scenario, ...detail });
  await page.route('**/*', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (url.origin !== baseUrl.origin) {
      errors.push('便捷操作验收禁止访问外部系统');
      return route.abort();
    }
    if (!url.pathname.startsWith('/api/')) return route.continue();
    let data = { items: [], total: 0, page: 1, pageSize: 20 };
    if (request.method() !== 'GET') {
      assert.equal(request.method(), 'PUT', '仅允许拦截排序保存');
      assert.ok(url.pathname.endsWith('/quick-actions/order'), '仅允许模拟便捷操作排序');
      assert.deepEqual(request.postDataJSON(), {
        quickActionIds: [...ids].reverse(),
        expectedQuickActionIds: ids,
        initializeOnly: true
      });
      writeCount += 1;
      simulatedWrites += 1;
      if (writeCount === 1) {
        await firstWrite;
        return route.fulfill({
          status: 500,
          json: { success: false, message: '本地合成排序保存失败' }
        });
      }
      customOrder = true;
      data = { items: [...rows].reverse(), hasCustomOrder: true };
    } else if (url.pathname.endsWith('/quick-actions'))
      data = { items: customOrder ? [...rows].reverse() : rows, hasCustomOrder: customOrder };
    else if (/\/auth\/(me|session)$/.test(url.pathname)) data = user;
    else if (url.pathname.endsWith('/branding/public'))
      data = { appName: 'ID 业务管理', logoText: 'ID', logoUrl: '/brand/default-logo.svg' };
    else if (url.pathname.endsWith('/time')) data = { now, timezone: 'Asia/Shanghai' };
    else if (url.pathname.endsWith('/change-versions')) data = { generatedAt: now, versions: {} };
    else if (url.pathname.endsWith('/renewals/warning-summary'))
      data = { total: 0, warningDays: 7 };
    else if (url.pathname.endsWith('/sensitive-access/approvals/summary')) data = { pending: 0 };
    else if (url.pathname.endsWith('/bootstrap'))
      data = { list: data, options: { statuses: [], permissions: [] }, generatedAt: now };
    await route.fulfill({
      json: {
        success: true,
        data,
        message: 'OK',
        requestId: 'quick-action-fixture',
        timestamp: now
      }
    });
  });
  await page.goto(new URL('/v2/system/roles', baseUrl).href, { waitUntil: 'domcontentloaded' });
  await phase(page, 'ready', '.v2-roles-page .v2-async-region');
  assert.equal(await page.evaluate(() => document.documentElement.dataset.v2Theme), theme);
  const drawer = page.locator('.v2-quick-actions-drawer.el-drawer');
  const entry = page.getByRole('button', { name: '便捷操作', exact: true });
  await entry.click();
  const deadline = Date.now() + 10_000;
  while (writeCount === 0) {
    assert.ok(Date.now() < deadline, '首次旧顺序同步请求未启动');
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  await drawer.locator('.el-drawer__close-btn').click();
  await drawer.waitFor({ state: 'hidden' });
  record('actual-drawer-closes-during-legacy-initialization');
  if (databaseConfirmed) {
    customOrder = true;
    await entry.click();
    await phase(page, 'ready', '.v2-quick-actions-drawer .v2-async-region');
    await settleDrawer(drawer);
  }
  const finished = page.waitForEvent('requestfinished', {
    predicate: (request) => request.url().endsWith('/quick-actions/order')
  });
  releaseWrite();
  await finished;
  await page.evaluate(() => new Promise((resolve) => requestAnimationFrame(resolve)));
  const retry = drawer.getByRole('button', { name: '重试同步', exact: true });
  if (databaseConfirmed) {
    assert.equal(await retry.count(), 0);
    assert.deepEqual(
      await drawer
        .locator('[data-sort-id]:visible')
        .evaluateAll((nodes) => nodes.map((node) => node.getAttribute('data-sort-id'))),
      [...ids].reverse()
    );
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), legacyKey), null);
    assert.equal(writeCount, 1);
    record('database-confirmation-ignores-cancelled-write-late-failure');
  } else {
    await entry.click();
    await phase(page, 'ready', '.v2-quick-actions-drawer .v2-async-region');
    await retry.waitFor();
    await settleDrawer(drawer);
    assert.equal(await retry.isEnabled(), true);
    assert.equal(writeCount, 1, '重开不得自动重发失败 PUT');
    assert.notEqual(await page.evaluate((key) => localStorage.getItem(key), legacyKey), null);
    const box = await retry.boundingBox();
    assert.ok(
      box.x >= 0 && box.x + box.width <= width && box.y + box.height <= 1000,
      `重试按钮必须完整位于 ${width}×1000 可视区域：${JSON.stringify(box)}`
    );
    record('failed-cancelled-migration-reopens-with-visible-explicit-retry', { retryBox: box });
    await page.screenshot({ path: path.join(output, `${theme}-${width}-retry-notice.png`) });
    await retry.click();
    await retry.waitFor({ state: 'hidden' });
    await phase(page, 'ready', '.v2-quick-actions-drawer .v2-async-region');
    assert.equal(writeCount, 2, '只有明确重试才发送第二次 PUT');
    assert.equal(await page.evaluate((key) => localStorage.getItem(key), legacyKey), null);
    record('explicit-retry-confirms-database-order-and-removes-legacy-storage');
  }
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth
    ),
    false
  );
  await page.screenshot({
    path: path.join(
      output,
      `${theme}-${width}-${databaseConfirmed ? 'confirmed-late-error' : 'retry-success'}.png`
    )
  });
  await page.close();
}

async function settleDrawer(drawer) {
  await drawer.evaluate(async (node) => {
    const transitions = node
      .getAnimations({ subtree: true })
      .filter((animation) => animation.effect?.getComputedTiming().iterations !== Infinity);
    await Promise.all(transitions.map((animation) => animation.finished.catch(() => undefined)));
  });
}

async function verifyFixture(theme, width) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.route('**/*', async (route) => {
    const url = new URL(route.request().url());
    if (url.origin !== baseUrl.origin || url.pathname.startsWith('/api/')) {
      errors.push('合成夹具不应访问业务 API 或外部站点');
      await route.abort();
    } else await route.continue();
  });
  const record = (scenario, detail = {}) => checks.push({ theme, width, scenario, ...detail });
  await page.goto(
    new URL(`/async-consistency-fixture.html?theme=${theme}&mode=slow`, baseUrl).href,
    { waitUntil: 'domcontentloaded' }
  );
  await phase(page, 'initial-loading');
  assert.equal(await page.locator('[data-query-region] > .v2-page-state--loading').count(), 1);
  assert.equal(await page.locator('[data-query-region]').getAttribute('aria-busy'), 'true');
  record('first-loading-one-skeleton');
  await phase(page, 'ready');
  const initial = await page.locator('[data-query-data]').textContent();
  const firstCount = await counter(page);
  await page.locator('[data-query-toggle]').click();
  await page.locator('[data-query-probe]').waitFor({ state: 'hidden' });
  await page.locator('[data-query-toggle]').click();
  await phase(page, 'ready');
  assert.equal(await counter(page), firstCount);
  assert.equal(await page.locator('[data-query-data]').textContent(), initial);
  record('clean-cache-remount-no-read');

  const region = page.locator('[data-query-region]');
  const beforeBox = await region.boundingBox();
  await page.locator('[data-query-refresh]').click();
  await phase(page, 'refreshing');
  assert.equal(await page.locator('[data-query-refresh]').isDisabled(), true);
  assert.equal(await page.locator('[data-query-refresh] .is-loading').count(), 0);
  assert.equal(await page.locator('[data-query-data]').textContent(), initial);
  await page.waitForTimeout(150);
  assert.equal(await region.locator('.v2-async-region__progress').count(), 1);
  const refreshingBox = await region.boundingBox();
  assert.ok(Math.abs(beforeBox.height - refreshingBox.height) <= 1);
  record('refresh-keeps-content-and-one-progress', { height: refreshingBox.height });
  await phase(page, 'ready');

  await page.locator('[data-response-mode]').selectOption('failure');
  const successful = await page.locator('[data-query-data]').textContent();
  await page.locator('[data-query-refresh]').click();
  await phase(page, 'refresh-error');
  assert.equal(await page.locator('[data-query-data]').textContent(), successful);
  assert.equal(await region.locator('.v2-async-region__refresh-error').count(), 1);
  const failedCount = await counter(page);
  await page.waitForTimeout(180);
  assert.equal(await counter(page), failedCount);
  record('failed-refresh-retains-content-without-loop');
  await page.locator('[data-response-mode]').selectOption('fast');
  await region.locator('.v2-async-region__refresh-error button').click();
  await phase(page, 'ready');
  record('explicit-retry-recovers');

  const oldPage = await page.locator('[data-query-data]').textContent();
  await page.locator('[data-response-mode]').selectOption('failure');
  await page.locator('[data-query-next]').click();
  await phase(page, 'transitioning');
  assert.equal(await page.locator('[data-query-action]').isDisabled(), true);
  assert.equal(await page.locator('[data-nested-action]').isDisabled(), true);
  assert.equal(await page.locator('[data-query-data]').textContent(), oldPage);
  record('parameter-transition-readonly-including-nested-region');
  await phase(page, 'refresh-error');
  assert.equal(await page.locator('[data-nested-action]').isDisabled(), true);
  await page.locator('[data-response-mode]').selectOption('fast');
  await region.locator('.v2-async-region__refresh-error button').click();
  await phase(page, 'ready');
  assert.equal(await page.locator('[data-nested-action]').isDisabled(), false);
  assert.match(await page.locator('[data-query-data]').textContent(), /第 2 页/);
  record('new-parameters-commit-atomically-and-unlock');

  if ((theme === 'light' && width === 1440) || (theme === 'dark' && width === 390)) {
    await page.locator('[data-response-mode]').selectOption('ignore-abort');
    await page.locator('[data-query-refresh]').click();
    await phase(page, 'refreshing');
    await page.locator('[data-query-toggle]').click();
    await page.locator('[data-query-probe]').waitFor({ state: 'hidden' });
    await page.locator('[data-cache-clear]').click();
    const canceledCount = await counter(page);
    await page.waitForTimeout(900);
    assert.equal(await counter(page), canceledCount);
    record('late-response-after-leaving-does-not-restart');
    await page.locator('[data-response-mode]').selectOption('fast');
    await page.locator('[data-query-toggle]').click();
    await phase(page, 'ready');
    await page.locator('[data-response-mode]').selectOption('ignore-abort');
    await page.locator('[data-query-refresh]').click();
    await phase(page, 'refreshing');
    const oldRequestCount = await counter(page);
    await page.locator('[data-response-mode]').selectOption('fast');
    await page.locator('[data-scope-invalidate]').click();
    await phase(page, 'ready');
    assert.equal(await counter(page), oldRequestCount + 1);
    const latest = await page.locator('[data-query-data]').textContent();
    await page.waitForTimeout(900);
    assert.equal(await page.locator('[data-query-data]').textContent(), latest);
    assert.equal(await counter(page), oldRequestCount + 1);
    record('scope-invalidation-replaces-aborted-read-and-rejects-late-result');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.locator('[data-response-mode]').selectOption('slow');
    await page.locator('[data-query-refresh]').click();
    await region.locator('.v2-async-region__progress').waitFor();
    const animation = await region
      .locator('.v2-async-region__progress > span:first-child')
      .evaluate((element) => getComputedStyle(element).animationName);
    assert.equal(animation, 'none');
    await page.screenshot({
      path: path.join(output, `${theme}-${width}-refresh.png`),
      fullPage: true
    });
    record('reduced-motion-keeps-static-progress');
    await phase(page, 'ready');
  }

  const legacy = page.locator('[data-legacy-region]');
  await page.locator('[data-legacy-first-failure]').click();
  await legacy.locator('[data-legacy-retry]').click();
  await phase(page, 'initial-loading', '[data-legacy-region]');
  assert.equal(await legacy.locator('[data-legacy-retry]').count(), 0);
  record('initial-retry-replaces-old-error-with-one-loading-state');
  await phase(page, 'ready', '[data-legacy-region]');
  await page.locator('[data-legacy-refresh-failure]').click();
  await legacy.locator('[data-legacy-retry]').click();
  await phase(page, 'refreshing', '[data-legacy-region]');
  assert.equal(await legacy.locator('[data-legacy-content]').isVisible(), true);
  assert.equal(await legacy.locator('.v2-async-region__refresh-error').count(), 0);
  await legacy.locator('.v2-async-region__progress').waitFor();
  record('refresh-retry-keeps-content-and-clears-old-error-feedback');
  await phase(page, 'ready', '[data-legacy-region]');
  await page.locator('[data-legacy-forbidden]').click();
  assert.equal(await legacy.getAttribute('aria-busy'), 'false');
  assert.equal(await legacy.locator('.v2-page-state--loading').count(), 0);
  record('forbidden-is-not-busy-or-empty');
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth > document.documentElement.clientWidth
    ),
    false
  );
  await page.close();
}

async function phase(page, value, selector = '[data-query-region]') {
  await page.locator(`${selector}[data-v2-query-phase="${value}"]`).waitFor();
}

async function counter(page) {
  return Number((await page.locator('[data-request-count]').textContent()).match(/\d+/)[0]);
}

async function verifyRealRoutes() {
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  page.on('pageerror', (error) => errors.push(error.message));
  const user = {
    id: '11111111-1111-4111-8111-111111111111',
    username: 'interaction-fixture',
    displayName: '验收管理员',
    roles: ['admin'],
    permissions: [],
    mustResetPassword: false
  };
  await page.addInitScript((value) => {
    localStorage.setItem('apple_business_access_token', 'local-interaction-fixture');
    localStorage.setItem('apple_business_current_user', JSON.stringify(value));
  }, user);
  let failRead = false;
  let bootstrapCount = 0;
  let authCount = 0;
  const now = '2026-10-01T12:00:00.000Z';
  await page.route('**/api/**', async (route) => {
    const url = new URL(route.request().url());
    if (!url.pathname.startsWith('/api/')) return route.continue();
    assert.equal(route.request().method(), 'GET', '真实路由验收禁止业务写入');
    let data = { items: [], total: 0, page: 1, pageSize: 20 };
    if (/\/auth\/(me|session)$/.test(url.pathname)) {
      authCount += 1;
      await new Promise((resolve) => setTimeout(resolve, 200));
      data = user;
    } else if (url.pathname.endsWith('/branding/public'))
      data = {
        appName: 'ID 业务管理',
        logoText: 'ID',
        logoUrl: '/brand/default-logo.svg',
        appSubtitle: '交互验收'
      };
    else if (url.pathname.endsWith('/time')) data = { now, timezone: 'Asia/Shanghai' };
    else if (url.pathname.endsWith('/change-versions')) data = { generatedAt: now, versions: {} };
    else if (url.pathname.endsWith('/renewals/warning-summary'))
      data = { total: 0, warningDays: 7 };
    else if (url.pathname.endsWith('/sensitive-access/approvals/summary')) data = { pending: 0 };
    else if (url.pathname.endsWith('/bootstrap')) {
      bootstrapCount += 1;
      const failure = failRead;
      await new Promise((resolve) => setTimeout(resolve, 400));
      if (failure)
        return route.fulfill({
          status: 500,
          json: { success: false, message: '验收读取失败，请重试。' }
        });
      data = {
        list: { items: [], total: 0, page: 1, pageSize: 20 },
        options: {
          countries: [],
          statuses: [],
          suppliers: [],
          sources: [],
          tags: [],
          services: []
        },
        permissions: [],
        sensitiveDisplayCatalog: [],
        sensitiveDisplayModeLabels: {},
        generatedAt: now
      };
    }
    await route.fulfill({
      json: { success: true, data, message: 'OK', requestId: 'interaction-fixture', timestamp: now }
    });
  });
  await page.goto(new URL('/v2/system/roles', baseUrl).href, { waitUntil: 'domcontentloaded' });
  await page
    .locator('.v2-roles-page .v2-async-region[data-v2-query-phase="ready"]')
    .waitFor({ timeout: 40_000 });
  const region = page.locator('.v2-roles-page .v2-async-region');
  const before = bootstrapCount;
  const button = page.getByRole('button', { name: '查询', exact: true });
  await button.evaluate((element) => {
    element.click();
    element.click();
  });
  await phase(page, 'refreshing', '.v2-roles-page .v2-async-region');
  await phase(page, 'ready', '.v2-roles-page .v2-async-region');
  assert.equal(bootstrapCount, before + 1);
  checks.push({ scenario: 'actual-role-query-double-click-single-read' });
  failRead = true;
  await button.click();
  await phase(page, 'refresh-error', '.v2-roles-page .v2-async-region');
  assert.equal(await region.locator('.v2-unified-table').isVisible(), true);
  failRead = false;
  await region.getByRole('button', { name: '重试', exact: true }).click();
  await phase(page, 'ready', '.v2-roles-page .v2-async-region');
  checks.push({ scenario: 'actual-role-failure-retains-table-and-retry-recovers' });
  const authBeforeReload = authCount;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await phase(page, 'ready', '.v2-roles-page .v2-async-region');
  assert.equal(new URL(page.url()).pathname, '/v2/system/roles');
  assert.equal(authCount, authBeforeReload + 1);
  checks.push({ scenario: 'actual-browser-refresh-preserves-route-and-single-session-check' });
  await page.close();
}

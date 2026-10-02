#!/usr/bin/env node
/* global document, getComputedStyle */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const configuredUrl = process.env.V2_INTERACTION_ADMIN_URL;
const baseUrl = new URL(configuredUrl || 'http://127.0.0.1:5390');
assert.ok(['localhost', '127.0.0.1', '::1'].includes(baseUrl.hostname), '仅允许本机验收');
const output = path.resolve(
  root,
  process.argv[2] ?? '.runtime/refresh-interaction-consistency-20261001/browser'
);
assert.ok(!path.relative(root, output).startsWith('..'), '验收产物必须位于当前项目');
mkdirSync(output, { recursive: true });
const checks = [];
const errors = [];
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
    !(await fetch(new URL('/async-consistency-fixture.html', baseUrl)).catch(() => null))?.ok
  ) {
    assert.ok(Date.now() < deadline && server?.exitCode == null, '验收服务器未启动');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await chromium.launch();
  for (const theme of ['light', 'dark']) {
    for (const width of [1440, 901, 900, 768, 390]) await verifyFixture(theme, width);
  }
  await verifyRealRoutes();
  assert.deepEqual(errors, []);
  writeFileSync(
    path.join(output, 'checks.json'),
    JSON.stringify(
      {
        ok: true,
        checks,
        errors,
        businessWrites: 0,
        data: 'local synthetic fixtures and intercepted read responses'
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
      widths: 5,
      businessWrites: 0,
      output
    })
  );
} finally {
  await browser?.close();
  server?.kill('SIGTERM');
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

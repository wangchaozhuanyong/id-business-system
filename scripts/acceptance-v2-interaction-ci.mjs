#!/usr/bin/env node
/* global document, window, MutationObserver, requestAnimationFrame, location */
import assert from 'node:assert/strict';
import { cpus, availableParallelism, platform, arch } from 'node:os';
import { spawn, spawnSync } from 'node:child_process';
import { mkdirSync, writeFileSync, appendFileSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { startOwnedMysqlTestInstance } from './lib/owned-mysql-test-instance.mjs';
import {
  assertPreviewExecutionContext,
  isolatedPreviewEnvironment,
  redactPreviewOutput,
  previewServerTimings,
  seedPreviewRows,
  listPreviewRoutes,
  PREVIEW_BASE,
  PREVIEW_API_READY_PATH,
  waitForPreviewService
} from './lib/interaction-preview-runtime.mjs';
import { compareInteractionMetrics } from './compare-v2-interaction-metrics.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
assertPreviewExecutionContext(process.env, root);
const output = path.join(root, '.runtime/interaction-preview-20261103/remote');
mkdirSync(output, { recursive: true });
const env = isolatedPreviewEnvironment(process.env);
const secrets = [
  env.JWT_SECRET,
  env.FIELD_ENCRYPTION_KEY,
  env.HASH_SECRET,
  env.SEED_ADMIN_PASSWORD
];
const children = [],
  checks = [],
  metrics = {};
let database, browser, authState, sessionState, activePage;
const save = (name, value) =>
  writeFileSync(path.join(output, name), JSON.stringify(value, null, 2) + '\n');
const log = (name, value) =>
  appendFileSync(path.join(output, name), redactPreviewOutput(value, secrets));
function run(name, command, args, cwd = root, environment = env) {
  const result = spawnSync(command, args, {
    cwd,
    env: environment,
    encoding: 'utf8',
    timeout: 300000,
    maxBuffer: 32 * 1024 * 1024
  });
  log(`${name}.log`, `${result.stdout ?? ''}${result.stderr ?? ''}`);
  assert.equal(result.status, 0, `${name} failed; see sanitized artifact log`);
}
function start(name, args, cwd = root) {
  const child = spawn(process.execPath, args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
  for (const stream of [child.stdout, child.stderr]) {
    let pending = '';
    stream.on('data', (data) => {
      pending += data.toString();
      const boundary = pending.lastIndexOf('\n');
      if (boundary >= 0) {
        log(`${name}.log`, pending.slice(0, boundary + 1));
        pending = pending.slice(boundary + 1);
      }
    });
    stream.on('end', () => {
      if (pending) log(`${name}.log`, pending);
    });
  }
  children.push(child);
  return child;
}
async function available(url) {
  await waitForPreviewService(url, {
    isRunning: () => children.every((child) => child.exitCode === null && child.signalCode === null)
  });
}
async function settled(page) {
  await page.waitForFunction(() => {
    const main = document.querySelector('#v2-main');
    return (
      main?.querySelector('.v2-page-layout') &&
      !main.querySelector(
        '[data-v2-query-phase="initial-loading"], [data-v2-query-phase="transitioning"]'
      )
    );
  });
  assert.equal(await page.locator('.app-route-error, .v2-route-error').count(), 0);
}
async function navigate(page, target) {
  const link = page.locator(`a[href="${target}"]`).first();
  if (await link.count()) await link.evaluate((element) => element.click());
  else await page.goto(new URL(target, page.url()).href, { waitUntil: 'domcontentloaded' });
  await page.waitForURL(
    (url) =>
      url.pathname === target ||
      (target === '/v2/auto-recharge/bank-cards' &&
        url.pathname === '/v2/account-settings/bank-cards')
  );
  await settled(page);
}
async function login(page, port) {
  await page.goto(`http://127.0.0.1:${port}/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('[name="username"]').fill(env.SEED_ADMIN_USERNAME);
  await page.locator('[name="password"]').fill(env.SEED_ADMIN_PASSWORD);
  await page.locator('#v2-admin-login-form button[type="submit"]').click();
  await page.waitForURL('**/v2/**');
  await settled(page);
}
function watchRequests(page) {
  const state = { reads: 0, unexpectedWrites: [], errors: [], timings: [] };
  const starts = new WeakMap();
  page.on('pageerror', (error) => state.errors.push(error.name));
  page.on('request', (request) => {
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) return;
    assert.equal(url.hostname, '127.0.0.1');
    if (
      !['GET', 'HEAD', 'OPTIONS'].includes(request.method()) &&
      !/^\/api\/auth\/(?:login|session|logout)$/.test(url.pathname)
    )
      state.unexpectedWrites.push({
        method: request.method(),
        path: url.pathname.replace(/[\da-f]{8}-(?:[\da-f-]{27,})/gi, ':id')
      });
    if (
      /(?:\/id-business-v2\/(?:accounts|customers|orders)|\/v2\/roles)(?:\/bootstrap)?$/.test(
        url.pathname
      ) &&
      request.method() === 'GET'
    )
      state.reads++;
    starts.set(request, performance.now());
  });
  page.on('response', (response) => {
    const url = new URL(response.url()),
      started = starts.get(response.request());
    if (
      started === undefined ||
      !/(?:\/id-business-v2\/(?:accounts|customers|orders)|\/v2\/roles)(?:\/bootstrap)?$/.test(
        url.pathname
      )
    )
      return;
    state.timings.push({
      path: url.pathname,
      status: response.status(),
      responseHeadersMs: performance.now() - started,
      serverTiming: previewServerTimings(response.headers()['server-timing'])
    });
  });
  return state;
}
async function sample(page, target, table, expectedRows = 20) {
  await page.evaluate(
    ({ target, table, expectedRows }) => {
      const started = performance.now();
      let feedback = null,
        completed = false,
        blank = 0;
      window.__previewSample = null;
      const finish = () => {
        const element = document.querySelector(`[data-table-schema="${table}"]`);
        if (
          completed ||
          location.pathname !== target ||
          element?.closest('.v2-async-region')?.getAttribute('data-v2-query-phase') !== 'ready' ||
          (expectedRows !== null &&
            element.querySelectorAll('.el-table__body tbody tr').length !== expectedRows)
        )
          return;
        completed = true;
        observer.disconnect();
        requestAnimationFrame(() =>
          requestAnimationFrame(() => {
            window.__previewSample = {
              paintMs: performance.now() - started,
              feedbackMs: feedback ?? performance.now() - started,
              blankFrames: blank,
              dataSource: performance
                .getEntriesByName('v2:route-data-ready')
                .filter((entry) => entry.startTime >= started && entry.detail?.path === target)
                .at(-1)?.detail?.source,
              longTasks: performance
                .getEntriesByName('v2:long-task')
                .filter((entry) => entry.startTime >= started)
                .map((entry) => entry.duration),
              tableMeasurements: performance
                .getEntriesByName('v2:table-measure')
                .filter((entry) => entry.startTime >= started)
                .map((entry) => entry.duration)
            };
          })
        );
      };
      const observer = new MutationObserver(finish);
      observer.observe(document.querySelector('#v2-main'), {
        subtree: true,
        childList: true,
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
        finish();
        if (!completed && performance.now() - started < 10000) requestAnimationFrame(tick);
      };
      document.querySelector(`a[href="${target}"]`).click();
      requestAnimationFrame(tick);
    },
    { target, table, expectedRows }
  );
  await page.waitForFunction(() => window.__previewSample !== null);
  return page.evaluate(() => window.__previewSample);
}
async function benchmark(label, port) {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'light',
    serviceWorkers: 'block'
  });
  const page = (activePage = await context.newPage());
  page.setDefaultTimeout(15000);
  const requests = watchRequests(page);
  await login(page, port);
  const routes = [
    ['/v2/accounts', 'accounts.main'],
    ['/v2/orders', 'orders.main'],
    ['/v2/customers', 'customers.main'],
    ['/v2/system/roles', 'roles.main', null]
  ];
  for (const [target] of routes) await navigate(page, target);
  // Navigation clicks originate from the sidebar; keep the pointer out of table cells.
  await page.mouse.move(12, 12);
  await page.evaluate(
    () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
  );
  const initialReads = requests.reads,
    samples = [];
  for (let round = 0; round < 60; round++)
    for (const [target, table, expectedRows] of routes) {
      const value = await sample(page, target, table, expectedRows);
      assert.equal(value.dataSource, 'memory-cache');
      assert.equal(value.blankFrames, 0);
      samples.push({ path: target, ...value });
    }
  assert.equal(requests.reads, initialReads, `${label} cache visits read clean business lists`);
  assert.deepEqual(requests.unexpectedWrites, []);
  assert.deepEqual(requests.errors, []);
  metrics[label] = {
    conditions: {
      browser: browser.version(),
      device: {
        platform: platform(),
        arch: arch(),
        cpuModel: cpus()[0]?.model,
        logicalCpus: availableParallelism()
      },
      viewport: '1440x1000',
      theme: 'light',
      inputMode: 'scripted sidebar navigation; pointer parked in sidebar',
      data: 'owned-mysql-45-rows-v1',
      network: 'real HTTP to same owned API/MySQL on one runner',
      measurement:
        'DOM commit observer plus two-rAF; 20 rows in primary lists; owned role rows in control; warm routes'
    },
    samples
  };
  save(`metrics-${label}.json`, metrics[label]);
  save(`requests-${label}.json`, requests);
  if (label === 'after') {
    authState = await context.storageState();
    sessionState = await page.evaluate(() => sessionStorage.getItem('apple_business_auth_v2'));
  }
  await context.close();
}
async function matrix(routes) {
  const focus = [
    '/v2/accounts',
    '/v2/orders',
    '/v2/workbench/renewals',
    '/v2/auto-recharge',
    '/v2/account-settings/bank-orders',
    '/v2/account-settings/mailbox',
    '/v2/account-settings/proxies',
    '/v2/customers'
  ];
  for (const theme of ['light', 'dark'])
    for (const width of [1440, 1024, 901, 900, 768, 390]) {
      const context = await browser.newContext({
        viewport: { width, height: 1000 },
        colorScheme: theme,
        storageState: authState,
        serviceWorkers: 'block'
      });
      await context.addInitScript(
        ({ session, theme }) => {
          sessionStorage.setItem('apple_business_auth_v2', session);
          localStorage.setItem('id-business-v2-theme', theme);
        },
        { session: sessionState, theme }
      );
      const page = (activePage = await context.newPage());
      page.setDefaultTimeout(15000);
      const requests = watchRequests(page);
      await page.goto('http://127.0.0.1:5374/v2/customers', { waitUntil: 'domcontentloaded' });
      await settled(page);
      for (const target of width === 1440 ? routes : focus) {
        await navigate(page, target);
        const state = await page.evaluate(() => ({
          overflow: document.documentElement.scrollWidth > window.innerWidth + 1,
          errors: document.querySelectorAll(
            '#v2-main .v2-page-state--error, #v2-main .v2-async-region__refresh-error'
          ).length,
          regions: [...document.querySelectorAll('#v2-main [data-v2-query-phase]')].map((element) =>
            element.getAttribute('data-v2-query-phase')
          ),
          metricGeometry: [...document.querySelectorAll('#v2-main .v2-overview-metric')]
            .filter((element) => element.getBoundingClientRect().width > 0)
            .map((element) => {
              const rect = (selector) => {
                const range = document.createRange();
                range.selectNodeContents(element.querySelector(selector));
                return range.getBoundingClientRect().toJSON();
              };
              return {
                box: element.getBoundingClientRect().toJSON(),
                label: rect('.v2-overview-metric__label'),
                value: rect('.v2-overview-metric__value')
              };
            })
        }));
        assert.equal(state.overflow, false, `${target} overflow at ${theme}/${width}`);
        for (const { label, value } of state.metricGeometry)
          assert.ok(
            Math.abs(label.y + label.height / 2 - value.y - value.height / 2) <= 1.5,
            `${target} metric text alignment at ${theme}/${width}`
          );
        checks.push({
          path: target,
          resolvedPath: new URL(page.url()).pathname,
          theme,
          width,
          ...state
        });
        if ([1440, 390].includes(width) && focus.includes(target))
          await page.screenshot({
            path: path.join(output, `${theme}-${width}-${target.split('/').at(-1)}.png`),
            animations: 'disabled'
          });
        if (target === '/v2/customers') {
          const firstHeight = await page
            .locator('.v2-records-list')
            .evaluate((node) => node.getBoundingClientRect().height);
          await page.locator('.el-pager .number').last().click();
          await page.waitForFunction(() =>
            document.querySelector('#v2-main .v2-records-list')?.textContent?.includes('本页 5 条')
          );
          await settled(page);
          const lastHeight = await page
            .locator('.v2-records-list')
            .evaluate((node) => node.getBoundingClientRect().height);
          assert.ok(
            lastHeight >= firstHeight - 2,
            `Customer last page frame shrank at ${theme}/${width}`
          );
          const search = page.getByRole('textbox', { name: '搜索客户' });
          await search.fill('合成无匹配资料');
          await search.press('Enter');
          await page.locator('.v2-records-empty:visible').waitFor();
          await settled(page);
          const emptyHeight = await page
            .locator('.v2-records-list')
            .evaluate((node) => node.getBoundingClientRect().height);
          assert.ok(
            emptyHeight >= firstHeight - 2,
            `Customer empty frame shrank at ${theme}/${width}`
          );
          checks.push({
            path: target,
            theme,
            width,
            lastPageFrameStable: true,
            emptyFrameStable: true,
            firstHeight,
            lastHeight,
            emptyHeight
          });
        }
      }
      assert.deepEqual(requests.unexpectedWrites, []);
      assert.deepEqual(requests.errors, []);
      await context.close();
    }
}
async function interactionFeedback() {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    storageState: authState,
    serviceWorkers: 'block'
  });
  await context.addInitScript(
    (session) => sessionStorage.setItem('apple_business_auth_v2', session),
    sessionState
  );
  const page = (activePage = await context.newPage());
  page.setDefaultTimeout(15000);
  const requests = watchRequests(page),
    samples = [];
  await page.goto('http://127.0.0.1:5374/v2/customers', { waitUntil: 'domcontentloaded' });
  await settled(page);
  const arm = async (element, kind, keyword = '') =>
    element.evaluate(
      (element, { kind, keyword }) => {
        window.__previewFeedback = null;
        element.addEventListener(
          kind === 'filter' ? 'keydown' : 'click',
          () => {
            const started = performance.now();
            const tick = () => {
              const region = document.querySelector('#v2-main .v2-async-region');
              const drawer = [...document.querySelectorAll('.el-drawer')].find(
                (node) =>
                  node.closest('.el-overlay')?.style.display !== 'none' &&
                  node.querySelector('.el-form-item input')
              );
              const toolDrawer = document.querySelector(
                '.v2-workspace-shortcut-drawer .v2-workspace-shortcut-drawer__toolbar'
              );
              const filterFeedback =
                ['transitioning', 'refreshing'].includes(
                  region?.getAttribute('data-v2-query-phase')
                ) || document.querySelector('.el-table__body')?.textContent?.includes(keyword);
              if (
                kind === 'tools-drawer' ? toolDrawer : kind === 'drawer' ? drawer : filterFeedback
              )
                window.__previewFeedback = performance.now() - started;
              else if (performance.now() - started < 10000) requestAnimationFrame(tick);
            };
            requestAnimationFrame(tick);
          },
          { capture: true, once: true }
        );
      },
      { kind, keyword }
    );
  const search = page.getByRole('textbox', { name: '搜索客户' });
  for (let index = 1; index <= 20; index++) {
    const keyword = `合成客户${index}`;
    await search.fill(keyword);
    await arm(search, 'filter', keyword);
    await search.press('Enter');
    await page.waitForFunction(() => window.__previewFeedback !== null);
    samples.push({
      kind: 'filter',
      feedbackMs: await page.evaluate(() => window.__previewFeedback)
    });
    await page.locator('#v2-main .v2-async-region[data-v2-query-phase="ready"]').first().waitFor();
  }
  await search.fill('');
  await search.press('Enter');
  await page.locator('#v2-main .v2-async-region[data-v2-query-phase="ready"]').first().waitFor();
  const create = page.getByRole('button', { name: '新增客户', exact: true }).first();
  await arm(create, 'drawer');
  await create.click();
  await page.waitForFunction(() => window.__previewFeedback !== null);
  const coldCustomerDrawerMs = await page.evaluate(() => window.__previewFeedback);
  let drawer = page.locator('.el-drawer:visible');
  const nameInput = () =>
    drawer
      .locator('.el-form-item')
      .filter({ hasText: /^\s*客户名称/ })
      .locator('input')
      .first();
  await nameInput().fill('合成未保存草稿');
  await drawer.getByRole('button', { name: '关闭', exact: true }).click();
  await drawer.waitFor({ state: 'hidden' });
  for (let index = 0; index < 20; index++) {
    await arm(create, 'drawer');
    await create.click();
    await page.waitForFunction(() => window.__previewFeedback !== null);
    samples.push({
      kind: 'drawer',
      feedbackMs: await page.evaluate(() => window.__previewFeedback)
    });
    drawer = page.locator('.el-drawer:visible');
    assert.equal(await nameInput().inputValue(), '合成未保存草稿');
    await drawer.getByRole('button', { name: '关闭', exact: true }).click();
    await drawer.waitFor({ state: 'hidden' });
  }
  const summaries = ['filter', 'drawer'].map((kind) => {
    const values = samples
      .filter((sample) => sample.kind === kind)
      .map((sample) => sample.feedbackMs)
      .sort((a, b) => a - b);
    return { kind, samples: values.length, p95: values[Math.ceil(values.length * 0.95) - 1] };
  });
  const coldDrawers = [{ kind: 'customer', feedbackMs: coldCustomerDrawerMs }];
  save('interaction-feedback.json', { samples, summaries, coldDrawers });
  const menuChecks = [];
  for (const target of ['/v2/accounts', '/v2/orders']) {
    await navigate(page, target);
    for (const [index, keyboard] of [
      [0, false],
      [0, false],
      [1, true]
    ]) {
      const trigger = page.getByRole('button', { name: '更多操作', exact: true }).nth(index);
      if (keyboard) {
        await trigger.focus();
        await trigger.press('ArrowDown');
      } else await trigger.click();
      const menu = page.locator('.el-dropdown-menu:visible');
      await menu.waitFor();
      await page.keyboard.press('Escape');
      await menu.waitFor({ state: 'hidden' });
      assert.equal(
        await trigger.evaluate(
          (node) => node === document.activeElement || node.contains(document.activeElement)
        ),
        true,
        'Menu must return focus to its trigger'
      );
      menuChecks.push({ target, index, keyboard, focusReturned: true });
      save('menu-first-use.json', menuChecks);
    }
    if (target === '/v2/accounts') {
      const createAccount = page.getByRole('button', { name: '新增 ID', exact: true }).first();
      await arm(createAccount, 'drawer');
      await createAccount.click();
      await page.waitForFunction(() => window.__previewFeedback !== null);
      coldDrawers.push({
        kind: 'account',
        feedbackMs: await page.evaluate(() => window.__previewFeedback)
      });
      const accountDrawer = page.locator('.el-drawer:visible');
      await accountDrawer.getByRole('button', { name: '关闭', exact: true }).click();
      await accountDrawer.waitFor({ state: 'hidden' });
    }
  }
  save('menu-first-use.json', menuChecks);
  const manageTools = page.getByRole('button', { name: '管理工具', exact: true });
  await arm(manageTools, 'tools-drawer');
  await manageTools.click();
  await page.waitForFunction(() => window.__previewFeedback !== null);
  coldDrawers.push({
    kind: 'tools',
    feedbackMs: await page.evaluate(() => window.__previewFeedback)
  });
  let toolDrawer = page.locator('.v2-workspace-shortcut-drawer:visible');
  await toolDrawer.getByRole('button', { name: '新增网址', exact: true }).click();
  const toolName = () =>
    page
      .locator('.v2-workspace-shortcut-drawer:visible .el-form-item')
      .filter({ hasText: '网址名称' })
      .locator('input');
  await toolName().fill('合成未保存工具草稿');
  await toolDrawer.locator('.el-drawer__close-btn').click();
  await toolDrawer.waitFor({ state: 'hidden' });
  const toolFeedback = [];
  for (let index = 0; index < 20; index++) {
    await arm(manageTools, 'tools-drawer');
    await manageTools.click();
    await page.waitForFunction(() => window.__previewFeedback !== null);
    toolFeedback.push(await page.evaluate(() => window.__previewFeedback));
    assert.equal(await toolName().inputValue(), '合成未保存工具草稿');
    toolDrawer = page.locator('.v2-workspace-shortcut-drawer:visible');
    await toolDrawer.locator('.el-drawer__close-btn').click();
    await toolDrawer.waitFor({ state: 'hidden' });
  }
  toolFeedback.sort((a, b) => a - b);
  summaries.push({ kind: 'tools-drawer', samples: 20, p95: toolFeedback[18] });
  save('interaction-feedback.json', { samples, summaries, coldDrawers });
  assert.ok(
    coldDrawers.every((value) => value.feedbackMs <= 200),
    'Cold drawer feedback exceeds 200ms'
  );
  assert.ok(
    summaries.every((summary) => summary.samples >= 20 && summary.p95 <= 200),
    'Filter/drawer feedback P95 exceeds 200ms'
  );
  assert.deepEqual(requests.unexpectedWrites, []);
  assert.deepEqual(requests.errors, []);
  await context.close();
}
async function profileCurrent() {
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    colorScheme: 'light',
    serviceWorkers: 'block'
  });
  const page = (activePage = await context.newPage());
  page.setDefaultTimeout(15000);
  await login(page, 5374);
  const routes = [
    ['/v2/accounts', 'accounts.main'],
    ['/v2/orders', 'orders.main'],
    ['/v2/customers', 'customers.main']
  ];
  for (const [route] of routes) await navigate(page, route);
  const cdp = await context.newCDPSession(page);
  await cdp.send('Performance.enable');
  const samples = [];
  for (let round = 0; round < 2; round++)
    for (const [route, table] of routes) {
      const before = (await cdp.send('Performance.getMetrics')).metrics;
      await cdp.send('Profiler.enable');
      await cdp.send('Profiler.setSamplingInterval', { interval: 500 });
      await cdp.send('Profiler.start');
      const measured = await sample(page, route, table);
      const { profile } = await cdp.send('Profiler.stop');
      const after = (await cdp.send('Performance.getMetrics')).metrics;
      save(`cpu-${round}-${table}.json`, profile);
      const delta = Object.fromEntries(
        after
          .filter((v) => /Duration$|Count$/.test(v.name))
          .map((v) => [v.name, v.value - (before.find((b) => b.name === v.name)?.value ?? 0)])
      );
      samples.push({ path: route, ...measured, delta });
    }
  save('render-profile-summary.json', {
    source: process.env.GITHUB_SHA,
    diagnosticOnly: true,
    samples
  });
  console.log(JSON.stringify({ diagnosticOnly: true, samples: samples.length }));
  await context.close();
}
try {
  database = await startOwnedMysqlTestInstance({
    runtime: 'docker',
    database: `id_business_v2_interaction_${Date.now()}`,
    project: root
  });
  secrets.push(database.rootPassword);
  env.DATABASE_URL = `mysql://root:${database.rootPassword}@127.0.0.1:${database.port}/${database.database}`;
  run('migrations', process.execPath, [
    'node_modules/prisma/build/index.js',
    'migrate',
    'deploy',
    '--schema',
    'apps/api/prisma-mysql/schema.prisma'
  ]);
  run('seed-admin', 'npm', ['run', 'prisma:seed', '--workspace', '@apple-business/api']);
  save('fixture.json', await seedPreviewRows(root, env, database));
  const baseline = path.join(root, '.runtime/interaction-preview-20261103/baseline');
  run('baseline-checkout', 'git', ['worktree', 'add', '--detach', baseline, PREVIEW_BASE]);
  symlinkSync(path.join(root, 'node_modules'), path.join(baseline, 'node_modules'), 'dir');
  run('baseline-build', 'npm', ['run', 'build', '--workspace', '@apple-business/admin'], baseline, {
    ...env,
    NODE_ENV: 'production'
  });
  start('api', ['apps/api/dist/main.js', '--host=127.0.0.1']);
  await available(`http://127.0.0.1:5300${PREVIEW_API_READY_PATH}`);
  for (const [label, project, port] of [
    ['after', root, '5374'],
    ['before', baseline, '5375']
  ]) {
    start(
      `preview-${label}`,
      [
        path.join(root, 'node_modules/vite/bin/vite.js'),
        'preview',
        '--host',
        '127.0.0.1',
        '--port',
        port,
        '--strictPort'
      ],
      path.join(project, 'apps/admin')
    );
    await available(`http://127.0.0.1:${port}/login`);
  }
  browser = await chromium.launch({ headless: true });
  if (process.argv.includes('--profile-only')) {
    await profileCurrent();
  } else {
    await benchmark('before', 5375);
    await benchmark('after', 5374);
    let performanceError;
    try {
      save('performance-comparison.json', compareInteractionMetrics(metrics.after, metrics.before));
    } catch (error) {
      performanceError = error;
      save('performance-error.json', { message: error.message });
    }
    const routes = await listPreviewRoutes(root);
    await interactionFeedback();
    await matrix(routes);
    save('checks.json', {
      checks,
      source: process.env.GITHUB_SHA,
      baseline: PREVIEW_BASE,
      routes: routes.length,
      productionAccess: false,
      localMacServicesStarted: false,
      performancePassed: !performanceError
    });
    if (performanceError) throw performanceError;
    console.log(
      JSON.stringify({
        ok: true,
        source: process.env.GITHUB_SHA,
        routeChecks: checks.length,
        benchmarkSamples: metrics.before.samples.length + metrics.after.samples.length
      })
    );
  }
} catch (error) {
  save('failure.json', {
    name: error.name,
    message: redactPreviewOutput(error.message, secrets),
    checks
  });
  await activePage?.screenshot({ path: path.join(output, 'failure.png') }).catch(() => {});
  console.error(JSON.stringify({ ok: false, error: redactPreviewOutput(error.message, secrets) }));
  process.exitCode = 1;
} finally {
  await browser?.close().catch(() => {});
  for (const child of children.reverse()) {
    if (child.exitCode === null) {
      child.kill('SIGTERM');
      await Promise.race([
        new Promise((resolve) => child.once('exit', resolve)),
        new Promise((resolve) => setTimeout(resolve, 5000))
      ]);
      if (child.exitCode === null) child.kill('SIGKILL');
    }
  }
  await database?.cleanup();
  save('cleanup.json', {
    ownedDatabaseRemoved: Boolean(database),
    childProcessesStopped: children.every(
      (child) => child.exitCode !== null || child.signalCode !== null
    ),
    productionResourcesTouched: false
  });
}

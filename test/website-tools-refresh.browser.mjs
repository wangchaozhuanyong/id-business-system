import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { EventEmitter, once } from 'node:events';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { initializeLocalAdmin } from '../server/local-auth.mjs';
import { startPreview } from '../server/preview.mjs';
import { interceptDesign, origin as offlineOrigin } from './helpers/offline-design.mjs';

const analyticsPath = '/api/local/tools/website-analytics';
const visitsPath = '/api/local/tools/website-visits/search';
const firstVisitFilters = { days: 7, sort: 'newest', page: 1, pageSize: 20, ip: '203.0.113.7' };
const nextVisitFilters = { days: 30, sort: 'oldest', page: 1, pageSize: 20, ip: '203.0.113.8' };
const loading = /正在|加载|读取|查询/;

function interceptedTools(page, origin) {
  const requests = new Map([
    [analyticsPath, []],
    [visitsPath, []]
  ]);
  const events = new EventEmitter();
  return {
    async install() {
      await page.route('**/*', (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) return route.abort();
        const queue = requests.get(url.pathname);
        if (!queue) return route.fallback();
        queue.push(route);
        events.emit(url.pathname);
      });
    },
    async next(path) {
      const queue = requests.get(path);
      if (!queue.length) await once(events, path, { signal: AbortSignal.timeout(5000) });
      return queue.shift();
    },
    async reply(route, body, status = 200) {
      const request = route.request();
      const received = page.waitForResponse((response) => response.request() === request);
      await route.fulfill({ status, json: body });
      await (await received).finished();
      await page.evaluate(
        () => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))
      );
    }
  };
}

function analyticsResult(pageViews) {
  return {
    timeZone: 'Asia/Shanghai',
    utcOffset: '+08:00',
    summary: { pageViews, visitors: 12, sessions: 25 },
    daily: [{ date: '2026-11-04', metrics: { pageViews: 9, visitors: 8, sessions: 10 } }]
  };
}

function visitResult(path, { page = 1, pageSize = 20, total = 34 } = {}) {
  return {
    page,
    pageSize,
    total,
    items: [
      {
        id: `visit-${page}`,
        occurredAt: '2026-11-04T10:00:00.000Z',
        path,
        ipMasked: '203.0.113.***'
      }
    ]
  };
}

async function setVisitFilters(page, filters) {
  await page.getByRole('tab', { name: '访问记录与 IP', exact: true }).click();
  await page.locator('#ops-visits-days').selectOption(String(filters.days));
  await page.locator('#ops-visits-sort').selectOption(filters.sort);
  await page.locator('#ops-visits-ip').fill(filters.ip);
}

test(
  'website statistics and visits retain results during refresh and discard stale responses',
  { timeout: 45_000 },
  async (t) => {
    const playwright = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
    assert(playwright, '请通过 ID_RECHARGE_QA_PLAYWRIGHT 指定已有 Playwright 模块入口');
    const { chromium } = await import(pathToFileURL(playwright).href);
    const offline = process.env.ID_LAYOUT_QA_OFFLINE === '1';
    let browser, host, directory;
    t.after(async () => {
      try {
        await browser?.close();
      } finally {
        if (host) {
          const stopped = new Promise((resolve) => host.server.close(resolve));
          host.server.closeAllConnections();
          await stopped;
        }
        if (directory) await rm(directory, { recursive: true, force: true });
      }
    });
    const user = {
      name: '工具专项管理员',
      email: 'website-tools-fixture@example.test',
      password: randomBytes(24).toString('hex')
    };
    if (!offline) {
      const runtime = fileURLToPath(new URL('../.runtime/', import.meta.url));
      await mkdir(runtime, { recursive: true, mode: 0o700 });
      directory = await mkdtemp(join(runtime, 'website-tools-browser-test-'));
      const authPath = join(directory, 'employees.json');
      await initializeLocalAdmin(authPath, user);
      host = await startPreview(0, { databasePath: ':memory:', authPath });
    }
    const origin = offline ? offlineOrigin : new URL(host.url).origin;
    browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
    const page = await browser.newPage({ viewport: { width: 1280, height: 850 } });
    if (offline) await interceptDesign(page.context(), {
      actor: { id: 'synthetic-admin', name: user.name, role: 'admin' },
      localFixtures: { toolbox: { version: 0, data: { shortcuts: [], phrases: [] } } }
    });
    page.setDefaultTimeout(5000);
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    const tools = interceptedTools(page, origin);
    const readCounts = { analytics: 0, visits: 0 };
    page.on('request', (request) => {
      const path = new URL(request.url()).pathname;
      if (path === analyticsPath) readCounts.analytics++;
      if (path === visitsPath) readCounts.visits++;
    });
    await tools.install();

    await page.goto(origin + '/#/workspace/mail-submit');
    if (!offline) {
      await page.locator('#local-auth-email').fill(user.email);
      await page.locator('#local-auth-password').fill(user.password);
      await page.getByRole('button', { name: '登录', exact: true }).click();
    }
    const drawer = page.locator('#drawer');
    const entries = page.getByRole('navigation', { name: '常用工具' });
    const names = ['个人工具', '在线工具', '话术文案'];
    assert.deepEqual(await entries.getByRole('button').allTextContents(), names);
    for (const name of names) {
      await entries.getByRole('button', { name, exact: true }).click();
      await drawer.getByRole('heading', { name, exact: true }).waitFor();
      await drawer.getByRole('button', { name: '关闭抽屉', exact: true }).click();
    }
    async function openMonitor(expectRead = true) {
      if (!await drawer.isVisible()) {
        await page.getByRole('button', { name: '在线工具', exact: true }).click();
      }
      await page.evaluate(() => window.IDDesignModules.find(module => module.id === 'operations').onClick('tool-open', { dataset: { name: '网站监控' } }));
      if (expectRead) return tools.next(analyticsPath);
    }
    const analytics = drawer.locator('[data-website-analytics-result]');
    const analyticsStatus = drawer.locator('[data-website-analytics-status]');
    const visits = drawer.locator('[data-visits-result]');
    const visitsStatus = drawer.locator('[data-visits-status]');
    const showPendingLine = async (status) => {
      await status.waitFor();
      assert.equal(await status.textContent(), '');
      assert((await status.boundingBox()).height <= 3);
    };
    const showMetric = async (value) => {
      await drawer.getByRole('tab', { name: '访问统计', exact: true }).click();
      await analytics.getByText(String(value), { exact: true }).waitFor();
    };
    const showVisit = async (path) => {
      await drawer.getByRole('tab', { name: '访问记录与 IP', exact: true }).click();
      await visits.getByRole('button', { name: '查看完整页面路径' })
        .and(visits.getByText(path, { exact: true })).waitFor();
    };
    let analyticsDays = 7;
    async function requestAnalytics(days) {
      if (days) analyticsDays = days;
      await drawer.getByRole('tab', { name: '访问统计', exact: true }).click();
      await drawer.getByRole('button', { name: days ? `最近 ${days} 天` : '刷新统计', exact: true }).click();
      const request = await tools.next(analyticsPath);
      assert.equal(request.request().method(), 'GET');
      assert.equal(new URL(request.request().url()).searchParams.get('days'), String(analyticsDays));
      return request;
    }
    async function requestVisits() {
      await drawer.getByRole('tab', { name: '访问记录与 IP', exact: true }).click();
      await drawer.getByRole('button', { name: '查询明细', exact: true }).click();
      const request = await tools.next(visitsPath);
      assert.equal(request.request().method(), 'POST');
      return request;
    }

    const firstAnalytics = await openMonitor();
    await tools.reply(await tools.next(visitsPath), { items: [], page: 1, pageSize: 20, total: 0 });
    await analyticsStatus.waitFor();
    assert.match(await analyticsStatus.textContent(), loading);
    await tools.reply(firstAnalytics, analyticsResult(111));
    await showMetric(111);

    const initialCounts = { ...readCounts };
    await drawer.getByRole('button', { name: '关闭抽屉', exact: true }).click();
    await drawer.locator('.online-tool-list').waitFor();
    await openMonitor(false);
    await showMetric(111);
    assert.deepEqual(readCounts, initialCounts, '重开工具应同步复用有效统计和明细，不重新请求');

    const beforeRefresh = await analytics.boundingBox();
    const slowerAnalytics = await requestAnalytics();
    await showPendingLine(analyticsStatus);
    assert.deepEqual(await analytics.boundingBox(), beforeRefresh);
    assert(await drawer.getByRole('button', { name: '刷新统计' }).isDisabled());
    await showMetric(111);
    const newerAnalytics = await requestAnalytics(30);
    await tools.reply(newerAnalytics, analyticsResult(333));
    await showMetric(333);
    await tools.reply(slowerAnalytics, analyticsResult(222));
    await showMetric(333);
    assert.equal(await analytics.getByText('222', { exact: true }).count(), 0);

    const pendingThirtyDays = await requestAnalytics();
    const beforeCachedSwitch = { ...readCounts };
    await drawer.getByRole('button', { name: '最近 7 天', exact: true }).click();
    await showMetric(222);
    assert.deepEqual(readCounts, beforeCachedSwitch, '切回已有时间范围不重复请求');
    await tools.reply(pendingThirtyDays, analyticsResult(666));
    await showMetric(222);
    await drawer.getByRole('button', { name: '最近 30 天', exact: true }).click();
    await showMetric(666);

    const failingAnalytics = await requestAnalytics();
    await showMetric(666);
    await tools.reply(failingAnalytics, { error: '统计服务暂时失败' }, 503);
    assert.match(await analyticsStatus.textContent(), /统计服务暂时失败/);
    await showMetric(666);

    await setVisitFilters(page, firstVisitFilters);
    const firstVisit = await requestVisits();
    assert.deepEqual(firstVisit.request().postDataJSON(), firstVisitFilters);
    await showPendingLine(visitsStatus);
    await tools.reply(firstVisit, visitResult('/first-page'));
    await showVisit('/first-page');

    await setVisitFilters(page, nextVisitFilters);
    const nextPage = visits.getByRole('button', { name: '下一页', exact: true });
    await nextPage.click();
    const failingPage = await tools.next(visitsPath);
    assert.deepEqual(failingPage.request().postDataJSON(), { ...firstVisitFilters, page: 2 });
    await showPendingLine(visitsStatus);
    await showVisit('/first-page');
    await tools.reply(failingPage, { error: '访问记录暂时失败' }, 503);
    assert.match(await visitsStatus.textContent(), /访问记录暂时失败/);
    await showVisit('/first-page');

    await nextPage.click();
    const slowerPage = await tools.next(visitsPath);
    assert.deepEqual(slowerPage.request().postDataJSON(), { ...firstVisitFilters, page: 2 });
    await showVisit('/first-page');
    const newerVisits = await requestVisits();
    assert.deepEqual(newerVisits.request().postDataJSON(), nextVisitFilters);
    await tools.reply(newerVisits, visitResult('/new-query', { total: 55 }));
    await showVisit('/new-query');
    await tools.reply(slowerPage, visitResult('/stale-page-two', { page: 2 }));
    await showVisit('/new-query');
    assert.equal(await visits.getByText('/stale-page-two', { exact: true }).count(), 0);
    await visits.getByLabel('每页条数', { exact: true }).selectOption('50');
    const resizedVisits = await tools.next(visitsPath);
    assert.deepEqual(resizedVisits.request().postDataJSON(), { ...nextVisitFilters, pageSize: 50 });
    await tools.reply(resizedVisits, visitResult('/new-size', { pageSize: 50, total: 55 }));
    await showVisit('/new-size');

    const closedAnalytics = await requestAnalytics();
    const closedVisits = await requestVisits();
    await drawer.getByRole('button', { name: '关闭抽屉', exact: true }).click();
    await drawer.locator('.online-tool-list').waitFor();
    const reopenedAnalytics = await openMonitor();
    const reopenedVisits = await tools.next(visitsPath);
    await tools.reply(reopenedAnalytics, analyticsResult(444));
    await tools.reply(reopenedVisits, visitResult('/reopened'));
    await showMetric(444);
    await showVisit('/reopened');
    await tools.reply(closedAnalytics, analyticsResult(555));
    await tools.reply(closedVisits, visitResult('/closed-drawer'));
    await showMetric(444);
    await showVisit('/reopened');
    assert.equal(await analytics.getByText('555', { exact: true }).count(), 0);
    assert.equal(await visits.getByText('/closed-drawer', { exact: true }).count(), 0);
    assert.deepEqual(errors, []);
  }
);

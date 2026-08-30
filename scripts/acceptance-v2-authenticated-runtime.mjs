#!/usr/bin/env node
/* global document */
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright';

const rootDir = new URL('..', import.meta.url);
loadEnvFile(new URL('.env', rootDir));

const adminBaseUrl = String(
  process.env.V2_RUNTIME_AUDIT_ADMIN_BASE_URL ?? 'http://127.0.0.1:5374'
).replace(/\/$/, '');
const apiBaseUrl = String(
  process.env.V2_RUNTIME_AUDIT_API_BASE_URL ?? 'http://127.0.0.1:5300/api'
).replace(/\/$/, '');
const outputDir =
  process.env.V2_RUNTIME_AUDIT_OUTPUT_DIR ?? '/tmp/id-business-v2-authenticated-runtime-audit';
const sampleRounds = Number(process.env.V2_RUNTIME_AUDIT_ROUNDS ?? 12);
const username = process.env.V2_PERF_USERNAME ?? process.env.SEED_ADMIN_USERNAME;
const password = process.env.V2_PERF_PASSWORD ?? process.env.SEED_ADMIN_PASSWORD;

assertLoopbackUrl(adminBaseUrl, '管理端');
assertLoopbackUrl(apiBaseUrl, 'API');
assert.ok(username && password, '缺少真实登录验收账号');
assert.ok(Number.isInteger(sampleRounds) && sampleRounds >= 5, '页面采样轮数至少为 5');

await mkdir(outputDir, { recursive: true });

const apiSession = await apiRequest('/auth/login', {
  method: 'POST',
  body: { username, password }
});
const accessToken = apiSession.data?.accessToken;
assert.ok(accessToken, 'API 登录没有返回 accessToken');

const browser = await chromium.launch({ headless: true });
const screenshots = [];
const runtimeEvidence = {
  realtime: {},
  employeeConcurrency: {},
  whitelistConcurrency: {},
  pagePerformance: []
};

try {
  const loginContext = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const loginPage = await loginContext.newPage();
  await loginPage.goto(`${adminBaseUrl}/login`, { waitUntil: 'domcontentloaded' });
  await loginPage.locator('#v2-admin-login-form').waitFor({ state: 'visible' });
  await capture(loginPage, '01-login-desktop.png', { fullPage: true });
  await loginContext.close();

  const contextA = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const pageA = await contextA.newPage();
  const requestCountsA = observeSyncRequests(pageA);
  await login(pageA, username, password);
  await capture(pageA, '02-dashboard-desktop.png', { fullPage: true });
  const storageState = await contextA.storageState();
  const sessionStorageState = await pageA.evaluate(() =>
    Object.fromEntries(
      Array.from({ length: sessionStorage.length }, (_, index) => sessionStorage.key(index))
        .filter(Boolean)
        .map((key) => [key, sessionStorage.getItem(key)])
    )
  );
  const browserAuthState = { storageState, sessionStorageState };

  runtimeEvidence.pagePerformance = await measureAuthenticatedRoutes(
    browser,
    browserAuthState,
    sampleRounds
  );
  await captureAuthenticatedPages(browser, browserAuthState);

  const contextB = await browser.newContext({
    storageState,
    viewport: { width: 1440, height: 900 }
  });
  await installSessionStorage(contextB, sessionStorageState);
  const pageB = await contextB.newPage();
  const requestCountsB = observeSyncRequests(pageB);

  await Promise.all([
    openAuthenticatedRoute(pageA, '/v2/system/employees'),
    openAuthenticatedRoute(pageB, '/v2/system/employees')
  ]);
  await Promise.all([
    waitForRealtimeConnection(pageA, requestCountsA),
    waitForRealtimeConnection(pageB, requestCountsB)
  ]);
  await Promise.all([pageA.waitForTimeout(500), pageB.waitForTimeout(500)]);
  const versionsBaseline = {
    browserA: requestCountsA.changeVersions,
    browserB: requestCountsB.changeVersions
  };

  const documentEpochA = await pageA.evaluate(() => performance.timeOrigin);

  const bootstrap = await apiRequest('/v2/employees/bootstrap?page=1&pageSize=20', {
    accessToken
  });
  const adminRole = bootstrap.data?.roles?.find((role) => role.code === 'admin');
  assert.ok(adminRole?.id, '未找到管理员角色');

  const uniqueSuffix = `${Date.now().toString(36)}${randomBytes(3).toString('hex')}`;
  const targetUsername = `runtime_audit_${uniqueSuffix}`;
  const targetPassword = `Audit${randomBytes(9).toString('hex')}8a`;
  const initialDisplayName = `实时审计初始-${uniqueSuffix}`;
  const createdAt = performance.now();
  const employee = await apiRequest('/v2/employees', {
    method: 'POST',
    accessToken,
    body: {
      username: targetUsername,
      displayName: initialDisplayName,
      initialPassword: targetPassword,
      roleIds: [adminRole.id]
    }
  });
  assert.ok(employee.data?.id && employee.data?.updatedAt, '未创建并发测试员工');
  await Promise.all([
    pageA.getByText(initialDisplayName, { exact: true }).first().waitFor(),
    pageB.getByText(initialDisplayName, { exact: true }).first().waitFor()
  ]);
  runtimeEvidence.realtime.employeeCreateVisibleMs = Math.round(performance.now() - createdAt);

  const expectedUpdatedAt = employee.data.updatedAt;
  const candidateNames = [`并发管理员甲-${uniqueSuffix}`, `并发管理员乙-${uniqueSuffix}`];
  const conflictStartedAt = performance.now();
  const updateResults = await Promise.all(
    candidateNames.map((displayName) =>
      apiRequest(`/v2/employees/${employee.data.id}`, {
        method: 'PATCH',
        accessToken,
        body: {
          expectedUpdatedAt,
          displayName,
          status: employee.data.status,
          roleIds: employee.data.roles.map((role) => role.id)
        },
        allowedStatuses: [200, 409]
      })
    )
  );
  assert.deepEqual(
    updateResults.map((result) => result.status).sort((left, right) => left - right),
    [200, 409],
    '同版本并发员工更新必须恰好一笔成功、一笔冲突'
  );
  const employeeWinner = updateResults.find((result) => result.status === 200)?.data;
  assert.ok(employeeWinner?.displayName, '员工并发更新没有成功结果');
  await Promise.all([
    pageA.getByText(employeeWinner.displayName, { exact: true }).first().waitFor(),
    pageB.getByText(employeeWinner.displayName, { exact: true }).first().waitFor()
  ]);
  runtimeEvidence.employeeConcurrency = {
    statuses: updateResults.map((result) => result.status),
    winner: employeeWinner.displayName,
    visibleInBothBrowsersMs: Math.round(performance.now() - conflictStartedAt)
  };

  await capture(pageA, '03-employees-realtime-desktop.png', { fullPage: true });
  const employeeRow = pageA.locator('.el-table__row').filter({ hasText: targetUsername });
  await employeeRow.getByRole('button', { name: '编辑', exact: true }).click();
  await pageA.getByRole('heading', { name: '编辑员工账号', exact: true }).waitFor();
  await pageA.waitForTimeout(500);
  await capture(pageA, '04-employee-edit-drawer.png');
  await pageA.keyboard.press('Escape');

  const previousRealtimeConnectionsB = requestCountsB.realtime;
  await openAuthenticatedRoute(pageB, '/v2/system/security');
  await pageB.getByRole('tab', { name: 'MFA 与白名单', exact: true }).click();
  await pageB.getByText('IP 白名单', { exact: true }).waitFor();
  await waitForPageReady(pageB);
  await waitForRealtimeConnection(pageB, requestCountsB, previousRealtimeConnectionsB + 1);
  await pageB.waitForTimeout(500);
  versionsBaseline.browserB = requestCountsB.changeVersions;
  const documentEpochB = await pageB.evaluate(() => performance.timeOrigin);

  const whitelistIp = `203.0.113.${10 + (Date.now() % 180)}`;
  const whitelist = await apiRequest('/v2/security/ip-whitelists', {
    method: 'POST',
    accessToken,
    body: {
      ipOrCidr: whitelistIp,
      scope: 'api',
      enabled: false,
      remark: `并发审计-${uniqueSuffix}`
    }
  });
  assert.ok(whitelist.data?.id && whitelist.data?.updatedAt, '未创建白名单并发测试记录');
  await pageB.getByText(whitelistIp, { exact: true }).first().waitFor();

  const whitelistResults = await Promise.all(
    ['白名单并发甲', '白名单并发乙'].map((remark) =>
      apiRequest(`/v2/security/ip-whitelists/${whitelist.data.id}`, {
        method: 'PATCH',
        accessToken,
        body: {
          expectedUpdatedAt: whitelist.data.updatedAt,
          ipOrCidr: whitelist.data.ipOrCidr,
          scope: whitelist.data.scope,
          enabled: false,
          remark: `${remark}-${uniqueSuffix}`
        },
        allowedStatuses: [200, 409]
      })
    )
  );
  assert.deepEqual(
    whitelistResults.map((result) => result.status).sort((left, right) => left - right),
    [200, 409],
    '同版本并发白名单更新必须恰好一笔成功、一笔冲突'
  );
  const whitelistWinner = whitelistResults.find((result) => result.status === 200)?.data;
  assert.ok(whitelistWinner?.remark, '白名单并发更新没有成功结果');
  await pageB.getByText(whitelistWinner.remark, { exact: true }).first().waitFor();
  runtimeEvidence.whitelistConcurrency = {
    statuses: whitelistResults.map((result) => result.status),
    winner: whitelistWinner.remark
  };
  await capture(pageB, '05-security-policy-desktop.png', { fullPage: true });
  await pageB.getByText(whitelistIp, { exact: true }).first().scrollIntoViewIfNeeded();
  await capture(pageB, '06-security-whitelist-realtime.png');

  await Promise.all([pageA.waitForTimeout(2_000), pageB.waitForTimeout(2_000)]);
  assert.equal(
    await pageA.evaluate(() => performance.timeOrigin),
    documentEpochA,
    '浏览器 A 的实时更新触发了整页刷新'
  );
  assert.equal(
    await pageB.evaluate(() => performance.timeOrigin),
    documentEpochB,
    '浏览器 B 的实时更新触发了整页刷新'
  );
  assert.equal(
    requestCountsA.changeVersions,
    versionsBaseline.browserA,
    'SSE 正常连接时浏览器 A 仍固定轮询版本接口'
  );
  assert.equal(
    requestCountsB.changeVersions,
    versionsBaseline.browserB,
    'SSE 正常连接时浏览器 B 仍固定轮询版本接口'
  );
  runtimeEvidence.realtime = {
    ...runtimeEvidence.realtime,
    browserAConnections: requestCountsA.realtime,
    browserBConnections: requestCountsB.realtime,
    fixedVersionPollsAfterConnected: {
      browserA: requestCountsA.changeVersions - versionsBaseline.browserA,
      browserB: requestCountsB.changeVersions - versionsBaseline.browserB
    },
    pageReloads: {
      browserA: 0,
      browserB: 0
    }
  };

  const mobileContext = await browser.newContext({
    storageState,
    viewport: { width: 390, height: 844 }
  });
  await installSessionStorage(mobileContext, sessionStorageState);
  const mobilePage = await mobileContext.newPage();
  await openAuthenticatedRoute(mobilePage, '/v2/system/employees');
  await mobilePage
    .locator('.v2-records-mobile-list')
    .getByText(employeeWinner.displayName, { exact: true })
    .first()
    .waitFor();
  await capture(mobilePage, '07-employees-mobile.png', { fullPage: true });
  await mobilePage.locator('.v2-records-mobile-list').first().scrollIntoViewIfNeeded();
  await mobilePage.waitForTimeout(300);
  await capture(mobilePage, '08-employees-mobile-list.png');
  await mobileContext.close();

  await contextB.close();
  await contextA.close();

  const report = {
    generatedAt: new Date().toISOString(),
    adminBaseUrl,
    apiBaseUrl,
    sampleRounds,
    screenshots,
    ...runtimeEvidence
  };
  const reportPath = `${outputDir}/runtime-audit.json`;
  await writeFile(reportPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  console.log(`[V2 authenticated runtime] ${JSON.stringify(report)}`);
  console.log(`[V2 authenticated runtime] PASSED report=${reportPath}`);
} finally {
  await browser.close();
  await apiRequest('/auth/logout', {
    method: 'POST',
    accessToken,
    allowedStatuses: [200, 401]
  }).catch(() => undefined);
}

async function login(page, loginUsername, loginPassword) {
  await page.goto(`${adminBaseUrl}/login`, { waitUntil: 'domcontentloaded' });
  await page.locator('#v2-admin-login-form').waitFor({ state: 'visible' });
  await page.locator('[name="username"]').fill(loginUsername);
  await page.locator('[name="password"]').fill(loginPassword);
  await page.locator('#v2-admin-login-form button[type="submit"]').click();
  await page.waitForURL('**/v2/**');
  await waitForPageReady(page);
}

async function openAuthenticatedRoute(page, path) {
  await page.goto(`${adminBaseUrl}${path}`, { waitUntil: 'domcontentloaded' });
  await waitForPageReady(page);
}

async function waitForPageReady(page) {
  await page.locator('#v2-main').waitFor({ state: 'visible', timeout: 30_000 });
  await page.locator('.v2-topbar__identity h1').waitFor({ state: 'visible', timeout: 30_000 });
  await page.waitForFunction(
    () =>
      document.querySelectorAll('#v2-main .v2-page-state--loading').length === 0 &&
      document.querySelectorAll('#v2-main .v2-route-error, #v2-main .v2-page-state--error')
        .length === 0,
    undefined,
    { timeout: 30_000 }
  );
}

async function waitForRealtimeConnection(page, requestCounts, minimumConnections = 1) {
  const startedAt = Date.now();
  while (requestCounts.realtime < minimumConnections && Date.now() - startedAt < 30_000) {
    await page.waitForTimeout(50);
  }
  assert.ok(requestCounts.realtime >= minimumConnections, '浏览器没有建立实时事件连接');
}

function observeSyncRequests(page) {
  const counts = {
    realtime: 0,
    changeVersions: 0
  };
  page.on('request', (request) => {
    const path = new URL(request.url()).pathname;
    if (path.endsWith('/api/realtime/events')) counts.realtime += 1;
    if (path.endsWith('/api/id-business-v2/change-versions')) counts.changeVersions += 1;
  });
  return counts;
}

async function measureAuthenticatedRoutes(targetBrowser, browserAuthState, rounds) {
  const paths = [
    '/v2/dashboard',
    '/v2/orders',
    '/v2/exchange-rates',
    '/v2/system/employees',
    '/v2/system/security'
  ];
  const results = [];
  for (const path of paths) {
    const samples = [];
    for (let round = 0; round < rounds; round += 1) {
      const context = await targetBrowser.newContext({
        storageState: browserAuthState.storageState,
        viewport: { width: 1440, height: 900 }
      });
      await installSessionStorage(context, browserAuthState.sessionStorageState);
      const page = await context.newPage();
      const startedAt = performance.now();
      await openAuthenticatedRoute(page, path);
      samples.push(Math.round(performance.now() - startedAt));
      await context.close();
    }
    results.push({
      path,
      samples: samples.length,
      p50Ms: percentile(samples, 50),
      p95Ms: percentile(samples, 95),
      p99Ms: percentile(samples, 99),
      maxMs: Math.max(...samples)
    });
  }
  return results;
}

async function captureAuthenticatedPages(targetBrowser, browserAuthState) {
  const routes = [
    ['dashboard', '/v2/dashboard'],
    ['renewals', '/v2/workbench/renewals'],
    ['order-entry', '/v2/workbench/order-entry'],
    ['topup-workbench', '/v2/workbench/topups'],
    ['accounts', '/v2/accounts'],
    ['orders', '/v2/orders'],
    ['customers', '/v2/customers'],
    ['topup-records', '/v2/records/topups'],
    ['activation-records', '/v2/records/activations'],
    ['account-losses', '/v2/records/account-losses'],
    ['exchange-rates', '/v2/exchange-rates'],
    ['options', '/v2/options'],
    ['finance-ledger', '/v2/data/finance'],
    ['finance-expenses', '/v2/data/finance/expenses'],
    ['data-analytics', '/v2/data/analytics'],
    ['data-governance', '/v2/data/governance'],
    ['business-monitoring', '/v2/monitoring/business'],
    ['system-monitoring', '/v2/monitoring/system'],
    ['employees', '/v2/system/employees'],
    ['roles', '/v2/system/roles'],
    ['audit-logs', '/v2/system/audit-logs'],
    ['branding', '/v2/system/branding'],
    ['security', '/v2/system/security'],
    ['profile', '/v2/profile']
  ];
  const context = await targetBrowser.newContext({
    storageState: browserAuthState.storageState,
    viewport: { width: 1440, height: 900 }
  });
  await installSessionStorage(context, browserAuthState.sessionStorageState);
  const page = await context.newPage();
  for (const [index, [name, path]] of routes.entries()) {
    await openAuthenticatedRoute(page, path);
    await capture(page, `page-${String(index + 1).padStart(2, '0')}-${name}.png`, {
      fullPage: true
    });
  }
  await context.close();
}

async function installSessionStorage(context, entries) {
  await context.addInitScript((values) => {
    for (const [key, value] of Object.entries(values)) {
      if (value !== null) sessionStorage.setItem(key, value);
    }
  }, entries);
}

function percentile(samples, target) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil((target / 100) * sorted.length) - 1)];
}

async function capture(page, fileName, options = {}) {
  const path = `${outputDir}/${fileName}`;
  await page.screenshot({ path, fullPage: options.fullPage ?? false });
  screenshots.push(path);
}

async function apiRequest(path, options = {}) {
  const response = await fetch(`${apiBaseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.accessToken ? { Authorization: `Bearer ${options.accessToken}` } : {}),
      ...(options.body ? { 'Content-Type': 'application/json' } : {})
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
    signal: AbortSignal.timeout(30_000)
  });
  const payload = await response.json().catch(() => null);
  const allowedStatuses = options.allowedStatuses ?? [200, 201];
  assert.ok(
    allowedStatuses.includes(response.status),
    `API 请求失败：${options.method ?? 'GET'} ${path} -> ${response.status}`
  );
  return {
    status: response.status,
    data: payload?.data ?? payload
  };
}

function assertLoopbackUrl(value, label) {
  const parsed = new URL(value);
  assert.ok(
    ['127.0.0.1', 'localhost', '::1'].includes(parsed.hostname),
    `${label}真实登录验收只允许一次性本机环境`
  );
}

function loadEnvFile(fileUrl) {
  try {
    for (const line of readFileSync(fileUrl, 'utf8').split(/\r?\n/)) {
      const normalized = line.trim();
      if (!normalized || normalized.startsWith('#')) continue;
      const separator = normalized.indexOf('=');
      if (separator < 0) continue;
      process.env[normalized.slice(0, separator)] ??= normalized.slice(separator + 1);
    }
  } catch {
    // Missing values are reported by assertions above.
  }
}

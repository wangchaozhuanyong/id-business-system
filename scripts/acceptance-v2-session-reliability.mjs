#!/usr/bin/env node
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { chromium } from 'playwright';

const rootDir = process.cwd();
const adminDir = path.join(rootDir, 'apps', 'admin');
const viteCliPath = path.join(rootDir, 'node_modules', 'vite', 'bin', 'vite.js');
const configuredAdminUrl = process.env.V2_SESSION_RELIABILITY_ADMIN_URL;
const adminUrl = new URL(configuredAdminUrl ?? 'http://127.0.0.1:5394');
const viewports = [
  { name: 'desktop', width: 1440, height: 900 },
  { name: 'mobile-390', width: 390, height: 844 }
];
const user = {
  id: 'session-reliability-user',
  username: 'session-reliability',
  displayName: '会话可靠性管理员',
  roles: ['admin'],
  permissions: ['customer.view', 'customer.create', 'customer.update'],
  mustResetPassword: false
};

assert.ok(
  ['localhost', '127.0.0.1', '::1'].includes(adminUrl.hostname),
  '会话可靠性验收只允许连接本机管理端'
);

let adminServer = null;
let browser = null;

try {
  if (!configuredAdminUrl) {
    await runNpmCommand(['run', 'build', '--workspace', '@apple-business/shared'], '共享包构建');
    adminServer = startAdminServer();
  }
  await waitForServer();
  browser = await chromium.launch({ headless: true });
  await warmAdminRuntime(browser);

  for (const viewport of viewports) {
    await verifyColdAuth503(browser, viewport);
  }
  await verifyVerifiedSessionDegradation(browser);

  console.log(
    JSON.stringify({
      ok: true,
      viewports: viewports.map(({ name, width }) => `${name}:${width}px`),
      cold503: ['no-business-shell', 'no-runtime-overlay', 'no-navigation-abort'],
      verified503: ['preserve-shell', 'preserve-content', 'read-only-banner', 'central-write-gate'],
      recovery: 'invalidate-active-queries'
    })
  );
} finally {
  await browser?.close().catch(() => undefined);
  await stopAdminServer(adminServer);
}

async function verifyColdAuth503(browserInstance, viewport) {
  const context = await browserInstance.newContext({ viewport });
  const page = await context.newPage();
  const errors = collectBoundaryErrors(page);
  const unexpectedBusinessRequests = [];
  let authCalls = 0;
  await seedCredential(page);
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (!pathname.startsWith('/api/')) {
      await route.continue();
      return;
    }
    if (request.method() === 'GET' && pathname.endsWith('/api/id-business-v2/branding/public')) {
      await fulfillSuccess(route, {});
      return;
    }
    if (request.method() === 'GET' && pathname.endsWith('/api/auth/me')) {
      authCalls += 1;
      await fulfillAuthUnavailable(route);
      return;
    }
    unexpectedBusinessRequests.push(`${request.method()} ${pathname}`);
    await fulfillAuthUnavailable(route);
  });

  try {
    await page.goto(new URL('/v2/customers', adminUrl).href, { waitUntil: 'domcontentloaded' });
    try {
      await page.getByText('暂时无法确认登录状态').waitFor({
        state: 'visible',
        timeout: 15_000
      });
    } catch (error) {
      const body = await page
        .locator('body')
        .innerText()
        .catch(() => '');
      const session = await page
        .evaluate(async () => {
          const { sessionCoordinator } = await import('/src/auth/sessionCoordinator.ts');
          return {
            credential: sessionCoordinator.credential.value,
            state: sessionCoordinator.state.value,
            storage: Object.fromEntries(
              Array.from({ length: localStorage.length }, (_, index) => {
                const key = localStorage.key(index) ?? '';
                return [key, localStorage.getItem(key)];
              })
            )
          };
        })
        .catch((reason) => ({ evaluationError: String(reason) }));
      throw new Error(
        `${viewport.name} 冷启动 503 边界未就绪；url=${page.url()}; authCalls=${authCalls}; session=${JSON.stringify(session)}; body=${body.slice(0, 1200)}; errors=${errors.join(';')}`,
        { cause: error }
      );
    }

    assert.equal(
      await page.locator('.v2-shell').count(),
      0,
      `${viewport.name} 冷启动提前挂载业务外壳`
    );
    assert.equal(
      await page.locator('.app-route-error').count(),
      0,
      `${viewport.name} 认证 503 误升级为全局 runtime 弹窗`
    );
    assert.deepEqual(errors, [], `${viewport.name} 出现导航或 pageerror：${errors.join('; ')}`);
    assert.deepEqual(unexpectedBusinessRequests, [], `${viewport.name} 会话未确认时发出业务请求`);
  } finally {
    await context.close();
  }
}

async function warmAdminRuntime(browserInstance) {
  const context = await browserInstance.newContext({ viewport: viewports[0] });
  const page = await context.newPage();
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (!pathname.startsWith('/api/')) {
      await route.continue();
      return;
    }
    if (pathname.endsWith('/api/health/ready')) {
      await fulfillSuccess(route, { status: 'ready', database: 'ok' });
      return;
    }
    if (request.method() === 'GET' && pathname.endsWith('/api/auth/me')) {
      await fulfillSuccess(route, user);
      return;
    }
    if (
      request.method() === 'GET' &&
      pathname.endsWith('/api/id-business-v2/customers/bootstrap')
    ) {
      await fulfillSuccess(route, createCustomersBootstrap());
      return;
    }
    if (request.method() === 'GET' && pathname.endsWith('/api/id-business-v2/customers')) {
      await fulfillSuccess(route, createCustomersBootstrap().list);
      return;
    }
    if (request.method() === 'GET' && pathname.endsWith('/api/id-business-v2/change-versions')) {
      await fulfillSuccess(route, { generatedAt: new Date().toISOString(), versions: {} });
      return;
    }
    await fulfillSuccess(route, user);
  });
  try {
    let loginReady = false;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.goto(new URL('/login', adminUrl).href, { waitUntil: 'domcontentloaded' });
      loginReady = await page
        .locator('#v2-admin-login-form')
        .waitFor({ state: 'visible', timeout: 5_000 })
        .then(() => true)
        .catch(() => false);
      if (loginReady) break;
    }
    if (!loginReady) throw new Error('管理端登录运行时预热失败');

    await seedCredential(page);
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await page.goto(new URL('/v2/customers', adminUrl).href, {
        waitUntil: 'domcontentloaded'
      });
      const protectedRouteReady = await page
        .locator('[data-table-schema="customers.main"]')
        .waitFor({ state: 'visible', timeout: 10_000 })
        .then(() => true)
        .catch(() => false);
      if (protectedRouteReady) return;
    }
    throw new Error('管理端受保护路由运行时预热失败');
  } finally {
    await context.close();
  }
}

async function verifyVerifiedSessionDegradation(browserInstance) {
  const context = await browserInstance.newContext({ viewport: viewports[0] });
  const page = await context.newPage();
  const errors = collectBoundaryErrors(page);
  let authAvailable = true;
  let customerReadCount = 0;
  let observedBusinessPosts = 0;
  await seedCredential(page);
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const pathname = new URL(request.url()).pathname;
    if (!pathname.startsWith('/api/')) {
      await route.continue();
      return;
    }
    if (request.method() === 'GET' && pathname.endsWith('/api/auth/me')) {
      if (authAvailable) await fulfillSuccess(route, user);
      else await fulfillAuthUnavailable(route);
      return;
    }
    if (
      request.method() === 'GET' &&
      pathname.endsWith('/api/id-business-v2/customers/bootstrap')
    ) {
      customerReadCount += 1;
      await fulfillSuccess(route, createCustomersBootstrap());
      return;
    }
    if (request.method() === 'GET' && pathname.endsWith('/api/id-business-v2/customers')) {
      customerReadCount += 1;
      await fulfillSuccess(route, createCustomersBootstrap().list);
      return;
    }
    if (request.method() === 'GET' && pathname.endsWith('/api/id-business-v2/change-versions')) {
      await fulfillSuccess(route, { generatedAt: new Date().toISOString(), versions: {} });
      return;
    }
    if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method())) observedBusinessPosts += 1;
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({
        success: false,
        errorCode: 'UNEXPECTED_ACCEPTANCE_REQUEST',
        message: 'Unexpected acceptance request',
        retryable: false,
        timestamp: new Date().toISOString()
      })
    });
  });

  try {
    await page.goto(new URL('/v2/customers', adminUrl).href, { waitUntil: 'domcontentloaded' });
    await page.locator('[data-table-schema="customers.main"]').waitFor({
      state: 'visible',
      timeout: 15_000
    });
    await page.getByText('会话可靠性客户', { exact: true }).first().waitFor({
      state: 'visible'
    });
    const tableInstance = await page
      .locator('[data-table-schema="customers.main"]')
      .evaluate((node) => {
        const token = `session-${Date.now()}`;
        node.setAttribute('data-session-acceptance-instance', token);
        return token;
      });

    authAvailable = false;
    const degradedResolution = await page.evaluate(async () => {
      const { sessionCoordinator } = await import('/src/auth/sessionCoordinator.ts');
      return sessionCoordinator.refreshCurrentUser('background');
    });
    assert.equal(degradedResolution, 'degraded', '已验证 503 没有进入 verified degraded');
    await page.locator('.v2-session-degraded').waitFor({ state: 'visible' });

    assert.equal(await page.locator('.v2-shell').count(), 1, '已验证 503 卸载了业务外壳');
    assert.equal(
      await page
        .locator('[data-table-schema="customers.main"]')
        .getAttribute('data-session-acceptance-instance'),
      tableInstance,
      '已验证 503 重建了最后成功内容'
    );
    assert.equal(
      await page.locator('.app-route-error').count(),
      0,
      '已验证 503 误显示 runtime 弹窗'
    );

    const writeResult = await page.evaluate(async () => {
      const { http } = await import('/src/api/client.ts');
      try {
        await http.post('/id-business-v2/session-acceptance-write', { unsafe: true });
        return { accepted: true, code: '' };
      } catch (error) {
        return {
          accepted: false,
          code: error && typeof error === 'object' && 'code' in error ? String(error.code) : ''
        };
      }
    });
    assert.deepEqual(writeResult, { accepted: false, code: 'SESSION_WRITE_BLOCKED' });
    assert.equal(observedBusinessPosts, 0, '中央写门禁后仍发出 POST');

    await page.evaluate(async () => {
      const { v2Router } = await import('/src/v2-router.ts');
      await v2Router.push('/v2/orders');
    });
    assert.equal(locationPath(page.url()), '/v2/customers', 'degraded 新受保护导航没有留在 from');

    const readsBeforeRecovery = customerReadCount;
    authAvailable = true;
    const recoveryResolution = await page.evaluate(async () => {
      const { sessionCoordinator } = await import('/src/auth/sessionCoordinator.ts');
      return sessionCoordinator.ensureSession({ force: true, source: 'manual-retry' });
    });
    assert.equal(recoveryResolution, 'ready', '认证恢复后未回到 ready');
    await page.locator('.v2-session-degraded').waitFor({ state: 'detached' });
    await waitFor(() => customerReadCount > readsBeforeRecovery, 5_000);

    assert.deepEqual(errors, [], `已验证降级链路出现导航或 pageerror：${errors.join('; ')}`);
  } finally {
    await context.close();
  }
}

async function seedCredential(page) {
  await page.addInitScript((currentUser) => {
    localStorage.setItem('apple_business_access_token', 'session-reliability-token');
    localStorage.setItem('apple_business_current_user', JSON.stringify(currentUser));
  }, user);
}

async function fulfillSuccess(route, data) {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    headers: { 'X-Request-Id': 'session-acceptance-success' },
    body: JSON.stringify({
      success: true,
      data,
      message: 'OK',
      requestId: 'session-acceptance-success',
      timestamp: new Date().toISOString()
    })
  });
}

async function fulfillAuthUnavailable(route) {
  await route.fulfill({
    status: 503,
    contentType: 'application/json',
    headers: { 'Retry-After': '0', 'X-Request-Id': 'session-acceptance-503' },
    body: JSON.stringify({
      success: false,
      errorCode: 'AUTH_DEPENDENCY_UNAVAILABLE',
      message: '登录服务暂时不可用，请稍后重试。',
      requestId: 'session-acceptance-503',
      retryable: true,
      retryAfterMs: 0,
      timestamp: new Date().toISOString()
    })
  });
}

function createCustomersBootstrap() {
  const now = new Date().toISOString();
  return {
    list: {
      items: [
        {
          id: 'customer-session-reliability',
          name: '会话可靠性客户',
          maskedPhone: '138****5678',
          displayPhone: '138****5678',
          phoneTail: '5678',
          hasPhone: true,
          wechat: null,
          hasWechat: false,
          qq: null,
          hasQq: false,
          maskedWhatsapp: null,
          displayWhatsapp: null,
          whatsappTail: null,
          hasWhatsapp: false,
          contactDisplayModes: {
            phone: 'masked',
            wechat: 'hidden',
            qq: 'hidden',
            whatsapp: 'hidden'
          },
          sourceOptionId: null,
          source: null,
          tagOptionIds: [],
          tags: [],
          serviceOptionIds: [],
          services: [],
          recordStatus: 'active',
          remark: null,
          createdAt: now,
          updatedAt: now
        }
      ],
      total: 1,
      page: 1,
      pageSize: 20
    },
    options: { sources: [], tags: [], services: [] },
    generatedAt: now
  };
}

function collectBoundaryErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror:${error.message}`));
  page.on('console', (message) => {
    if (
      message.type() === 'error' &&
      /Navigation aborted|Uncaught \(in promise\)|Unhandled Promise/i.test(message.text())
    ) {
      errors.push(`console:${message.text()}`);
    }
  });
  return errors;
}

function locationPath(url) {
  return new URL(url).pathname;
}

function startAdminServer() {
  const output = [];
  const child = spawn(
    process.execPath,
    [viteCliPath, '--host', adminUrl.hostname, '--port', adminUrl.port, '--strictPort'],
    {
      cwd: adminDir,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        VITE_API_BASE_URL: '/api',
        VITE_SUPABASE_URL: '',
        VITE_SUPABASE_ANON_KEY: '',
        VITE_SUPABASE_PUBLISHABLE_KEY: '',
        VITE_V2_REALTIME_CHANGES_ENABLED: 'false'
      },
      stdio: ['ignore', 'pipe', 'pipe']
    }
  );
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      output.push(String(chunk));
      if (output.length > 80) output.shift();
    });
  }
  child.recentOutput = output;
  return child;
}

async function waitForServer() {
  const deadline = Date.now() + 30_000;
  const loginUrl = new URL('/login', adminUrl);
  while (Date.now() < deadline) {
    if (adminServer?.exitCode != null) {
      throw new Error(`管理端测试服务提前退出：${adminServer.recentOutput.join('')}`);
    }
    const response = await fetch(loginUrl, { signal: AbortSignal.timeout(1_000) }).catch(
      () => null
    );
    if (response?.ok) return;
    await delay(200);
  }
  throw new Error(`管理端测试服务未就绪：${loginUrl}`);
}

async function stopAdminServer(child) {
  if (!child || child.exitCode != null) return;
  child.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => child.once('close', resolve)),
    delay(3_000).then(() => {
      if (child.exitCode == null) child.kill('SIGKILL');
    })
  ]);
}

async function runNpmCommand(args, label) {
  const output = [];
  const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd: rootDir,
    env: process.env,
    stdio: ['ignore', 'pipe', 'pipe']
  });
  for (const stream of [child.stdout, child.stderr]) {
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => output.push(String(chunk)));
  }
  const exitCode = await new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('close', resolve);
  });
  if (exitCode !== 0) throw new Error(`${label}失败：${output.join('')}`);
}

async function waitFor(predicate, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(50);
  }
  throw new Error('等待会话恢复刷新超时');
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

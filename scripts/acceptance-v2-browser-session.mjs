#!/usr/bin/env node
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { chromium } from 'playwright';
import { createServer } from 'vite';

// Isolated users and in-memory session registry. No database, production URL or real credentials.
const require = createRequire(import.meta.url);
require('reflect-metadata');
const { Test } = require('@nestjs/testing');
const { Reflector } = require('@nestjs/core');
const { JwtService } = require('@nestjs/jwt');
const { AuthService } = require('../apps/api/dist/auth/auth.service.js');
const { JwtAuthGuard } = require('../apps/api/dist/auth/jwt-auth.guard.js');
const { AuthAvailabilityMonitor } = require('../apps/api/dist/auth/auth-availability.monitor.js');
const { V2AuthController } = require('../apps/api/dist/v2-auth/v2-auth.controller.js');
const {
  ApiResponseInterceptor
} = require('../apps/api/dist/common/interceptors/api-response.interceptor.js');
const { HttpExceptionFilter } = require('../apps/api/dist/common/filters/http-exception.filter.js');
const user = {
  id: 'browser-session-test-user',
  username: 'browser-session-test',
  displayName: '会话测试用户',
  roles: ['staff'],
  permissions: ['customer.view'],
  mustResetPassword: false
};
const jwt = new JwtService({ secret: randomBytes(32).toString('hex') });
const activeTokens = new Set();
let loginCount = 0;
let restoreCount = 0;
const authService = {
  async login(dto) {
    assert.equal(dto.username, user.username);
    assert.equal(dto.password, 'browser-session-fixture-password');
    loginCount += 1;
    const accessToken = jwt.sign(
      { sub: user.id, username: user.username, jti: randomUUID() },
      { expiresIn: '1h' }
    );
    activeTokens.add(accessToken);
    return { accessToken, user };
  },
  async logout(token) {
    activeTokens.delete(token);
    return { loggedOut: true };
  }
};
const moduleRef = await Test.createTestingModule({
  controllers: [V2AuthController],
  providers: [{ provide: AuthService, useValue: authService }]
}).compile();
const api = moduleRef.createNestApplication({ logger: false });
api.setGlobalPrefix('api');
api.use((request, _response, next) => {
  if (request.originalUrl === '/api/auth/session') restoreCount += 1;
  next();
});
api.useGlobalGuards(
  new JwtAuthGuard(
    new Reflector(),
    jwt,
    { getAuthenticatedUser: async () => user },
    {
      isAccessTokenActive: async (token) => activeTokens.has(token),
      isRequestIpAllowed: async () => true,
      isMfaRequiredForUser: async () => false
    },
    new AuthAvailabilityMonitor()
  )
);
api.useGlobalInterceptors(new ApiResponseInterceptor());
api.useGlobalFilters(new HttpExceptionFilter());
let vite;
let browser;
const results = [];
const errors = [];
try {
  await api.listen(0, '127.0.0.1');
  const apiAddress = await api.getUrl();
  Object.assign(process.env, {
    NODE_ENV: 'development',
    VITE_API_BASE_URL: '/api',
    VITE_DEV_API_PROXY_TARGET: apiAddress,
    VITE_V2_REALTIME_CHANGES_ENABLED: 'false'
  });
  vite = await createServer({
    root: resolve('apps/admin'),
    configFile: resolve('apps/admin/vite.config.ts'),
    server: { host: '127.0.0.1', port: 5397, strictPort: true },
    logLevel: 'error'
  });
  await vite.listen();
  const url = 'http://127.0.0.1:5397';
  browser = await chromium.launch({ headless: true });
  for (const broadcastEnabled of [true, false]) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    if (!broadcastEnabled)
      await context.addInitScript(() => {
        globalThis.BroadcastChannel = undefined;
      });
    await installBusinessFixtures(context);
    const original = await context.newPage();
    const loginsBefore = loginCount;
    await original.goto(`${url}/v2/customers`);
    await original.locator('input[name="username"]').fill(user.username);
    await original.locator('input[name="password"]').fill('browser-session-fixture-password');
    await original.getByRole('button', { name: '进入运营后台' }).click();
    await waitForCustomers(original);
    const cookies = await context.cookies();
    const cookie = cookies.find((item) => item.name === 'id_business_browser_session');
    assert.ok(
      cookie?.httpOnly && cookie.sameSite === 'Strict' && cookie.path === '/api/auth/session'
    );
    assert.equal(cookie.expires, -1);
    const restoredBefore = restoreCount;
    const second = await context.newPage();
    await second.goto(original.url());
    await waitForCustomers(second);
    assert.equal(loginCount, loginsBefore + 1, 'new tab performed an additional password login');
    assert.equal(
      restoreCount,
      restoredBefore + 1,
      'new tab did not perform a single server restore'
    );
    await original.reload();
    await waitForCustomers(original);
    assert.equal(await second.evaluate(() => localStorage.getItem('apple_business_auth_v2')), null);
    assert.equal(
      await second.evaluate(() =>
        globalThis.document.cookie.includes('id_business_browser_session')
      ),
      false
    );
    const credentialHeaders = await second.evaluate(async () => {
      const response = await fetch('/api/auth/session');
      return { status: response.status, cacheControl: response.headers.get('cache-control') };
    });
    assert.deepEqual(credentialHeaders, { status: 200, cacheControl: 'no-store' });
    const denied = await second.evaluate(async () => (await fetch('/api/auth/me')).status);
    assert.equal(denied, 401, 'cookie authorized a normal endpoint');

    const unrelated = await browser.newContext();
    await installBusinessFixtures(unrelated);
    const unrelatedPage = await unrelated.newPage();
    await unrelatedPage.goto(`${url}/v2/customers`);
    await unrelatedPage.locator('#v2-admin-login-form').waitFor();
    await unrelated.close();

    await second.evaluate(async () => {
      const { sessionCoordinator } = await import('/src/auth/sessionCoordinator.ts');
      await sessionCoordinator.logout();
    });
    await original.locator('#v2-admin-login-form').waitFor();
    await second.locator('#v2-admin-login-form').waitFor();
    await original.reload();
    await original.locator('#v2-admin-login-form').waitFor();
    assert.equal(
      (await context.cookies()).some((item) => item.name === 'id_business_browser_session'),
      false
    );
    const third = await context.newPage();
    await third.goto(`${url}/v2/customers`);
    await third.locator('#v2-admin-login-form').waitFor();

    // A subsequent login also recovers already-open tabs through the shared generation marker.
    await second.locator('input[name="username"]').fill(user.username);
    await second.locator('input[name="password"]').fill('browser-session-fixture-password');
    await second.getByRole('button', { name: '进入运营后台' }).click();
    await waitForCustomers(original);
    await waitForCustomers(second);
    await waitForCustomers(third);
    activeTokens.clear();
    const revoked = await context.newPage();
    await revoked.goto(`${url}/v2/customers`);
    await revoked.locator('#v2-admin-login-form').waitFor();
    await second.evaluate(async () => {
      const { sessionCoordinator } = await import('/src/auth/sessionCoordinator.ts');
      await sessionCoordinator.refreshCurrentUser('background');
    });
    await original.locator('#v2-admin-login-form').waitFor();
    await third.locator('#v2-admin-login-form').waitFor();
    results.push({
      broadcastEnabled,
      loginOnce: true,
      newTabRestored: true,
      reloadPreserved: true,
      separateBrowserIsolated: true,
      logoutSynced: true,
      reloginSynced: true,
      revocationRejected: true
    });
    await context.close();
  }
  assert.deepEqual(errors, [], 'browser runtime errors');
  console.log(
    JSON.stringify({
      ok: true,
      backend: 'compiled-controller-and-real-jwt-guard',
      businessData: 'isolated-fixtures',
      results
    })
  );
} catch (error) {
  const pages = [];
  for (const context of browser?.contexts() ?? []) {
    for (const page of context.pages()) {
      pages.push({
        path: new URL(page.url()).pathname,
        text: (
          await page
            .locator('body')
            .innerText()
            .catch(() => '')
        ).slice(0, 700)
      });
    }
  }
  console.error(JSON.stringify({ errors, pages, loginCount, restoreCount }));
  throw error;
} finally {
  await browser?.close();
  await vite?.close();
  await api.close();
}

async function waitForCustomers(page) {
  await page.locator('[data-table-schema="customers.main"]').waitFor({ timeout: 30_000 });
  assert.equal(new URL(page.url()).pathname, '/v2/customers');
}

async function installBusinessFixtures(context) {
  context.on('page', (page) => page.on('pageerror', (error) => errors.push(error.message)));
  await context.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (!pathname.startsWith('/api/')) return route.continue();
    if (pathname.startsWith('/api/auth/')) return route.continue();
    let data = {};
    if (pathname === '/api/id-business-v2/customers/bootstrap') {
      data = {
        list: { items: [], total: 0, page: 1, pageSize: 20 },
        options: { sources: [], tags: [], services: [] },
        generatedAt: new Date().toISOString()
      };
    } else if (pathname === '/api/id-business-v2/customers') {
      data = { items: [], total: 0, page: 1, pageSize: 20 };
    } else if (pathname === '/api/id-business-v2/change-versions') {
      data = { generatedAt: new Date().toISOString(), versions: {} };
    } else if (pathname.startsWith('/api/health/')) {
      data = { status: 'ready', database: 'ok' };
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data, message: 'ok' })
    });
  });
}

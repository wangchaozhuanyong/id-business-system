import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const projectDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  assert.ok(['--dist', '--output'].includes(process.argv[index]), 'Unknown acceptance option');
  assert.ok(
    process.argv[index + 1] && !options.has(process.argv[index]),
    'Missing or duplicate acceptance option'
  );
  options.set(process.argv[index], process.argv[index + 1]);
}
const outputDirectory = path.resolve(
  options.get('--output') ?? path.join(projectDirectory, '.runtime/feature-retirement-acceptance')
);
const distDirectory = path.resolve(
  options.get('--dist') ?? path.join(projectDirectory, 'apps/admin/dist')
);
for (const directory of [outputDirectory, distDirectory]) {
  assert.ok(
    directory.startsWith(`${projectDirectory}${path.sep}`),
    'Acceptance inputs and outputs must belong to this project'
  );
}
const screenshotDirectory = path.join(outputDirectory, 'frontend-ui');
const origin = 'https://id-removal-acceptance.example.invalid';
const now = '2026-10-17T09:00:00.000Z';
const user = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'removal-acceptance',
  displayName: '移除验收管理员',
  mustResetPassword: false,
  roles: ['admin'],
  permissions: []
};
const account = {
  id: '22222222-2222-4222-8222-222222222222',
  registered: true,
  saleStatus: 'unsold',
  soldAt: null,
  email: '历史账号验收@example.invalid',
  emailMasked: '历史账号验收@example.invalid',
  registrationCountryCode: 'PH',
  registrationIp: '192.0.2.8',
  registeredAt: now,
  registrationSource: 'automatic',
  needsSupplement: true,
  status: 'active',
  subscriptionState: 'never_subscribed',
  dueAt: null,
  currentPlan: null,
  hasPassword: false,
  hasTotp: false,
  remark: '合成历史资料，仅用于离线验收',
  offerStatus: 'unknown',
  firstLoginNetwork: null,
  lastLoginNetwork: null,
  createdAt: now,
  updatedAt: now
};
const warnings = {
  warningDays: 3,
  upcomingCount: 0,
  expiredCount: 0,
  totalCount: 0,
  items: [],
  evaluatedAt: now,
  revalidateAt: '2099-01-01T00:00:00.000Z'
};
const dashboard = {
  generatedAt: now,
  businessDate: '2026-10-17',
  timezone: 'Asia/Shanghai',
  warningDays: 3,
  access: Object.fromEntries(
    [
      'orders',
      'activations',
      'renewals',
      'accounts',
      'balances',
      'exchangeRates',
      'finance',
      'audit'
    ].map((key) => [key, true])
  ),
  business: {
    todayOrders: 0,
    todayCompletedOrders: 0,
    todayActivations: 0,
    todayTopups: 0,
    todayTopupCostCny: '0',
    todayRevenueCny: '0',
    todayProfitCny: '0'
  },
  risks: {
    pendingOrders: 0,
    failedOrders: 0,
    overdueRenewals: 0,
    dueSoonRenewals: 0,
    lowBalanceAccounts: 0,
    failedExchangeRuns: 0
  },
  assets: {
    totalAccounts: 1,
    availableAccounts: 1,
    inventoryBookValueCny: '0',
    financeHistoryStatus: 'not_started'
  },
  recentOrders: [],
  upcomingRenewals: [],
  recentAudits: []
};
const fixtures = new Map([
  ['/api/auth/me', user],
  ['/api/auth/session', { accessToken: 'synthetic-offline-token', user }],
  [
    '/api/id-business-v2/branding/public',
    {
      appName: 'ID 业务管理',
      logoText: 'ID',
      logoUrl: '/brand/default-logo.svg',
      appSubtitle: '业务管理',
      documentTitleSuffix: 'ID 业务管理'
    }
  ],
  ['/api/id-business-v2/time', { now, timezone: 'Asia/Shanghai' }],
  ['/api/id-business-v2/change-versions', { generatedAt: now, versions: {} }],
  ['/api/id-business-v2/table-preferences', { items: [] }],
  ['/api/id-business-v2/workspace-shortcuts', { items: [] }],
  [
    '/api/id-business-v2/sensitive-access/approvals/summary',
    { pendingCount: 0, items: [], generatedAt: now }
  ],
  ['/api/id-business-v2/renewals/warning-summary', warnings],
  ['/api/id-business-v2/bank-recharge/renewal-warnings', warnings],
  [
    '/api/id-business-v2/bank-recharge/accounts',
    { items: [account], total: 1, page: 1, pageSize: 20 }
  ],
  ['/api/id-business-v2/dashboard/overview', dashboard]
]);
const contentTypes = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.json': 'application/json'
};

await mkdir(screenshotDirectory, { recursive: true });
const index = await readFile(path.join(distDirectory, 'index.html'));
const allRequests = [];
const unexpectedRequests = [];
const pageErrors = [];
const results = [];
const browser = await chromium.launch({ headless: true });
try {
  for (const theme of ['light', 'dark']) {
    for (const viewport of [
      { width: 1440, height: 1000 },
      { width: 390, height: 844 }
    ]) {
      const name = `${theme}-${viewport.width}`;
      const context = await browser.newContext({
        viewport,
        serviceWorkers: 'block',
        reducedMotion: 'reduce'
      });
      await context.addInitScript(
        ({ theme, user }) => {
          localStorage.setItem('id-business-v2-theme', theme);
          sessionStorage.setItem(
            'apple_business_auth_v2',
            JSON.stringify({
              credentialId: 'offline-acceptance',
              schemaVersion: 2,
              token: 'synthetic-offline-token',
              tokenRevision: 1,
              updatedAt: Date.now(),
              userCache: user
            })
          );
        },
        { theme, user }
      );
      const page = await context.newPage();
      page.on('pageerror', (error) => pageErrors.push({ scenario: name, message: error.message }));
      await page.route('**/*', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        allRequests.push({
          scenario: name,
          method: request.method(),
          pathname: url.pathname,
          type: request.resourceType()
        });
        if (url.origin !== origin || request.method() !== 'GET') {
          unexpectedRequests.push({
            scenario: name,
            method: request.method(),
            origin: url.origin,
            pathname: url.pathname
          });
          await route.abort('blockedbyclient');
          return;
        }
        if (url.pathname.startsWith('/api/')) {
          if (url.pathname === '/api/realtime/events') {
            await route.fulfill({
              contentType: 'text/event-stream',
              body: `event: heartbeat\ndata: ${JSON.stringify({ timestamp: now })}\n\n`
            });
            return;
          }
          if (!fixtures.has(url.pathname)) {
            unexpectedRequests.push({
              scenario: name,
              method: request.method(),
              pathname: url.pathname
            });
            await route.fulfill({
              status: 500,
              contentType: 'application/json',
              body: JSON.stringify({ success: false, message: '未定义的离线验收读取' })
            });
            return;
          }
          await route.fulfill({
            contentType: 'application/json',
            body: JSON.stringify({
              success: true,
              data: fixtures.get(url.pathname),
              message: 'OK',
              requestId: 'offline-removal-acceptance',
              timestamp: now
            })
          });
          return;
        }
        if (request.resourceType() === 'document') {
          await route.fulfill({ contentType: 'text/html; charset=utf-8', body: index });
          return;
        }
        const filename = path.resolve(distDirectory, `.${decodeURIComponent(url.pathname)}`);
        if (!filename.startsWith(`${distDirectory}${path.sep}`))
          throw new Error('Invalid static path');
        try {
          await route.fulfill({
            contentType: contentTypes[path.extname(filename)] ?? 'application/octet-stream',
            body: await readFile(filename)
          });
        } catch {
          unexpectedRequests.push({ scenario: name, staticPath: url.pathname });
          await route.fulfill({ status: 404, body: 'Missing offline fixture' });
        }
      });

      await page.goto(`${origin}/v2/account-settings/chatgpt-accounts`, {
        waitUntil: 'networkidle'
      });
      await page.locator('.v2-shell').waitFor();
      await page.getByText(account.emailMasked, { exact: true }).first().waitFor();
      await page
        .locator('.bank-recharge-page')
        .getByText('自动注册', { exact: true })
        .waitFor({ state: 'attached' });
      assert.equal(await page.locator('html').getAttribute('data-v2-theme'), theme);
      const nav = page.locator('.v2-navigation');
      assert.equal(await nav.locator('a[href^="/v2/auto-registration"]').count(), 0);
      assert.equal(await nav.getByText('自动注册', { exact: true }).count(), 0);
      for (const [href, title] of [
        ['/v2/account-settings/chatgpt-accounts', 'ChatGPT 账号'],
        ['/v2/account-settings/mailbox', '邮件验证码查询'],
        ['/v2/auto-recharge', '自动充值']
      ]) {
        const link = nav.locator(`a[href="${href}"]`);
        assert.equal(await link.count(), 1, `${name}: missing ${title}`);
        assert.equal((await link.textContent()).trim(), title);
      }
      const search = page.getByRole('searchbox', { name: '搜索页面和业务模块' });
      const globalSearchVisible = await search.isVisible();
      if (globalSearchVisible) {
        await search.fill('自动注册');
        await page.getByText('没有匹配的业务页面', { exact: true }).waitFor();
        await search.fill('');
        await search.press('Escape');
      }
      if (viewport.width < 900) await page.getByTitle('打开导航', { exact: true }).click();
      await page.screenshot({
        path: path.join(screenshotDirectory, `${name}-accounts-navigation.png`),
        fullPage: true
      });
      const overflow = await page.evaluate(() => ({
        scrollWidth: globalThis.document.documentElement.scrollWidth,
        viewportWidth: globalThis.innerWidth
      }));
      assert.ok(
        overflow.scrollWidth <= overflow.viewportWidth + 1,
        `${name}: document horizontal overflow`
      );

      await page.goto(`${origin}/v2/auto-registration`, { waitUntil: 'networkidle' });
      await page.waitForURL(`${origin}/v2/dashboard`);
      await page.locator('.v2-shell').waitFor();
      assert.equal(
        await page.locator('.v2-navigation a[href^="/v2/auto-registration"]').count(),
        0
      );
      await page.screenshot({
        path: path.join(screenshotDirectory, `${name}-retired-url-fallback.png`),
        fullPage: true
      });
      results.push({
        scenario: name,
        theme,
        viewport,
        accountAndHistoricalSourceRendered: true,
        retainedLinks: ['ChatGPT 账号', '邮件验证码查询', '自动充值'],
        retiredNavigationAbsent: true,
        retiredGlobalSearchAbsent: globalSearchVisible
          ? true
          : 'search hidden by existing responsive layout',
        retiredUrlFallback: new URL(page.url()).pathname,
        documentOverflow: overflow
      });
      await context.close();
    }
  }
  assert.deepEqual(
    unexpectedRequests,
    [],
    'All requests must be intercepted by defined offline fixtures'
  );
  assert.deepEqual(pageErrors, [], 'No browser page errors expected');
  const registrationApiRequests = allRequests.filter(
    (request) =>
      request.pathname.startsWith('/api/') && request.pathname.includes('auto-registration')
  );
  assert.deepEqual(
    registrationApiRequests,
    [],
    'Retired feature must not issue registration API requests'
  );
  const report = {
    status: 'passed',
    mode: 'Playwright route.fulfill against local production build; no HTTP server and no network passthrough',
    buildId: index.toString().match(/name="v2-build-id" content="([^"]+)"/)?.[1],
    indexSha256: createHash('sha256').update(index).digest('hex'),
    scenarios: results,
    requestCount: allRequests.length,
    apiPaths: [
      ...new Set(
        allRequests
          .filter((request) => request.pathname.startsWith('/api/'))
          .map((request) => request.pathname)
      )
    ],
    registrationApiRequests,
    unexpectedRequests,
    pageErrors,
    limitations: [
      'Synthetic administrator and read-only API fixtures; no live account/database checks',
      'Preserved mailbox/recharge navigation verified; their unrelated business workflows were not executed'
    ]
  };
  await writeFile(
    path.join(outputDirectory, 'frontend-static-acceptance.json'),
    `${JSON.stringify(report, null, 2)}\n`
  );
  await writeFile(
    path.join(outputDirectory, 'frontend-static-acceptance.md'),
    `# 自动注册移除：静态构建页面验收\n\n结果：通过。构建编号：\`${report.buildId}\`。\n\n- 以本地正式构建产物完成 4 种组合：浅色／深色 × 1440px／390px。\n- 自动注册导航和全局搜索入口均不存在；ChatGPT 账号、邮件验证码查询、自动充值链接保留。\n- 合成历史账号及历史自动注册来源可正常展示。\n- 旧地址 \`/v2/auto-registration\` 均回退到 \`/v2/dashboard\`。\n- 注册 API 请求 0 次、未定义／外部请求 0 次、页面异常 0 次。\n- 所有资源由 Playwright 直接读取本地 dist 后 fulfill，未启动 HTTP 服务，未访问外部或生产接口；仅使用合成身份和读取回执。\n\n截图：\`frontend-ui/\`（8 张）。本次验证导航和页面兼容，不执行保留模块的充值、支付、邮箱读取或真实资料操作。\n`
  );
  console.log(JSON.stringify(report, null, 2));
} catch (error) {
  await writeFile(
    path.join(outputDirectory, 'frontend-static-acceptance-failure.json'),
    JSON.stringify(
      {
        error: error.message,
        unexpectedRequests,
        pageErrors,
        apiPaths: [
          ...new Set(
            allRequests
              .filter((request) => request.pathname.startsWith('/api/'))
              .map((request) => request.pathname)
          )
        ]
      },
      null,
      2
    )
  );
  throw error;
} finally {
  await browser.close();
}

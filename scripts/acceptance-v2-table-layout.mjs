#!/usr/bin/env node
/* global document, getComputedStyle, location, requestAnimationFrame, window */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const rootDir = process.cwd();
const adminDir = path.join(rootDir, 'apps', 'admin');
const viteCliPath = path.join(rootDir, 'node_modules', 'vite', 'bin', 'vite.js');
const configuredAdminUrl = process.env.V2_TABLE_LAYOUT_ADMIN_URL;
const adminUrl = new URL(configuredAdminUrl ?? 'http://127.0.0.1:5384');
const screenshotDirectory = process.env.V2_TABLE_LAYOUT_SCREENSHOT_DIR
  ? path.resolve(process.env.V2_TABLE_LAYOUT_SCREENSHOT_DIR)
  : null;
const viewportWidths = [2141, 1920, 1600, 1440, 1024, 901, 900, 768, 390];
const stabilityCheckpoints = [50, 100, 260, 500];
const mobileBreakpoint = 900;
const routeScrollRestoreTolerancePx = 8;
const registeredSchemaIds = loadRegisteredSchemaIds();
const permissionScenarios = [
  {
    key: 'all',
    permissions: [
      'customer.view',
      'customer.create',
      'customer.update',
      'customer.delete',
      'customer.view_phone'
    ],
    desktopActionCount: 3
  },
  {
    key: 'update-only',
    permissions: ['customer.view', 'customer.update'],
    desktopActionCount: 2
  },
  {
    key: 'delete-only',
    permissions: ['customer.view', 'customer.delete'],
    desktopActionCount: 1
  },
  {
    key: 'view-only',
    permissions: ['customer.view'],
    desktopActionCount: 0
  }
];
const dataScopes = [
  'account-losses',
  'accounts',
  'accounts-options',
  'activations',
  'balances',
  'balances-options',
  'balance-records',
  'balance-record-options',
  'branding',
  'customers',
  'customers-options',
  'exchange-rates',
  'options',
  'options-page',
  'options-reference',
  'orders',
  'orders-options',
  'order-entry-manual-candidates',
  'order-entry-matching',
  'order-entry-options',
  'renewals',
  'renewals-options',
  'renewal-warning-settings',
  'renewal-warning-summary'
];

assert.ok(
  ['localhost', '127.0.0.1', '::1'].includes(adminUrl.hostname),
  '操作列布局验收只允许连接本机管理端'
);

if (screenshotDirectory) mkdirSync(screenshotDirectory, { recursive: true });

let adminServer = null;
let browser = null;

try {
  if (!configuredAdminUrl) {
    await buildSharedPackage();
    adminServer = startAdminServer(adminUrl);
  }
  await waitForServer(adminUrl, adminServer);

  browser = await chromium.launch({ headless: true });
  await warmLayoutFixture(browser);
  await warmCustomerPage(browser);
  await verifyLayoutFixture(browser);
  await verifyPublicPageScroll(browser);
  for (const scenario of permissionScenarios) {
    await verifyCustomerPage(browser, scenario);
  }

  console.log(
    JSON.stringify({
      ok: true,
      actionLayouts: ['icon', 'single', 'double', 'triple', 'wide'],
      permissionScenarios: permissionScenarios.map(({ key }) => key),
      viewportWidths,
      stabilityCheckpoints: ['2rAF', ...stabilityCheckpoints.map((value) => `${value}ms`)],
      registeredSchemas: registeredSchemaIds.length
    })
  );
} finally {
  await browser?.close().catch(() => undefined);
  await stopAdminServer(adminServer);
}

async function buildSharedPackage() {
  await runNpmCommand(
    ['run', 'build', '--workspace', '@apple-business/shared'],
    '共享包构建',
    process.env
  );
}

async function runNpmCommand(args, label, env) {
  const output = [];
  const child = spawn(process.platform === 'win32' ? 'npm.cmd' : 'npm', args, {
    cwd: rootDir,
    env,
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
  if (exitCode !== 0) {
    throw new Error(`${label}失败（${exitCode}）：\n${output.join('')}`);
  }
}

function startAdminServer(url) {
  const output = [];
  const child = spawn(
    process.execPath,
    [viteCliPath, '--host', url.hostname, '--port', url.port, '--strictPort'],
    {
      cwd: adminDir,
      env: {
        ...process.env,
        NODE_ENV: 'development',
        VITE_API_BASE_URL: '/api',
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

async function waitForServer(url, child) {
  const deadline = Date.now() + 30_000;
  const loginUrl = new URL('/login', url);
  while (Date.now() < deadline) {
    if (child?.exitCode != null) {
      throw new Error(
        `管理端测试服务器提前退出（${child.exitCode}）：\n${child.recentOutput.join('')}`
      );
    }
    const response = await fetch(loginUrl, {
      signal: AbortSignal.timeout(1_000)
    }).catch(() => null);
    if (response?.ok) return;
    await delay(200);
  }
  throw new Error(`管理端测试服务器未在 30 秒内启动：${loginUrl}`);
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

async function warmLayoutFixture(browserInstance) {
  const context = await browserInstance.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  try {
    await warmPage(page, '/table-layout-fixture.html', '[data-layout-fixture]');
  } finally {
    await context.close();
  }
}

async function warmCustomerPage(browserInstance) {
  const context = await browserInstance.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const user = createUser(permissionScenarios[0]);
  const unexpectedRequests = [];

  await page.addInitScript((currentUser) => {
    localStorage.setItem('apple_business_access_token', 'layout-test-token');
    localStorage.setItem('apple_business_current_user', JSON.stringify(currentUser));
  }, user);
  await installApiMocks(page, user, unexpectedRequests, new Map());

  try {
    await warmPage(page, '/v2/customers', '.v2-records-mobile-item');
  } finally {
    await context.close();
  }
}

async function warmPage(page, pathname, readySelector) {
  const targetUrl = new URL(pathname, adminUrl).href;
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded' });
    const ready = await page
      .locator(readySelector)
      .first()
      .waitFor({ state: 'attached', timeout: 5_000 })
      .then(() => true)
      .catch(() => false);
    if (ready) {
      await settleLayout(page);
      return;
    }
  }
  throw new Error(`布局验收预热失败：${targetUrl}`);
}

async function verifyLayoutFixture(browserInstance) {
  const context = await browserInstance.newContext({ viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage();
  const runtimeErrors = collectRuntimeErrors(page);
  try {
    await page.goto(new URL('/table-layout-fixture.html', adminUrl).href, {
      waitUntil: 'networkidle'
    });
    await page.locator('[data-layout-fixture]').first().waitFor({ state: 'visible' });

    for (const width of viewportWidths) {
      await page.setViewportSize({ width, height: 1000 });
      assertLayoutStable(await sampleLayoutTimeline(page), `布局夹具 ${width}px`);
      const measurements = await measureActionGroups(page, '[data-layout-fixture]');
      assert.equal(measurements.length, 5, `宽度 ${width}px 未渲染全部五种操作列档位`);
      assertActionGroupsFit(measurements, `布局夹具 ${width}px`);
      assertSemanticColumnLayout(await measureSemanticColumnLayout(page), `语义列夹具 ${width}px`);
      assertNarrowContainerLayout(
        await measureSemanticColumnLayout(page, '[data-narrow-container]'),
        `窄容器夹具 ${width}px`
      );
      assertRegisteredSchemaFixtures(await measureRegisteredSchemaFixtures(page), width);
      assert.equal(await getDocumentOverflow(page), 0, `布局夹具 ${width}px 出现页面横向溢出`);
      await verifyPrimaryVerticalScroll(page, `布局夹具 ${width}px`);
    }
    await verifyScrollLifecycle(page);
    assert.deepEqual(runtimeErrors, [], `布局夹具出现浏览器错误：${runtimeErrors.join('\n')}`);
  } finally {
    await context.close();
  }
}

async function verifyPrimaryVerticalScroll(page, label) {
  const content = page.locator('.v2-content');
  const before = await content.evaluate((node) => ({
    clientHeight: node.clientHeight,
    scrollHeight: node.scrollHeight,
    scrollTop: node.scrollTop
  }));
  const maxScrollTop = before.scrollHeight - before.clientHeight;
  assert.ok(maxScrollTop > 100, `${label} 未形成可用的主内容纵向滚动区`);

  const requestedScrollTop = Math.min(320, maxScrollTop);
  const scrolledTop = await content.evaluate((node, top) => {
    node.scrollTop = top;
    return node.scrollTop;
  }, requestedScrollTop);
  assert.ok(scrolledTop > 0, `${label} 主内容滚动位置无法更新`);

  const documentMetrics = await page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    return {
      clientHeight: root.clientHeight,
      scrollHeight: root.scrollHeight,
      scrollTop: root.scrollTop
    };
  });
  assert.ok(
    documentMetrics.scrollHeight - documentMetrics.clientHeight <= 1,
    `${label} 后台外壳与主内容同时产生纵向滚动`
  );
  assert.ok(Math.abs(documentMetrics.scrollTop) <= 1, `${label} 文档滚动位置不为零`);
  await content.evaluate((node) => {
    node.scrollTop = 0;
  });
}

async function verifyPublicPageScroll(browserInstance) {
  const context = await browserInstance.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  const runtimeErrors = collectRuntimeErrors(page);
  await page.addInitScript(() => {
    localStorage.removeItem('apple_business_auth_v2');
    localStorage.removeItem('apple_business_access_token');
    localStorage.removeItem('apple_business_current_user');
  });
  await page.route('**/api/**', async (route) => {
    const pathname = new URL(route.request().url()).pathname;
    if (!pathname.startsWith('/api/')) {
      await route.continue();
      return;
    }
    if (pathname.endsWith('/api/health/ready')) {
      await fulfillSuccess(route, { status: 'ready', database: 'ok' });
      return;
    }
    if (pathname.endsWith('/api/id-business-v2/branding/public')) {
      await fulfillSuccess(route, createDefaultBrandingSettings());
      return;
    }
    if (pathname.endsWith('/api/auth/me')) {
      await route.fulfill({
        status: 401,
        contentType: 'application/json',
        body: JSON.stringify({
          success: false,
          errorCode: 'AUTH_MISSING',
          message: '请先登录后再操作。',
          retryable: false,
          timestamp: new Date().toISOString()
        })
      });
      return;
    }
    await route.fulfill({
      status: 503,
      contentType: 'application/json',
      body: JSON.stringify({
        success: false,
        errorCode: 'PUBLIC_SCROLL_ACCEPTANCE_UNAVAILABLE',
        message: '登录页滚动验收不依赖后端',
        retryable: true,
        timestamp: new Date().toISOString()
      })
    });
  });

  try {
    await page.goto(new URL('/login', adminUrl).href, { waitUntil: 'domcontentloaded' });
    try {
      await page.locator('#v2-admin-login-form').waitFor({ state: 'visible', timeout: 10_000 });
    } catch (error) {
      const diagnostics = await page.evaluate(() => ({
        bodyText: document.body.innerText.slice(0, 1200),
        storageKeys: Array.from({ length: localStorage.length }, (_, index) =>
          String(localStorage.key(index) ?? '')
        ),
        url: location.href
      }));
      throw new Error(`登录页滚动验收未进入登录界面：${JSON.stringify(diagnostics)}`, {
        cause: error
      });
    }
    const before = await page.evaluate(() => {
      const root = document.scrollingElement ?? document.documentElement;
      return {
        clientHeight: root.clientHeight,
        rootOverflowY: getComputedStyle(document.documentElement).overflowY,
        scrollHeight: root.scrollHeight
      };
    });
    const maxScrollTop = before.scrollHeight - before.clientHeight;
    assert.equal(before.rootOverflowY, 'auto', '公共页面没有恢复文档纵向滚动');
    assert.ok(maxScrollTop > 0, '390px 登录页验收没有产生长内容');

    const after = await page.evaluate((top) => {
      const root = document.scrollingElement ?? document.documentElement;
      root.scrollTop = top;
      const security = document.querySelector('.v2-login-security');
      const bounds = security?.getBoundingClientRect();
      return {
        scrollTop: root.scrollTop,
        securityBottom: bounds?.bottom ?? Number.POSITIVE_INFINITY,
        securityTop: bounds?.top ?? Number.POSITIVE_INFINITY,
        viewportHeight: window.innerHeight
      };
    }, maxScrollTop);
    assert.ok(after.scrollTop > 0, '390px 登录页无法更新文档滚动位置');
    assert.ok(
      after.securityTop < after.viewportHeight && after.securityBottom <= after.viewportHeight + 1,
      '390px 登录页底部安全提示无法通过滚动到达'
    );
    assert.deepEqual(
      runtimeErrors,
      [],
      `登录页滚动验收出现浏览器错误：${runtimeErrors.join('\n')}`
    );
  } finally {
    await context.close();
  }
}

async function verifyCustomerPage(browserInstance, scenario) {
  const context = await browserInstance.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const runtimeErrors = collectRuntimeErrors(page);
  const unexpectedRequests = [];
  const tablePreferences = new Map();
  const user = createUser(scenario);

  await page.addInitScript((currentUser) => {
    localStorage.setItem('apple_business_access_token', 'layout-test-token');
    localStorage.setItem('apple_business_current_user', JSON.stringify(currentUser));
  }, user);
  await installApiMocks(page, user, unexpectedRequests, tablePreferences);

  try {
    await page.goto(new URL('/v2/customers', adminUrl).href, {
      waitUntil: 'domcontentloaded'
    });
    let customerTableInstance;
    try {
      customerTableInstance = await waitForCustomerContentReady(page, user.displayName);
    } catch (error) {
      const bodyText = await page
        .locator('body')
        .innerText()
        .catch(() => '');
      throw new Error(
        [
          error instanceof Error ? error.message : String(error),
          `当前地址：${page.url()}`,
          `页面内容：${bodyText.slice(0, 2_000)}`,
          `未模拟请求：${unexpectedRequests.join('、') || '无'}`,
          `浏览器错误：${runtimeErrors.join('、') || '无'}`
        ].join('\n'),
        { cause: error }
      );
    }
    runtimeErrors.length = 0;

    for (const width of viewportWidths) {
      const viewportHeight = width <= mobileBreakpoint ? 844 : 900;
      await page.setViewportSize({ width, height: viewportHeight });
      await assertCustomerContentReady(page, user.displayName, customerTableInstance, width);
      assertLayoutStable(await sampleLayoutTimeline(page), `客户页 ${scenario.key} ${width}px`);
      await assertShellViewportContract(page, viewportHeight, `客户页 ${scenario.key} ${width}px`);
      if (width > mobileBreakpoint) {
        await verifyDesktopCustomerLayout(page, scenario, width);
      } else {
        await verifyMobileCustomerLayout(page, scenario, width);
      }
      await maybeCaptureScreenshot(page, scenario.key, width);
    }

    if (scenario.key === 'all') {
      await verifyRouteScrollRestoration(page);
      await verifyCustomerColumnPreferencePersistence(page, user.displayName, tablePreferences);
    }

    assert.deepEqual(
      unexpectedRequests,
      [],
      `${scenario.key} 出现未模拟 API 请求：${unexpectedRequests.join('、')}`
    );
    assert.deepEqual(
      runtimeErrors,
      [],
      `${scenario.key} 出现浏览器错误：${runtimeErrors.join('\n')}`
    );
  } finally {
    await context.close();
  }
}

async function assertShellViewportContract(page, viewportHeight, label) {
  const metrics = await page.evaluate(() => {
    const root = document.scrollingElement ?? document.documentElement;
    const shell = document.querySelector('.v2-shell');
    const workspace = document.querySelector('.v2-workspace');
    const content = document.querySelector('.v2-content');
    return {
      contentOverflowY: content ? getComputedStyle(content).overflowY : '',
      documentClientHeight: root.clientHeight,
      documentScrollHeight: root.scrollHeight,
      shellHeight: shell?.clientHeight ?? 0,
      workspaceHeight: workspace?.clientHeight ?? 0
    };
  });
  assert.ok(Math.abs(metrics.shellHeight - viewportHeight) <= 1, `${label} 外壳没有约束在视口内`);
  assert.ok(
    Math.abs(metrics.workspaceHeight - viewportHeight) <= 1,
    `${label} 工作区没有约束在视口内`
  );
  assert.equal(metrics.contentOverflowY, 'auto', `${label} 主内容未保持独立滚动`);
  assert.ok(
    metrics.documentScrollHeight - metrics.documentClientHeight <= 1,
    `${label} 出现额外的文档纵向滚动`
  );
}

async function verifyRouteScrollRestoration(page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  const content = page.locator('.v2-content');
  const inner = page.locator('.v2-content__inner');
  const originalUrl = page.url();
  await inner.evaluate((node) => {
    node.style.minHeight = '1800px';
  });
  const initialScrollTop = await content.evaluate((node) => {
    node.scrollTop = 280;
    return node.scrollTop;
  });
  assert.ok(initialScrollTop >= 279, '路由滚动恢复验收未能设置初始位置');

  await page.evaluate(async () => {
    const { v2Router } = await import('/src/v2-router.ts');
    await v2Router.push({ path: '/v2/customers', query: { scrollAcceptance: '1' } });
  });
  await settleLayout(page);
  const newRouteScrollTop = await content.evaluate((node) => node.scrollTop);
  assert.ok(newRouteScrollTop <= 1, '新路由没有从顶部开始');

  await page.evaluate(async () => {
    const { v2Router } = await import('/src/v2-router.ts');
    await v2Router.push('/v2/customers');
  });
  await settleLayout(page);
  const restoredMetrics = await content.evaluate((node) => ({
    clientHeight: node.clientHeight,
    scrollHeight: node.scrollHeight,
    scrollTop: node.scrollTop
  }));
  assert.ok(
    Math.abs(restoredMetrics.scrollTop - initialScrollTop) <= routeScrollRestoreTolerancePx,
    `返回原路由时未恢复主内容滚动位置：${JSON.stringify({
      currentUrl: page.url(),
      initialScrollTop,
      newRouteScrollTop,
      originalUrl,
      restoredMetrics
    })}`
  );

  await inner.evaluate((node) => {
    node.style.minHeight = '';
  });
  await content.evaluate((node) => {
    node.scrollTop = 0;
  });
}

async function waitForCustomerContentReady(page, expectedDisplayName) {
  await page.waitForLoadState('networkidle', { timeout: 20_000 });
  await page.waitForFunction(
    ({ displayName, quietMilliseconds }) => {
      const table = document.querySelector('[data-table-schema="customers.main"]');
      const region = table?.closest('.v2-async-region');
      const renderedDisplayName = document
        .querySelector('.v2-topbar__account-copy strong')
        ?.textContent?.trim();
      const rowCount =
        table?.querySelectorAll('.el-table__body-wrapper .el-table__row').length ?? 0;
      const ready =
        location.pathname === '/v2/customers' &&
        renderedDisplayName === displayName &&
        document.querySelectorAll('[data-table-schema="customers.main"]').length === 1 &&
        region?.getAttribute('aria-busy') === 'false' &&
        rowCount === 2 &&
        document.querySelectorAll('.v2-records-mobile-item').length === 2;
      const readinessKey = '__v2TableAcceptanceReadiness';
      const state = window[readinessKey];
      if (!ready) {
        window[readinessKey] = null;
        return false;
      }
      if (!state || state.table !== table || state.rowCount !== rowCount) {
        window[readinessKey] = { rowCount, since: performance.now(), table };
        return false;
      }
      return performance.now() - state.since >= quietMilliseconds;
    },
    { displayName: expectedDisplayName, quietMilliseconds: 200 },
    { timeout: 20_000 }
  );

  const instanceToken = `customers-${Date.now()}`;
  await page.locator('[data-table-schema="customers.main"]').evaluate((table, token) => {
    table.setAttribute('data-layout-acceptance-instance', token);
  }, instanceToken);
  return instanceToken;
}

async function assertCustomerContentReady(page, expectedDisplayName, instanceToken, width) {
  const state = await page.evaluate(
    ({ displayName, token }) => {
      const table = document.querySelector('[data-table-schema="customers.main"]');
      const region = table?.closest('.v2-async-region');
      return {
        pathname: location.pathname,
        renderedDisplayName: document
          .querySelector('.v2-topbar__account-copy strong')
          ?.textContent?.trim(),
        tableCount: document.querySelectorAll('[data-table-schema="customers.main"]').length,
        tableInstance: table?.getAttribute('data-layout-acceptance-instance') ?? null,
        regionBusy: region?.getAttribute('aria-busy') ?? null,
        rowCount: table?.querySelectorAll('.el-table__body-wrapper .el-table__row').length ?? 0,
        cardCount: document.querySelectorAll('.v2-records-mobile-item').length,
        expectedDisplayName: displayName,
        expectedInstance: token
      };
    },
    { displayName: expectedDisplayName, token: instanceToken }
  );
  assert.deepEqual(
    state,
    {
      pathname: '/v2/customers',
      renderedDisplayName: expectedDisplayName,
      tableCount: 1,
      tableInstance: instanceToken,
      regionBusy: 'false',
      rowCount: 2,
      cardCount: 2,
      expectedDisplayName,
      expectedInstance: instanceToken
    },
    `客户页 ${width}px 布局采样前内容尚未就绪或表格被重新挂载`
  );
}

async function verifyDesktopCustomerLayout(page, scenario, width) {
  assert.equal(await page.locator('.v2-records-table').isVisible(), true);
  assert.equal(await page.locator('.v2-records-mobile-list').isVisible(), false);

  const measurements = await measureActionGroups(page, '.v2-records-table');
  assert.equal(measurements.length, 2, `${scenario.key} ${width}px 操作列行数不正确`);
  for (const measurement of measurements) {
    assert.equal(
      measurement.visibleButtons,
      scenario.desktopActionCount,
      `${scenario.key} ${width}px 可见操作按钮数量不正确`
    );
    assert.equal(
      measurement.layout,
      'triple',
      `${scenario.key} ${width}px 客户操作列未使用 triple 档位`
    );
  }
  assertActionGroupsFit(measurements, `客户页 ${scenario.key} ${width}px`);
  assert.equal(await getDocumentOverflow(page), 0, `${scenario.key} ${width}px 出现页面横向溢出`);
}

async function verifyMobileCustomerLayout(page, scenario, width) {
  assert.equal(await page.locator('.v2-records-table').isVisible(), false);
  assert.equal(await page.locator('.v2-records-mobile-list').isVisible(), true);

  const measurements = await page.locator('.v2-records-mobile-item').evaluateAll((cards) =>
    cards.map((card) => {
      const cardRect = card.getBoundingClientRect();
      const buttons = [...card.querySelectorAll('button')].filter((button) => {
        const style = getComputedStyle(button);
        const rect = button.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0;
      });
      const groups = [...card.querySelectorAll('.v2-record-actions')];
      return {
        cardOverflow: Math.max(0, card.scrollWidth - card.clientWidth),
        groupOverflow: groups.map((group) => Math.max(0, group.scrollWidth - group.clientWidth)),
        outsideButtons: buttons.filter((button) => {
          const rect = button.getBoundingClientRect();
          return rect.left < cardRect.left - 1 || rect.right > cardRect.right + 1;
        }).length
      };
    })
  );

  for (const measurement of measurements) {
    assert.equal(measurement.cardOverflow, 0, `${scenario.key} ${width}px 移动卡片发生横向溢出`);
    assert.equal(
      measurement.groupOverflow.some((overflow) => overflow > 1),
      false,
      `${scenario.key} ${width}px 移动操作按钮组发生裁切`
    );
    assert.equal(
      measurement.outsideButtons,
      0,
      `${scenario.key} ${width}px 存在超出移动卡片的按钮`
    );
  }
  assert.equal(await getDocumentOverflow(page), 0, `${scenario.key} ${width}px 出现页面横向溢出`);
}

async function verifyCustomerColumnPreferencePersistence(page, displayName, tablePreferences) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await settleLayout(page);

  const settingsButton = page.getByRole('button', { name: /^列设置/ }).first();
  await settingsButton.click();
  const settingsDrawer = page.locator('.v2-table-column-settings');
  await settingsDrawer.waitFor({ state: 'visible' });

  assert.equal(
    await settingsDrawer.getByRole('checkbox', { name: /微信/ }).isChecked(),
    true,
    '客户表微信列默认未显示'
  );
  assert.equal(
    await settingsDrawer.getByRole('checkbox', { name: '操作', exact: true }).count(),
    0,
    '系统操作列不应进入可隐藏列清单'
  );
  await settingsDrawer.locator('.el-checkbox', { hasText: '微信' }).click();
  assert.equal(
    await settingsDrawer.getByRole('checkbox', { name: /微信/ }).isChecked(),
    false,
    '客户表微信列未在列设置中取消选中'
  );
  await settingsDrawer.getByRole('button', { name: '保存设置' }).click();
  await settingsDrawer.waitFor({ state: 'hidden' });

  assert.deepEqual(
    tablePreferences.get('customers.main')?.hiddenColumnKeys,
    ['wechat'],
    '列偏好未通过保存接口持久化'
  );
  await waitForCustomerTableHeader(page, '微信', false);
  assert.ok((await readCustomerTableHeaders(page)).includes('操作'), '隐藏数据列时操作列被误隐藏');

  await page.setViewportSize({ width: 390, height: 844 });
  await settleLayout(page);
  assert.equal(
    await visibleElementCount(page.locator('.v2-records-mobile-item dt', { hasText: '微信' })),
    0,
    '保存后移动卡片仍显示已隐藏列'
  );

  await page.reload({ waitUntil: 'domcontentloaded' });
  await waitForCustomerContentReady(page, displayName);
  await page.setViewportSize({ width: 1440, height: 900 });
  await settleLayout(page);
  await waitForCustomerTableHeader(page, '微信', false);

  await page.getByRole('button', { name: /^列设置（隐藏 1）$/ }).click();
  await settingsDrawer.waitFor({ state: 'visible' });
  await settingsDrawer.getByRole('button', { name: '恢复默认' }).click();
  await page.getByRole('button', { name: '确认恢复' }).click();
  await settingsDrawer.waitFor({ state: 'hidden' });
  assert.equal(tablePreferences.has('customers.main'), false, '恢复默认未删除服务端偏好');
  await waitForCustomerTableHeader(page, '微信', true);
}

async function visibleElementCount(locator) {
  const elements = await locator.all();
  const visible = await Promise.all(elements.map((element) => element.isVisible()));
  return visible.filter(Boolean).length;
}

async function readCustomerTableHeaders(page) {
  return page
    .locator('[data-table-schema="customers.main"] th .cell')
    .evaluateAll((headers) => headers.map((header) => header.textContent?.trim() ?? ''));
}

async function waitForCustomerTableHeader(page, label, expectedVisible) {
  await page.waitForFunction(
    ({ expected, text }) => {
      const headers = [
        ...document.querySelectorAll('[data-table-schema="customers.main"] th .cell')
      ]
        .map((header) => header.textContent?.trim() ?? '')
        .filter(Boolean);
      return headers.includes(text) === expected;
    },
    { expected: expectedVisible, text: label },
    { timeout: 5_000 }
  );
}

async function measureActionGroups(page, containerSelector) {
  return page.locator(`${containerSelector} .v2-table-actions`).evaluateAll((groups) =>
    groups.map((group) => {
      const cell = group.closest('td');
      const table = group.closest('.el-table');
      const groupRect = group.getBoundingClientRect();
      const cellRect = cell?.getBoundingClientRect();
      const tableRect = table?.getBoundingClientRect();
      const header = table?.querySelector('th.v2-table-action-column');
      const buttons = [...group.querySelectorAll('button')].filter((button) => {
        const style = getComputedStyle(button);
        const rect = button.getBoundingClientRect();
        return style.display !== 'none' && style.visibility !== 'hidden' && rect.width > 0;
      });
      const buttonRects = buttons.map((button) => {
        const rect = button.getBoundingClientRect();
        return { left: rect.left, right: rect.right, top: rect.top };
      });
      return {
        layout: group.getAttribute('data-action-layout'),
        visibleButtons: buttons.length,
        overflow: Math.max(0, group.scrollWidth - group.clientWidth),
        outsideCell: cellRect
          ? buttonRects.filter(
              (rect) => rect.left < cellRect.left - 1 || rect.right > cellRect.right + 1
            ).length
          : buttons.length,
        wrappedRows: new Set(buttonRects.map((rect) => Math.round(rect.top))).size,
        fixedOutsideTable:
          cellRect && tableRect
            ? cellRect.left < tableRect.left - 1 || cellRect.right > tableRect.right + 1
            : true,
        groupOutsideCell:
          cellRect == null ||
          groupRect.left < cellRect.left - 1 ||
          groupRect.right > cellRect.right + 1,
        cellTextAlign: cell ? getComputedStyle(cell).textAlign : null,
        headerTextAlign: header ? getComputedStyle(header).textAlign : null,
        groupJustifyContent: getComputedStyle(group).justifyContent
      };
    })
  );
}

function assertActionGroupsFit(measurements, label) {
  for (const [index, measurement] of measurements.entries()) {
    assert.ok(measurement.layout, `${label} 第 ${index + 1} 行缺少操作列档位`);
    assert.equal(measurement.overflow, 0, `${label} 第 ${index + 1} 行操作组内部溢出`);
    assert.equal(measurement.outsideCell, 0, `${label} 第 ${index + 1} 行按钮超出操作单元格`);
    assert.ok(measurement.wrappedRows <= 1, `${label} 第 ${index + 1} 行操作按钮发生换行`);
    assert.equal(
      measurement.fixedOutsideTable,
      false,
      `${label} 第 ${index + 1} 行固定操作列超出表格`
    );
    assert.equal(
      measurement.groupOutsideCell,
      false,
      `${label} 第 ${index + 1} 行操作组超出单元格`
    );
    assert.equal(measurement.cellTextAlign, 'right', `${label} 第 ${index + 1} 行操作内容未靠右`);
    assert.equal(measurement.headerTextAlign, 'right', `${label} 第 ${index + 1} 行操作表头未靠右`);
    assert.equal(
      measurement.groupJustifyContent,
      'flex-end',
      `${label} 第 ${index + 1} 行操作按钮组未贴近右侧`
    );
  }
}

async function measureSemanticColumnLayout(page, containerSelector = '[data-alignment-fixture]') {
  return page.locator(containerSelector).evaluate((container) => {
    const table = container.querySelector('.v2-unified-table');
    const tableWidth = table?.getBoundingClientRect().width ?? 0;
    const containerRect = container.getBoundingClientRect();
    const tableRect = table?.getBoundingClientRect();
    const scroller = table
      ? [...table.querySelectorAll('.el-scrollbar__wrap')].sort(
          (left, right) =>
            right.scrollWidth - right.clientWidth - (left.scrollWidth - left.clientWidth)
        )[0]
      : null;
    const columns = ['text', 'identifier', 'index', 'numeric', 'date', 'status'].map((kind) => {
      const header = container.querySelector(`th.v2-table-column--${kind}`);
      const cell = container.querySelector(`td.v2-table-column--${kind}`);
      const cellContent = cell?.querySelector('.cell');
      return {
        kind,
        width: header?.getBoundingClientRect().width ?? 0,
        headerTextAlign: header ? getComputedStyle(header).textAlign : null,
        cellTextAlign: cell ? getComputedStyle(cell).textAlign : null,
        fontVariantNumeric: cellContent ? getComputedStyle(cellContent).fontVariantNumeric : null,
        paddingLeft: cellContent
          ? Number.parseFloat(getComputedStyle(cellContent).paddingLeft)
          : null,
        paddingRight: cellContent
          ? Number.parseFloat(getComputedStyle(cellContent).paddingRight)
          : null
      };
    });
    return {
      tableWidth,
      columns,
      scrollerClientWidth: scroller?.clientWidth ?? 0,
      scrollerScrollWidth: scroller?.scrollWidth ?? 0,
      outsideContainer:
        tableRect == null
          ? Number.POSITIVE_INFINITY
          : Math.max(0, containerRect.left - tableRect.left, tableRect.right - containerRect.right)
    };
  });
}

function assertSemanticColumnLayout(measurement, label) {
  const expectedAlignments = {
    text: 'left',
    identifier: 'left',
    index: 'center',
    numeric: 'right',
    date: 'left',
    status: 'center'
  };
  const minimumWidths = {
    text: 160,
    identifier: 192,
    index: 72,
    numeric: 128,
    date: 165,
    status: 112
  };
  const expectedPadding = Math.min(12, Math.max(8, measurement.tableWidth / 100));
  assert.equal(measurement.columns.length, 6, `${label} 未渲染全部六种语义列`);
  for (const column of measurement.columns) {
    const expected = expectedAlignments[column.kind];
    assert.equal(column.headerTextAlign, expected, `${label} ${column.kind} 表头未对齐`);
    assert.equal(column.cellTextAlign, expected, `${label} ${column.kind} 内容未对齐`);
    assert.ok(
      Math.abs(column.paddingLeft - expectedPadding) <= 0.25,
      `${label} ${column.kind} 左侧间距未连续自适应`
    );
    assert.ok(
      Math.abs(column.paddingRight - expectedPadding) <= 0.25,
      `${label} ${column.kind} 右侧间距未连续自适应`
    );
    if (column.kind === 'index') {
      assert.ok(
        Math.abs(column.width - minimumWidths.index) <= 1,
        `${label} 序号列未保持 72px 固定宽度`
      );
    } else {
      assert.ok(
        column.width >= minimumWidths[column.kind] - 1,
        `${label} ${column.kind} 小于 schema 最小宽度`
      );
    }
    if (['identifier', 'index', 'numeric', 'date'].includes(column.kind)) {
      assert.match(
        column.fontVariantNumeric ?? '',
        /tabular-nums/,
        `${label} ${column.kind} 未启用等宽数字`
      );
    }
  }

  const flexibleColumns = measurement.columns.filter((column) => column.kind !== 'index');
  const flexibleMinimumTotal = flexibleColumns.reduce(
    (total, column) => total + minimumWidths[column.kind],
    0
  );
  const flexibleActualTotal = flexibleColumns.reduce((total, column) => total + column.width, 0);
  const hasHorizontalOverflow =
    measurement.scrollerScrollWidth > measurement.scrollerClientWidth + 1;

  if (hasHorizontalOverflow) {
    for (const column of flexibleColumns) {
      assert.ok(
        Math.abs(column.width - minimumWidths[column.kind]) <= 1,
        `${label} ${column.kind} 内部滚动时未保持 schema 最小宽度`
      );
    }
  } else {
    const proportionalScale = flexibleActualTotal / flexibleMinimumTotal;
    for (const column of flexibleColumns) {
      const expectedWidth = minimumWidths[column.kind] * proportionalScale;
      const actualScale = column.width / minimumWidths[column.kind];
      assert.ok(
        Math.abs(actualScale - proportionalScale) <= 0.03,
        `${label} ${column.kind} 未按 schema 最小宽度同比例分配剩余空间（实际 ${column.width.toFixed(2)}，期望 ${expectedWidth.toFixed(2)}，实际比例 ${actualScale.toFixed(4)}，整体比例 ${proportionalScale.toFixed(4)}）`
      );
    }
  }
}

function assertNarrowContainerLayout(measurement, label) {
  assertSemanticColumnLayout(measurement, label);
  assert.ok(measurement.tableWidth <= 480.5, `${label} 表格宽度超出 480px 抽屉容器`);
  assert.ok(measurement.outsideContainer <= 1, `${label} 表格越出抽屉容器`);
  assert.ok(
    measurement.scrollerScrollWidth > measurement.scrollerClientWidth + 1,
    `${label} 未把超宽内容限制为表格内部横向滚动`
  );
}

async function measureRegisteredSchemaFixtures(page) {
  return page.locator('[data-schema-fixture]').evaluateAll((sections) =>
    sections.map((section) => {
      const table = section.querySelector('.v2-unified-table');
      const sectionRect = section.getBoundingClientRect();
      const tableRect = table?.getBoundingClientRect();
      const visible = Boolean(
        table &&
        getComputedStyle(table).display !== 'none' &&
        tableRect &&
        tableRect.width > 0 &&
        tableRect.height > 0
      );
      const headers = table ? [...table.querySelectorAll('.el-table__header-wrapper th')] : [];
      return {
        id: section.getAttribute('data-schema-fixture'),
        schemaId: table?.getAttribute('data-table-schema') ?? null,
        mobileMode: table?.getAttribute('data-mobile-mode') ?? null,
        expectedColumns: Number(section.getAttribute('data-schema-columns')),
        renderedColumns: headers.length,
        visible,
        invalidVisibleColumnWidths: visible
          ? headers.filter((header) => {
              const width = header.getBoundingClientRect().width;
              return !Number.isFinite(width) || width <= 0;
            }).length
          : 0,
        outsideContainer:
          tableRect == null
            ? Number.POSITIVE_INFINITY
            : Math.max(0, sectionRect.left - tableRect.left, tableRect.right - sectionRect.right)
      };
    })
  );
}

function assertRegisteredSchemaFixtures(measurements, width) {
  const actualIds = measurements
    .map(({ id }) => id)
    .filter(Boolean)
    .sort();
  assert.deepEqual(actualIds, registeredSchemaIds, `${width}px 未动态渲染所有最终 schema`);
  assert.equal(new Set(actualIds).size, actualIds.length, `${width}px schema 夹具 id 重复`);

  for (const measurement of measurements) {
    assert.equal(measurement.schemaId, measurement.id, `${width}px schema id 与表格不一致`);
    assert.equal(
      measurement.renderedColumns,
      measurement.expectedColumns,
      `${width}px ${measurement.id} 列数与 schema 不一致`
    );
    const expectedVisible = width > mobileBreakpoint || measurement.mobileMode === 'scroll';
    assert.equal(
      measurement.visible,
      expectedVisible,
      `${width}px ${measurement.id} 移动呈现模式不正确`
    );
    if (measurement.visible) {
      assert.equal(
        measurement.invalidVisibleColumnWidths,
        0,
        `${width}px ${measurement.id} 存在无效列宽`
      );
      assert.ok(measurement.outsideContainer <= 1, `${width}px ${measurement.id} 表格超出容器`);
    }
  }
}

async function sampleLayoutTimeline(page) {
  const startedAt = Date.now();
  await waitForTwoAnimationFrames(page);
  const samples = [{ checkpoint: '2rAF', state: await captureLayoutState(page) }];
  for (const checkpoint of stabilityCheckpoints) {
    const remaining = startedAt + checkpoint - Date.now();
    if (remaining > 0) await page.waitForTimeout(remaining);
    samples.push({ checkpoint: `${checkpoint}ms`, state: await captureLayoutState(page) });
  }
  return samples;
}

async function captureLayoutState(page) {
  return page.evaluate(() => ({
    documentOverflow: Math.max(
      0,
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
      document.body.scrollWidth - document.body.clientWidth
    ),
    tables: [...document.querySelectorAll('.v2-unified-table')].map((table, index) => {
      const rect = table.getBoundingClientRect();
      const scrollers = [...table.querySelectorAll('.el-scrollbar__wrap')];
      const scroller = scrollers.sort(
        (left, right) =>
          right.scrollWidth - right.clientWidth - (left.scrollWidth - left.clientWidth)
      )[0];
      return {
        identity: `${table.getAttribute('data-table-schema') ?? 'unknown'}#${index}`,
        visible: getComputedStyle(table).display !== 'none' && rect.width > 0,
        left: rect.left,
        width: rect.width,
        scrollLeft: scroller?.scrollLeft ?? 0,
        headerWidths: [...table.querySelectorAll('.el-table__header-wrapper th')].map(
          (header) => header.getBoundingClientRect().width
        )
      };
    })
  }));
}

function assertLayoutStable(samples, label) {
  const baseline = samples.at(-1)?.state;
  assert.ok(baseline, `${label} 缺少布局采样`);
  for (const { checkpoint, state } of samples) {
    assert.ok(state.documentOverflow <= 1, `${label} ${checkpoint} 页面出现横向溢出`);
    assert.equal(
      state.tables.length,
      baseline.tables.length,
      `${label} ${checkpoint} 表格数量漂移`
    );
    for (const [index, table] of state.tables.entries()) {
      const expected = baseline.tables[index];
      assert.equal(table.identity, expected.identity, `${label} ${checkpoint} 表格顺序漂移`);
      assert.equal(table.visible, expected.visible, `${label} ${checkpoint} 表格可见性漂移`);
      assert.ok(
        Math.abs(table.left - expected.left) <= 1,
        `${label} ${checkpoint} ${table.identity} 横向位置漂移超过 1px`
      );
      assert.ok(
        Math.abs(table.width - expected.width) <= 1,
        `${label} ${checkpoint} ${table.identity} 宽度漂移超过 1px`
      );
      assert.ok(
        Math.abs(table.scrollLeft - expected.scrollLeft) <= 1,
        `${label} ${checkpoint} ${table.identity} scrollLeft 漂移超过 1px`
      );
      assert.equal(
        table.headerWidths.length,
        expected.headerWidths.length,
        `${label} ${checkpoint} ${table.identity} 表头列数漂移`
      );
      for (const [columnIndex, columnWidth] of table.headerWidths.entries()) {
        assert.ok(
          Math.abs(columnWidth - expected.headerWidths[columnIndex]) <= 1,
          `${label} ${checkpoint} ${table.identity} 第 ${columnIndex + 1} 列宽漂移超过 1px`
        );
      }
    }
  }
}

async function verifyScrollLifecycle(page) {
  await page.setViewportSize({ width: 390, height: 844 });
  await settleLayout(page);
  const before = await setLifecycleScroll(page, 240);
  assert.ok(before.maxScrollLeft > 1, '滚动生命周期夹具未产生内部横向滚动');
  assert.ok(before.scrollLeft > 1, '滚动生命周期夹具未能设置 scrollLeft');

  await page.locator('[data-update-same-table]').click();
  const sameTableSamples = await sampleLifecycleTimeline(page);
  for (const sample of sameTableSamples) {
    assert.equal(
      sample.schemaId,
      before.schemaId,
      `${sample.checkpoint} 同表数据更新意外更换 schema`
    );
    assert.ok(
      Math.abs(sample.scrollLeft - before.scrollLeft) <= 1,
      `${sample.checkpoint} 同表数据更新未保留 scrollLeft`
    );
  }

  await page.locator('[data-switch-schema]').click();
  const switchedSamples = await sampleLifecycleTimeline(page);
  for (const sample of switchedSamples) {
    assert.notEqual(sample.schemaId, before.schemaId, `${sample.checkpoint} schema 未完成切换`);
    assert.ok(sample.scrollLeft <= 1, `${sample.checkpoint} schema 切换后未归零 scrollLeft`);
  }
  assert.equal(await getDocumentOverflow(page), 0, '滚动生命周期验收出现页面溢出');
}

async function setLifecycleScroll(page, requestedLeft) {
  return page.locator('[data-scroll-lifecycle] .v2-unified-table').evaluate((table, left) => {
    const scroller = [...table.querySelectorAll('.el-scrollbar__wrap')].sort(
      (first, second) =>
        second.scrollWidth - second.clientWidth - (first.scrollWidth - first.clientWidth)
    )[0];
    if (!scroller) return { schemaId: null, scrollLeft: 0, maxScrollLeft: 0 };
    scroller.scrollLeft = Math.min(left, scroller.scrollWidth - scroller.clientWidth);
    scroller.dispatchEvent(new Event('scroll'));
    return {
      schemaId: table.getAttribute('data-table-schema'),
      scrollLeft: scroller.scrollLeft,
      maxScrollLeft: scroller.scrollWidth - scroller.clientWidth
    };
  }, requestedLeft);
}

async function sampleLifecycleTimeline(page) {
  const startedAt = Date.now();
  await waitForTwoAnimationFrames(page);
  const samples = [{ checkpoint: '2rAF', ...(await readLifecycleState(page)) }];
  for (const checkpoint of stabilityCheckpoints) {
    const remaining = startedAt + checkpoint - Date.now();
    if (remaining > 0) await page.waitForTimeout(remaining);
    samples.push({ checkpoint: `${checkpoint}ms`, ...(await readLifecycleState(page)) });
  }
  return samples;
}

async function readLifecycleState(page) {
  return page.locator('[data-scroll-lifecycle] .v2-unified-table').evaluate((table) => {
    const scroller = [...table.querySelectorAll('.el-scrollbar__wrap')].sort(
      (first, second) =>
        second.scrollWidth - second.clientWidth - (first.scrollWidth - first.clientWidth)
    )[0];
    return {
      schemaId: table.getAttribute('data-table-schema'),
      scrollLeft: scroller?.scrollLeft ?? 0
    };
  });
}

async function getDocumentOverflow(page) {
  return page.evaluate(() =>
    Math.max(
      0,
      document.documentElement.scrollWidth - document.documentElement.clientWidth,
      document.body.scrollWidth - document.body.clientWidth
    )
  );
}

async function installApiMocks(page, user, unexpectedRequests, tablePreferences) {
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) {
      await route.continue();
      return;
    }
    if (request.method() === 'GET' && url.pathname.endsWith('/api/auth/me')) {
      await fulfillSuccess(route, user);
      return;
    }
    if (
      request.method() === 'GET' &&
      url.pathname.endsWith('/api/id-business-v2/branding/public')
    ) {
      await fulfillSuccess(route, createDefaultBrandingSettings());
      return;
    }
    if (request.method() === 'GET' && url.pathname.endsWith('/api/id-business-v2/time')) {
      await fulfillSuccess(route, {
        now: new Date().toISOString(),
        timezone: 'Asia/Shanghai'
      });
      return;
    }
    if (
      request.method() === 'GET' &&
      url.pathname.endsWith('/api/id-business-v2/customers/bootstrap')
    ) {
      await fulfillSuccess(route, createCustomersBootstrap());
      return;
    }
    if (
      request.method() === 'GET' &&
      url.pathname.endsWith('/api/id-business-v2/table-preferences')
    ) {
      await fulfillSuccess(route, { items: [...tablePreferences.values()] });
      return;
    }
    const tablePreferenceMatch = url.pathname.match(
      /\/api\/id-business-v2\/table-preferences\/([^/]+)$/
    );
    if (tablePreferenceMatch && request.method() === 'PUT') {
      const tableId = decodeURIComponent(tablePreferenceMatch[1]);
      const body = request.postDataJSON();
      const preference = {
        tableId,
        hiddenColumnKeys: body.hiddenColumnKeys,
        updatedAt: new Date().toISOString()
      };
      tablePreferences.set(tableId, preference);
      await fulfillSuccess(route, preference);
      return;
    }
    if (tablePreferenceMatch && request.method() === 'DELETE') {
      const tableId = decodeURIComponent(tablePreferenceMatch[1]);
      const deleted = tablePreferences.delete(tableId);
      await fulfillSuccess(route, { tableId, hiddenColumnKeys: [], deleted });
      return;
    }
    if (
      request.method() === 'GET' &&
      url.pathname.endsWith('/api/id-business-v2/change-versions')
    ) {
      await fulfillSuccess(route, {
        generatedAt: new Date().toISOString(),
        versions: Object.fromEntries(dataScopes.map((scope) => [scope, '0']))
      });
      return;
    }

    unexpectedRequests.push(`${request.method()} ${url.pathname}`);
    await route.fulfill({
      status: 500,
      contentType: 'application/json',
      body: JSON.stringify({
        success: false,
        errorCode: 'UNEXPECTED_LAYOUT_TEST_REQUEST',
        message: 'Unexpected layout test request',
        requestId: 'request-layout-unexpected',
        retryable: false,
        timestamp: new Date().toISOString()
      })
    });
  });
}

async function fulfillSuccess(route, data) {
  await route.fulfill({
    status: 200,
    contentType: 'application/json',
    body: JSON.stringify({
      success: true,
      data,
      message: 'OK',
      requestId: 'request-layout-success',
      timestamp: new Date().toISOString()
    })
  });
}

function createDefaultBrandingSettings() {
  const now = new Date().toISOString();
  return {
    appName: 'ID 业务管理',
    logoText: 'ID',
    logoUrl: '/brand/default-logo.svg',
    appSubtitle: 'Apple ID 订阅运营',
    loginHeroTitle: '把订单、余额与续费\n收进一条安全动线',
    loginNote: '内部后台仅限授权人员访问，登录后继续处理订单与财务任务。',
    footerText: '© 2026 Apple 内部系统 · 仅限授权人员访问',
    documentTitleSuffix: 'ID 业务管理',
    updatedByUserId: null,
    createdAt: now,
    updatedAt: now
  };
}

function createUser(scenario) {
  return {
    id: `layout-${scenario.key}`,
    username: `layout-${scenario.key}`,
    displayName: `布局验收 ${scenario.key}`,
    roles: ['layout-test'],
    permissions: scenario.permissions,
    mustResetPassword: false
  };
}

function createCustomersBootstrap() {
  const source = createOption('source-wechat', 'customer_source', 'wechat', '微信');
  const tag = createOption('tag-quality', 'customer_tag', 'quality', '高质量');
  const now = new Date().toISOString();
  const service = {
    ...createOption('service-ai', 'service', 'ai-service', 'AI 服务'),
    parent: { id: 'business-ai', name: 'AI 类' },
    firstOpenedAt: '2026-05-01T00:00:00.000Z',
    lastOpenedAt: '2026-07-30T00:00:00.000Z',
    activationCount: 3
  };
  const items = [
    createCustomer('customer-active', '完整权限客户', 'active', source, tag, service, now),
    createCustomer('customer-disabled', '停用状态客户', 'disabled', source, tag, service, now)
  ];
  return {
    list: {
      items,
      total: items.length,
      page: 1,
      pageSize: 20
    },
    options: {
      sources: [source],
      tags: [tag],
      services: [service]
    },
    generatedAt: now
  };
}

function createCustomer(id, name, recordStatus, source, tag, service, now) {
  return {
    id,
    name,
    maskedPhone: '138****5678',
    displayPhone: '138****5678',
    phoneTail: '5678',
    hasPhone: true,
    wechat: 'lay***est',
    hasWechat: true,
    qq: '10***01',
    hasQq: true,
    maskedWhatsapp: '+60****6789',
    displayWhatsapp: '+60****6789',
    whatsappTail: '23456789',
    hasWhatsapp: true,
    contactDisplayModes: {
      phone: 'reveal_direct',
      wechat: 'reveal_direct',
      qq: 'reveal_direct',
      whatsapp: 'reveal_direct'
    },
    sourceOptionId: source.id,
    source,
    tagOptionIds: [tag.id],
    tags: [tag],
    serviceOptionIds: [service.id],
    services: [service],
    recordStatus,
    remark: null,
    createdBy: null,
    createdAt: now,
    updatedAt: now
  };
}

function createOption(id, type, code, name) {
  return {
    id,
    type,
    code,
    name,
    parentId: null,
    parent: null,
    countryOptionId: null,
    country: null,
    businessAmount: null,
    currencyCode: null
  };
}

function collectRuntimeErrors(page) {
  const errors = [];
  page.on('pageerror', (error) => errors.push(`pageerror:${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(`console:${message.text()}`);
  });
  return errors;
}

async function settleLayout(page) {
  await waitForTwoAnimationFrames(page);
}

async function waitForTwoAnimationFrames(page) {
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      })
  );
}

function loadRegisteredSchemaIds() {
  const source = readFileSync(
    path.join(rootDir, 'apps/admin/src/v2/features/tableSchemas.ts'),
    'utf8'
  )
    .replace(/^import[^\n]+\n/m, '')
    .replace('const table = defineV2TableSchema;', 'const table = (schema) => schema;')
    .replaceAll('export const ', 'const ')
    .replaceAll(' as const', '');
  const registry = new Function(`${source}\nreturn v2TableSchemas;`)();
  return Object.values(registry)
    .flatMap((schemas) => Object.values(schemas))
    .map((schema) => schema.id)
    .sort();
}

async function maybeCaptureScreenshot(page, scenarioKey, width) {
  if (!screenshotDirectory || scenarioKey !== 'all' || ![1440, 390].includes(width)) return;
  await page.screenshot({
    path: path.join(screenshotDirectory, `customers-${scenarioKey}-${width}.png`),
    fullPage: true
  });
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

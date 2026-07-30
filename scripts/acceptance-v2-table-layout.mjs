#!/usr/bin/env node
/* global document, getComputedStyle, requestAnimationFrame */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
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
const viewportWidths = [1440, 1024, 901, 900, 768, 390];
const mobileBreakpoint = 900;
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
  for (const scenario of permissionScenarios) {
    await verifyCustomerPage(browser, scenario);
  }

  console.log(
    JSON.stringify({
      ok: true,
      actionLayouts: ['icon', 'single', 'double', 'triple', 'wide'],
      permissionScenarios: permissionScenarios.map(({ key }) => key),
      viewportWidths
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
  await installApiMocks(page, user, unexpectedRequests);

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

    for (const width of [1600, 1440, 1024, 901]) {
      await page.setViewportSize({ width, height: 1000 });
      await settleLayout(page);
      const measurements = await measureActionGroups(page, '[data-layout-fixture]');
      assert.equal(measurements.length, 5, `宽度 ${width}px 未渲染全部五种操作列档位`);
      assertActionGroupsFit(measurements, `布局夹具 ${width}px`);
      assertSemanticColumnLayout(await measureSemanticColumnLayout(page), `语义列夹具 ${width}px`);
      assert.equal(await getDocumentOverflow(page), 0, `布局夹具 ${width}px 出现页面横向溢出`);
    }
    assert.deepEqual(runtimeErrors, [], `布局夹具出现浏览器错误：${runtimeErrors.join('\n')}`);
  } finally {
    await context.close();
  }
}

async function verifyCustomerPage(browserInstance, scenario) {
  const context = await browserInstance.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const runtimeErrors = collectRuntimeErrors(page);
  const unexpectedRequests = [];
  const user = createUser(scenario);

  await page.addInitScript((currentUser) => {
    localStorage.setItem('apple_business_access_token', 'layout-test-token');
    localStorage.setItem('apple_business_current_user', JSON.stringify(currentUser));
  }, user);
  await installApiMocks(page, user, unexpectedRequests);

  try {
    await page.goto(new URL('/v2/customers', adminUrl).href, {
      waitUntil: 'domcontentloaded'
    });
    try {
      await page.locator('.v2-records-mobile-item').first().waitFor({
        state: 'attached',
        timeout: 20_000
      });
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
      await page.setViewportSize({ width, height: width <= mobileBreakpoint ? 844 : 900 });
      await settleLayout(page);
      if (width > mobileBreakpoint) {
        await verifyDesktopCustomerLayout(page, scenario, width);
      } else {
        await verifyMobileCustomerLayout(page, scenario, width);
      }
      await maybeCaptureScreenshot(page, scenario.key, width);
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

async function measureSemanticColumnLayout(page) {
  return page.locator('[data-alignment-fixture]').evaluate((container) => {
    const table = container.querySelector('.v2-adaptive-table');
    const tableWidth = table?.getBoundingClientRect().width ?? 0;
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
    return { tableWidth, columns };
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
  const expectedWidths = {
    identifier: 192,
    index: 72,
    numeric: 128,
    date: 165,
    status: 112
  };
  const expectedPadding =
    measurement.tableWidth >= 1200 ? 12 : measurement.tableWidth >= 840 ? 10 : 8;
  assert.equal(measurement.columns.length, 6, `${label} 未渲染全部六种语义列`);
  for (const column of measurement.columns) {
    const expected = expectedAlignments[column.kind];
    assert.equal(column.headerTextAlign, expected, `${label} ${column.kind} 表头未对齐`);
    assert.equal(column.cellTextAlign, expected, `${label} ${column.kind} 内容未对齐`);
    assert.equal(column.paddingLeft, expectedPadding, `${label} ${column.kind} 左侧间距不正确`);
    assert.equal(column.paddingRight, expectedPadding, `${label} ${column.kind} 右侧间距不正确`);
    if (column.kind === 'text') {
      assert.ok(column.width >= 160, `${label} 文本列小于 wide 最小宽度`);
    } else {
      assert.equal(
        Math.round(column.width),
        expectedWidths[column.kind],
        `${label} ${column.kind} 未保持固定语义宽度`
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

async function installApiMocks(page, user, unexpectedRequests) {
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
      url.pathname.endsWith('/api/id-business-v2/customers/bootstrap')
    ) {
      await fulfillSuccess(route, createCustomersBootstrap());
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
      timestamp: new Date().toISOString()
    })
  });
}

function createUser(scenario) {
  return {
    id: `layout-${scenario.key}`,
    username: `layout-${scenario.key}`,
    displayName: `布局验收 ${scenario.key}`,
    roles: ['layout-test'],
    permissions: scenario.permissions
  };
}

function createCustomersBootstrap() {
  const source = createOption('source-wechat', 'customer_source', 'wechat', '微信');
  const tag = createOption('tag-quality', 'customer_tag', 'quality', '高质量');
  const service = {
    ...createOption('service-ai', 'service', 'ai-service', 'AI 服务'),
    parent: { id: 'business-ai', name: 'AI 类' }
  };
  const now = new Date().toISOString();
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
    phoneTail: '5678',
    hasPhone: true,
    wechat: 'layout-test',
    sourceOptionId: source.id,
    source,
    tagOptionIds: [tag.id],
    tags: [tag],
    serviceOptionIds: [service.id],
    services: [service],
    recordStatus,
    remark: null,
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
  // The shell and sidebar use 220ms responsive transitions. Wait for those to
  // finish before measuring or capturing the breakpoint result.
  await page.waitForTimeout(260);
  await page.evaluate(
    () =>
      new Promise((resolve) => {
        requestAnimationFrame(() => requestAnimationFrame(resolve));
      })
  );
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

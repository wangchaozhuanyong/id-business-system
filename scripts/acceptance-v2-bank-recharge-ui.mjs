#!/usr/bin/env node
/* global document, getComputedStyle, window */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const adminDir = path.join(root, 'apps/admin');
const baseUrl = 'http://127.0.0.1:5385';
const outputDir = path.join(root, '.runtime/bank-recharge');
const now = new Date('2026-09-23T12:00:00.000Z').toISOString();
const orderId = '22222222-2222-4222-8222-222222222222';
const accountId = '33333333-3333-4333-8333-333333333333';
const customerId = '44444444-4444-4444-8444-444444444444';
const cardId = '55555555-5555-4555-8555-555555555555';
const customer = { id: customerId, name: '银充测试客户长名称用于验证单行显示' };
const newCustomerId = '88888888-8888-4888-8888-888888888888';
const account = { id: accountId, emailMasked: 'te***@example.invalid' };
const card = {
  id: cardId,
  label: '菲律宾银充 Visa 卡长名称',
  last4: '1234',
  currencyCode: 'PHP',
  active: true
};
const order = {
  id: orderId,
  orderNo: 'BC20260923120000LONGORDER',
  source: 'automatic',
  rechargeJobId: null,
  accountId,
  account,
  customerId,
  customer,
  cardId,
  card,
  activeSubscription: { status: 'active' },
  cardLast4: '1234',
  plan: 'plus',
  chargeAmount: '1000.0000',
  chargeCurrencyCode: 'PHP',
  customerFeeRate: '2.5000',
  customerFeeAmount: '25.0000',
  customerFeeOverridden: false,
  bankFeeAmount: '3.5000',
  bankFeeCurrencyCode: 'PHP',
  receivedAmount: '1200.0000',
  receivedCurrencyCode: 'CNY',
  chargeFxRateToCny: '0.13000000',
  bankFeeFxRateToCny: null,
  receivedFxRateToCny: null,
  fundingFinanceAccountId: null,
  receivedFinanceAccountId: '66666666-6666-4666-8666-666666666666',
  profitAmountCny: '1069.5450',
  status: 'completed',
  financeStatus: 'posted',
  openedAt: now,
  dueAt: '2026-09-25T12:00:00.000Z',
  verifiedAt: now,
  manualEvidenceRef: null,
  remark: '',
  createdAt: now,
  updatedAt: now
};

async function assertListHeaderLayout(page, label) {
  const layout = await page
    .locator('.v2-records-list')
    .first()
    .evaluate((list) => {
      const header = list.querySelector(':scope > header');
      const title = header?.querySelector('.v2-section-heading__title');
      if (!header || !title) return null;
      const listBox = list.getBoundingClientRect();
      const headerBox = header.getBoundingClientRect();
      const titleBox = title.getBoundingClientRect();
      return {
        leftInset: titleBox.left - listBox.left,
        topInset: titleBox.top - listBox.top,
        headerHeight: headerBox.height,
        borderWidth: getComputedStyle(header).borderBottomWidth
      };
    });
  assert.ok(layout, `${label} 缺少列表标题`);
  assert.ok(layout.leftInset >= 12, `${label} 标题贴边：${JSON.stringify(layout)}`);
  assert.ok(layout.topInset >= 10, `${label} 标题顶部间距不足：${JSON.stringify(layout)}`);
  assert.ok(layout.headerHeight >= 50, `${label} 标题行高度不足：${JSON.stringify(layout)}`);
  assert.notEqual(layout.borderWidth, '0px', `${label} 缺少标题分隔线`);
}

mkdirSync(outputDir, { recursive: true });
const server = spawn(
  process.execPath,
  [
    path.join(root, 'node_modules/vite/bin/vite.js'),
    '--host',
    '127.0.0.1',
    '--port',
    '5385',
    '--strictPort'
  ],
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
const serverOutput = [];
for (const stream of [server.stdout, server.stderr]) {
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => serverOutput.push(String(chunk)));
}
let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt += 1) {
    if (server.exitCode !== null) throw new Error(`Vite 已退出：${serverOutput.join('')}`);
    const response = await fetch(`${baseUrl}/login`, { signal: AbortSignal.timeout(1000) }).catch(
      () => null
    );
    if (response?.ok) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(ready, `Vite 未启动：${serverOutput.join('')}`);
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  const unexpected = [];
  const orderRequests = [];
  const runtimeErrors = [];
  let showAccounts = true;
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  await page.addInitScript(() => {
    const user = {
      id: '11111111-1111-4111-8111-111111111111',
      username: 'bank-acceptance',
      displayName: '银充验收管理员',
      roles: ['admin'],
      permissions: [],
      mustResetPassword: false
    };
    localStorage.setItem('apple_business_access_token', 'bank-acceptance-token');
    localStorage.setItem('apple_business_current_user', JSON.stringify(user));
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    const pathname = url.pathname;
    if (!pathname.startsWith('/api/')) {
      await route.continue();
      return;
    }
    let data;
    if (pathname.endsWith('/auth/me') || pathname.endsWith('/auth/session')) {
      data = {
        id: '11111111-1111-4111-8111-111111111111',
        username: 'bank-acceptance',
        displayName: '银充验收管理员',
        roles: ['admin'],
        permissions: [],
        mustResetPassword: false
      };
    } else if (pathname.endsWith('/id-business-v2/branding/public')) {
      data = {
        appName: 'ID 业务管理',
        logoText: 'ID',
        logoUrl: '/brand/default-logo.svg',
        appSubtitle: '业务管理',
        documentTitleSuffix: 'ID 业务管理'
      };
    } else if (pathname.endsWith('/id-business-v2/time')) {
      data = { now, timezone: 'Asia/Shanghai' };
    } else if (pathname.endsWith('/id-business-v2/change-versions')) {
      data = { generatedAt: now, versions: {} };
    } else if (pathname.endsWith('/id-business-v2/table-preferences')) {
      data = { items: [] };
    } else if (pathname.endsWith('/id-business-v2/bank-recharge/orders')) {
      orderRequests.push(url.search);
      const pageNumber = Number(url.searchParams.get('page') || '1');
      const empty = url.searchParams.get('keyword') === 'empty';
      data = {
        items: empty
          ? []
          : pageNumber === 1
            ? [order]
            : [
                {
                  ...order,
                  id: '77777777-7777-4777-8777-777777777777',
                  orderNo: 'BC-LAST-PAGE',
                  source: 'manual',
                  customer: null,
                  customerId: null,
                  customerFeeRate: '0',
                  customerFeeAmount: '0',
                  status: 'pending_details',
                  financeStatus: 'unposted',
                  profitAmountCny: null,
                  activeSubscription: null
                }
              ],
        total: empty ? 0 : 21,
        page: pageNumber,
        pageSize: 20
      };
    } else if (pathname.endsWith('/id-business-v2/bank-recharge/orders/options')) {
      data = {
        customers: [customer],
        financeAccounts: [
          {
            id: order.receivedFinanceAccountId,
            name: '人民币测试账户',
            currency: 'CNY',
            accountType: 'bank'
          }
        ]
      };
    } else if (pathname.endsWith('/id-business-v2/bank-recharge/accounts')) {
      data = {
        items: showAccounts
          ? [
              {
                ...account,
                status: 'active',
                hasPassword: true,
                hasTotp: true,
                remark: null,
                createdAt: now,
                updatedAt: now
              }
            ]
          : []
      };
    } else if (pathname.endsWith('/id-business-v2/bank-recharge/cards')) {
      data = { items: [card] };
    } else if (pathname.endsWith('/id-business-v2/bank-recharge/currencies')) {
      data = { items: [{ code: 'PHP', name: '菲律宾比索', minorUnits: 2, active: true }] };
    } else if (pathname.endsWith('/id-business-v2/bank-recharge/renewal-warnings')) {
      data = {
        warningDays: 3,
        upcomingCount: 1,
        expiredCount: 0,
        totalCount: 1,
        items: [
          {
            id: 'bank-warning-1',
            orderId,
            orderNo: order.orderNo,
            customerName: customer.name,
            accountMasked: account.emailMasked,
            plan: 'plus',
            dueAt: '2026-09-25T12:00:00.000Z',
            warningState: 'upcoming'
          }
        ],
        evaluatedAt: now,
        revalidateAt: now
      };
    } else if (pathname.endsWith('/id-business-v2/renewals/workbench/bootstrap')) {
      data = {
        list: {
          items: [],
          total: 0,
          page: 1,
          pageSize: 20,
          warningSummary: { warningDays: 3, upcomingCount: 0, expiredCount: 0, totalCount: 0 },
          evaluatedAt: now,
          revalidateAt: now
        },
        options: {
          filters: { customers: [], accounts: [], services: [] },
          manualRenewal: null
        },
        generatedAt: now
      };
    } else if (pathname.endsWith('/id-business-v2/renewals/workbench')) {
      data = {
        items: [],
        total: 0,
        page: 1,
        pageSize: 20,
        warningSummary: { warningDays: 3, upcomingCount: 0, expiredCount: 0, totalCount: 0 },
        evaluatedAt: now,
        revalidateAt: now
      };
    } else if (pathname.endsWith('/id-business-v2/renewals/warning-summary')) {
      data = {
        warningDays: 3,
        defaultWarningDays: 3,
        minWarningDays: 1,
        maxWarningDays: 365,
        updatedAt: null,
        upcomingCount: 0,
        expiredCount: 0,
        totalCount: 0,
        items: [],
        evaluatedAt: now,
        revalidateAt: now
      };
    } else if (pathname.endsWith('/id-business-v2/sensitive-access/approvals/summary')) {
      data = { pendingCount: 0, items: [], generatedAt: now };
    } else if (pathname.endsWith('/id-business-v2/customers/bootstrap')) {
      data = {
        list: { items: [], total: 0, page: 1, pageSize: 1 },
        options: { sources: [], tags: [], services: [] },
        generatedAt: now
      };
    } else if (pathname.endsWith('/id-business-v2/customers') && request.method() === 'POST') {
      data = {
        id: newCustomerId,
        name: request.postDataJSON().name,
        wechat: null,
        qq: null,
        maskedPhone: null,
        maskedWhatsapp: null
      };
    } else {
      unexpected.push(`${request.method()} ${pathname}`);
      await route.fulfill({
        status: 500,
        contentType: 'application/json',
        body: JSON.stringify({ success: false, message: 'Unexpected acceptance request' })
      });
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: true,
        data,
        message: 'OK',
        requestId: 'bank-acceptance',
        timestamp: now
      })
    });
  });

  await page.goto(`${baseUrl}/v2/auto-recharge/bank-orders`, { waitUntil: 'domcontentloaded' });
  try {
    await page.getByText('BC20260923120000LONGORDER').waitFor({ state: 'visible', timeout: 15000 });
  } catch (error) {
    await page.screenshot({ path: path.join(outputDir, 'bank-orders-debug.png'), fullPage: true });
    throw new Error(
      `银充页面未显示订单：url=${page.url()}；请求=${unexpected.join(', ')}；错误=${runtimeErrors.join(', ')}；页面=${(await page.locator('body').innerText()).slice(0, 1200)}`,
      { cause: error }
    );
  }
  for (const width of [2307, 1440, 900, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const mobileOverlay = page.locator('.v2-mobile-overlay');
    if (await mobileOverlay.isVisible()) await mobileOverlay.click();
    await page.waitForTimeout(300);
    await assertListHeaderLayout(page, `${width}px 银充订单`);
    await page.screenshot({
      path: path.join(outputDir, `bank-orders-${width}.png`),
      fullPage: true
    });
    const layout = await page.evaluate(() => {
      const table = document.querySelector('.bank-recharge-nowrap');
      const row = table?.querySelector('.el-table__body tr.el-table__row');
      const cells = [...(row?.querySelectorAll('td .cell') ?? [])];
      const actions = [...(row?.querySelectorAll('.v2-table-actions button') ?? [])];
      const actionCell = row?.querySelector('.v2-table-action-column');
      const scroll = table?.querySelector('.el-scrollbar__wrap');
      return {
        rowHeight: row?.getBoundingClientRect().height ?? 0,
        cellWhiteSpace: cells.map((cell) => getComputedStyle(cell).whiteSpace),
        actionCount: actions.length,
        actionsInside: actions.every((button) => {
          const buttonBox = button.getBoundingClientRect();
          const cellBox = actionCell?.getBoundingClientRect();
          return (
            cellBox && buttonBox.left >= cellBox.left - 1 && buttonBox.right <= cellBox.right + 1
          );
        }),
        pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
        tableScrollWidth: scroll?.scrollWidth ?? 0,
        tableClientWidth: scroll?.clientWidth ?? 0
      };
    });
    assert.ok(
      layout.rowHeight > 0 && layout.rowHeight <= 60,
      `${width}px 表格行出现换行：${JSON.stringify(layout)}`
    );
    assert.ok(
      layout.cellWhiteSpace.length > 0 && layout.cellWhiteSpace.every((item) => item === 'nowrap'),
      `${width}px 存在多行单元格：${JSON.stringify(layout)}`
    );
    assert.equal(layout.actionCount, 2, `${width}px 操作按钮不完整`);
    assert.ok(layout.actionsInside, `${width}px 操作按钮超出操作列`);
    assert.ok(layout.pageOverflow <= 1, `${width}px 页面横向溢出：${layout.pageOverflow}`);
    if (width === 390)
      assert.ok(layout.tableScrollWidth > layout.tableClientWidth, '窄屏表格未在容器内横向滚动');
  }
  await page.getByRole('button', { name: '下一页' }).click();
  try {
    await page.getByText('BC-LAST-PAGE').waitFor({ state: 'visible', timeout: 10000 });
  } catch (error) {
    await page.screenshot({
      path: path.join(outputDir, 'bank-orders-last-debug.png'),
      fullPage: true
    });
    throw new Error(
      `末页未显示：请求=${orderRequests.join(', ')}；页面=${(await page.locator('body').innerText()).slice(-1300)}`,
      { cause: error }
    );
  }
  await page.getByRole('button', { name: '修改' }).click();
  await page.getByText('银充订单资料').waitFor({ state: 'visible' });
  await page
    .locator('.el-form-item')
    .filter({ hasText: '客户手续费率' })
    .locator('input')
    .fill('2.5');
  try {
    await page.getByText(/25(?:\.0+)? PHP/).waitFor({ state: 'visible', timeout: 3000 });
  } catch (error) {
    await page.screenshot({
      path: path.join(outputDir, 'bank-orders-fee-debug.png'),
      fullPage: true
    });
    throw new Error(`手续费预览不符：${(await page.locator('body').innerText()).slice(-1500)}`, {
      cause: error
    });
  }
  await page.getByRole('button', { name: '新增客户' }).click();
  await page.getByText('快速建立客户资料').waitFor({ state: 'visible' });
  await page.getByPlaceholder('输入客户名称').fill('新建银充客户');
  await page.getByRole('button', { name: '保存并选中' }).click();
  await page
    .getByLabel('银充订单资料')
    .getByText('新建银充客户', { exact: true })
    .waitFor({ state: 'visible' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText('BC20260923120000LONGORDER').waitFor({ state: 'visible' });
  await page.getByRole('textbox', { name: '搜索银充订单' }).fill('empty');
  await page.getByRole('button', { name: '查询' }).click();
  await page.getByText('暂无银充订单').waitFor({ state: 'visible' });
  await assertListHeaderLayout(page, '390px 银充订单空状态');
  await page.screenshot({ path: path.join(outputDir, 'bank-orders-empty-390.png') });
  await page.goto(`${baseUrl}/v2/workbench/renewals`, { waitUntil: 'domcontentloaded' });
  await page.getByText('银充续费提醒').waitFor({ state: 'visible' });
  await page.getByText(customer.name).waitFor({ state: 'visible' });
  await page.getByText(order.orderNo).waitFor({ state: 'visible' });
  await page.waitForFunction(() => {
    const tag = document.querySelector('.bank-recharge-renewal-list .el-tag');
    return tag && !tag.classList.contains('el-zoom-in-center-enter-active');
  });
  const renewalFits = await page
    .locator('.bank-recharge-renewal-list')
    .evaluate((element) => element.scrollWidth <= element.clientWidth);
  assert.ok(renewalFits, '窄屏银充续费提醒出现横向溢出');
  const warningTagWidth = await page
    .locator('.bank-recharge-renewal-list .el-tag')
    .evaluate((element) => element.getBoundingClientRect().width);
  assert.ok(warningTagWidth >= 70, '窄屏续费状态标签被裁切');
  await page.locator('.bank-recharge-renewals').screenshot({
    path: path.join(outputDir, 'bank-renewals-390.png')
  });
  await page.goto(`${baseUrl}/v2/auto-recharge/chatgpt-accounts`, {
    waitUntil: 'domcontentloaded'
  });
  await page.getByText(account.emailMasked).waitFor({ state: 'visible' });
  for (const width of [2307, 1440, 900, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await assertListHeaderLayout(page, `${width}px ChatGPT 账号`);
    if (width === 2307 || width === 390) {
      await page.screenshot({
        path: path.join(outputDir, `bank-chatgpt-accounts-${width}.png`),
        fullPage: true
      });
    }
  }
  showAccounts = false;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText('暂无 ChatGPT 账号').waitFor({ state: 'visible' });
  await assertListHeaderLayout(page, '390px ChatGPT 账号空状态');
  await page.screenshot({ path: path.join(outputDir, 'bank-chatgpt-accounts-empty-390.png') });
  await page.getByRole('button', { name: '新增账号' }).click();
  await page.getByPlaceholder('输入 ChatGPT 登录邮箱').waitFor({ state: 'visible' });
  await page.getByPlaceholder('输入登录密码').waitFor({ state: 'visible' });
  await page.getByPlaceholder('Base32 密钥或 otpauth 链接；可稍后补充').waitFor({
    state: 'visible'
  });
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(outputDir, 'bank-chatgpt-accounts-390.png') });
  assert.deepEqual(unexpected, [], `存在未模拟请求：${unexpected.join(', ')}`);
  assert.deepEqual(runtimeErrors, [], `浏览器异常：${runtimeErrors.join(', ')}`);
  console.log(
    JSON.stringify({
      ok: true,
      widths: [2307, 1440, 900, 390],
      states: ['first', 'last', 'empty'],
      outputDir
    })
  );
  await context.close();
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => server.once('close', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);
  if (server.exitCode === null) server.kill('SIGKILL');
}

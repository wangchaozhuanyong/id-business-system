#!/usr/bin/env node
/* global document, getComputedStyle, window */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const adminDir = path.join(root, 'apps/admin');
const port = Number(process.env.BIT_ORDER_UI_PORT ?? '5385');
assert.ok(Number.isInteger(port) && port > 1024 && port <= 65535, '本地验收端口无效');
const baseUrl = `http://127.0.0.1:${port}`;
const outputDir = path.resolve(root, process.argv[2] ?? '.runtime/bit-orders-20261010/ui');
const now = new Date('2026-09-23T12:00:00.000Z').toISOString();
const orderId = '22222222-2222-4222-8222-222222222222';
const accountId = '33333333-3333-4333-8333-333333333333';
const customerId = '44444444-4444-4444-8444-444444444444';
const cardId = '55555555-5555-4555-8555-555555555555';
const customer = { id: customerId, name: '比特充值测试客户长名称用于验证单行显示' };
const newCustomerId = '88888888-8888-4888-8888-888888888888';
const account = { id: accountId, emailMasked: 'te***@example.invalid' };
const card = {
  id: cardId,
  label: '菲律宾比特充值 Visa 卡长名称',
  last4: '4444',
  currencyCode: 'PHP',
  active: true
};
const mutations = [];
const order = {
  id: orderId,
  orderNo: 'BC20260923120000LONGORDER',
  source: 'automatic',
  rechargeJobId: '15151515-1515-4515-8515-151515151515',
  accountId,
  account,
  customerId,
  customer,
  cardId,
  card,
  activeSubscription: { status: 'active' },
  cardLast4: '4444',
  plan: 'plus',
  chargeAmount: '1000.0000',
  chargeCurrencyCode: 'PHP',
  chargeCountryCode: 'PH',
  accountingVersion: 'subscription_cost_v2',
  usdtFeeAmount: '3',
  usdtFeeCurrencyCode: 'CNY',
  usdtFeeFinanceAccountId: '66666666-6666-4666-8666-666666666666',
  usdtFeeFxRateToCny: '1',
  usdtFeeAmountCny: '3',
  shoppingFeeAmount: '2',
  shoppingFeeCurrencyCode: 'CNY',
  shoppingFeeFinanceAccountId: '66666666-6666-4666-8666-666666666666',
  shoppingFeeFxRateToCny: '1',
  shoppingFeeAmountCny: '2',
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
  profitAmountCny: '1065.0000',
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

const pricingSettings = {
  receivedCurrencyCode: 'CNY',
  shoppingFeePercent: '0.1',
  usdtFeePercent: '2.5',
  planPrices: {
    go: '500',
    plus: '1000',
    'pro-5x': null,
    'pro-20x': null,
    'pro-500': null,
    business: null,
    enterprise: null,
    edu: null
  },
  updatedAt: now
};
const pricingRates = [
  {
    currency: 'PHP',
    rateToCny: '0.13',
    id: 'fx-php',
    capturedAt: now,
    expiresAt: '2027-01-01T00:00:00.000Z'
  },
  {
    currency: 'USDT',
    rateToCny: '7',
    id: 'fx-usdt',
    capturedAt: now,
    expiresAt: '2027-01-01T00:00:00.000Z'
  }
];
const pendingGo = {
  ...order,
  id: '12121212-1212-4212-8212-121212121212',
  orderNo: 'BC-BIT-GO-PAID-100',
  rechargeJobId: '16161616-1616-4616-8616-161616161616',
  plan: 'go',
  chargeAmount: '100.0000',
  receivedAmount: null,
  receivedCurrencyCode: null,
  usdtFeeAmount: null,
  shoppingFeeAmount: null,
  usdtFeeCurrencyCode: null,
  shoppingFeeCurrencyCode: null,
  usdtFeeFxRateToCny: null,
  shoppingFeeFxRateToCny: null,
  chargeFxRateToCny: null,
  profitAmountCny: null,
  status: 'pending_details',
  financeStatus: 'unposted'
};
const pendingUpgrade = {
  ...pendingGo,
  id: '13131313-1313-4313-8313-131313131313',
  orderNo: 'BC-BIT-PLUS-UPGRADE-60',
  rechargeJobId: '17171717-1717-4717-8717-171717171717',
  plan: 'plus',
  chargeAmount: '60.0000',
  // 官网后续续费价不能代替本次补付金额。
  rechargeJob: {
    executionMode: 'bitbrowser',
    currentPlan: 'go',
    quote: { renewalAmount: '1000', payableAmount: '60' }
  }
};
const layoutMeasurements = [];

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
      const titleText = title.querySelector('.v2-section-heading__text');
      const countText = header.querySelector('.v2-section-heading__actions > span');
      const textRect = (element) => {
        if (!element) return null;
        const range = document.createRange();
        range.selectNodeContents(element);
        const rect = range.getBoundingClientRect();
        return {
          top: rect.top,
          bottom: rect.bottom,
          height: rect.height,
          lineHeight: getComputedStyle(element).lineHeight
        };
      };
      return {
        listWidth: listBox.width,
        listHeight: listBox.height,
        titleText: textRect(titleText),
        countText: textRect(countText),
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
  if (
    layout.titleText &&
    layout.countText &&
    Math.abs(layout.titleText.top - layout.countText.top) < 10
  ) {
    assert.equal(
      layout.titleText.lineHeight,
      layout.countText.lineHeight,
      `${label} 标题/总数行高不一致`
    );
    assert.ok(
      Math.abs(
        (layout.titleText.top + layout.titleText.bottom) / 2 -
          (layout.countText.top + layout.countText.bottom) / 2
      ) <= 1,
      `${label} 实际标题/总数文字错位：${JSON.stringify(layout)}`
    );
  }
  layoutMeasurements.push({ label, ...layout });
}

function formInput(drawer, label) {
  return drawer
    .locator('.el-form-item')
    .filter({ hasText: label })
    .first()
    .locator('input')
    .first();
}
async function waitForFixture(test, label) {
  for (let attempt = 0; attempt < 150; attempt += 1) {
    if (test()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${label} 未在限定时间内发生`);
}
async function listFrame(page) {
  await page.waitForTimeout(350);
  return page.locator('.bank-recharge-page .v2-records-list').evaluate((element) => {
    const box = element.getBoundingClientRect();
    const measure = (target) =>
      target
        ? {
            height: target.getBoundingClientRect().height,
            minHeight: getComputedStyle(target).minHeight
          }
        : null;
    return {
      width: box.width,
      height: box.height,
      header: measure(element.querySelector(':scope > header')),
      footer: measure(element.querySelector(':scope > footer')),
      shell: measure(element.querySelector(':scope > .v2-unified-table-shell')),
      table: measure(element.querySelector('.el-table')),
      tableHeader: measure(element.querySelector('.el-table__header-wrapper')),
      tableBody: measure(element.querySelector('.el-table__body-wrapper')),
      empty: measure(element.querySelector('.el-table__empty-block')),
      helpHeader: measure(element.querySelector('.v2-records-help-title')),
      rememberedHeight: getComputedStyle(element).getPropertyValue(
        '--v2-records-list-body-min-height'
      )
    };
  });
}

async function assertDrawerLayout(page, title) {
  const drawer = page.getByLabel(title, { exact: true });
  await page.waitForFunction((heading) => {
    const element = [...document.querySelectorAll('.el-drawer')].find(
      (item) => item.getAttribute('aria-label') === heading
    );
    const box = element?.getBoundingClientRect();
    return box && box.left >= 0 && box.right <= window.innerWidth + 1;
  }, title);
  const layout = await drawer.evaluate((element) => ({
    bodyFits:
      element.querySelector('.el-drawer__body').scrollWidth <=
      element.querySelector('.el-drawer__body').clientWidth + 1,
    footerFits: [...element.querySelectorAll('.el-drawer__footer button')].every((button) => {
      const box = button.getBoundingClientRect();
      return box.left >= 0 && box.right <= window.innerWidth + 1;
    })
  }));
  assert.ok(
    layout.bodyFits && layout.footerFits,
    `${title} 内容或按钮超出窄屏：${JSON.stringify(layout)}`
  );
}

mkdirSync(outputDir, { recursive: true });
const server = spawn(
  process.execPath,
  [
    path.join(root, 'node_modules/vite/bin/vite.js'),
    '--host',
    '127.0.0.1',
    '--port',
    String(port),
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
  await page.clock.install();
  const unexpected = [];
  const pricingMutations = [];
  let failNextPricingSave = false;
  let holdNextPricingSave = false;
  let pendingPricingSave;
  let releasePricingSave;
  let failNextOrderRead = false;
  let pricingRevision = 0;
  const orderRequests = [];
  const runtimeErrors = [];
  let showAccounts = true;
  let accountStatus = 'active';
  let managedCards = [
    {
      ...card,
      status: 'active',
      expiry: '12/39',
      hasNumber: true,
      remark1: '常用',
      remark2: '测试',
      accountCount: 1,
      createdAt: now,
      updatedAt: now
    }
  ];
  const importedCardId = '99999999-9999-4999-8999-999999999999';
  page.on('pageerror', (error) => runtimeErrors.push(error.message));
  await context.route('**/*', async (route) => {
    if (new URL(route.request().url()).origin === baseUrl) return route.continue();
    unexpected.push(
      `EXTERNAL ${route.request().method()} ${new URL(route.request().url()).origin}`
    );
    await route.abort('blockedbyclient');
  });
  await page.addInitScript(() => {
    const user = {
      id: '11111111-1111-4111-8111-111111111111',
      username: 'bank-acceptance',
      displayName: '比特充值验收管理员',
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
        displayName: '比特充值验收管理员',
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
    } else if (pathname.endsWith('/id-business-v2/vendure-mailboxes/primary-accounts')) {
      data = {
        items: [{ id: 'fixture-primary', email: 'primary@example.invalid', status: 'ACTIVE' }],
        total: 1,
        page: 1,
        pageSize: 1000
      };
    } else if (pathname.endsWith('/id-business-v2/table-preferences')) {
      data = { items: [] };
    } else if (pathname.endsWith('/id-business-v2/bank-recharge/order-pricing-settings')) {
      if (request.method() === 'PUT') {
        const input = request.postDataJSON();
        pricingMutations.push(input);
        if (failNextPricingSave || input.updatedAt !== pricingSettings.updatedAt) {
          const message = failNextPricingSave
            ? '验收模拟：比例保存失败'
            : '收费设置已被其他管理员修改，请刷新后核对';
          const status = failNextPricingSave ? 422 : 409;
          failNextPricingSave = false;
          await route.fulfill({
            status,
            contentType: 'application/json',
            body: JSON.stringify({ success: false, message, requestId: 'pricing-failure' })
          });
          return;
        }
        if (holdNextPricingSave) {
          holdNextPricingSave = false;
          pendingPricingSave = input;
          await new Promise((resolve) => {
            releasePricingSave = resolve;
          });
          pendingPricingSave = undefined;
        }
        Object.assign(pricingSettings, input, {
          updatedAt: new Date(Date.parse(now) + ++pricingRevision).toISOString()
        });
      }
      data = structuredClone(pricingSettings);
    } else if (pathname.endsWith('/id-business-v2/bank-recharge/order-pricing-rates')) {
      data = { items: pricingRates, generatedAt: now };
    } else if (
      /\/bank-recharge\/orders\/[^/]+\/(correct|refund)$/.test(pathname) &&
      request.method() === 'POST'
    ) {
      const input = request.postDataJSON();
      mutations.push({ pathname, input });
      data = { ...order, ...input, updatedAt: new Date(Date.parse(now) + 1).toISOString() };
    } else if (pathname.endsWith('/id-business-v2/bank-recharge/orders')) {
      orderRequests.push(url.search);
      if (failNextOrderRead) {
        await route.fulfill({
          status: 503,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, message: '验收模拟：订单读取失败' })
        });
        return;
      }
      const pageNumber = Number(url.searchParams.get('page') || '1');
      const empty = url.searchParams.get('keyword') === 'empty';
      data = {
        items: empty
          ? []
          : pageNumber === 1
            ? [order, pendingGo, pendingUpgrade]
            : [
                {
                  ...order,
                  id: '77777777-7777-4777-8777-777777777777',
                  orderNo: 'BC-LAST-PAGE',
                  source: 'manual',
                  rechargeJobId: null,
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
        pageSize: 20,
        evaluatedAt: now,
        revalidateAt: '2027-01-01T00:00:00.000Z'
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
    } else if (
      pathname.endsWith('/id-business-v2/bank-recharge/accounts/import') &&
      request.method() === 'POST'
    ) {
      const input = request.postDataJSON();
      assert.equal(input.accounts.length, 1);
      assert.equal(input.accounts[0].email, 'new@example.invalid');
      assert.equal(input.accounts[0].password, '');
      assert.equal(input.accounts[0].totpSecret, 'JBSWY3DPEHPK3PXP');
      assert.equal(input.accounts[0].remark, '导入备注');
      showAccounts = true;
      account.emailMasked = 'ne***@example.invalid';
      data = { imported: 1 };
    } else if (
      pathname.endsWith(`/id-business-v2/bank-recharge/accounts/${accountId}`) &&
      request.method() === 'PATCH'
    ) {
      const input = request.postDataJSON();
      if (input.email) {
        assert.equal(input.email, 'updated@example.invalid');
        assert.equal(input.password, 'updated-pass');
        assert.equal(input.totpSecret, 'JBSWY3DPEHPK3PXP');
        account.emailMasked = 'up***@example.invalid';
      }
      if (input.status) accountStatus = input.status;
      data = { id: accountId, emailMasked: account.emailMasked, status: accountStatus };
    } else if (
      pathname.endsWith(`/id-business-v2/bank-recharge/accounts/${accountId}/lifecycle-preview`)
    ) {
      assert.equal(url.searchParams.get('action'), 'delete');
      data = {
        id: accountId,
        entity: 'account',
        action: 'delete',
        label: account.emailMasked,
        status: accountStatus,
        deletedAt: null,
        expectedUpdatedAt: now,
        references: {},
        previewFingerprint: 'synthetic-account-delete-preview'
      };
    } else if (
      pathname.endsWith(`/id-business-v2/bank-recharge/accounts/${accountId}`) &&
      request.method() === 'DELETE'
    ) {
      const input = request.postDataJSON();
      assert.equal(input.reason, '仿真账号误录，移入回收站');
      assert.equal(input.expectedUpdatedAt, now);
      assert.equal(input.previewFingerprint, 'synthetic-account-delete-preview');
      assert.match(input.operationId, /^[0-9a-f-]{36}$/);
      showAccounts = false;
      data = { id: accountId };
    } else if (pathname.endsWith('/id-business-v2/bank-recharge/accounts')) {
      data = {
        total: showAccounts ? 1 : 0,
        page: 1,
        pageSize: 20,
        items: showAccounts
          ? [
              {
                ...account,
                status: accountStatus,
                hasPassword: true,
                hasTotp: true,
                firstLoginNetwork: { ip: '8.8.8.8', countryCode: 'US', observedAt: now },
                lastLoginNetwork: { ip: '1.1.1.1', countryCode: 'US', observedAt: now },
                remark: null,
                createdAt: now,
                updatedAt: now
              }
            ]
          : []
      };
    } else if (
      pathname.endsWith('/id-business-v2/bank-recharge/cards/management/import') &&
      request.method() === 'POST'
    ) {
      const input = request.postDataJSON();
      assert.equal(input.currencyCode, 'PHP');
      assert.equal(input.cards[0].number, '4111111111111111');
      assert.equal(input.cards[0].remark1, '新卡');
      assert.equal(input.cards[0].cvc, undefined);
      managedCards.unshift({
        ...managedCards[0],
        id: importedCardId,
        label: '银行卡 ····1111',
        last4: '1111',
        accountCount: 0,
        remark1: '新卡',
        remark2: '备用'
      });
      data = { imported: 1 };
    } else if (
      pathname.endsWith(`/id-business-v2/bank-recharge/cards/management/${importedCardId}`) &&
      request.method() === 'PATCH'
    ) {
      const input = request.postDataJSON();
      managedCards[0] = {
        ...managedCards[0],
        label: input.label ?? managedCards[0].label,
        status: input.status ?? managedCards[0].status,
        remark1: input.remark1 ?? managedCards[0].remark1
      };
      data = { id: importedCardId };
    } else if (
      pathname.endsWith(`/id-business-v2/bank-recharge/cards/management/${importedCardId}`) &&
      request.method() === 'DELETE'
    ) {
      managedCards = managedCards.filter((item) => item.id !== importedCardId);
      data = { id: importedCardId };
    } else if (
      pathname.endsWith(`/id-business-v2/bank-recharge/cards/management/${cardId}/orders`)
    ) {
      data = {
        items: [
          {
            id: orderId,
            orderNo: order.orderNo,
            accountId,
            account,
            chargeAmount: '1000.0000',
            chargeCurrencyCode: 'PHP',
            status: 'completed',
            verifiedAt: now,
            createdAt: now
          }
        ],
        total: 1,
        page: 1,
        pageSize: 20
      };
    } else if (
      pathname.endsWith(`/id-business-v2/bank-recharge/cards/management/${cardId}`) &&
      request.method() === 'GET'
    ) {
      data = {
        ...managedCards.find((item) => item.id === cardId),
        number: '5555555555554444'
      };
    } else if (pathname.endsWith('/id-business-v2/bank-recharge/cards/management')) {
      const empty = url.searchParams.get('keyword') === 'empty';
      const pageNumber = Number(url.searchParams.get('page') || '1');
      const items = empty
        ? []
        : managedCards.filter(
            (item) =>
              !url.searchParams.get('status') || item.status === url.searchParams.get('status')
          );
      data = {
        items: pageNumber === 1 ? items : [],
        total: items.length,
        page: pageNumber,
        pageSize: 20
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
      `比特充值页面未显示订单：url=${page.url()}；请求=${unexpected.join(', ')}；错误=${runtimeErrors.join(', ')}；页面=${(await page.locator('body').innerText()).slice(0, 1200)}`,
      { cause: error }
    );
  }
  assert.ok(
    orderRequests.some(
      (search) => new URLSearchParams(search).get('executionSource') === 'bitbrowser'
    ),
    '比特订单初次读取未限定原比特浏览器来源'
  );
  const completedRow = page
    .locator('.el-table__body tr.el-table__row')
    .filter({ hasText: order.orderNo })
    .first();
  const goRow = page
    .locator('.el-table__body tr.el-table__row')
    .filter({ hasText: pendingGo.orderNo })
    .first();
  const upgradeRow = page
    .locator('.el-table__body tr.el-table__row')
    .filter({ hasText: pendingUpgrade.orderNo })
    .first();
  await upgradeRow.getByText('991.0047（预估）', { exact: true }).waitFor({ state: 'visible' });
  assert.match(await goRow.innerText(), /100\.0000 PHP · 菲律宾/);
  assert.match(await goRow.innerText(), /500 CNY（待核收）/);
  assert.match(await upgradeRow.innerText(), /60\.0000 PHP · 菲律宾/);
  assert.match(await upgradeRow.innerText(), /0\.0279 USDT（预估）/);
  assert.match(await upgradeRow.innerText(), /1(?:\.00)? CNY（预估）/);
  assert.match(await upgradeRow.innerText(), /1000 CNY（待核收）/);
  assert.match(await completedRow.innerText(), /1065\.0000/);
  assert.doesNotMatch(await completedRow.innerText(), /预估/);
  await page.getByRole('button', { name: /^使用状态说明：/ }).click();
  await page
    .locator('.feature-help-popper')
    .getByText('使用中：对应订阅记录处于有效状态，且没有判定为已到期。', { exact: true })
    .waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: '收费与手续费设置', exact: true }).click();
  const pricingDrawer = page.getByLabel('比特订单收费设置', { exact: true });
  await formInput(pricingDrawer, 'Go 收费').waitFor({ state: 'visible' });
  assert.equal(await formInput(pricingDrawer, 'Go 收费').inputValue(), '500');
  assert.equal(await formInput(pricingDrawer, 'Plus 收费').inputValue(), '1000');
  assert.equal(await formInput(pricingDrawer, '购物网手续费').inputValue(), '0.1');
  assert.equal(await formInput(pricingDrawer, 'USDT 手续费').inputValue(), '2.5');
  assert.match(
    await pricingDrawer
      .locator('.el-form-item')
      .filter({ hasText: '客户收款币种' })
      .first()
      .innerText(),
    /人民币（CNY）/
  );
  await pricingDrawer.getByRole('combobox', { name: '客户收款默认币种' }).click();
  await page.getByRole('option', { name: '马币（MYR）', exact: true }).click();
  assert.match(
    await pricingDrawer
      .locator('.el-form-item')
      .filter({ hasText: '客户收款币种' })
      .first()
      .innerText(),
    /马币（MYR）/
  );
  await pricingDrawer.getByRole('combobox', { name: '客户收款默认币种' }).click();
  await page.getByRole('option', { name: '人民币（CNY）', exact: true }).click();
  await formInput(pricingDrawer, '购物网手续费').fill('0.01');
  failNextPricingSave = true;
  await pricingDrawer.getByRole('button', { name: '保存', exact: true }).click();
  await pricingDrawer
    .locator('[role="alert"]')
    .filter({ hasText: '验收模拟：比例保存失败' })
    .waitFor({ state: 'visible' });
  assert.equal(
    await formInput(pricingDrawer, '购物网手续费').inputValue(),
    '0.01',
    '失败保存清空了比例草稿'
  );
  await pricingDrawer.getByRole('button', { name: '关闭', exact: true }).click();
  await pricingDrawer.waitFor({ state: 'hidden' });
  await page.locator('a[href="/v2/auto-recharge/chatgpt-accounts"]').first().click();
  await page.waitForURL('**/v2/auto-recharge/chatgpt-accounts');
  await page.locator('a[href="/v2/auto-recharge/bank-orders"]').first().click();
  await page.waitForURL('**/v2/auto-recharge/bank-orders');
  await page.getByRole('button', { name: '收费与手续费设置', exact: true }).click();
  await formInput(pricingDrawer, '购物网手续费').waitFor({ state: 'visible' });
  assert.equal(
    await formInput(pricingDrawer, '购物网手续费').inputValue(),
    '0.01',
    '切页后收费设置草稿丢失'
  );
  await formInput(pricingDrawer, '购物网手续费').fill('0.1');
  await formInput(pricingDrawer, 'Go 收费').fill('501');
  holdNextPricingSave = true;
  await pricingDrawer.getByRole('button', { name: '保存', exact: true }).click();
  await waitForFixture(() => Boolean(pendingPricingSave), '等待收费保存请求');
  await formInput(pricingDrawer, 'Go 收费').fill('502');
  releasePricingSave();
  await page.getByText('套餐收费和手续费比例已保存', { exact: true }).waitFor({ state: 'visible' });
  assert.equal(pricingSettings.planPrices.go, '501', '保存请求没有使用提交快照');
  assert.equal(
    await formInput(pricingDrawer, 'Go 收费').inputValue(),
    '502',
    '迟到保存响应覆盖了后续编辑'
  );
  await pricingDrawer.getByRole('button', { name: '保存', exact: true }).click();
  await pricingDrawer.waitFor({ state: 'hidden' });
  assert.equal(pricingSettings.planPrices.go, '502', '后续编辑未能按新的版本保存');
  await page.getByRole('button', { name: '收费与手续费设置', exact: true }).click();
  await formInput(pricingDrawer, 'Go 收费').waitFor({ state: 'visible' });
  await formInput(pricingDrawer, 'Go 收费').fill('503');
  // 模拟另一管理员修改共享设置；旧草稿必须得到冲突，而不是覆盖新值。
  pricingSettings.planPrices.go = '500';
  pricingSettings.updatedAt = new Date(Date.parse(now) + ++pricingRevision).toISOString();
  await pricingDrawer.getByRole('button', { name: '保存', exact: true }).click();
  await pricingDrawer
    .locator('[role="alert"]')
    .filter({ hasText: '收费设置已被其他管理员修改，请刷新后核对' })
    .waitFor({ state: 'visible' });
  assert.equal(await formInput(pricingDrawer, 'Go 收费').inputValue(), '503', '版本冲突应保留输入');
  assert.equal(pricingSettings.planPrices.go, '500', '旧版本设置覆盖了其他管理员的值');
  await pricingDrawer.getByRole('button', { name: '重新载入已保存设置', exact: true }).click();
  await page.waitForFunction(() => {
    const drawer = [...document.querySelectorAll('.el-drawer')].find(
      (item) => item.getAttribute('aria-label') === '比特订单收费设置'
    );
    const field = [...(drawer?.querySelectorAll('.el-form-item') ?? [])].find(
      (item) => item.querySelector('label')?.textContent?.trim() === 'Go 收费'
    );
    return field?.querySelector('input')?.value === '500';
  });
  await pricingDrawer
    .getByRole('button', { name: '保存', exact: true })
    .waitFor({ state: 'visible' });
  assert.equal(
    await formInput(pricingDrawer, 'Go 收费').inputValue(),
    '500',
    '显式重新载入没有恢复已保存金额'
  );
  await pricingDrawer.getByRole('button', { name: '保存', exact: true }).click();
  await pricingDrawer.waitFor({ state: 'hidden' });
  await page.reload({ waitUntil: 'domcontentloaded' });
  await completedRow.waitFor({ state: 'visible' });
  await upgradeRow.getByText('991.0047（预估）', { exact: true }).waitFor({ state: 'visible' });

  await upgradeRow.getByRole('button', { name: '修改', exact: true }).click();
  const upgradeDrawer = page.getByLabel('比特订单资料', { exact: true });
  await upgradeDrawer.getByRole('button', { name: '按设置计算收款与手续费', exact: true }).click();
  assert.equal(await formInput(upgradeDrawer, '客户实收').inputValue(), '1000');
  assert.equal(await formInput(upgradeDrawer, 'USDT 手续费').inputValue(), '0.0279');
  assert.equal(await formInput(upgradeDrawer, '购物网手续费').inputValue(), '1');
  assert.match(
    await upgradeDrawer
      .locator('.el-form-item')
      .filter({ hasText: '代付金额' })
      .first()
      .innerText(),
    /60\.0000 PHP/
  );
  await formInput(upgradeDrawer, '客户实收').fill('800');
  await upgradeDrawer.getByRole('button', { name: '按设置计算收款与手续费', exact: true }).click();
  assert.equal(
    await formInput(upgradeDrawer, '客户实收').inputValue(),
    '800',
    '按设置计算不应覆盖实际收款'
  );
  assert.equal(
    await formInput(upgradeDrawer, '购物网手续费').inputValue(),
    '0.8',
    '购物网费用未使用实际收款'
  );
  assert.equal(
    await formInput(upgradeDrawer, 'USDT 手续费').inputValue(),
    '0.0279',
    'USDT 费用未使用当次补付金额'
  );
  await upgradeDrawer.getByRole('button', { name: '关闭', exact: true }).click();
  await upgradeDrawer.waitFor({ state: 'hidden' });

  for (const theme of ['light', 'dark']) {
    await page.setViewportSize({ width: 1440, height: 900 });
    await page.getByTitle(theme === 'dark' ? '切换为深色主题' : '切换为浅色主题').click();
    for (const width of [1440, 390]) {
      await page.setViewportSize({ width, height: 900 });
      if (width === 390) await page.keyboard.press('Escape');
      await page.waitForTimeout(350);
      await assertListHeaderLayout(page, `${theme} ${width}px 比特订单`);
      await page.screenshot({
        path: path.join(outputDir, `bit-orders-${theme}-${width}.png`),
        fullPage: true
      });
      await page.getByRole('button', { name: '收费与手续费设置', exact: true }).click();
      await pricingDrawer.waitFor({ state: 'visible' });
      await assertDrawerLayout(page, '比特订单收费设置');
      await page.screenshot({
        path: path.join(outputDir, `pricing-settings-${theme}-${width}.png`),
        fullPage: true
      });
      await pricingDrawer.getByRole('button', { name: '关闭', exact: true }).click();
      await pricingDrawer.waitFor({ state: 'hidden' });
      const overflow = await page.evaluate(
        () => document.documentElement.scrollWidth - window.innerWidth
      );
      assert.ok(overflow <= 1, `${theme} ${width}px 比特订单横向溢出`);
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByTitle('切换为浅色主题').click();
  for (const width of [2307, 1440, 900, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const mobileOverlay = page.locator('.v2-mobile-overlay');
    if (await mobileOverlay.isVisible()) await mobileOverlay.click();
    await page.waitForTimeout(300);
    await assertListHeaderLayout(page, `${width}px 比特订单`);
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
  await page.getByText('使用中', { exact: true }).first().waitFor({ state: 'visible' });
  await page.clock.fastForward(2 * 24 * 60 * 60 * 1000 + 2000);
  await page.getByText('已到期', { exact: true }).first().waitFor({ state: 'visible' });
  await page.getByRole('button', { name: '更多操作', exact: true }).first().click();
  await page.getByRole('menuitem', { name: '更正订单', exact: true }).click();
  await page.getByText('更正比特订单', { exact: true }).waitFor({ state: 'visible' });
  await page.getByPlaceholder('说明资料或账务更正原因').fill('验收到期资料更正');
  await assertDrawerLayout(page, '更正比特订单');
  await page.screenshot({ path: path.join(outputDir, 'bank-correction-390.png'), fullPage: true });
  await page.getByRole('button', { name: '更正并重新入账', exact: true }).click();
  await page.getByText('比特订单已更正并重新入账', { exact: true }).waitFor({ state: 'visible' });
  assert.equal(mutations.at(-1).input.reason, '验收到期资料更正');
  assert.equal(mutations.at(-1).input.chargeAmount, undefined, '自动付款事实不应随更正提交');
  await page.getByRole('button', { name: '更多操作', exact: true }).first().click();
  await page.getByRole('menuitem', { name: '退款与回款', exact: true }).click();
  await page.getByPlaceholder('留空退回剩余实收；仅补上游回款时填 0').fill('50');
  const refundDrawer = page.getByLabel('登记比特充值退款');
  await refundDrawer
    .locator('.el-form-item')
    .filter({ hasText: '退款原因' })
    .locator('input')
    .fill('仅退客户部分款');
  await refundDrawer
    .locator('.el-form-item')
    .filter({ hasText: '退款凭据' })
    .locator('input')
    .fill('synthetic-refund-receipt');
  await assertDrawerLayout(page, '登记比特充值退款');
  await page.screenshot({ path: path.join(outputDir, 'bank-refund-390.png'), fullPage: true });
  await refundDrawer.getByRole('button', { name: '保存', exact: true }).click();
  await page
    .getByText('已按实际退款与回款金额登记账务', { exact: true })
    .waitFor({ state: 'visible' });
  assert.equal(mutations.at(-1).input.customerRefundAmount, '50');
  assert.equal(mutations.at(-1).input.chargeRecoveryAmountCny, '0');
  assert.equal(mutations.at(-1).input.usdtFeeRecoveryAmount, '0');
  assert.equal(mutations.at(-1).input.shoppingFeeRecoveryAmount, '0');
  assert.equal(mutations.at(-1).input.bankFeeRecoveryAmountCny, undefined);
  await refundDrawer.waitFor({ state: 'hidden' });
  await page.locator('.bank-recharge-toolbar .el-select').first().click();
  await page.getByRole('option', { name: '全部来源（含手工历史）', exact: true }).click();
  await completedRow.waitFor({ state: 'visible' });
  const firstFrame = await listFrame(page);
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
  const lastFrame = await listFrame(page);
  assert.ok(
    Math.abs(lastFrame.height - firstFrame.height) <= 1,
    `首末页列表框架跳动：${JSON.stringify({ firstFrame, lastFrame })}`
  );
  await assertListHeaderLayout(page, '390px 比特订单末页');
  await page.getByRole('button', { name: '修改' }).click();
  await page.getByText('比特订单资料').waitFor({ state: 'visible' });
  await page.locator('.el-form-item').filter({ hasText: 'USDT 手续费' }).locator('input').fill('3');
  try {
    await page.getByText('2.3077%', { exact: true }).waitFor({ state: 'visible', timeout: 3000 });
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
  await page.getByPlaceholder('输入客户名称').fill('新建比特充值客户');
  await page.getByRole('button', { name: '保存并选中' }).click();
  await page
    .getByLabel('比特订单资料')
    .getByText('新建比特充值客户', { exact: true })
    .waitFor({ state: 'visible' });
  failNextOrderRead = true;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.getByText('验收模拟：订单读取失败', { exact: true }).waitFor({ state: 'visible' });
  await page.screenshot({
    path: path.join(outputDir, 'bit-orders-failure-390.png'),
    fullPage: true
  });
  failNextOrderRead = false;
  await page.getByRole('button', { name: '重新加载', exact: true }).click();
  await page.getByText('BC20260923120000LONGORDER').waitFor({ state: 'visible' });
  const recoveredFrame = await listFrame(page);
  await page.getByRole('textbox', { name: '搜索比特订单' }).fill('empty');
  await page.getByRole('button', { name: '查询' }).click();
  await page.getByText('暂无比特订单').waitFor({ state: 'visible' });
  await assertListHeaderLayout(page, '390px 比特订单空状态');
  const emptyFrame = await listFrame(page);
  assert.ok(
    Math.abs(emptyFrame.height - recoveredFrame.height) <= 1,
    `空状态改变列表框架：${JSON.stringify({ recoveredFrame, emptyFrame })}`
  );
  await page.screenshot({ path: path.join(outputDir, 'bank-orders-empty-390.png') });
  await page.goto(`${baseUrl}/v2/workbench/renewals`, { waitUntil: 'domcontentloaded' });
  await page.getByText('比特充值续费提醒').waitFor({ state: 'visible' });
  await page.getByText(customer.name).waitFor({ state: 'visible' });
  await page.getByText(order.orderNo).waitFor({ state: 'visible' });
  await page.waitForFunction(() => {
    const tag = document.querySelector('.bank-recharge-renewal-list .el-tag');
    return tag && !tag.classList.contains('el-zoom-in-center-enter-active');
  });
  const renewalFits = await page
    .locator('.bank-recharge-renewal-list')
    .evaluate((element) => element.scrollWidth <= element.clientWidth);
  assert.ok(renewalFits, '窄屏比特充值续费提醒出现横向溢出');
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
  await page.getByText('8.8.8.8 · 美国').waitFor({ state: 'visible' });
  await page.getByText('1.1.1.1 · 美国').waitFor({ state: 'visible' });
  for (const width of [2307, 1440, 900, 390]) {
    await page.setViewportSize({ width, height: 900 });
    if (width <= 900) {
      await page.keyboard.press('Escape');
      await page.waitForFunction(
        () => document.querySelector('.v2-sidebar').getBoundingClientRect().right <= 0
      );
    }
    await page.waitForTimeout(350);
    if (width <= 900) {
      await page
        .locator('.v2-records-table .el-scrollbar__wrap')
        .first()
        .evaluate((element) => {
          element.scrollLeft = element.scrollWidth;
        });
      await page.waitForTimeout(50);
    }
    await assertListHeaderLayout(page, `${width}px ChatGPT 账号`);
    const actionLayout = await page
      .locator('.v2-records-table .v2-table-actions')
      .first()
      .evaluate((element) => {
        const cell = element.closest('.v2-table-action-column');
        const buttons = [...element.querySelectorAll('button')];
        const bounds = cell?.getBoundingClientRect();
        return {
          buttons: buttons.length,
          visible:
            Boolean(bounds) &&
            buttons.every((button) => {
              const box = button.getBoundingClientRect();
              return (
                box.left >= bounds.left - 1 &&
                box.right <= bounds.right + 1 &&
                box.left >= 0 &&
                box.right <= window.innerWidth + 1
              );
            }),
          pageOverflow: document.documentElement.scrollWidth - window.innerWidth
        };
      });
    assert.equal(actionLayout.buttons, 4, `${width}px ChatGPT 操作按钮数量不符`);
    assert.ok(actionLayout.visible, `${width}px ChatGPT 操作按钮被裁切`);
    assert.ok(actionLayout.pageOverflow <= 1, `${width}px ChatGPT 页面横向溢出`);
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
  await page.getByRole('button', { name: '批量导入' }).click();
  await page
    .getByRole('textbox', { name: '粘贴 ChatGPT 账号资料' })
    .fill('new@example.invalid JBSWY3DPEHPK3PXP 导入备注');
  await page.getByRole('button', { name: '导入账号' }).click();
  await page.getByText('ne***@example.invalid').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: '编辑' }).click();
  await page
    .getByPlaceholder('当前 ne***@example.invalid；留空保留')
    .fill('updated@example.invalid');
  await page.getByPlaceholder('留空表示保留原密码').fill('updated-pass');
  await page.getByPlaceholder('Base32 密钥或 otpauth 链接；可稍后补充').fill('JBSWY3DPEHPK3PXP');
  await page.getByRole('button', { name: '保存', exact: true }).click();
  await page.getByText('up***@example.invalid').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: '更多操作' }).click();
  await page.getByText('停用', { exact: true }).click();
  await page
    .locator('.v2-records-table')
    .getByText('停用', { exact: true })
    .first()
    .waitFor({ state: 'visible' });
  assert.equal(accountStatus, 'disabled');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(350);
  await page.getByRole('button', { name: '更多操作' }).click();
  await page.getByRole('menuitem', { name: '移入回收站', exact: true }).click();
  const accountRecycleDialog = page.getByRole('dialog', { name: '移入回收站', exact: true });
  await accountRecycleDialog.locator('textarea').fill('仿真账号误录，移入回收站');
  await accountRecycleDialog.getByRole('button', { name: '移入回收站', exact: true }).click();
  await page.getByText('暂无 ChatGPT 账号').waitFor({ state: 'visible' });
  await page.getByRole('button', { name: '新增账号' }).click();
  await page.getByPlaceholder('输入 ChatGPT 登录邮箱').waitFor({ state: 'visible' });
  await page.getByPlaceholder('选填；未设置密码可留空').waitFor({ state: 'visible' });
  await page.getByPlaceholder('Base32 密钥或 otpauth 链接；可稍后补充').waitFor({
    state: 'visible'
  });
  await page.waitForTimeout(350);
  await page.screenshot({ path: path.join(outputDir, 'bank-chatgpt-accounts-390.png') });

  await page.goto(`${baseUrl}/v2/auto-recharge/bank-cards`, { waitUntil: 'domcontentloaded' });
  await page.getByText(card.label).waitFor({ state: 'visible' });
  for (const width of [2307, 1440, 900, 390]) {
    await page.setViewportSize({ width, height: 900 });
    const mobileOverlay = page.locator('.v2-mobile-overlay');
    if (await mobileOverlay.isVisible()) await mobileOverlay.click();
    await page.waitForTimeout(300);
    await assertListHeaderLayout(page, `${width}px 银行卡`);
    const actions = await page
      .locator('.v2-records-table .v2-table-actions')
      .first()
      .evaluate((element) => {
        const cell = element.closest('.v2-table-action-column');
        const buttons = [...element.querySelectorAll('button')];
        const bounds = cell?.getBoundingClientRect();
        return {
          count: buttons.length,
          visible:
            Boolean(bounds) &&
            buttons.every((button) => {
              const box = button.getBoundingClientRect();
              return box.left >= bounds.left - 1 && box.right <= bounds.right + 1;
            }),
          overflow: document.documentElement.scrollWidth - window.innerWidth
        };
      });
    assert.equal(actions.count, 2, `${width}px 银行卡操作按钮数量不符`);
    assert.ok(actions.visible, `${width}px 银行卡操作按钮被裁切`);
    assert.ok(actions.overflow <= 1, `${width}px 银行卡页面横向溢出`);
  }
  await page.screenshot({ path: path.join(outputDir, 'bank-cards-first-390.png'), fullPage: true });
  await page.getByRole('button', { name: '详细', exact: true }).click();
  await page.getByText('5555555555554444').waitFor({ state: 'visible' });
  await page.getByText(order.orderNo).last().waitFor({ state: 'visible' });
  await assertDrawerLayout(page, '银行卡详细');
  await page.screenshot({
    path: path.join(outputDir, 'bank-cards-detail-390.png'),
    fullPage: true
  });
  await page.getByRole('button', { name: '前往订单' }).click();
  await page.waitForURL(
    (url) =>
      url.pathname.endsWith('/bank-orders') &&
      url.searchParams.get('accountId') === accountId &&
      url.searchParams.get('orderNo') === order.orderNo
  );
  await page.getByLabel('比特订单资料', { exact: true }).waitFor({ state: 'visible' });
  assert.ok(
    orderRequests.some((search) => {
      const params = new URLSearchParams(search);
      return params.get('accountId') === accountId && params.get('keyword') === order.orderNo;
    }),
    '银行卡关联订单跳转后未按账号和订单号筛选'
  );
  await page.goto(`${baseUrl}/v2/auto-recharge/bank-cards`, { waitUntil: 'domcontentloaded' });
  await page.getByText(card.label).waitFor({ state: 'visible' });
  await page.getByRole('button', { name: '批量导入' }).click();
  await page
    .getByRole('textbox', { name: '粘贴银行卡资料' })
    .fill('4111111111111111 12/39 新卡 备用');
  await page.getByRole('button', { name: '导入银行卡' }).click();
  await page.getByText('银行卡 ····1111').waitFor({ state: 'visible' });
  const importedRow = page.locator('.el-table__body tr').filter({ hasText: '1111' });
  await importedRow.getByRole('button', { name: '更多操作' }).click();
  await page.getByRole('menuitem', { name: '编辑' }).click();
  const editCardDrawer = page.getByLabel('编辑银行卡', { exact: true });
  await editCardDrawer
    .locator('.el-form-item')
    .filter({ hasText: '银行卡名称' })
    .locator('input')
    .fill('新卡名称');
  await assertDrawerLayout(page, '编辑银行卡');
  await editCardDrawer.getByRole('button', { name: '保存', exact: true }).click();
  await editCardDrawer.waitFor({ state: 'hidden' });
  await page.getByText('新卡名称').waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await importedRow.getByRole('button', { name: '更多操作' }).click();
  await page.getByRole('menuitem', { name: '停用' }).waitFor({ state: 'visible' });
  await page.getByRole('menuitem', { name: '停用' }).click();
  await importedRow.getByText('停用', { exact: true }).waitFor({ state: 'visible' });
  await page.keyboard.press('Escape');
  await importedRow.getByRole('button', { name: '更多操作' }).click();
  await page.getByRole('menuitem', { name: '删除' }).click();
  await page.getByRole('button', { name: '删除银行卡', exact: true }).click();
  await page.getByText('新卡名称').waitFor({ state: 'detached' });
  await page.getByPlaceholder('名称、卡尾号或备注').fill('empty');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.getByText('暂无银行卡').waitFor({ state: 'visible' });
  await assertListHeaderLayout(page, '390px 银行卡空状态');
  await page.screenshot({ path: path.join(outputDir, 'bank-cards-empty-390.png'), fullPage: true });
  assert.deepEqual(unexpected, [], `存在未模拟请求：${unexpected.join(', ')}`);
  assert.deepEqual(runtimeErrors, [], `浏览器异常：${runtimeErrors.join(', ')}`);
  writeFileSync(
    path.join(outputDir, 'measurements.json'),
    JSON.stringify(
      {
        layoutMeasurements,
        pricingMutations,
        orderRequests,
        firstFrame,
        lastFrame,
        recoveredFrame,
        emptyFrame
      },
      null,
      2
    ) + '\n'
  );
  console.log(
    JSON.stringify({
      ok: true,
      widths: [2307, 1440, 900, 390],
      states: [
        'pricing-default-cny-and-currency-switch',
        'pricing-failure-and-route-draft',
        'pricing-late-save-preserves-edits',
        'pricing-shared-version-conflict',
        'go-payment-and-plus-actual-upgrade-amount',
        'actual-receipt-fee-basis',
        'country-and-usage-status-help',
        'light-dark-pricing-drawers',
        'order-read-failure-retry',
        'first',
        'last',
        'empty',
        'correction',
        'refund',
        'server-clock',
        'expiry-transition',
        'account-import-edit-disable-soft-delete',
        'card-detail-import-edit-disable-delete-empty'
      ],
      outputDir
    })
  );
  await context.close();
} catch (error) {
  const failedPage = browser?.contexts()[0]?.pages().at(-1);
  if (failedPage) {
    await failedPage
      .screenshot({ path: path.join(outputDir, 'failure-current.png'), fullPage: true })
      .catch(() => undefined);
    writeFileSync(
      path.join(outputDir, 'failure-current.txt'),
      `${error.stack}\n\n${await failedPage.locator('body').innerText()}\n`
    );
  }
  throw error;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => server.once('close', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);
  if (server.exitCode === null) server.kill('SIGKILL');
}

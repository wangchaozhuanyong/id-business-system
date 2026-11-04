/* global window */
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';

export const OFFLINE_ORIGIN = 'https://id-interaction-fixture.invalid';
export const fixtureUser = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'synthetic-review',
  displayName: '合成交互验收',
  roles: ['admin'],
  permissions: [],
  mustResetPassword: false
};
const now = '2026-11-02T12:00:00.000Z';
const country = { id: 'country-us', code: 'US', name: '美国' };
const status = { id: 'status-normal', code: 'normal', name: '正常', isSystem: true };
const service = {
  id: 'service-demo',
  code: 'demo',
  name: '合成订阅服务',
  parent: { id: 'category-demo', name: '合成业务' },
  country,
  countryOptionId: country.id,
  businessAmount: '20',
  currencyCode: 'USD'
};
const platform = { id: 'platform-demo', code: 'demo', name: '合成收款平台', currencyCode: 'CNY' };
export function customer(index) {
  return {
    id: `customer-${index}`,
    name: `合成客户${String(index).padStart(2, '0')}${index === 1 ? '·用于检验长文本与操作完整性' : ''}`,
    maskedPhone: null,
    displayPhone: null,
    phoneTail: null,
    hasPhone: false,
    wechat: null,
    hasWechat: false,
    qq: null,
    hasQq: false,
    maskedWhatsapp: null,
    displayWhatsapp: null,
    whatsappTail: null,
    hasWhatsapp: false,
    contactDisplayModes: {
      phone: 'reveal_direct',
      wechat: 'reveal_direct',
      qq: 'reveal_direct',
      whatsapp: 'reveal_direct'
    },
    sourceOptionId: null,
    source: null,
    tagOptionIds: [],
    tags: [],
    serviceOptionIds: [],
    services: [],
    recordStatus: 'active',
    remark: '仅用于离线验收的合成资料',
    createdBy: null,
    createdAt: now,
    updatedAt: now
  };
}
function account(index) {
  return {
    id: `account-${index}`,
    appleIdMasked: `synthetic-${index}@example.invalid`,
    displayAppleId: `synthetic-${index}@example.invalid`,
    hasPassword: false,
    hasPhone: false,
    hasSecurityInfo: false,
    displayPhone: null,
    maskedPhone: null,
    phoneTail: null,
    countryOptionId: country.id,
    country,
    statusOptionId: status.id,
    status,
    supplierOptionId: null,
    supplier: null,
    currentBalance: '20',
    balanceCostAmount: '120',
    purchaseCost: '10',
    purchaseOriginalAmount: '10',
    purchaseCurrency: 'CNY',
    purchaseFxRateToCny: '1',
    purchaseFxSnapshotId: null,
    purchaseFinanceAccountId: null,
    purchaseSupplierAccountId: null,
    purchasedAt: now,
    saleState: 'available',
    soldAt: null,
    soldByOrder: null,
    lossStatus: 'active',
    lossReportedAt: null,
    activeLossId: null,
    recordStatus: 'active',
    disabledReason: null,
    disabledAt: null,
    remark: '合成 ID',
    createdBy: null,
    createdAt: now,
    updatedAt: now
  };
}
function order(index) {
  return {
    id: `order-${index}`,
    orderNo: `SYNTHETIC-${index}`,
    customer: customer(index),
    service,
    account: account(index),
    settlementPlatform: platform,
    platformOrderNo: null,
    maskedWebsiteAccount: null,
    displayWebsiteAccount: null,
    hasWebsiteAccount: false,
    receivedAmount: '160',
    receivedOriginalAmount: '160',
    receivedCurrency: 'CNY',
    receivedFxRateToCny: '1',
    receivedFxSnapshotId: null,
    receivedFinanceAccountId: null,
    receivedFinanceAccount: null,
    receivedAt: now,
    platformFeeAmount: '0',
    accountSource: 'inventory',
    sourceSoldOrderId: null,
    sourceSoldOrder: null,
    accountDisposition: 'retained',
    accountCostAmount: '10',
    appliedAccountCostAmount: '10',
    balanceAmount: '20',
    balanceCurrencyCode: 'USD',
    remainingRefundableBalanceAmount: '20',
    balanceCostAmount: '120',
    refundCostAmount: null,
    profitAmount: null,
    profitRate: null,
    status: 'pending',
    statusChangedAt: now,
    openedAt: null,
    dueAt: null,
    remark: '合成订单',
    createdBy: null,
    createdAt: now,
    updatedAt: now,
    activeLock: null,
    upgradeBalanceReturn: null,
    archivedAt: null,
    operations: {
      canConsume: false,
      canComplete: false,
      canEdit: true,
      canEditCore: true,
      canEditPricing: true,
      canEditReceiptAccount: true,
      canRefund: false,
      canRecordUpgradeBalanceReturn: false,
      canReverseUpgradeBalanceReturn: false,
      canCancel: false,
      canDelete: false
    }
  };
}
const rows = {
  customers: Array.from({ length: 45 }, (_, index) => customer(index + 1)),
  accounts: Array.from({ length: 45 }, (_, index) => account(index + 1)),
  orders: Array.from({ length: 45 }, (_, index) => order(index + 1))
};
export async function offlineAdminContext(browser, distributionDirectory, options = {}) {
  const dist = path.resolve(distributionDirectory);
  assert.ok(existsSync(path.join(dist, 'index.html')), '缺少管理端构建产物');
  const context = await browser.newContext({
    viewport: { width: 1440, height: 1000 },
    ...options,
    serviceWorkers: 'block'
  });
  const control = {
    delayMs: 0,
    holdRead: null,
    failRead: false,
    empty: false,
    failSave: true,
    readCounts: new Map(),
    writes: 0,
    blocked: [],
    errors: []
  };
  await context.addInitScript(
    ({ user, theme, origin }) => {
      if (window.location.origin !== origin) return;
      sessionStorage.setItem(
        'apple_business_auth_v2',
        JSON.stringify({
          schemaVersion: 2,
          credentialId: 'synthetic-offline-credential',
          token: 'synthetic-not-a-real-credential',
          tokenRevision: 1,
          updatedAt: Date.now(),
          userCache: user
        })
      );
      localStorage.setItem(
        'apple_business_browser_session_marker',
        JSON.stringify({ credentialId: 'synthetic-offline-credential', signedOut: false })
      );
      localStorage.setItem('id-business-v2-theme', theme);
    },
    { user: fixtureUser, theme: options.colorScheme ?? 'light', origin: OFFLINE_ORIGIN }
  );
  const assets = new Map();
  await context.route('**/*', async (route) => {
    const request = route.request(),
      url = new URL(request.url()),
      p = url.pathname;
    if (url.origin !== OFFLINE_ORIGIN) {
      control.blocked.push(url.origin);
      return route.abort();
    }
    if (!p.startsWith('/api/')) {
      const pathname =
        p === '/' || p === '/v2' || p.startsWith('/v2/') || p === '/login'
          ? '/index.html'
          : decodeURIComponent(p);
      const file = path.resolve(dist, `.${pathname}`);
      assert.ok(file.startsWith(dist + path.sep), '离线资源越界');
      if (!existsSync(file)) return route.fulfill({ status: 404, body: 'Missing offline asset' });
      const contentType =
        {
          '.html': 'text/html',
          '.js': 'application/javascript',
          '.css': 'text/css',
          '.svg': 'image/svg+xml',
          '.png': 'image/png',
          '.ico': 'image/x-icon',
          '.woff2': 'font/woff2'
        }[path.extname(file)] ?? 'application/octet-stream';
      if (!assets.has(file)) assets.set(file, readFileSync(file));
      return route.fulfill({ status: 200, contentType, body: assets.get(file) });
    }
    const respond = (data) =>
      route.fulfill({
        json: { success: true, data, message: 'OK', requestId: 'synthetic-offline', timestamp: now }
      });
    if (request.method() !== 'GET') {
      if (!/^\/api\/id-business-v2\/customers(?:\/[^/]+)?$/.test(p)) {
        control.blocked.push(`${request.method()} ${p}`);
        return route.abort();
      }
      control.writes++;
      if (control.failSave)
        return route.fulfill({
          status: 500,
          json: { success: false, message: '合成保存失败，请重试' }
        });
      return respond({ ...customer(99), ...request.postDataJSON() });
    }
    control.readCounts.set(p, (control.readCounts.get(p) ?? 0) + 1);
    if (p === '/api/realtime/events')
      return route.fulfill({
        status: 200,
        contentType: 'text/event-stream',
        body: ': synthetic offline heartbeat\n\n'
      });
    if (p.endsWith('/auth/me')) return respond(fixtureUser);
    if (p.endsWith('/auth/session'))
      return respond({ accessToken: 'synthetic-not-a-real-credential', user: fixtureUser });
    if (p.endsWith('/branding/public'))
      return respond({
        appName: '合成交互验收',
        logoText: 'ID',
        logoUrl: '/brand/default-logo.svg',
        appSubtitle: '离线合成环境',
        loginHeroTitle: '合成验收',
        loginNote: '合成验收',
        footerText: '合成验收',
        documentTitleSuffix: '合成验收'
      });
    if (p.endsWith('/time'))
      return respond({ now: new Date().toISOString(), timezone: 'Asia/Shanghai' });
    if (p.endsWith('/change-versions')) return respond({ generatedAt: now, versions: {} });
    if (p.endsWith('/warning-summary')) return respond({ total: 0, warningDays: 7 });
    if (p.endsWith('/warning-settings')) return respond({ warningDays: 7, updatedAt: now });
    if (p.endsWith('/orders/entry-options'))
      return respond({
        customers: rows.customers,
        countries: [
          { ...country, children: [{ id: 'category-demo', name: '合成业务', children: [service] }] }
        ],
        services: [service],
        settlementPlatforms: [platform],
        latestFxRates: [],
        financeAccounts: []
      });
    const key = Object.keys(rows).find((key) => p.includes(`/id-business-v2/${key}`));
    if (key) {
      if (control.holdRead) await control.holdRead;
      if (control.delayMs) await new Promise((resolve) => setTimeout(resolve, control.delayMs));
      if (control.failRead)
        return route.fulfill({
          status: 500,
          json: { success: false, message: '合成读取失败，请重试' }
        });
      const page = Number(url.searchParams.get('page') || 1),
        pageSize = Number(url.searchParams.get('pageSize') || 20);
      const all = control.empty ? [] : rows[key];
      const list = {
        items: all.slice((page - 1) * pageSize, page * pageSize),
        total: all.length,
        page,
        pageSize
      };
      if (p.endsWith('/bootstrap'))
        return respond({
          list,
          options: {
            countries: [country],
            statuses: [status],
            suppliers: [],
            sources: [],
            tags: [],
            services: [service],
            settlementPlatforms: [platform]
          },
          generatedAt: now
        });
      const id = p.split('/').at(-1);
      const row = all.find((row) => row.id === id);
      return respond(row ?? list);
    }
    if (p.includes('/renewals/workbench'))
      return respond({
        list: {
          items: [],
          total: 0,
          page: 1,
          pageSize: 20,
          evaluatedAt: now,
          revalidateAt: null,
          warningSummary: { warningDays: 7, upcomingCount: 0, expiredCount: 0, totalCount: 0 }
        },
        options: {
          filters: { customers: [], accounts: [], services: [], countries: [] },
          manualRenewal: { services: [], settlementPlatforms: [], financeAccounts: [] }
        },
        generatedAt: now
      });
    if (p.endsWith('/roles/bootstrap'))
      return respond({
        list: { items: [], total: 0, page: 1, pageSize: 20 },
        options: { permissions: [], statuses: [] },
        generatedAt: now
      });

    return respond({ items: [], total: 0, page: 1, pageSize: 20, revalidateAt: null });
  });
  context.on('page', (page) => page.on('pageerror', (error) => control.errors.push(error.message)));
  return { context, control };
}
export async function navigateOffline(page, target) {
  await page
    .locator(`a[href="${target}"]`)
    .first()
    .evaluate((element) => element.click());
  await page.waitForURL(`**${target}`);
  await page.locator('#v2-main .v2-async-region[data-v2-query-phase="ready"]').first().waitFor();
}

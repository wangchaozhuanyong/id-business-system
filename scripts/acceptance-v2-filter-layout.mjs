#!/usr/bin/env node
/* global document, getComputedStyle, NodeFilter, window */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const baseUrl = new URL(process.env.V2_FILTER_LAYOUT_ADMIN_URL || 'http://127.0.0.1:5386');
assert.ok(['localhost', '127.0.0.1', '::1'].includes(baseUrl.hostname), '只允许本机布局验收');
const outputDir = path.resolve(
  root,
  process.argv.slice(2).find((arg) => !arg.startsWith('--')) ?? '.runtime/filter-layout-20261001'
);
mkdirSync(outputDir, { recursive: true });
const widths = [1920, 1440, 1180, 1024, 901, 900, 768, 640, 390];
const checks = [];
const lifecycleOnly = process.argv.includes('--lifecycle-only');
const realToolbarOnly = process.argv.includes('--real-toolbar-only');
const fromMobilePagination = process.argv.includes('--from-mobile-pagination');
const lifecycleTheme = process.argv
  .find((arg) => arg.startsWith('--lifecycle-theme='))
  ?.split('=')[1];
assert.ok(
  !lifecycleTheme || ['light', 'dark'].includes(lifecycleTheme),
  '生命周期主题只允许light/dark'
);
const customerReads = [];
const afterToolbar = process.argv.includes('--after-toolbar') || fromMobilePagination;
assert.ok(
  [lifecycleOnly, realToolbarOnly, afterToolbar].filter(Boolean).length <= 1,
  '验收分段模式不能同时启用'
);
let fixtureGroups = 0;
const errors = [];
const alignmentErrors = [];
const user = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'layout-fixture',
  displayName: '布局验收管理员',
  roles: ['super_admin', 'admin'],
  permissions: [],
  mustResetPassword: false
};
const now = '2026-10-01T12:00:00.000Z';
let customerCount = 2;
let customerReadBehavior = 'normal';
const customer = (index) => ({
  id: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`,
  name: `本地布局客户 ${index}`,
  maskedPhone: null,
  displayPhone: null,
  hasPhone: false,
  wechat: null,
  hasWechat: false,
  qq: null,
  hasQq: false,
  maskedWhatsapp: null,
  displayWhatsapp: null,
  hasWhatsapp: false,
  contactDisplayModes: { phone: 'masked', wechat: 'masked', qq: 'masked', whatsapp: 'masked' },
  sourceOptionId: null,
  source: null,
  tagOptionIds: [],
  tags: [],
  serviceOptionIds: [],
  services: [],
  recordStatus: 'active',
  remark: null,
  createdBy: user,
  createdAt: now,
  updatedAt: now
});
let server;
let browser;
let page;
try {
  if (!process.env.V2_FILTER_LAYOUT_ADMIN_URL) {
    server = spawn(
      process.execPath,
      [
        path.join(root, 'node_modules/vite/bin/vite.js'),
        '--host',
        baseUrl.hostname,
        '--port',
        baseUrl.port,
        '--strictPort'
      ],
      {
        cwd: path.join(root, 'apps/admin'),
        env: {
          ...process.env,
          VITE_API_BASE_URL: '/api',
          VITE_V2_REALTIME_CHANGES_ENABLED: 'false'
        },
        stdio: 'ignore'
      }
    );
    for (let attempt = 0; attempt < 100; attempt += 1) {
      assert.equal(server.exitCode, null, '验收服务器提前退出');
      const response = await fetch(new URL('/login', baseUrl)).catch(() => null);
      if (response?.ok) break;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1920, height: 1000 } });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() !== 'error') return;
    const pathname = new URL(message.location().url || baseUrl.href).pathname;
    const expectedReadFailure =
      customerReadBehavior === 'error' &&
      /\/api\/id-business-v2\/customers(\/bootstrap)?$/.test(pathname) &&
      message.text().includes('503 (Service Unavailable)');
    if (!expectedReadFailure) errors.push(`console:${message.text()}`);
  });
  await page.addInitScript((fixtureUser) => {
    // Seed only this isolated local test tab using the current credential contract.
    sessionStorage.setItem(
      'apple_business_auth_v2',
      JSON.stringify({
        credentialId: 'layout-fixture-credential',
        schemaVersion: 2,
        token: 'local-layout-fixture',
        tokenRevision: 1,
        updatedAt: Date.now(),
        userCache: fixtureUser
      })
    );
    localStorage.setItem(
      'apple_business_browser_session_marker',
      JSON.stringify({
        credentialId: 'layout-fixture-credential',
        signedOut: false
      })
    );
  }, user);
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) {
      await route.continue();
      return;
    }
    assert.equal(request.method(), 'GET', `布局验收禁止业务写入：${url.pathname}`);
    if (/\/customers(\/bootstrap)?$/.test(url.pathname))
      customerReads.push({ url: url.pathname + url.search, behavior: customerReadBehavior });
    const requestReadBehavior = customerReadBehavior;
    if (/\/customers(\/bootstrap)?$/.test(url.pathname) && requestReadBehavior !== 'normal') {
      await new Promise((resolve) => setTimeout(resolve, 900));
      if (requestReadBehavior === 'error') {
        await route.fulfill({ status: 503, json: { message: '本地模拟读取失败' } });
        return;
      }
    }
    let data = { items: [], total: 0, page: 1, pageSize: 20 };
    if (url.pathname.endsWith('/auth/me')) data = user;
    else if (url.pathname.endsWith('/auth/session'))
      data = { accessToken: 'local-layout-fixture', user };
    else if (url.pathname.endsWith('/branding/public')) {
      data = {
        appName: 'ID 业务管理',
        logoText: 'ID',
        logoUrl: '/brand/default-logo.svg',
        appSubtitle: '布局验收'
      };
    } else if (url.pathname.endsWith('/time')) data = { now, timezone: 'Asia/Shanghai' };
    else if (url.pathname.endsWith('/change-versions')) data = { generatedAt: now, versions: {} };
    else if (url.pathname.endsWith('/renewals/warning-summary'))
      data = { total: 0, warningDays: 7 };
    else if (url.pathname.endsWith('/sensitive-access/approvals/summary')) data = { pending: 0 };
    else if (url.pathname.endsWith('/accounts/purchase-sources'))
      data = { financeAccounts: [], supplierWallets: [] };
    else if (url.pathname.endsWith('/dashboard/overview'))
      data = {
        generatedAt: now,
        businessDate: now.slice(0, 10),
        timezone: 'Asia/Shanghai',
        warningDays: 7,
        access: {
          orders: true,
          activations: true,
          renewals: true,
          accounts: true,
          balances: true,
          exchangeRates: true,
          finance: true,
          audit: true
        },
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
          totalAccounts: 0,
          availableAccounts: 0,
          inventoryBookValueCny: '0',
          financeHistoryStatus: 'completed'
        },
        recentOrders: [],
        upcomingRenewals: [],
        recentAudits: []
      };
    else if (url.pathname.endsWith('/auto-recharge/addresses'))
      data = {
        items: [],
        total: 0,
        page: 1,
        pageSize: 20,
        totals: { unused: 0, used: 0, disabled: 0 }
      };
    else if (/\/customers(\/bootstrap)?$/.test(url.pathname)) {
      const empty = url.searchParams.get('keyword') === 'empty';
      const pageNumber = Number(url.searchParams.get('page') || 1);
      const pageSize = Number(url.searchParams.get('pageSize') || 20);
      const offset = (pageNumber - 1) * pageSize;
      const list = {
        items: empty
          ? []
          : Array.from(
              { length: Math.max(0, Math.min(pageSize, customerCount - offset)) },
              (_, index) => customer(offset + index + 1)
            ),
        total: empty ? 0 : customerCount,
        page: pageNumber,
        pageSize
      };
      data = url.pathname.endsWith('/bootstrap')
        ? { list, options: { sources: [], tags: [], services: [] }, generatedAt: now }
        : list;
    } else if (url.pathname.endsWith('/bootstrap')) {
      data = {
        list: { items: [], total: 0, page: 1, pageSize: 20 },
        options: {
          countries: [],
          statuses: [],
          suppliers: [],
          sources: [],
          tags: [],
          services: []
        },
        permissions: [],
        sensitiveDisplayCatalog: [],
        sensitiveDisplayModeLabels: {},
        generatedAt: now
      };
    } else if (url.pathname.endsWith('/auto-recharge/proxies')) {
      const number = Number(url.searchParams.get('page') || 1);
      const empty = url.searchParams.get('keyword') === 'empty';
      data = {
        items: empty
          ? []
          : [
              {
                id: '22222222-2222-4222-8222-222222222222',
                countryCode: 'US',
                kind: 'static_residential',
                connectionMode: 'direct',
                protocol: 'http',
                linkMask: 'https://example.invalid/…',
                status: 'active',
                remark1: number === 1 ? '布局验收' : '最后一页',
                remark2: '',
                createdAt: now,
                updatedAt: now
              }
            ],
        total: empty ? 0 : 21,
        page: number,
        pageSize: 20
      };
    }
    await route.fulfill({
      json: { success: true, data, message: 'OK', requestId: 'layout-fixture', timestamp: now }
    });
  });

  if (!lifecycleOnly) {
    // Actual mailbox components: all three tabs, successful empty states, and pagination.
    if (!realToolbarOnly && !afterToolbar) {
      for (const width of widths) {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(new URL('/vendure-mailbox-design-fixture.html', baseUrl).href);
        for (const tab of ['主邮箱管理', '虚拟邮箱管理', '收件记录']) {
          await page.getByRole('tab', { name: tab, exact: true }).click();
          await page.locator('.vendure-mailbox-toolbar').waitFor();
          await settle(page);
          await checkToolbar(page, '.vendure-mailbox-toolbar', `邮箱-${tab}-${width}`);
        }
        if ([1920, 390].includes(width)) {
          await page.screenshot({
            path: path.join(outputDir, `mailbox-${width}.png`),
            fullPage: true
          });
        }
      }
      for (const state of ['', '?state=empty']) {
        await page.setViewportSize({ width: 1440, height: 1000 });
        await page.goto(new URL(`/vendure-mailbox-design-fixture.html${state}`, baseUrl).href);
        await page.locator('.vendure-mailbox-toolbar').waitFor();
        await settle(page);
        await checkToolbar(page, '.vendure-mailbox-toolbar', `邮箱-${state || '第一页'}`);
        if (!state) {
          await page.getByRole('tab', { name: '收件记录', exact: true }).click();
          await page.locator('.el-pagination .btn-next').click();
          await settle(page);
          await checkToolbar(page, '.vendure-mailbox-toolbar', '邮箱-最后一页');
        }
      }
    }

    // Real routes with intercepted local read responses; no API or database is started.
    if (!afterToolbar) {
      for (const route of ['proxies', 'chatgpt-accounts', 'bank-cards']) {
        for (const width of widths) {
          await page.setViewportSize({ width, height: 1000 });
          await page.goto(new URL(`/v2/auto-recharge/${route}`, baseUrl).href);
          await page
            .locator('.v2-page-context__filters > .el-form--inline')
            .waitFor({ timeout: 40_000 })
            .catch(async (error) => {
              await page.screenshot({
                path: path.join(outputDir, 'route-failure.png'),
                fullPage: true
              });
              throw new Error(
                `${route}/${width}: ${error.message}; url=${page.url()}; UI=${(await page.locator('body').innerText()).slice(0, 1600)}; runtime=${JSON.stringify(errors)}`
              );
            });
          await settle(page);
          await checkToolbar(
            page,
            '.v2-page-context__filters > .el-form--inline',
            `${route}-${width}`
          );
          await checkLabels(page, `${route}-${width}`);
          if (route === 'proxies' && [1920, 390].includes(width)) {
            await page.screenshot({
              path: path.join(outputDir, `proxies-${width}.png`),
              fullPage: true
            });
          }
        }
      }
      await page.setViewportSize({ width: 1440, height: 1000 });
      await page.goto(new URL('/v2/auto-recharge/proxies', baseUrl).href);
      await page.getByRole('main').getByText('布局验收', { exact: true }).waitFor();
      await page.locator('.el-pagination .btn-next').click();
      await page.getByText('最后一页', { exact: true }).waitFor();
      await checkToolbar(page, '.recharge-proxy-filters', '代理-最后一页');
      await page.getByPlaceholder('国家代码或备注').fill('empty');
      await page.getByRole('button', { name: '搜索', exact: true }).click();
      await page.getByText('暂无代理 IP', { exact: true }).waitFor();
      await checkToolbar(page, '.recharge-proxy-filters', '代理-空状态');
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.getByRole('button', { name: '新增代理 IP', exact: true }).click();
        await page.getByRole('heading', { name: '新增代理 IP', exact: true }).waitFor();
        await settle(page);
        await checkLabels(page, `代理-抽屉-${width}`);
        const drawer = page.getByLabel('新增代理 IP', { exact: true });
        await drawer.locator('.el-drawer__close-btn').click();
        await drawer.waitFor({ state: 'hidden' });
      }

      // The address import group must share the same row as search and status filters.
      for (const width of widths) {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(new URL('/v2/auto-recharge/addresses', baseUrl).href);
        await page.locator('.recharge-address-toolbar').waitFor();
        await settle(page);
        await checkToolbar(page, '.recharge-address-toolbar', `addresses-${width}`);
        if (width === 1440) {
          await page.getByLabel('搜索街道地址', { exact: true }).fill('layout-query-check');
          const searchRead = page.waitForResponse((response) => {
            const url = new URL(response.url());
            return (
              url.pathname.endsWith('/auto-recharge/addresses') &&
              url.searchParams.get('keyword') === 'layout-query-check'
            );
          });
          await page.getByRole('button', { name: '查询', exact: true }).click();
          await searchRead;
          checks.push({ label: 'addresses-filter-query', requestedKeyword: 'layout-query-check' });
        }
        await page.getByLabel('选择街道地址文件', { exact: true }).setInputFiles({
          name: 'address-layout-long-filename-for-import.txt',
          mimeType: 'text/plain',
          buffer: Buffer.from('100 Layout Test Street\n200 Layout Test Street')
        });
        await page.getByText('已读取 2 行', { exact: true }).waitFor();
        await checkToolbar(page, '.recharge-address-toolbar', `addresses-selected-${width}`);
      }
    }
    if (!realToolbarOnly) {
      // A short first page must already reserve the empty state's body height.
      if (!fromMobilePagination) {
        for (const dark of [false, true]) {
          for (const count of [1, 2]) {
            customerCount = count;
            for (const width of [1440, 390]) {
              await page.setViewportSize({ width, height: 1000 });
              await page.goto(new URL('/v2/customers', baseUrl).href);
              await page
                .getByText('本地布局客户 1', { exact: true })
                .filter({ visible: true })
                .waitFor();
              await page.evaluate((dark) => {
                document.documentElement.dataset.v2Theme = dark ? 'dark' : 'light';
                document.documentElement.classList.toggle('dark', dark);
              }, dark);
              await settle(page);
              if (width === 390) {
                const desktopHeight = await page
                  .locator('.v2-records-list > .v2-unified-table-shell')
                  .evaluate((element) => element.getBoundingClientRect().height);
                assert.equal(desktopHeight, 0, '手机卡片模式不得保留隐藏桌面表格的占位');
              }
              const height = () =>
                page
                  .locator('.v2-records-list')
                  .evaluate((element) => element.getBoundingClientRect().height);
              const firstHeight = await height();
              await page.getByRole('textbox', { name: '搜索客户', exact: true }).fill('empty');
              await page.getByRole('button', { name: '查询客户', exact: true }).click();
              await page.locator('.v2-records-empty:visible').waitFor();
              await settle(page);
              const emptyHeight = await height();
              assert.equal(
                emptyHeight,
                firstHeight,
                `${count} 条客户 ${width}px：空状态改变列表高度`
              );
              await page.getByRole('textbox', { name: '搜索客户', exact: true }).fill('');
              await page.getByRole('button', { name: '查询客户', exact: true }).click();
              await page
                .getByText('本地布局客户 1', { exact: true })
                .filter({ visible: true })
                .waitFor();
              await settle(page);
              const restoredHeight = await height();
              assert.equal(
                restoredHeight,
                firstHeight,
                `${count} 条客户 ${width}px：恢复列表改变高度`
              );
              checks.push({
                label: `客户短列表-${dark ? 'dark' : 'light'}-${count}-${width}`,
                firstHeight,
                emptyHeight,
                restoredHeight
              });
            }
          }
        }
      }
      // The reserved right workspace column must stay independent from business pagination.
      for (const total of [21, 501]) {
        customerCount = total;
        for (const width of fromMobilePagination ? [390] : [1440, 390]) {
          await page.setViewportSize({ width, height: 1000 });
          await page.goto(new URL('/v2/customers', baseUrl).href);
          await page
            .getByText('本地布局客户 1', { exact: true })
            .filter({ visible: true })
            .waitFor();
          await settle(page);
          await page.locator('#v2-main').evaluate((element) => {
            element.scrollTop = element.scrollHeight;
          });
          const geometry = await page.evaluate(() => {
            const next = document.querySelector('.v2-records-pagination .btn-next');
            const main = document.querySelector('#v2-main');
            const dock = document.querySelector('.v2-workspace-dock');
            if (!next || !main || !dock) throw new Error('缺少分页、业务内容或全局右栏');
            const button = next.getBoundingClientRect();
            const content = main.getBoundingClientRect();
            const tool = dock.getBoundingClientRect();
            const overlaps = (left, right) =>
              left.left < right.right &&
              left.right > right.left &&
              left.top < right.bottom &&
              left.bottom > right.top;
            const target = document.elementFromPoint(
              button.left + button.width / 2,
              button.top + button.height / 2
            );
            return {
              main: {
                left: content.left,
                right: content.right,
                top: content.top,
                bottom: content.bottom
              },
              dock: { left: tool.left, right: tool.right, top: tool.top, bottom: tool.bottom },
              button: {
                left: button.left,
                right: button.right,
                top: button.top,
                bottom: button.bottom
              },
              dockWidth: tool.width,
              contentOverlapsDock: overlaps(content, tool),
              paginationOverlapsDock: overlaps(button, tool),
              paginationWithinContent:
                button.left >= content.left &&
                button.right <= content.right &&
                button.top >= content.top &&
                button.bottom <= content.bottom,
              paginationHitTarget: next === target || next.contains(target),
              collapsed: dock.classList.contains('is-collapsed'),
              pageOverflow: document.documentElement.scrollWidth - window.innerWidth,
              pageControls: [
                ...document.querySelectorAll(
                  '.v2-records-pagination .el-pagination button, .v2-records-pagination .el-pager > li'
                )
              ]
                .filter((element) => element.getBoundingClientRect().width > 0)
                .map((element) => {
                  const rect = element.getBoundingClientRect();
                  return {
                    label: element.textContent.trim() || element.className,
                    left: rect.left,
                    right: rect.right,
                    top: rect.top,
                    bottom: rect.bottom,
                    width: rect.width,
                    height: rect.height,
                    withinContent:
                      rect.left >= content.left &&
                      rect.right <= content.right &&
                      rect.top >= content.top &&
                      rect.bottom <= content.bottom
                  };
                })
            };
          });
          checks.push({ label: `页尾右栏几何-${total}-${width}`, ...geometry });
          await page.screenshot({
            path: path.join(outputDir, `pagination-dock-${total}-${width}.png`)
          });
          assert.equal(geometry.contentOverlapsDock, false, `${width}px：右栏侵入主业务区域`);
          assert.equal(geometry.paginationOverlapsDock, false, `${width}px：右栏挡住分页按钮`);
          assert.equal(
            geometry.paginationWithinContent,
            true,
            `${width}px：分页按钮超出业务可视区域`
          );
          assert.equal(
            geometry.paginationHitTarget,
            true,
            `${width}px：分页按钮点击位置被其他元素覆盖`
          );
          assert.ok(geometry.pageOverflow <= 1, `${width}px：右栏导致整页横向溢出`);
          for (const control of geometry.pageControls) {
            assert.ok(
              control.withinContent,
              `${total}条/${width}px：分页控件 ${control.label} 超出业务可视区 ${JSON.stringify(control)}`
            );
            if (width <= 900)
              assert.ok(
                control.width >= 44 && control.height >= 44,
                '手机分页控件不得缩小触控范围'
              );
          }
          if (width <= 900) {
            assert.equal(geometry.collapsed, true, '窄屏默认显示右侧收起轨道');
            assert.ok(
              geometry.dockWidth >= 44 && geometry.dockWidth <= 64,
              '窄屏轨道必须保留完整触控宽度'
            );
          } else {
            assert.equal(geometry.collapsed, false, '1440px 桌面默认展开右侧工作区');
            assert.ok(geometry.dockWidth >= 320, '桌面右栏必须保留独立完整内容宽度');
          }
          await page.locator('.v2-records-pagination .btn-next').click();
          await page
            .getByText('本地布局客户 21', { exact: true })
            .filter({ visible: true })
            .waitFor();
          const lastPage = Math.ceil(total / 20);
          if (lastPage > 2) {
            await page
              .locator('.v2-records-pagination .el-pager > li.number')
              .filter({ hasText: new RegExp(`^${lastPage}$`) })
              .click();
            await page
              .getByText(`本地布局客户 ${total}`, { exact: true })
              .filter({ visible: true })
              .waitFor();
          }
          checks.push({
            label: `页尾独立右栏-${total}-${width}`,
            ...geometry,
            pageChanged: true,
            lastPage
          });
        }
      }
      customerCount = 2;

      // Shared styles are also exercised by existing fixtures across every business group.
      const fixtures = [
        'accounts',
        'customers',
        'orders',
        'topup-records',
        'topups',
        'activations',
        'renewals',
        'exchange-rates',
        'finance-ledger',
        'finance-expenses',
        'employees',
        'roles',
        'security',
        'profile',
        'branding',
        'options',
        'order-entry',
        'workspace',
        'theme-components'
      ];
      fixtureGroups = fixtures.length;
      for (const fixture of fixtures) {
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 1000 });
          await page.goto(new URL(`/${fixture}-design-fixture.html`, baseUrl).href);
          await page.locator('.v2-shell').waitFor();
          await settle(page);
          await checkLabels(page, `${fixture}-${width}`);
          await checkPageWidth(page, `${fixture}-${width}`);
        }
      }
      for (const [route, title] of [
        ['/v2/accounts', '新增 ID'],
        ['/v2/customers', '新增客户'],
        ['/v2/system/roles', '新建角色']
      ]) {
        for (const width of [1440, 390]) {
          await page.setViewportSize({ width, height: 1000 });
          await page.goto(new URL(route, baseUrl).href);
          await page.getByRole('button', { name: title, exact: true }).first().click();
          const drawer = page.getByLabel(title, { exact: true });
          await drawer.waitFor();
          await settle(page);
          await checkLabels(page, `${route}-抽屉-${width}`);
          await drawer.locator('.el-drawer__close-btn').click();
        }
      }
    }
    writeFileSync(path.join(outputDir, 'layout-geometry.json'), JSON.stringify(checks, null, 2));
    assert.deepEqual(alignmentErrors, [], '实际文字节点对齐失败');
  }

  // Exercise shared loading and draft behavior through real routes and local GET mocks.
  if (!realToolbarOnly) {
    for (const theme of lifecycleTheme ? [lifecycleTheme] : ['light', 'dark']) {
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(new URL('/v2/customers', baseUrl).href);
        await page.getByText('本地布局客户 1', { exact: true }).filter({ visible: true }).waitFor();
        await page
          .getByTitle(`切换为${theme === 'dark' ? '深' : '浅'}色主题`, { exact: true })
          .click();
        const search = page.getByRole('textbox', { name: '搜索客户', exact: true });
        const draftText = `本地草稿-${theme}-${width}`;
        await search.fill(draftText);
        await page.getByRole('button', { name: '新增客户', exact: true }).first().click();
        const drawer = page.getByLabel('新增客户', { exact: true });
        const nameInput = drawer
          .locator('.el-form-item')
          .filter({ hasText: '客户名称' })
          .getByRole('textbox');
        await nameInput.fill(draftText);
        await drawer.locator('.el-drawer__close-btn').click();
        await drawer.waitFor({ state: 'hidden' });
        await page.getByRole('button', { name: '新增客户', exact: true }).first().click();
        assert.equal(await nameInput.inputValue(), draftText, '关闭并重开抽屉必须恢复输入');
        await drawer.getByRole('button', { name: '关闭', exact: true }).click();
        await drawer.waitFor({ state: 'hidden' });
        await navigateLocally(page, '/v2/accounts', width);
        await page.getByRole('button', { name: '新增 ID', exact: true }).first().waitFor();
        await navigateLocally(page, '/v2/customers', width);
        await search.waitFor();
        assert.equal(await search.inputValue(), draftText, '同标签页切页返回必须恢复搜索');
        await page.getByRole('button', { name: '新增客户', exact: true }).first().click();
        assert.equal(await nameInput.inputValue(), draftText, '切页返回必须恢复新增资料草稿');
        await drawer.getByRole('button', { name: '关闭', exact: true }).click();
        await drawer.waitFor({ state: 'hidden' });
        checks.push({ label: `输入保留-${theme}-${width}`, drawerReopen: true, routeReturn: true });

        const list = page.locator('.v2-records-list');
        await list.waitFor();
        // Restored search drafts can start a read before the list is remounted.
        // Settle that baseline before assigning the next request its failure mode.
        await page
          .locator('.v2-async-region[data-v2-query-phase="ready"]')
          .filter({ has: list })
          .waitFor();
        const before = await list.evaluate((element) => element.getBoundingClientRect().height);
        customerReadBehavior = 'error';
        await search.fill(`读取重试-${theme}-${width}`);
        await page.getByRole('button', { name: '查询客户', exact: true }).click();
        const progress = page.locator('.v2-async-region__progress:visible');
        await progress.waitFor();
        assert.equal(await progress.count(), 1, '读取只允许一个区域加载反馈');
        assert.equal(await page.locator('.el-loading-mask:visible').count(), 0, '禁止全页加载遮罩');
        assert.equal(
          await list.evaluate((element) => element.getBoundingClientRect().height),
          before
        );
        assert.ok(
          await page.getByText('本地布局客户 1', { exact: true }).filter({ visible: true }).count()
        );
        const alert = page.locator('.v2-async-region__refresh-error');
        await alert.waitFor();
        assert.equal(
          await list.evaluate((element) => element.getBoundingClientRect().height),
          before
        );
        customerReadBehavior = 'normal';
        await alert.getByRole('button', { name: '重试', exact: true }).click();
        await alert.waitFor({ state: 'hidden' });
        await progress.waitFor({ state: 'hidden' });
        assert.equal(
          await search.inputValue(),
          `读取重试-${theme}-${width}`,
          '失败重试必须保留输入'
        );
        await checkPageWidth(page, `加载重试-${theme}-${width}`);
        checks.push({
          label: `加载重试-${theme}-${width}`,
          singleFeedback: true,
          contentRetained: true,
          frameHeight: before
        });
      }
    }
  }
  assert.deepEqual(errors, [], '页面运行时异常');
  writeFileSync(path.join(outputDir, 'geometry.json'), JSON.stringify(checks, null, 2));
  if (afterToolbar || realToolbarOnly || lifecycleOnly)
    writeFileSync(
      path.join(
        outputDir,
        `${afterToolbar ? 'after-toolbar' : realToolbarOnly ? 'real-toolbar' : 'lifecycle'}-geometry.json`
      ),
      JSON.stringify(checks, null, 2)
    );
  assert.deepEqual(alignmentErrors, [], '实际文字节点对齐失败');
  console.log(
    JSON.stringify({
      ok: true,
      checks: checks.length,
      widths: lifecycleOnly ? [1440, 390] : widths,
      fixtureGroups,
      realRoutes:
        lifecycleOnly || afterToolbar
          ? ['accounts', 'customers']
          : realToolbarOnly
            ? ['proxies', 'chatgpt-accounts', 'bank-cards', 'addresses']
            : ['proxies', 'chatgpt-accounts', 'bank-cards', 'addresses', 'customers', 'accounts'],
      businessWrites: 0,
      outputDir
    })
  );
} catch (error) {
  await page?.screenshot({ path: path.join(outputDir, 'failure-page.png') }).catch(() => undefined);
  const pageState = await page
    ?.evaluate(() => ({
      route: window.location.pathname,
      theme: document.documentElement.dataset.v2Theme,
      regions: [...document.querySelectorAll('[data-v2-query-phase]')].map((node) => ({
        phase: node.getAttribute('data-v2-query-phase'),
        text: node.textContent.slice(0, 300)
      }))
    }))
    .catch(() => null);
  writeFileSync(
    path.join(outputDir, 'failure.json'),
    JSON.stringify(
      { checks, errors, alignmentErrors, error: error.message, pageState, customerReads },
      null,
      2
    )
  );
  throw error;
} finally {
  await browser?.close();
  server?.kill('SIGTERM');
}

async function settle(page) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) =>
      window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))
    );
  });
}

async function checkPageWidth(page, label) {
  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - window.innerWidth
  );
  assert.ok(overflow <= 1, `${label} 页面横向溢出 ${overflow}px`);
  checks.push({ label, pageOverflow: overflow });
}

async function checkToolbar(page, selector, label) {
  const geometry = await page.locator(selector).evaluate((toolbar) => {
    const controlSelector =
      '.el-input__wrapper, .el-select__wrapper, .app-button, .el-checkbox, .recharge-address-file-picker';
    const controlRootSelector =
      '.el-input, .el-select, .app-button, .el-checkbox, .recharge-address-file-picker';
    const visible = (element) =>
      element.getBoundingClientRect().width > 0 && getComputedStyle(element).display !== 'none';
    const number = (value) => Number.parseFloat(value) || 0;
    const horizontalChrome = (style) =>
      number(style.paddingLeft) +
      number(style.paddingRight) +
      number(style.borderLeftWidth) +
      number(style.borderRightWidth);
    const children = (element) => [...element.children].filter(visible);
    // The browser wraps flex items according to their declared basis, before growing them.
    // Measure those bases plus labels and gaps, rather than assuming viewport width is usable.
    const requiredWidth = (element) => {
      const style = getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      const basis = style.flexBasis.endsWith('px') ? number(style.flexBasis) : null;
      let width = rect.width;
      if (!element.matches(controlRootSelector)) {
        const parts = children(element);
        if (parts.length) {
          const row =
            ['flex', 'inline-flex', 'grid', 'inline-grid'].includes(style.display) &&
            !style.flexDirection.startsWith('column');
          width =
            (row
              ? parts.reduce((sum, part) => sum + requiredWidth(part), 0) +
                number(style.columnGap) * (parts.length - 1)
              : Math.max(...parts.map(requiredWidth))) + horizontalChrome(style);
        }
        if (basis !== null) width = Math.max(width, basis);
      } else if (basis !== null) width = Math.max(basis, number(style.minWidth));
      // A 100% basis is an explicit narrow-layout row, not a shrunken desktop control.
      if (style.flexBasis.endsWith('%')) width = Math.max(width, rect.width);
      return width + number(style.marginLeft) + number(style.marginRight);
    };
    const rectOf = (element) => {
      const rect = element.getBoundingClientRect();
      return {
        left: rect.left,
        right: rect.right,
        top: rect.top,
        bottom: rect.bottom,
        center: (rect.top + rect.bottom) / 2
      };
    };
    const box = toolbar.getBoundingClientRect();
    const controls = [...toolbar.querySelectorAll(controlSelector)].filter(visible).map(rectOf);
    const flowGroups = [toolbar, ...toolbar.querySelectorAll('*')]
      .filter(visible)
      .flatMap((container) => {
        const style = getComputedStyle(container);
        if (
          !['flex', 'inline-flex', 'grid', 'inline-grid'].includes(style.display) ||
          style.flexDirection.startsWith('column')
        )
          return [];
        const parts = children(container);
        const controlParts = parts.filter(
          (part) =>
            part.matches(controlSelector) ||
            [...part.querySelectorAll(controlSelector)].some(visible)
        );
        if (controlParts.length < 2) return [];
        const groupControls = [...container.querySelectorAll(controlSelector)]
          .filter(visible)
          .map(rectOf);
        const availableWidth = container.getBoundingClientRect().width - horizontalChrome(style);
        const widths = parts.map((part) => ({
          className: part.className,
          requiredWidth: requiredWidth(part)
        }));
        const neededWidth =
          widths.reduce((sum, part) => sum + part.requiredWidth, 0) +
          number(style.columnGap) * (parts.length - 1);
        return [
          {
            className: container.className,
            availableWidth,
            neededWidth,
            widths,
            mustFitOneRow: neededWidth <= availableWidth + 1,
            centerSpread:
              Math.max(...groupControls.map(({ center }) => center)) -
              Math.min(...groupControls.map(({ center }) => center))
          }
        ];
      });
    return { left: box.left, right: box.right, height: box.height, controls, flowGroups };
  });
  checks.push({ label, ...geometry });
  assert.ok(geometry.controls.length > 0, `${label} 没有可见筛选器`);
  assert.ok(geometry.flowGroups.length > 0, `${label} 未找到可测量的筛选布局组`);
  for (const control of geometry.controls) {
    assert.ok(
      control.left >= geometry.left - 1 && control.right <= geometry.right + 1,
      `${label} 控件超出筛选区`
    );
  }
  for (const group of geometry.flowGroups) {
    if (group.mustFitOneRow)
      assert.ok(
        group.centerSpread <= 1,
        `${label} ${group.className} 可用 ${group.availableWidth.toFixed(1)}px，所需 ${group.neededWidth.toFixed(1)}px，却发生不必要换行`
      );
  }
  await checkPageWidth(page, label);
}

async function checkLabels(page, label) {
  const fields = await page.evaluate(() => {
    function textBox(element) {
      const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        if (!walker.currentNode.textContent.trim()) continue;
        const range = document.createRange();
        range.selectNodeContents(walker.currentNode);
        const box = range.getBoundingClientRect();
        if (box.width && box.height)
          return {
            top: box.top,
            bottom: box.bottom,
            height: box.height,
            center: (box.top + box.bottom) / 2
          };
      }
      return null;
    }
    return [...document.querySelectorAll('.el-form-item')].flatMap((item) => {
      const title = item.querySelector('.el-form-item__label');
      const control = item.querySelector(
        '.el-input:not(.el-input-number .el-input), .el-select, .el-date-editor'
      );
      if (
        !title ||
        !control ||
        !title.getBoundingClientRect().width ||
        !control.getBoundingClientRect().width
      )
        return [];
      const titleText = textBox(title);
      const titleBox = title.getBoundingClientRect();
      const controlBox = control.getBoundingClientRect();
      const controlText = control.querySelector('.el-select__placeholder');
      const input = control.querySelector('input');
      const inputBox = input?.getBoundingClientRect();
      const valueText = controlText
        ? textBox(controlText)
        : inputBox && {
            top: inputBox.top,
            bottom: inputBox.bottom,
            height: inputBox.height,
            center: (inputBox.top + inputBox.bottom) / 2
          };
      // Multi-line labels are allowed; compare single-line text, not just matching parent boxes.
      if (!titleText || !valueText || titleText.height > 22) return [];
      return [
        {
          label: title.textContent.trim(),
          titleText,
          valueText,
          labelLineHeight: getComputedStyle(title).lineHeight,
          labelRight: titleBox.right,
          controlLeft: controlBox.left,
          delta: Math.abs(titleText.center - valueText.center)
        }
      ];
    });
  });
  for (const field of fields) {
    assert.ok(
      field.labelRight <= field.controlLeft + 1,
      `${label} 标签未留在控件左侧：${field.label}`
    );
    if (field.delta > 2) alignmentErrors.push({ scenario: label, ...field });
  }
  checks.push({ label, fields });
}

async function navigateLocally(page, route, width) {
  if (width <= 900) await page.locator('.v2-menu-button').click();
  const link = page.locator(`.v2-navigation a[href="${route}"]`);
  const section = page
    .locator('.v2-navigation__section')
    .filter({ has: page.locator(`a[href="${route}"]`) });
  const parent = section.locator('.v2-navigation__parent');
  if ((await parent.getAttribute('aria-expanded')) !== 'true') await parent.click();
  await link.click();
  await page.waitForURL(new URL(route, baseUrl).href);
}

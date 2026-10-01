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
const outputDir = path.resolve(root, process.argv[2] ?? '.runtime/filter-layout-20261001');
mkdirSync(outputDir, { recursive: true });
const widths = [1920, 1440, 1180, 1024, 901, 900, 768, 640, 390];
const checks = [];
const errors = [];
const alignmentErrors = [];
const user = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'layout-fixture',
  displayName: '布局验收管理员',
  roles: ['admin'],
  permissions: [],
  mustResetPassword: false
};
const now = '2026-10-01T12:00:00.000Z';
let customerCount = 2;
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
  const page = await browser.newPage({ viewport: { width: 1920, height: 1000 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript((fixtureUser) => {
    localStorage.setItem('apple_business_access_token', 'local-layout-fixture');
    localStorage.setItem('apple_business_current_user', JSON.stringify(fixtureUser));
  }, user);
  await page.route('**/api/**', async (route) => {
    const request = route.request();
    const url = new URL(request.url());
    if (!url.pathname.startsWith('/api/')) {
      await route.continue();
      return;
    }
    assert.equal(request.method(), 'GET', `布局验收禁止业务写入：${url.pathname}`);
    let data = { items: [], total: 0, page: 1, pageSize: 20 };
    if (/\/auth\/(me|session)$/.test(url.pathname)) data = user;
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

  // Actual mailbox components: all three tabs, successful empty states, and pagination.
  for (const width of widths) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(new URL('/vendure-mailbox-design-fixture.html', baseUrl).href);
    for (const tab of ['主邮箱管理', '虚拟邮箱管理', '收件记录']) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      await page.locator('.vendure-mailbox-toolbar').waitFor();
      await settle(page);
      await checkToolbar(page, '.vendure-mailbox-toolbar', `邮箱-${tab}-${width}`, width >= 1440);
    }
    if ([1920, 390].includes(width)) {
      await page.screenshot({ path: path.join(outputDir, `mailbox-${width}.png`), fullPage: true });
    }
  }
  for (const state of ['', '?state=empty']) {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.goto(new URL(`/vendure-mailbox-design-fixture.html${state}`, baseUrl).href);
    await page.locator('.vendure-mailbox-toolbar').waitFor();
    await settle(page);
    await checkToolbar(page, '.vendure-mailbox-toolbar', `邮箱-${state || '第一页'}`, true);
    if (!state) {
      await page.getByRole('tab', { name: '收件记录', exact: true }).click();
      await page.locator('.el-pagination .btn-next').click();
      await settle(page);
      await checkToolbar(page, '.vendure-mailbox-toolbar', '邮箱-最后一页', true);
    }
  }

  // Real routes with intercepted local read responses; no API or database is started.
  for (const route of ['proxies', 'chatgpt-accounts', 'bank-cards']) {
    for (const width of widths) {
      await page.setViewportSize({ width, height: 1000 });
      await page.goto(new URL(`/v2/auto-recharge/${route}`, baseUrl).href);
      await page
        .locator('.v2-page-context__filters > .el-form--inline')
        .waitFor({ timeout: 40_000 });
      await settle(page);
      await checkToolbar(
        page,
        '.v2-page-context__filters > .el-form--inline',
        `${route}-${width}`,
        width >= 1440
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
  await checkToolbar(page, '.recharge-proxy-filters', '代理-最后一页', true);
  await page.getByPlaceholder('国家代码或备注').fill('empty');
  await page.getByRole('button', { name: '搜索', exact: true }).click();
  await page.getByText('暂无代理 IP', { exact: true }).waitFor();
  await checkToolbar(page, '.recharge-proxy-filters', '代理-空状态', true);
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
    await checkToolbar(page, '.recharge-address-toolbar', `addresses-${width}`, width >= 1440);
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
    await checkToolbar(
      page,
      '.recharge-address-toolbar',
      `addresses-selected-${width}`,
      width >= 1440
    );
  }

  // A short first page must already reserve the empty state's body height.
  for (const dark of [false, true]) {
    for (const count of [1, 2]) {
      customerCount = count;
      for (const width of [1440, 390]) {
        await page.setViewportSize({ width, height: 1000 });
        await page.goto(new URL('/v2/customers', baseUrl).href);
        await page.getByText('本地布局客户 1', { exact: true }).filter({ visible: true }).waitFor();
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
        assert.equal(emptyHeight, firstHeight, `${count} 条客户 ${width}px：空状态改变列表高度`);
        await page.getByRole('textbox', { name: '搜索客户', exact: true }).fill('');
        await page.getByRole('button', { name: '查询客户', exact: true }).click();
        await page.getByText('本地布局客户 1', { exact: true }).filter({ visible: true }).waitFor();
        await settle(page);
        const restoredHeight = await height();
        assert.equal(restoredHeight, firstHeight, `${count} 条客户 ${width}px：恢复列表改变高度`);
        checks.push({
          label: `客户短列表-${dark ? 'dark' : 'light'}-${count}-${width}`,
          firstHeight,
          emptyHeight,
          restoredHeight
        });
      }
    }
  }

  // At the end of a long list, the fixed quick action must not intercept pagination.
  customerCount = 21;
  for (const width of [1440, 390]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.goto(new URL('/v2/customers', baseUrl).href);
    await page.getByText('本地布局客户 1', { exact: true }).filter({ visible: true }).waitFor();
    await settle(page);
    await page.locator('#v2-main').evaluate((element) => {
      element.scrollTop = element.scrollHeight;
    });
    const overlap = await page.evaluate(() => {
      const next = document.querySelector('.v2-records-pagination .btn-next');
      const fab = document.querySelector('.v2-quick-actions-fab');
      const button = next.getBoundingClientRect();
      const tool = fab.getBoundingClientRect();
      return (
        button.left < tool.right &&
        button.right > tool.left &&
        button.top < tool.bottom &&
        button.bottom > tool.top
      );
    });
    assert.equal(overlap, false, `${width}px：浮动工具挡住分页按钮`);
    await page.locator('.v2-records-pagination .btn-next').click();
    await page.getByText('本地布局客户 21', { exact: true }).filter({ visible: true }).waitFor();
    checks.push({ label: `页尾浮动工具-${width}`, overlap, pageChanged: true });
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
  assert.deepEqual(errors, [], '页面运行时异常');
  writeFileSync(path.join(outputDir, 'geometry.json'), JSON.stringify(checks, null, 2));
  assert.deepEqual(alignmentErrors, [], '实际文字节点对齐失败');
  console.log(
    JSON.stringify({
      ok: true,
      checks: checks.length,
      widths,
      fixtureGroups: fixtures.length,
      realRoutes: ['proxies', 'chatgpt-accounts', 'bank-cards', 'addresses', 'customers'],
      businessWrites: 0,
      outputDir
    })
  );
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

async function checkToolbar(page, selector, label, singleRow) {
  const geometry = await page.locator(selector).evaluate((toolbar) => {
    const box = toolbar.getBoundingClientRect();
    const controls = [
      ...toolbar.querySelectorAll(
        '.el-input__wrapper, .el-select__wrapper, .app-button, .el-checkbox, .recharge-address-file-picker'
      )
    ]
      .filter((element) => element.getBoundingClientRect().width > 0)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          left: rect.left,
          right: rect.right,
          top: rect.top,
          bottom: rect.bottom,
          center: (rect.top + rect.bottom) / 2
        };
      });
    return { left: box.left, right: box.right, height: box.height, controls };
  });
  assert.ok(geometry.controls.length > 0, `${label} 没有可见筛选器`);
  for (const control of geometry.controls) {
    assert.ok(
      control.left >= geometry.left - 1 && control.right <= geometry.right + 1,
      `${label} 控件超出筛选区`
    );
  }
  if (singleRow) {
    const centers = geometry.controls.map(({ center }) => center);
    assert.ok(Math.max(...centers) - Math.min(...centers) <= 1, `${label} 宽屏发生不必要的换行`);
  }
  checks.push({ label, ...geometry });
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

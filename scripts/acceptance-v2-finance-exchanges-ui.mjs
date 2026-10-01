#!/usr/bin/env node
/* global document, window */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
const root = process.cwd(),
  output = path.join(root, '.runtime/fx-subscription-cost-20261001/fx-ui'),
  base = 'http://127.0.0.1:5386';
mkdirSync(output, { recursive: true });
const now = '2026-10-01T08:00:00.000Z';
const user = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'fx-ui-fixture',
  displayName: '换汇验收',
  roles: ['admin'],
  permissions: [],
  mustResetPassword: false
};
const accounts = ['CNY', 'MYR', 'USD'].map((currency, i) => ({
  id: `22222222-2222-4222-8222-22222222222${i}`,
  name: `${currency} 测试账户`,
  currency,
  accountType: 'bank',
  openingBalance: '1000',
  currentBalance: '1000',
  openingBalanceCny: '1000',
  currentBalanceCny: '1000',
  status: 'active',
  createdAt: now,
  updatedAt: now
}));
const exchange = {
  id: '33333333-3333-4333-8333-333333333333',
  journalId: '44444444-4444-4444-8444-444444444444',
  sourceAccountId: accounts[0].id,
  targetAccountId: accounts[1].id,
  sourceAccountName: accounts[0].name,
  targetAccountName: accounts[1].name,
  sourceCurrency: 'CNY',
  targetCurrency: 'MYR',
  sourceAmount: '1000',
  targetAmount: '590',
  feeAmount: '10',
  feeMode: 'target_deducted',
  totalDebit: '1000',
  grossTargetAmount: '600',
  exchangeRate: '0.6',
  reverseRate: '1.66666667',
  effectiveRate: '0.59',
  feePercent: '1.66666667',
  feeAmountCny: '16',
  fxGainLossCny: '-40',
  status: 'posted',
  occurredAt: now,
  createdAt: now,
  correctionOfId: null,
  channel: '测试渠道',
  remark: '隔离页面验收'
};
let empty = false,
  failList = false,
  failSave = true;
const mutations = [],
  errors = [],
  requests = [];
const server = spawn(
  process.execPath,
  [
    path.join(root, 'node_modules/vite/bin/vite.js'),
    '--host',
    '127.0.0.1',
    '--port',
    '5386',
    '--strictPort'
  ],
  {
    cwd: path.join(root, 'apps/admin'),
    env: { ...process.env, VITE_API_BASE_URL: '/api', VITE_V2_REALTIME_CHANGES_ENABLED: 'false' },
    stdio: 'ignore'
  }
);
let browser, activePage;
const allRequests = [];
try {
  for (let i = 0; i < 120; i++) {
    const result = await fetch(base, { signal: AbortSignal.timeout(500) }).catch(() => null);
    if (result?.ok) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const page = await context.newPage();
  activePage = page;
  page.on('pageerror', (e) => errors.push(e.message));
  await page.addInitScript((user) => {
    localStorage.setItem('apple_business_access_token', 'synthetic-ui-fixture');
    localStorage.setItem('apple_business_current_user', JSON.stringify(user));
  }, user);
  await page.route('**/api/**', async (route) => {
    allRequests.push(route.request().url());
    const request = route.request(),
      url = new URL(request.url()),
      pathname = url.pathname;
    if (!pathname.startsWith('/api/')) {
      await route.continue();
      return;
    }
    let data = { items: [] };
    let status = 200;
    if (/\/auth\/(me|session)$/.test(pathname)) data = user;
    else if (pathname.endsWith('/branding/public'))
      data = {
        appName: 'ID 业务管理',
        logoText: 'ID',
        logoUrl: '/brand/default-logo.svg',
        documentTitleSuffix: 'ID 业务管理'
      };
    else if (pathname.endsWith('/time')) data = { now, timezone: 'Asia/Shanghai' };
    else if (pathname.endsWith('/change-versions')) data = { generatedAt: now, versions: {} };
    else if (pathname.endsWith('/finance/ledger/bootstrap'))
      data = {
        accounts,
        wallets: [],
        inflows: {
          items: [],
          total: 0,
          summary: {
            operatingIncomeCny: '0',
            capitalContributionCny: '0',
            borrowedFundsCny: '0',
            totalInflowCny: '0'
          }
        },
        expenses: { items: [], total: 0 },
        journals: { items: [], total: 0 },
        periods: [],
        settings: { historyStatus: 'completed', baseCurrency: 'CNY' },
        supplierOptions: [],
        expenseCategories: [],
        incomeCategories: [],
        generatedAt: now
      };
    else if (pathname.endsWith('/finance/accounts') && request.method() === 'GET')
      data = { items: accounts };
    else if (pathname.endsWith('/finance/accounts') && request.method() === 'POST') {
      const input = request.postDataJSON();
      data = {
        ...accounts[0],
        ...input,
        id: '55555555-5555-4555-8555-555555555555',
        currentBalance: input.openingBalance
      };
      accounts.push(data);
    } else if (pathname.endsWith('/finance/exchanges') && request.method() === 'GET') {
      requests.push(url.search);
      if (failList) {
        status = 500;
        data = null;
        failList = false;
      } else {
        const pageNumber = Number(url.searchParams.get('page') || '1');
        const items = empty
          ? []
          : pageNumber === 1
            ? Array.from({ length: 20 }, (_, i) => ({ ...exchange, id: `record-${i}` }))
            : [{ ...exchange, id: 'last-record', remark: '末页记录' }];
        data = {
          items,
          total: empty ? 0 : 21,
          page: pageNumber,
          pageSize: 20,
          summary: {
            count: empty ? 0 : 21,
            feeAmountCny: empty ? '0' : '336',
            fxGainLossCny: empty ? '0' : '-840',
            currencies: empty
              ? []
              : [
                  { currency: 'CNY', sourceAmount: '21000', targetAmount: '0', feeAmount: '0' },
                  { currency: 'MYR', sourceAmount: '0', targetAmount: '12390', feeAmount: '210' }
                ]
          }
        };
      }
    } else if (
      /\/finance\/exchanges(?:\/[^/]+\/(corrections|reverse))?$/.test(pathname) &&
      request.method() === 'POST'
    ) {
      mutations.push(request.postDataJSON());
      if (failSave) {
        status = 500;
        data = null;
        failSave = false;
      } else data = exchange;
    }
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify({
        success: status === 200,
        data,
        message: status === 200 ? 'OK' : '验收模拟失败，请重试',
        requestId: 'fx-ui-fixture'
      })
    });
  });
  await page.goto(`${base}/v2/data/finance/expenses`);
  await page.getByRole('button', { name: /换汇记录/ }).click();
  await page.getByText('测试渠道 · 隔离页面验收').first().waitFor();
  const list = page.locator('.v2-records-list').filter({ hasText: '换汇记录' });
  const measureFrame = () =>
    list.evaluate((element) => {
      const box = element.getBoundingClientRect();
      const heading = element.querySelector('.v2-section-heading__title');
      const title = heading?.getBoundingClientRect();
      const body = element.querySelector('.v2-unified-table-shell')?.getBoundingClientRect();
      return {
        x: box.x,
        y: box.y,
        width: box.width,
        height: box.height,
        titleX: title?.x,
        titleY: title?.y,
        bodyHeight: body?.height
      };
    });
  const frames = [];
  for (const width of [1440, 768, 390]) {
    await page.setViewportSize({ width, height: 900 });
    await page.screenshot({ path: path.join(output, `first-${width}.png`), fullPage: true });
    const geometry = await page
      .locator('.v2-records-list')
      .filter({ hasText: '换汇记录' })
      .evaluate((list) => {
        const box = list.getBoundingClientRect();
        const action = list.querySelector('.el-table__row .v2-table-actions');
        return {
          x: box.x,
          y: box.y,
          width: box.width,
          height: box.height,
          overflow: document.documentElement.scrollWidth - window.innerWidth,
          actions: action?.getBoundingClientRect().width
        };
      });
    assert.ok(geometry.overflow <= 1, `${width}px 页面横向溢出`);
    const navigation = await page
      .getByRole('button', { name: /换汇记录/ })
      .locator('strong')
      .evaluate((title) => ({
        width: title.clientWidth,
        textWidth: title.scrollWidth
      }));
    assert.ok(navigation.textWidth <= navigation.width + 1, `${width}px 换汇标题被裁切`);
    assert.ok(geometry.actions > 0, `${width}px 换汇操作不可见`);
    frames.push({ width, geometry });
  }
  const firstFrame = await measureFrame();
  const nextVisible = await page.getByRole('button', { name: '下一页' }).evaluate((button) => {
    button.scrollIntoView({ block: 'center', behavior: 'instant' });
    const box = button.getBoundingClientRect();
    const target = document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2);
    return target === button || button.contains(target);
  });
  assert.ok(nextVisible, '换汇分页按钮被遮挡');
  await page.getByRole('button', { name: '下一页' }).click();
  await page.getByText('测试渠道 · 末页记录', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'last-390.png'), fullPage: true });
  const lastFrame = await measureFrame();
  assert.ok(Math.abs(firstFrame.height - lastFrame.height) <= 2, '末页列表框架发生收缩');
  assert.equal(firstFrame.titleX, lastFrame.titleX, '末页标题横向跳动');
  await page.getByRole('button', { name: '换汇录入', exact: true }).last().click();
  const drawer = page.getByLabel('换汇录入', { exact: true });
  await drawer.waitFor();
  const item = (label) =>
    drawer
      .locator('.el-form-item')
      .filter({ has: page.locator('.el-form-item__label', { hasText: label }) });
  await item('开支币种').locator('.el-select').click();
  await page.getByRole('option', { name: '日元（JPY）', exact: true }).waitFor();
  assert.equal(
    await page.locator('.el-select-dropdown:visible .el-select-dropdown__item').count(),
    26
  );
  await page.getByRole('option', { name: '人民币（CNY）', exact: true }).click();
  await item('付款账户').getByRole('button', { name: '新增账户' }).click();
  const accountDrawer = page.getByLabel('新建资金账户', { exact: true });
  await accountDrawer.waitFor();
  await accountDrawer
    .locator('.el-form-item')
    .filter({ hasText: '账户名称' })
    .locator('input')
    .fill('快捷新增人民币账户');
  await accountDrawer
    .locator('.el-form-item')
    .filter({ hasText: '期初余额' })
    .locator('input')
    .fill('2000');
  await accountDrawer.getByRole('button', { name: '保存', exact: true }).click();
  await item('付款账户')
    .getByText(/^快捷新增人民币账户/)
    .waitFor();
  await item('收款账户').locator('.el-select').click();
  await page.getByRole('option', { name: /MYR 测试账户/ }).click();
  await item('换汇本金').locator('input').fill('1000');
  await item('实际到账金额').locator('input').fill('590');
  await item('手续费金额').locator('input').fill('10');
  assert.ok((await item('手续费百分比').innerText()).includes('1%'));
  await item('手续费扣法').locator('.el-select').click();
  await page.getByRole('option', { name: '买入币种扣除', exact: true }).click();
  assert.ok((await item('手续费百分比').innerText()).includes('1.66666667%'));
  assert.ok((await item('含费实际汇率').innerText()).includes('0.59'));
  await drawer.getByRole('button', { name: '取消', exact: true }).click();
  await page.getByRole('button', { name: '继续填写', exact: true }).click();
  await drawer.getByRole('button', { name: '确认入账', exact: true }).click();
  await drawer.getByText('验收模拟失败，请重试').waitFor();
  await drawer.getByRole('button', { name: '确认入账', exact: true }).click();
  await drawer.waitFor({ state: 'hidden' });
  assert.equal(mutations.length, 2);
  assert.equal(mutations[0].idempotencyKey, mutations[1].idempotencyKey);
  failList = true;
  await page.getByRole('button', { name: '查询', exact: true }).click();
  await page.getByText(/^(更新失败|新条件加载失败)$/).waitFor();
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await page.getByText('测试渠道 · 隔离页面验收').first().waitFor();
  empty = true;
  await page.getByRole('button', { name: '查询', exact: true }).click();
  await page.getByText('暂无换汇记录', { exact: true }).waitFor();
  await page.screenshot({ path: path.join(output, 'empty-390.png'), fullPage: true });
  const emptyFrame = await measureFrame();
  assert.ok(Math.abs(firstFrame.height - emptyFrame.height) <= 2, '空状态列表外框发生收缩');
  assert.ok(Math.abs(firstFrame.bodyHeight - emptyFrame.bodyHeight) <= 2, '空状态列表框架发生收缩');
  assert.equal(firstFrame.titleX, emptyFrame.titleX, '空状态标题横向跳动');
  assert.equal(errors.length, 0, errors.join('\n'));
  assert.ok(requests.some((q) => q.includes('page=2')));
  writeFileSync(
    path.join(output, 'acceptance.json'),
    JSON.stringify(
      {
        ok: true,
        frames,
        paginationFrames: { first: firstFrame, last: lastFrame, empty: emptyFrame },
        listRequests: requests.length,
        submissions: mutations.length,
        runtimeErrors: errors
      },
      null,
      2
    )
  );
  console.log(JSON.stringify({ ok: true, output }));
} catch (error) {
  if (activePage) {
    await activePage.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
    writeFileSync(
      path.join(output, 'failure.json'),
      JSON.stringify(
        {
          message: error.message,
          url: activePage.url(),
          body: (await activePage.locator('body').innerText()).slice(-5500),
          errors,
          requests: allRequests
        },
        null,
        2
      )
    );
  }
  throw error;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}

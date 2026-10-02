/* global document, window */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
const root = process.cwd();
const output = path.resolve(root, '.runtime/name-library-qa/names-ui');
mkdirSync(output, { recursive: true });
const url = 'http://127.0.0.1:5398';
const server = spawn(
  process.execPath,
  [
    path.join(root, 'node_modules/vite/bin/vite.js'),
    '--host',
    '127.0.0.1',
    '--port',
    '5398',
    '--strictPort'
  ],
  {
    cwd: path.join(root, 'apps/admin'),
    env: {
      ...process.env,
      NODE_ENV: 'development',
      VITE_API_BASE_URL: '/api',
      VITE_V2_REALTIME_CHANGES_ENABLED: 'false'
    },
    stdio: 'pipe'
  }
);
let browser, page;
const errors = [];
const diagnostics = [];
for (const stream of [server.stdout, server.stderr])
  stream.on('data', (chunk) => diagnostics.push(String(chunk)));
const now = '2026-10-02T08:00:00.000Z';
const accountId = '11111111-1111-4111-8111-111111111111';
const cardId = '22222222-2222-4222-8222-222222222222';
const names = Array.from({ length: 21 }, (_, i) => ({
  id: `33333333-3333-4333-8333-${String(i).padStart(12, '0')}`,
  name: `Fixture Person ${String(i + 1).padStart(3, '0')}`,
  sequence: i + 1,
  active: true,
  matchCount: 0,
  lastMatchedAt: null,
  updatedAt: now
}));
let savedHolder = '',
  failMatch = false;
let removed = false,
  failSave = false,
  failedRead = false;
const checks = [];
try {
  for (let i = 0; i < 80; i++) {
    if ((await fetch(`${url}/login`).catch(() => null))?.ok) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  browser = await chromium.launch({ headless: true });
  page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('console', (message) => {
    if (message.type() === 'error') diagnostics.push(message.text());
  });
  page.on('requestfailed', (request) =>
    diagnostics.push(`${new URL(request.url()).pathname}: ${request.failure()?.errorText}`)
  );
  await page.addInitScript(() => {
    localStorage.setItem('apple_business_access_token', 'synthetic-ui-fixture');
    localStorage.setItem(
      'apple_business_current_user',
      JSON.stringify({
        id: '11111111-1111-4111-8111-111111111111',
        username: 'fixture-admin',
        displayName: '验收管理员',
        roles: ['admin'],
        permissions: [],
        mustResetPassword: false
      })
    );
  });
  await page.route('**/api/**', async (route) => {
    const request = route.request(),
      address = new URL(request.url()),
      pathname = address.pathname,
      method = request.method();
    if (!pathname.startsWith('/api/')) {
      await route.continue();
      return;
    }
    let data = { items: [], total: 0 };
    if (/\/auth\/(me|session)$/.test(pathname))
      data = {
        id: accountId,
        username: 'fixture-admin',
        displayName: '验收管理员',
        roles: ['admin'],
        permissions: [],
        mustResetPassword: false
      };
    else if (pathname.endsWith('/branding/public'))
      data = {
        appName: 'ID 业务管理',
        logoText: 'ID',
        logoUrl: '/brand/default-logo.svg',
        appSubtitle: '业务管理',
        documentTitleSuffix: 'ID 业务管理'
      };
    else if (pathname.endsWith('/time')) data = { now, timezone: 'Asia/Shanghai' };
    else if (pathname.endsWith('/change-versions')) data = { generatedAt: now, versions: {} };
    else if (pathname.endsWith('/auto-recharge/names') && method === 'GET') {
      if (failedRead) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, message: '姓名库读取失败' })
        });
        return;
      }
      const keyword = address.searchParams.get('keyword'),
        status = address.searchParams.get('status'),
        page = Number(address.searchParams.get('page') || 1),
        pageSize = Number(address.searchParams.get('pageSize') || 20);
      const rows = names.filter(
        (name) =>
          (!keyword || name.name === keyword) && (!status || name.active === (status === 'active'))
      );
      data = {
        items: rows.slice((page - 1) * pageSize, page * pageSize),
        total: rows.length,
        page,
        pageSize
      };
    } else if (pathname.endsWith('/names/match')) {
      if (failMatch) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, message: '姓名匹配失败，请重试' })
        });
        return;
      }
      const historic = request.postDataJSON().number === '4111111111111111';
      data = {
        name: historic ? 'Old Bound Person' : 'New Matched Person',
        confirmed: historic,
        cardId: null,
        billingAddressId: null
      };
    } else if (pathname.endsWith('/bank-recharge/currencies')) {
      data = { items: [{ code: 'USD', name: '美元', minorUnits: 2, active: true }] };
    } else if (pathname.endsWith('/auto-recharge/jobs')) data = { items: [], configured: true };
    else if (pathname.endsWith('/auto-recharge/server-proxy-settings'))
      data = { proxyId: null, proxy: null };
    else if (pathname.endsWith('/auto-recharge/bitbrowser-settings'))
      data = {
        connectorUrl: 'http://127.0.0.1:55321',
        localApiUrl: 'http://127.0.0.1:54345',
        groupName: '验收',
        tagName: '验收',
        proxyType: 'http',
        dynamicProxyUrlConfigured: false
      };
    else if (pathname.endsWith('/bank-recharge/cards/management')) {
      if (method === 'POST') {
        const input = request.postDataJSON();
        assert.equal(input.billingName, 'Saved Card Person');
        savedHolder = input.billingName;
        data = { id: cardId };
      } else
        data = {
          items: savedHolder
            ? [
                {
                  id: cardId,
                  label: '新验收银行卡',
                  last4: '4242',
                  expiry: '12/39',
                  currencyCode: 'USD',
                  status: 'active',
                  hasNumber: true,
                  billingName: savedHolder,
                  accountCount: 0,
                  updatedAt: now
                }
              ]
            : [],
          total: savedHolder ? 1 : 0,
          page: 1,
          pageSize: 20
        };
    } else if (pathname.endsWith('/names/import')) {
      if (failSave) {
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, message: '保存失败，请重试' })
        });
        return;
      }
      const input = request.postDataJSON();
      data = { imported: input.names.length, skipped: 0 };
    } else if (/\/names\/[^/]+$/.test(pathname) && method === 'PATCH') {
      const row = names.find((name) => name.id === pathname.split('/').at(-1)),
        input = request.postDataJSON();
      assert.equal(input.expectedUpdatedAt, row.updatedAt);
      Object.assign(row, input);
      data = { id: row.id };
    } else if (pathname.endsWith('/bank-recharge/accounts')) {
      data = {
        items: [
          {
            id: accountId,
            emailMasked: 'fi***@example.invalid',
            status: 'active',
            subscriptionState: 'active',
            hasPassword: true,
            hasTotp: true,
            remark: '',
            updatedAt: now,
            openingCard: {
              id: removed ? null : cardId,
              label: '验收银行卡',
              last4: '4444',
              numberSummary: '5*******55554444',
              deleted: removed
            }
          }
        ],
        total: 1,
        page: 1,
        pageSize: 20
      };
    } else if (pathname.endsWith('/opening-card-deletion'))
      data = {
        cardId,
        orderId: 'order-id',
        label: '验收银行卡',
        last4: '4444',
        numberSummary: '5*******55554444',
        linkedAccountCount: 2,
        orderCount: 3,
        expectedUpdatedAt: now
      };
    else if (pathname.endsWith('/opening-card') && method === 'DELETE') {
      assert.deepEqual(request.postDataJSON(), {
        cardId,
        orderId: 'order-id',
        linkedAccountCount: 2,
        orderCount: 3,
        expectedUpdatedAt: now
      });
      removed = true;
      data = { deleted: true };
    }
    await route.fulfill({
      status: 200,
      contentType: 'application/json',
      body: JSON.stringify({ success: true, data, message: 'OK', requestId: 'synthetic-fixture' })
    });
  });
  await page.goto(`${url}/v2/auto-recharge/names`);
  await page.getByText('Fixture Person 001', { exact: true }).waitFor({ timeout: 10000 });
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.v2Theme = theme;
      document.documentElement.style.colorScheme = theme;
    }, theme);
    for (const width of [1440, 1024, 901, 900, 768, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.getByText('Fixture Person 001', { exact: true }).waitFor();
      await page.waitForTimeout(260);
      const layout = await page.evaluate(() => {
        const toolbar = document.querySelector('.v2-page-context');
        const buttons = [
          ...document.querySelectorAll(
            '.el-table__fixed-right button, .el-table__body .v2-table-actions button'
          )
        ];
        return {
          overflow: document.documentElement.scrollWidth - window.innerWidth,
          listHeight: document.querySelector('.v2-records-list').getBoundingClientRect().height,
          labelTextOffsets: [...toolbar.querySelectorAll('.el-form-item')].flatMap((item) => {
            const label = item.querySelector('.el-form-item__label'),
              control = item.querySelector('.el-input__wrapper');
            if (!label || !control) return [];
            const range = document.createRange();
            range.selectNodeContents(label);
            const text = range.getBoundingClientRect(),
              box = control.getBoundingClientRect();
            return [Math.abs(text.top + text.height / 2 - box.top - box.height / 2)];
          }),
          toolbarHeight: toolbar?.getBoundingClientRect().height,
          buttonsVisible: buttons.every((button) => {
            const box = button.getBoundingClientRect();
            return box.width > 0;
          })
        };
      });
      assert.ok(layout.overflow <= 1, `${theme}/${width} 页框溢出`);
      assert.ok(layout.buttonsVisible);
      assert.ok(layout.labelTextOffsets.every((offset) => offset <= 1));
      await page.locator('.btn-next').click();
      await page.getByText('Fixture Person 021', { exact: true }).waitFor();
      await page.waitForTimeout(80);
      const lastHeight = await page
        .locator('.v2-records-list')
        .evaluate((list) => list.getBoundingClientRect().height);
      assert.ok(
        Math.abs(lastHeight - layout.listHeight) <= 1,
        `${theme}/${width} 末页框架缩放：${layout.listHeight} → ${lastHeight}`
      );
      assert.ok(await page.getByRole('button', { name: '编辑', exact: true }).isVisible());
      await page.locator('.btn-prev').click();
      await page.getByText('Fixture Person 001', { exact: true }).waitFor();
      await page.getByLabel('姓名搜索').fill('不存在的姓名');
      await page.getByRole('button', { name: '搜索', exact: true }).click();
      await page.getByText('暂无姓名', { exact: true }).waitFor();
      const emptyHeight = await page
        .locator('.v2-records-list')
        .evaluate((list) => list.getBoundingClientRect().height);
      assert.ok(
        Math.abs(emptyHeight - layout.listHeight) <= 1,
        `${theme}/${width} 空状态框架缩放：${layout.listHeight} → ${emptyHeight}`
      );
      assert.ok(
        (await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)) <= 1
      );
      await page.getByLabel('姓名搜索').fill('');
      await page.getByRole('button', { name: '搜索', exact: true }).click();
      await page.getByText('Fixture Person 001', { exact: true }).waitFor();
      checks.push({
        theme,
        width,
        first: true,
        last: true,
        empty: true,
        overflow: layout.overflow,
        listHeight: layout.listHeight,
        lastHeight,
        emptyHeight,
        labelTextOffsets: layout.labelTextOffsets
      });
      if ([1440, 390].includes(width))
        await page.screenshot({
          path: path.join(output, `names-${theme}-${width}.png`),
          fullPage: true
        });
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.getByRole('button', { name: '录入／批量导入', exact: true }).click();
  const drawer = page.getByRole('dialog', { name: '录入姓名' });
  await drawer.getByLabel('姓名列表').fill('Draft Person');
  await drawer.getByRole('button', { name: '关闭', exact: true }).click();
  await page.getByRole('button', { name: '录入／批量导入', exact: true }).click();
  assert.equal(await drawer.getByLabel('姓名列表').inputValue(), 'Draft Person');
  failSave = true;
  await drawer.getByRole('button', { name: '保存', exact: true }).click();
  await drawer.getByText('保存失败，请重试', { exact: true }).waitFor();
  assert.equal(await drawer.getByLabel('姓名列表').inputValue(), 'Draft Person');
  failSave = false;
  await drawer.getByRole('button', { name: '保存', exact: true }).click();
  await drawer.waitFor({ state: 'hidden' });
  await page.goto(`${url}/v2/auto-recharge/chatgpt-accounts`);
  await page.getByText('银行卡信息', { exact: true }).waitFor();
  await page.getByRole('button', { name: '删除卡', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: '删除开通银行卡' });
  await dialog.getByText('此卡关联 2 个账号、3 笔订单。', { exact: false }).waitFor();
  await dialog.getByRole('button', { name: '删除卡', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByText('已删除', { exact: true }).waitFor();
  assert.ok(await page.getByRole('button', { name: '删除卡', exact: true }).isDisabled());
  await page.goto(`${url}/v2/auto-recharge/bank-cards`);
  await page.getByRole('button', { name: '新增银行卡', exact: true }).click();
  const cardDrawer = page.getByRole('dialog', { name: '新增银行卡' });
  await cardDrawer.getByLabel('持卡人姓名', { exact: true }).fill('Saved Card Person');
  await cardDrawer.getByLabel('银行卡卡号', { exact: true }).fill('4242424242424242');
  await cardDrawer.getByLabel('有效期', { exact: true }).fill('12/39');
  await cardDrawer.getByRole('button', { name: '保存', exact: true }).click();
  await cardDrawer.waitFor({ state: 'hidden' });
  await page.getByText('Saved Card Person', { exact: true }).waitFor();
  await page.goto(`${url}/v2/auto-recharge`);
  const cardNumber = page.getByLabel('银行卡号', { exact: true });
  const holder = page.getByLabel('持卡人姓名', { exact: true });
  await cardNumber.fill('4111111111111111');
  await page.waitForFunction(
    (input) => input.value === 'Old Bound Person',
    await holder.elementHandle(),
    { timeout: 10000 }
  );
  assert.equal(await holder.getAttribute('readonly'), '');
  failMatch = true;
  await cardNumber.fill('4242424242424242');
  await page.getByText('姓名匹配失败，请重试', { exact: false }).waitFor();
  failMatch = false;
  await page.getByRole('button', { name: '重试', exact: true }).click();
  await page.waitForFunction(
    (input) => input.value === 'New Matched Person',
    await holder.elementHandle(),
    { timeout: 10000 }
  );
  assert.equal(await holder.getAttribute('readonly'), null);
  assert.deepEqual(errors, []);
  const result = {
    ok: true,
    layouts: checks,
    importDraftRetained: true,
    saveFailureRetained: true,
    openingCardColumn: true,
    deletionSharedImpactConfirmation: true,
    deletedSnapshotVisible: true,
    bankCardHolderSaved: true,
    historicNameReadonly: true,
    newNameRetryEditable: true,
    runtimeErrors: errors
  };
  writeFileSync(path.join(output, 'result.json'), JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({
      ok: true,
      layoutScenarios: checks.length * 3,
      interactions: 10,
      runtimeErrors: 0
    })
  );
} catch (error) {
  if (page) {
    await page.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
    console.log(
      JSON.stringify({
        url: page.url(),
        body: (await page.locator('body').innerText()).slice(0, 3000),
        runtimeErrors: errors,
        diagnostics
      })
    );
  }
  throw error;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}

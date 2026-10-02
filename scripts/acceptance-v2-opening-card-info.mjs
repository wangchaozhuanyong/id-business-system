/* global document, window */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const output = path.resolve(root, '.runtime/opening-card-info-20261002/browser');
mkdirSync(output, { recursive: true });
const url = 'http://127.0.0.1:5399';
const server = spawn(
  process.execPath,
  [
    path.join(root, 'node_modules/vite/bin/vite.js'),
    '--host',
    '127.0.0.1',
    '--port',
    '5399',
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
const now = '2026-10-02T08:00:00.000Z';
const cardId = '22222222-2222-4222-8222-222222222222';
const summary = '4*******23456789';
const accounts = Array.from({ length: 21 }, (_, i) => ({
  id: `11111111-1111-4111-8111-${String(i).padStart(12, '0')}`,
  emailMasked: `fi***${String(i + 1).padStart(3, '0')}@example.invalid`,
  status: 'active',
  subscriptionState: 'active',
  hasPassword: true,
  hasTotp: true,
  remark: '',
  updatedAt: now,
  openingCard: null
}));
let removed = false,
  failPreview = false,
  failDelete = false,
  browser;
const errors = [],
  diagnostics = [],
  layouts = [];
for (const stream of [server.stdout, server.stderr])
  stream.on('data', (chunk) => diagnostics.push(String(chunk)));
try {
  for (let i = 0; i < 80; i++) {
    if ((await fetch(`${url}/login`).catch(() => null))?.ok) break;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  page.on('pageerror', (error) => errors.push(error.message));
  await page.addInitScript(() => {
    localStorage.setItem('apple_business_access_token', 'synthetic-ui-fixture');
    localStorage.setItem(
      'apple_business_current_user',
      JSON.stringify({
        id: '11111111-1111-4111-8111-000000000000',
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
      pathname = address.pathname;
    if (!pathname.startsWith('/api/')) return route.continue();
    let data = { items: [], total: 0 },
      failure = '';
    if (/\/auth\/(me|session)$/.test(pathname))
      data = {
        id: accounts[0].id,
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
    else if (pathname.endsWith('/bank-recharge/accounts')) {
      const currentPage = Number(address.searchParams.get('page') || 1),
        pageSize = Number(address.searchParams.get('pageSize') || 20);
      const rows = address.searchParams.get('keyword')
        ? []
        : accounts.map((account, i) => ({
            ...account,
            openingCard: [0, 20].includes(i)
              ? {
                  id: removed ? null : cardId,
                  label: '验收银行卡',
                  last4: '6789',
                  numberSummary: summary,
                  deleted: removed
                }
              : null
          }));
      data = {
        items: rows.slice((currentPage - 1) * pageSize, currentPage * pageSize),
        total: rows.length,
        page: currentPage,
        pageSize
      };
    } else if (pathname.endsWith('/opening-card-deletion')) {
      failure = failPreview ? '银行卡关联读取失败，请重试' : '';
      data = {
        cardId,
        orderId: 'order-id',
        label: '验收银行卡',
        last4: '6789',
        numberSummary: summary,
        linkedAccountCount: 2,
        orderCount: 2,
        expectedUpdatedAt: now
      };
    } else if (pathname.endsWith('/opening-card') && request.method() === 'DELETE') {
      assert.deepEqual(request.postDataJSON(), {
        cardId,
        orderId: 'order-id',
        linkedAccountCount: 2,
        orderCount: 2,
        expectedUpdatedAt: now
      });
      failure = failDelete ? '删除失败，请重试' : '';
      if (!failure) removed = true;
      data = { deleted: true };
    }
    await route.fulfill({
      status: failure ? 500 : 200,
      contentType: 'application/json',
      body: JSON.stringify({
        success: !failure,
        data,
        message: failure || 'OK',
        requestId: 'synthetic-fixture'
      })
    });
  });
  await page.goto(`${url}/v2/auto-recharge/chatgpt-accounts`);
  await page.getByText(accounts[0].emailMasked, { exact: true }).waitFor();
  for (const theme of ['light', 'dark']) {
    await page.evaluate((theme) => {
      document.documentElement.dataset.v2Theme = theme;
      document.documentElement.style.colorScheme = theme;
    }, theme);
    for (const width of [2307, 1440, 900, 390]) {
      await page.setViewportSize({ width, height: 900 });
      await page.waitForTimeout(250);
      const first = await page.locator('.v2-records-list').evaluate((list) => {
        const actionCells = [...list.querySelectorAll('.v2-table-actions')];
        return {
          height: list.getBoundingClientRect().height,
          overflow: document.documentElement.scrollWidth - window.innerWidth,
          labels: [...document.querySelectorAll('.v2-page-context .el-form-item')].flatMap(
            (item) => {
              const label = item.querySelector('.el-form-item__label'),
                control = item.querySelector('.el-input__wrapper');
              if (!label || !control) return [];
              const range = document.createRange();
              range.selectNodeContents(label);
              const text = range.getBoundingClientRect(),
                box = control.getBoundingClientRect();
              return [Math.abs(text.y + text.height / 2 - box.y - box.height / 2)];
            }
          ),
          actionFits: actionCells.every((cell) => {
            const cellBox = cell.getBoundingClientRect();
            return [...cell.querySelectorAll('button')].every((button) => {
              const box = button.getBoundingClientRect();
              return (
                box.width > 0 && box.left >= cellBox.left - 1 && box.right <= cellBox.right + 1
              );
            });
          }),
          actionCellCount: actionCells.length
        };
      });
      assert.ok(first.overflow <= 1, `${theme}/${width} 页框溢出`);
      assert.ok(first.actionCellCount > 0 && first.actionFits, `${theme}/${width} 操作按钮裁切`);
      assert.ok(
        first.labels.every((offset) => offset <= 1),
        `${theme}/${width} 标签文字未对齐`
      );
      await page.getByText('银行卡信息', { exact: true }).waitFor();
      await page.getByText('银行卡删除状态', { exact: true }).waitFor();
      await page.getByText(summary, { exact: true }).waitFor();
      await page.getByText('尚未删除', { exact: true }).waitFor();
      await page.locator('.btn-next').click();
      await page.getByText(accounts[20].emailMasked, { exact: true }).waitFor();
      await page.waitForTimeout(150);
      const lastHeight = await page
        .locator('.v2-records-list')
        .evaluate((list) => list.getBoundingClientRect().height);
      assert.ok(
        Math.abs(lastHeight - first.height) <= 1,
        `${theme}/${width} 末页框架缩放：${first.height} → ${lastHeight}`
      );
      await page.getByRole('button', { name: '删除卡', exact: true }).waitFor();
      await page.locator('.btn-prev').click();
      await page.getByText(accounts[0].emailMasked, { exact: true }).waitFor();
      await page.getByPlaceholder('邮箱或备注', { exact: true }).fill('不存在的账号');
      await page.getByRole('button', { name: '搜索', exact: true }).click();
      await page.getByText('暂无 ChatGPT 账号', { exact: true }).waitFor();
      const emptyHeight = await page
        .locator('.v2-records-list')
        .evaluate((list) => list.getBoundingClientRect().height);
      assert.ok(
        Math.abs(emptyHeight - first.height) <= 1,
        `${theme}/${width} 空状态框架缩放：${first.height} → ${emptyHeight}`
      );
      await page.getByPlaceholder('邮箱或备注', { exact: true }).fill('');
      await page.getByRole('button', { name: '搜索', exact: true }).click();
      await page.getByText(accounts[0].emailMasked, { exact: true }).waitFor();
      layouts.push({ theme, width, first, lastHeight, emptyHeight });
      if ([1440, 390].includes(width)) {
        await page.locator('.el-table__body-wrapper .el-scrollbar__wrap').evaluate((element) => {
          element.scrollLeft = element.scrollWidth;
        });
        await page.waitForTimeout(100);
        const cardCell = await page.getByText(summary, { exact: true }).boundingBox();
        const action = await page
          .getByRole('button', { name: '删除卡', exact: true })
          .first()
          .boundingBox();
        if (width === 1440)
          assert.ok(
            cardCell && action && cardCell.x >= 0 && cardCell.x + cardCell.width <= action.x,
            '银行卡摘要被固定操作列遮挡'
          );
        await page.screenshot({
          path: path.join(output, `accounts-${theme}-${width}.png`),
          fullPage: true
        });
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  failPreview = true;
  await page.getByRole('button', { name: '删除卡', exact: true }).first().click();
  const dialog = page.getByRole('dialog', { name: '删除开通银行卡' });
  await dialog.getByText('银行卡关联读取失败，请重试', { exact: false }).waitFor();
  assert.ok(await dialog.getByRole('button', { name: '删除卡', exact: true }).isDisabled());
  failPreview = false;
  await dialog.getByRole('button', { name: '重新加载', exact: true }).click();
  await dialog
    .getByText(`确认从银行卡资料中删除 验收银行卡（${summary}）？`, { exact: true })
    .waitFor();
  failDelete = true;
  await dialog.getByRole('button', { name: '删除卡', exact: true }).click();
  await dialog.getByText('删除失败，请重试', { exact: false }).waitFor();
  failDelete = false;
  await dialog.getByRole('button', { name: '删除卡', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByText('已删除', { exact: true }).waitFor();
  assert.ok(await page.getByRole('button', { name: '删除卡', exact: true }).first().isDisabled());
  await page.getByText(summary, { exact: true }).waitFor();
  await page.locator('.btn-next').click();
  await page.getByText(accounts[20].emailMasked, { exact: true }).waitFor();
  await page.getByText('已删除', { exact: true }).waitFor();
  assert.deepEqual(errors, []);
  await page.locator('.el-table__body-wrapper .el-scrollbar__wrap').evaluate((element) => {
    element.scrollLeft = element.scrollWidth;
  });
  await page.waitForTimeout(100);
  await page.screenshot({
    path: path.join(output, 'accounts-deleted-dark-1440.png'),
    fullPage: true
  });
  writeFileSync(
    path.join(output, 'result.json'),
    JSON.stringify(
      {
        ok: true,
        layouts,
        previewFailureRetry: true,
        deleteFailureRetry: true,
        sharedDeletion: true,
        maskedHistoryPreserved: true,
        errors,
        realBusinessWrites: 0
      },
      null,
      2
    )
  );
  console.log(
    JSON.stringify({
      ok: true,
      layoutStates: layouts.length * 3,
      sharedDeletion: true,
      maskedHistoryPreserved: true,
      errors: errors.length
    })
  );
} catch (error) {
  writeFileSync(
    path.join(output, 'failure.json'),
    JSON.stringify({ message: error.message, layouts, errors, diagnostics }, null, 2)
  );
  throw error;
} finally {
  await browser?.close();
  server.kill('SIGTERM');
}

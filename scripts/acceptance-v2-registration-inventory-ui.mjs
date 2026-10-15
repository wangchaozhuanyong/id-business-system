#!/usr/bin/env node
/* global document, window, PopStateEvent */
import assert from 'node:assert/strict';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const distribution = path.join(root, 'apps/admin/dist');
const output = path.join(root, '.runtime/auto-registration-review-20261016/UI');
const origin = 'https://registration-inventory.acceptance.invalid';
const now = '2026-10-16T00:00:00.000Z';
const accountPath = '/v2/account-settings/chatgpt-accounts';
const registrationPath = '/v2/auto-registration';
const widths = [1440, 900, 390];
const themes = ['light', 'dark'];
assert.ok(
  process.argv.slice(2).every((arg) => arg === '--manual-sync-only'),
  '未知验收选项'
);
const manualOnly = process.argv.includes('--manual-sync-only');
const user = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'registration-acceptance',
  displayName: '注册验收管理员',
  roles: ['admin'],
  permissions: [],
  mustResetPassword: false
};
const account = (index, extra = {}) => ({
  id: `22222222-2222-4222-8222-${String(index).padStart(12, '0')}`,
  emailMasked: `fixture-${index}@example.invalid`,
  status: 'active',
  subscriptionState: 'never_subscribed',
  dueAt: null,
  currentPlan: null,
  hasPassword: false,
  hasTotp: false,
  remark: `账号验收 ${index}`,
  offerStatus: 'unknown',
  offerSource: null,
  offerObservedAt: null,
  registrationIp: null,
  registeredAt: null,
  registrationCountryCode: null,
  registrationSource: 'manual',
  needsSupplement: true,
  firstLoginNetwork: null,
  lastLoginNetwork: null,
  createdAt: now,
  updatedAt: now,
  deletedAt: null,
  openingCard: null,
  ...extra
});
const appleRow = (index, extra = {}) => ({
  aliasId: `alias-${index}`,
  email: `hidden-${index}@example.invalid`,
  primaryEmail: 'primary@example.invalid',
  mailboxStatus: 'ACTIVE',
  authorizationValid: true,
  primaryAvailable: true,
  registrationStatus: 'unregistered',
  registrationIp: null,
  registrationCountryCode: null,
  registrationIpSource: null,
  source: null,
  note: null,
  revision: 3,
  updatedAt: now,
  taskUuid: null,
  taskStatus: null,
  activeTaskUuid: null,
  canRegister: true,
  blockedReason: null,
  ...extra
});
async function navigate(page, target) {
  await page.evaluate((url) => {
    window.history.pushState({}, '', url);
    window.dispatchEvent(new PopStateEvent('popstate'));
  }, target);
}
async function geometry(page, label) {
  const measure = await page
    .locator('.v2-records-list')
    .first()
    .evaluate((list) => {
      const outer = list.getBoundingClientRect();
      const title = list.querySelector('.v2-section-heading__title');
      const count = list.querySelector('.v2-section-heading__actions span');
      const text = title?.getBoundingClientRect();
      const number = count?.getBoundingClientRect();
      return {
        width: outer.width,
        height: outer.height,
        titleInside:
          !text || (text.left >= outer.left && text.right <= outer.right && text.top >= outer.top),
        textAligned:
          !text ||
          !number ||
          number.top >= text.bottom - 1 ||
          Math.abs((text.top + text.bottom) / 2 - (number.top + number.bottom) / 2) <= 3,
        overflow: document.documentElement.scrollWidth > window.innerWidth + 1
      };
    });
  assert.ok(measure.titleInside, `${label} 标题文字超出列表`);
  assert.ok(measure.textAligned, `${label} 标题和数量文字未对齐`);
  assert.equal(measure.overflow, false, `${label} 页面横向溢出`);
  return measure;
}
async function snapshot(page, name) {
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise((resolve) =>
      window.requestAnimationFrame(() => window.requestAnimationFrame(resolve))
    );
    await Promise.all(
      document
        .getAnimations()
        .filter((animation) => animation.effect?.getTiming().iterations !== Infinity)
        .map((animation) => animation.finished.catch(() => {}))
    );
  });
  await page.screenshot({ path: path.join(output, name), fullPage: true });
}
mkdirSync(output, { recursive: true });
assert.ok(existsSync(path.join(distribution, 'index.html')), '请先构建管理端');
const browser = await chromium.launch({ headless: true });
const completed = [];
let inspectedPage;
let unexpected = [];
try {
  for (const theme of themes)
    for (const width of widths) {
      const context = await browser.newContext({ viewport: { width, height: 1000 } });
      const page = await context.newPage();
      inspectedPage = page;
      page.setDefaultTimeout(30000);
      const errors = [];
      unexpected = [];
      const writes = [];
      let failList = false;
      let failMailboxRead = false;
      const accounts = Array.from({ length: 21 }, (_, i) => account(i + 1));
      Object.assign(accounts[1], {
        registrationSource: 'automatic',
        registrationIp: '203.0.113.20',
        registrationCountryCode: 'PH',
        registeredAt: '2026-10-01T00:00:00.000Z',
        hasPassword: true,
        needsSupplement: false,
        remark: '官网创建待授权',
        openingCard: {
          id: 'card-1',
          label: '开通卡',
          last4: '1234',
          numberSummary: '4*******1234',
          deleted: false
        }
      });
      accounts[2].subscriptionState = 'active';
      const mailboxes = [
        appleRow(1, {
          registrationStatus: 'registered',
          source: 'manual',
          syncStatus: 'not_started'
        }),
        appleRow(2, {
          registrationStatus: 'registered',
          source: 'automatic',
          taskUuid: 'task-2',
          taskStatus: 'failed',
          creationConfirmed: true,
          authorizationStatus: 'pending',
          syncStatus: 'saved',
          registrationIp: '203.0.113.20',
          registrationCountryCode: 'PH',
          registrationIpSource: 'observed'
        }),
        ...Array.from({ length: 19 }, (_, i) => appleRow(i + 3))
      ];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.route('**/*', async (route) => {
        const url = new URL(route.request().url());
        if (url.origin !== origin) {
          unexpected.push(`external ${url.origin}`);
          await route.abort();
          return;
        }
        const relative = url.pathname.startsWith('/v2/') ? '/index.html' : url.pathname;
        const asset = path.resolve(distribution, `.${relative}`);
        if (!asset.startsWith(`${distribution}${path.sep}`) || !existsSync(asset)) {
          unexpected.push(`asset ${url.pathname}`);
          await route.fulfill({ status: 404, body: '' });
          return;
        }
        const contentType =
          {
            '.html': 'text/html',
            '.js': 'application/javascript',
            '.css': 'text/css',
            '.svg': 'image/svg+xml',
            '.png': 'image/png',
            '.ico': 'image/x-icon',
            '.woff2': 'font/woff2'
          }[path.extname(asset)] || 'application/octet-stream';
        await route.fulfill({ status: 200, contentType, body: readFileSync(asset) });
      });
      await page.addInitScript((fixture) => {
        localStorage.setItem(
          'apple_business_access_token',
          'synthetic-registration-acceptance-token'
        );
        localStorage.setItem('apple_business_current_user', JSON.stringify(fixture));
      }, user);
      await page.route('**/api/**', async (route) => {
        const request = route.request();
        const url = new URL(request.url());
        const endpoint = url.pathname;
        const method = request.method();
        if (endpoint === '/api/realtime/events') {
          await route.fulfill({
            status: 200,
            contentType: 'text/event-stream',
            body: 'retry: 60000\n: fixture\n\n'
          });
          return;
        }
        let data;
        if (endpoint.endsWith('/auth/me') || endpoint.endsWith('/auth/session')) data = user;
        else if (endpoint.endsWith('/branding/public'))
          data = {
            appName: 'ID 业务管理',
            logoText: 'ID',
            logoUrl: '/brand/default-logo.svg',
            appSubtitle: '业务管理',
            documentTitleSuffix: 'ID 业务管理'
          };
        else if (endpoint.endsWith('/id-business-v2/time'))
          data = { now, timezone: 'Asia/Shanghai' };
        else if (endpoint.endsWith('/change-versions')) data = { generatedAt: now, versions: {} };
        else if (
          endpoint.endsWith('/table-preferences') ||
          endpoint.endsWith('/workspace-shortcuts')
        )
          data = { items: [] };
        else if (endpoint.endsWith('/quick-actions')) data = { items: [], updatedAt: now };
        else if (endpoint.endsWith('/warning-summary') || endpoint.endsWith('/renewal-warnings'))
          data = {
            warningDays: 3,
            defaultWarningDays: 3,
            upcomingCount: 0,
            expiredCount: 0,
            totalCount: 0,
            items: [],
            evaluatedAt: now,
            revalidateAt: now
          };
        else if (endpoint.endsWith('/sensitive-access/approvals/summary'))
          data = { pendingCount: 0, items: [], generatedAt: now };
        else if (endpoint.endsWith('/bank-recharge/accounts') && method === 'GET') {
          if (failList) {
            await route.fulfill({
              status: 503,
              contentType: 'application/json',
              body: JSON.stringify({ success: false, message: '合成读取失败' })
            });
            return;
          }
          const q = url.searchParams;
          let items =
            q.get('deleted') === 'deleted'
              ? [account(99, { deletedAt: now, status: 'disabled', remark: '回收站记录' })]
              : accounts;
          if (q.get('subscriptionState') === 'never_subscribed')
            items = items.filter((item) => item.subscriptionState === 'never_subscribed');
          if (q.get('keyword'))
            items = items.filter((item) =>
              `${item.emailMasked} ${item.remark}`.includes(q.get('keyword'))
            );
          const current = Number(q.get('page') || 1),
            size = Number(q.get('pageSize') || 20);
          data = {
            items: items.slice((current - 1) * size, current * size),
            total: items.length,
            page: current,
            pageSize: size
          };
        } else if (endpoint.endsWith('/auto-registration/status'))
          data = {
            ready: true,
            workspacePath: '/api/id-business-v2/auto-registration/workspace/',
            version: 'fixture',
            sourceCommit: 'fixture'
          };
        else if (endpoint.endsWith('/workspace-session'))
          data = { expiresAt: '2099-01-01T00:00:00Z' };
        else if (endpoint.includes('/auto-registration/workspace/')) {
          const childPage = endpoint.endsWith('/accounts') ? '/accounts' : '/';
          await route.fulfill({
            status: 200,
            contentType: 'text/html',
            body: `<html><body><p>合成凭据工作区</p><button id="open">打开主台账</button><script>parent.postMessage({type:'id-registration:ready',page:${JSON.stringify(childPage)}},location.origin);document.getElementById('open').onclick=()=>parent.postMessage({type:'id-registration:account-open',page:'/accounts',accountId:'22222222-2222-4222-8222-000000000002'},location.origin)</script></body></html>`
          });
          return;
        } else if (endpoint.endsWith('/apple-mailboxes/resume'))
          data = { resumed: 0, synchronized: 0 };
        else if (endpoint.endsWith('/apple-mailboxes/manual-sync-preview')) {
          const targets = request.postDataJSON().items;
          writes.push({ endpoint, targets });
          data = {
            items: targets.map((target) => ({
              ...target,
              email: mailboxes.find((row) => row.aliasId === target.aliasId).email,
              status:
                target.revision === mailboxes.find((row) => row.aliasId === target.aliasId).revision
                  ? 'create'
                  : 'stale',
              accountId: null
            })),
            total: targets.length,
            creatable: targets.filter(
              (target) =>
                target.revision === mailboxes.find((row) => row.aliasId === target.aliasId).revision
            ).length
          };
        } else if (endpoint.endsWith('/apple-mailboxes/manual-sync')) {
          const targets = request.postDataJSON().items;
          assert.deepEqual(targets, [{ aliasId: 'alias-1', revision: manualOnly ? 8 : 3 }]);
          writes.push({ endpoint, targets });
          mailboxes[0].syncStatus = 'saved';
          data = {
            items: targets.map((target) => ({
              aliasId: target.aliasId,
              status: 'saved',
              accountId: accounts[0].id
            })),
            synchronized: targets.length,
            failed: 0,
            skipped: 0
          };
        } else if (endpoint.endsWith('/auto-registration/apple-mailboxes')) {
          if (failMailboxRead) {
            await route.fulfill({
              status: 503,
              contentType: 'application/json',
              body: JSON.stringify({ success: false, message: '合成邮箱读取失败' })
            });
            return;
          }
          const current = Number(url.searchParams.get('page') || 1),
            size = Number(url.searchParams.get('pageSize') || 20);
          data = {
            items: mailboxes.slice((current - 1) * size, current * size),
            total: mailboxes.length,
            page: current,
            pageSize: size
          };
        }
        if (data === undefined) {
          unexpected.push(`${method} ${endpoint}`);
          await route.fulfill({
            status: 500,
            contentType: 'application/json',
            body: JSON.stringify({ success: false, message: '未登记的验收请求' })
          });
        } else
          await route.fulfill({
            status: 200,
            contentType: 'application/json',
            body: JSON.stringify({
              success: true,
              data,
              message: 'OK',
              requestId: 'registration-acceptance',
              timestamp: now
            })
          });
      });
      if (!manualOnly) {
        await page.goto(`${origin}${accountPath}`, { waitUntil: 'domcontentloaded' });
        await page.getByText('账号验收 1', { exact: true }).waitFor();
        failList = true;
        await page.getByPlaceholder('邮箱或备注').fill('账号验收');
        await page.getByRole('button', { name: '搜索', exact: true }).click();
        await page.getByRole('alert').filter({ hasText: '合成读取失败' }).waitFor();
        assert.equal(await page.getByText('账号验收 1', { exact: true }).count(), 1);
        failList = false;
        await page.getByRole('button', { name: '重试', exact: true }).click();
        await page
          .getByRole('alert')
          .filter({ hasText: '合成读取失败' })
          .waitFor({ state: 'hidden' });
        await page.getByPlaceholder('邮箱或备注').fill('');
        await page.getByRole('button', { name: '搜索', exact: true }).click();
        await page.getByText('官网创建待授权', { exact: true }).waitFor();
        await page.evaluate((value) => {
          document.documentElement.setAttribute('data-v2-theme', value);
          document.documentElement.classList.toggle('dark', value === 'dark');
          document.documentElement.style.colorScheme = value;
        }, theme);
        assert.equal(
          await page
            .getByRole('tab', { name: '全部账号', exact: true })
            .getAttribute('aria-selected'),
          'true'
        );
        const header = await page.locator('.v2-records-table thead').innerText();
        for (const removed of ['首次登录', '最近登录', '银行卡删除状态'])
          assert.ok(!header.includes(removed));
        assert.ok(header.includes('注册 IP / 国家'));
        assert.equal(await page.getByRole('button', { name: /删除银行卡/ }).count(), 0);
        const manual = page
          .locator('.v2-records-table tbody tr')
          .filter({ hasText: '账号验收 1' })
          .first();
        assert.ok((await manual.innerText()).includes('已注册·待补资料'));
        assert.ok((await manual.innerText()).includes('国家未记录'));
        const partial = page
          .locator('.v2-records-table tbody tr')
          .filter({ hasText: '官网创建待授权' });
        assert.ok((await partial.innerText()).includes('203.0.113.20'));
        assert.ok((await partial.innerText()).includes('菲律宾'));
        assert.ok((await partial.innerText()).includes('4*******1234'));
        const first = await geometry(page, `${theme}-${width} 首页`);
        await snapshot(page, `${theme}-${width}-inventory.png`);
        await page.getByRole('button', { name: '下一页' }).click();
        await page.getByText('账号验收 21', { exact: true }).waitFor();
        const last = await geometry(page, `${theme}-${width} 末页`);
        assert.ok(last.height >= first.height - 1, '末页列表框架缩小');
        await page.getByRole('tab', { name: '待用账号', exact: true }).click();
        await page.getByText('账号验收 1', { exact: true }).waitFor();
        assert.equal(await page.getByText('账号验收 3', { exact: true }).count(), 0);
        await page.getByRole('tab', { name: '回收站', exact: true }).click();
        await page.getByText('回收站记录', { exact: true }).waitFor();
        await geometry(page, `${theme}-${width} 回收站`);
        await page.getByRole('tab', { name: '全部账号', exact: true }).click();
        await page.getByText('账号验收 1', { exact: true }).waitFor();
        await page.getByPlaceholder('邮箱或备注').fill('没有匹配项');
        await page.getByRole('button', { name: '搜索', exact: true }).click();
        await page.getByText('暂无 ChatGPT 账号', { exact: true }).waitFor();
        await geometry(page, `${theme}-${width} 空列表`);
        await page.getByPlaceholder('邮箱或备注').fill('');
        await page.getByRole('button', { name: '搜索', exact: true }).click();
        await page.getByText('账号验收 1', { exact: true }).waitFor();
        await page.getByRole('button', { name: '新增账号', exact: true }).click();
        let drawer = page.getByRole('dialog', { name: '新增 ChatGPT 账号', exact: true });
        await drawer
          .locator('input[name="chatgpt-account-create-email"]')
          .fill('draft@example.invalid');
        await drawer.getByPlaceholder('选填', { exact: true }).fill('注册验收草稿');
        await drawer.getByRole('button', { name: '关闭', exact: true }).click();
        await page.getByRole('button', { name: '新增账号', exact: true }).click();
        drawer = page.getByRole('dialog', { name: '新增 ChatGPT 账号', exact: true });
        assert.equal(
          await drawer.locator('input[name="chatgpt-account-create-email"]').inputValue(),
          'draft@example.invalid'
        );
        await drawer.getByRole('button', { name: '关闭', exact: true }).click();
        await navigate(page, registrationPath);
        await page.getByRole('tab', { name: '注册结果与凭据', exact: true }).waitFor();
        assert.equal(await page.getByRole('tab', { name: '订阅管理', exact: true }).count(), 0);
        await page.getByRole('tab', { name: '注册结果与凭据', exact: true }).click();
        await page.frameLocator('#registration-workspace').getByText('合成凭据工作区').waitFor();
        await page
          .frameLocator('#registration-workspace')
          .getByRole('button', { name: '打开主台账' })
          .click();
        await page.getByText('账号验收 1', { exact: true }).waitFor();
        assert.equal(new URL(page.url()).pathname, accountPath);
        assert.equal(
          await page
            .getByRole('tab', { name: '全部账号', exact: true })
            .getAttribute('aria-selected'),
          'true'
        );
        await page.getByRole('button', { name: '新增账号', exact: true }).click();
        drawer = page.getByRole('dialog', { name: '新增 ChatGPT 账号', exact: true });
        assert.equal(
          await drawer.locator('input[name="chatgpt-account-create-email"]').inputValue(),
          'draft@example.invalid'
        );
        await drawer.getByRole('button', { name: '关闭', exact: true }).click();
        await navigate(page, registrationPath);
      } else {
        await page.goto(`${origin}${registrationPath}`, { waitUntil: 'domcontentloaded' });
        await page.getByRole('tab', { name: '苹果隐藏邮箱', exact: true }).waitFor();
        await page.evaluate((value) => {
          document.documentElement.setAttribute('data-v2-theme', value);
          document.documentElement.classList.toggle('dark', value === 'dark');
          document.documentElement.style.colorScheme = value;
        }, theme);
      }
      await page.getByRole('tab', { name: '苹果隐藏邮箱', exact: true }).click();
      const mailbox =
        width <= 900
          ? page.locator('.v2-records-mobile-item').filter({ hasText: 'hidden-1@example.invalid' })
          : page
              .locator('.v2-records-table tbody tr')
              .filter({ hasText: 'hidden-1@example.invalid' });
      await mailbox.waitFor({ state: 'visible' });
      await mailbox.locator('.el-checkbox').click();
      if (manualOnly) mailboxes[0].revision = 8;
      await page.getByRole('button', { name: '同步历史标记', exact: true }).click();
      const confirmation = page.getByRole('dialog', { name: '同步历史人工标记', exact: true });
      if (manualOnly) {
        await confirmation
          .getByText('邮箱状态已变化，请刷新后重新选择', { exact: false })
          .waitFor();
        assert.equal(
          await confirmation.getByRole('button', { name: /同步到 ChatGPT 账号/ }).isEnabled(),
          false
        );
        await confirmation.getByRole('button', { name: '取消', exact: true }).click();
        await page.getByRole('button', { name: '同步历史标记', exact: true }).click();
        await confirmation
          .getByText('邮箱状态已变化，请刷新后重新选择', { exact: false })
          .waitFor();
        assert.equal(
          writes.filter((item) => item.endpoint.endsWith('/manual-sync-preview')).at(-1).targets[0]
            .revision,
          3
        );
        failMailboxRead = true;
        await confirmation.getByRole('button', { name: '重新核对最新状态', exact: true }).click();
        await confirmation.getByText('邮箱最新状态读取失败，请重试核对', { exact: true }).waitFor();
        assert.equal(
          await confirmation.getByRole('button', { name: /同步到 ChatGPT 账号/ }).isEnabled(),
          false
        );
        failMailboxRead = false;
        await confirmation.getByRole('button', { name: '重新核对最新状态', exact: true }).click();
      }
      await confirmation.getByText('将新增为已注册·待补资料', { exact: false }).waitFor();
      await snapshot(
        page,
        `${theme}-${width}-${manualOnly ? 'manual-recheck-preview' : 'manual-preview'}.png`
      );
      await confirmation.getByRole('button', { name: '同步到 ChatGPT 账号', exact: true }).click();
      await page.getByText(/历史标记同步：已同步 1 个/).waitFor();
      assert.ok(writes.some((write) => write.endpoint.endsWith('/manual-sync')));
      await snapshot(
        page,
        `${theme}-${width}-${manualOnly ? 'manual-recheck-result' : 'apple-result'}.png`
      );
      assert.deepEqual(unexpected, []);
      assert.deepEqual(errors, []);
      completed.push({
        theme,
        width,
        states: manualOnly
          ? [
              'stale-preview-blocks-save',
              'close-reopen-retains-version',
              'explicit-recheck-read-failure-retains-version-and-blocks-save',
              'explicit-recheck-updates-version',
              'manual-sync-cas-result'
            ]
          : [
              'all',
              'pending-data',
              'registration-facts',
              'card-display',
              'last-page',
              'unused',
              'recycle',
              'empty',
              'refresh-error-keeps-data-and-retry',
              'editor-close-reopen-and-route-draft',
              'retired-payment-tab',
              'native-to-main',
              'manual-sync-preview-and-result'
            ]
      });
      await context.close();
      console.log(JSON.stringify({ ok: true, theme, width }));
    }
  const result = {
    ok: true,
    mode: 'OFFLINE_BUILT_ADMIN_WITH_SYNTHETIC_API',
    localWebsiteStarted: false,
    productionMutated: false,
    completed
  };
  writeFileSync(
    path.join(output, manualOnly ? 'manual-recheck-result.json' : 'result.json'),
    `${JSON.stringify(result, null, 2)}\n`
  );
  console.log(JSON.stringify(result));
} catch (error) {
  if (inspectedPage && !inspectedPage.isClosed()) {
    await inspectedPage.screenshot({ path: path.join(output, 'failure.png'), fullPage: true });
    writeFileSync(
      path.join(output, 'failure-body.txt'),
      await inspectedPage.locator('body').innerText()
    );
    writeFileSync(path.join(output, 'failure-requests.json'), JSON.stringify(unexpected));
  }
  throw error;
} finally {
  await browser.close();
}

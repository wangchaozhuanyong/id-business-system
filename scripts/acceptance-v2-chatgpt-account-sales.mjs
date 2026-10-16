#!/usr/bin/env node
/* global document, window, getComputedStyle */
// 仅托管管理端构建的静态文件；接口全部使用合成资料，不启动网站服务或数据库。
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { extname, resolve, sep } from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const dist = resolve(root, 'apps/admin/dist');
const output = resolve(root, process.argv[2] ?? '.runtime/chatgpt-sale-status-20261016/browser');
assert.ok(output.startsWith(root + sep), '验收产物必须留在所属项目');
assert.ok(existsSync(resolve(dist, 'index.html')), '请先构建管理端');
mkdirSync(output, { recursive: true });
const now = '2026-10-16T01:00:00.000Z';
const routePath = '/v2/account-settings/chatgpt-accounts';
const user = {
  id: '11111111-1111-4111-8111-000000000000',
  username: 'fixture-admin',
  displayName: '验收管理员',
  roles: ['admin'],
  permissions: [],
  mustResetPassword: false
};
const checks = [],
  errors = [],
  unexpectedWrites = [];
const server = createServer((request, response) => {
  const requested = resolve(dist, '.' + new URL(request.url, 'http://fixture').pathname);
  if (!requested.startsWith(dist + sep)) return response.writeHead(403).end();
  const file =
    existsSync(requested) && extname(requested) ? requested : resolve(dist, 'index.html');
  response.setHeader(
    'Content-Type',
    {
      '.js': 'text/javascript',
      '.css': 'text/css',
      '.html': 'text/html',
      '.svg': 'image/svg+xml',
      '.woff2': 'font/woff2'
    }[extname(file)] ?? 'application/octet-stream'
  );
  response.end(readFileSync(file));
});
await new Promise((done) => server.listen(0, '127.0.0.1', done));
const base = `http://127.0.0.1:${server.address().port}`;
const browser = await chromium.launch({ headless: true });

function records() {
  return Array.from({ length: 25 }, (_, i) => ({
    id: `22222222-2222-4222-8222-${String(i).padStart(12, '0')}`,
    emailMasked: `sa***${String(i).padStart(3, '0')}@example.invalid`,
    registered: i !== 0,
    saleStatus: i === 22 || i === 23 ? 'sold' : 'unsold',
    soldAt: i === 22 ? '2026-10-15T01:00:00.000Z' : i === 23 ? now : null,
    deletedAt: i === 24 ? now : null,
    status: 'active',
    subscriptionState: i === 1 ? 'active' : 'never_subscribed',
    registrationSource: 'manual',
    registrationIp: null,
    registrationCountryCode: null,
    registeredAt: null,
    needsSupplement: true,
    hasPassword: true,
    hasTotp: false,
    remark: `测试账号 ${i}`,
    offerStatus: 'unknown',
    currentPlan: null,
    dueAt: null,
    firstLoginNetwork: null,
    lastLoginNetwork: null,
    createdAt: now,
    updatedAt: now,
    openingCard: null
  }));
}
async function fixture(width = 1440, theme = 'light') {
  const context = await browser.newContext({ viewport: { width, height: 1000 } });
  const state = { rows: records(), writes: [], fail: false, delay: 0, hidden: [], reads: [] };
  await context.addInitScript(
    ({ user, theme }) => {
      localStorage.setItem('apple_business_access_token', 'synthetic-ui-fixture');
      localStorage.setItem('apple_business_current_user', JSON.stringify(user));
      window.addEventListener(
        'DOMContentLoaded',
        () => {
          document.documentElement.dataset.v2Theme = theme;
        },
        { once: true }
      );
    },
    { user, theme }
  );
  await context.route('**/*', async (route) => {
    const req = route.request(),
      url = new URL(req.url()),
      p = url.pathname;
    if (url.origin !== base) return route.abort();
    if (!p.startsWith('/api/')) return route.continue();
    const method = req.method();
    let data = { items: [], total: 0 },
      failure = '',
      status = 200;
    if (/\/auth\/(me|session)$/.test(p)) data = user;
    else if (p.endsWith('/branding/public'))
      data = {
        appName: 'ID 业务管理',
        logoText: 'ID',
        logoUrl: '/brand/default-logo.svg',
        appSubtitle: '业务管理',
        documentTitleSuffix: 'ID 业务管理'
      };
    else if (p.endsWith('/time')) data = { now, timezone: 'Asia/Shanghai' };
    else if (p.endsWith('/change-versions')) data = { generatedAt: now, versions: {} };
    else if (p.endsWith('/table-preferences') && method === 'GET')
      data = {
        items: state.hidden.length
          ? [{ tableId: 'chatgpt-accounts.main', hiddenColumnKeys: state.hidden }]
          : []
      };
    else if (p.endsWith('/table-preferences/chatgpt-accounts.main') && method === 'PUT') {
      state.hidden = req.postDataJSON().hiddenColumnKeys;
      data = { tableId: 'chatgpt-accounts.main', hiddenColumnKeys: state.hidden };
    } else if (p.endsWith('/bank-recharge/accounts') && method === 'GET') {
      const q = Object.fromEntries(url.searchParams);
      state.reads.push(q);
      let rows = state.rows.filter((a) => (q.deleted === 'deleted' ? a.deletedAt : !a.deletedAt));
      if (q.saleStatus && q.saleStatus !== 'all')
        rows = rows.filter((a) => a.saleStatus === q.saleStatus);
      if (q.subscriptionState === 'never_subscribed')
        rows = rows.filter((a) => a.subscriptionState === 'never_subscribed');
      if (q.keyword) rows = rows.filter((a) => `${a.emailMasked} ${a.remark}`.includes(q.keyword));
      if (q.offerStatus && q.offerStatus !== 'all')
        rows = rows.filter((a) => a.offerStatus === q.offerStatus);
      if (q.saleStatus === 'sold')
        rows.sort((a, b) => b.soldAt.localeCompare(a.soldAt) || b.id.localeCompare(a.id));
      const page = Number(q.page || 1),
        pageSize = Number(q.pageSize || rows.length);
      data = {
        items: rows.slice((page - 1) * pageSize, page * pageSize),
        total: rows.length,
        page,
        pageSize
      };
    } else if (/\/bank-recharge\/accounts\/[^/]+$/.test(p) && method === 'PATCH') {
      const body = req.postDataJSON(),
        account = state.rows.find((a) => a.id === p.split('/').at(-1));
      assert.deepEqual(Object.keys(body).sort(), ['expectedUpdatedAt', 'saleStatus']);
      state.writes.push(body);
      if (state.delay) await new Promise((done) => setTimeout(done, state.delay));
      if (state.fail) {
        failure = '合成保存失败，请重试';
        status = 500;
        state.fail = false;
      } else if (!account || account.updatedAt !== body.expectedUpdatedAt) {
        failure = '账号资料已变化，请重新核对后保存';
        status = 409;
      } else if (body.saleStatus === 'sold' && !account.registered) {
        failure = '只有已标记注册的账号才能标记已出售';
        status = 409;
      } else {
        account.saleStatus = body.saleStatus;
        account.soldAt = body.saleStatus === 'sold' ? new Date().toISOString() : null;
        account.updatedAt = new Date().toISOString();
        data = { id: account.id };
      }
    } else if (!['GET', 'HEAD'].includes(method)) {
      unexpectedWrites.push({ p, method });
      return route.abort();
    }
    await route.fulfill({
      status,
      contentType: 'application/json',
      body: JSON.stringify({
        success: !failure,
        data,
        message: failure || 'OK',
        requestId: 'synthetic-sales-fixture'
      })
    });
  });
  const page = await context.newPage();
  page.on('pageerror', (e) => errors.push(e.message));
  await page.goto(`${base}${routePath}`);
  await page.getByText(state.rows[0].emailMasked, { exact: true }).waitFor();
  await page.evaluate((theme) => {
    document.documentElement.dataset.v2Theme = theme;
    document.documentElement.style.colorScheme = theme;
  }, theme);
  return { context, page, state };
}
const rows = (page) => page.locator('.el-table__body-wrapper tbody tr');
const row = (page, account) => rows(page).filter({ hasText: account.emailMasked });
async function action(page, account, name) {
  await row(page, account).getByRole('button', { name: '更多操作', exact: true }).click();
  await page
    .locator('.el-dropdown-menu:visible')
    .getByRole('menuitem', { name, exact: true })
    .click();
  const modal = page.getByRole('dialog', { name, exact: true });
  await modal.waitFor();
  await page.waitForFunction(
    () => !document.querySelector('.dialog-fade-enter-active, .dialog-fade-enter-from')
  );
  return modal;
}
async function tab(page, name) {
  await page.getByRole('tab', { name, exact: true }).click();
  await page.waitForFunction(
    () =>
      document
        .querySelector('.bank-recharge-page > .v2-async-region')
        ?.getAttribute('data-v2-query-phase') === 'ready'
  );
}
async function dimensions(page) {
  return page.locator('.v2-records-list').evaluate((list) => {
    const box = list.getBoundingClientRect();
    const title = list.querySelector('.v2-section-heading')?.getBoundingClientRect();
    const labels = [...document.querySelectorAll('.v2-page-context .el-form-item')].flatMap(
      (item) => {
        const label = item.querySelector('.el-form-item__label'),
          control = item.querySelector('.el-input__wrapper, .el-select__wrapper');
        if (!label || !control) return [];
        const range = document.createRange();
        range.selectNodeContents(label);
        const a = range.getBoundingClientRect(),
          b = control.getBoundingClientRect();
        return [
          {
            offset: Math.abs(a.y + a.height / 2 - b.y - b.height / 2),
            lineHeight: getComputedStyle(label).lineHeight
          }
        ];
      }
    );
    return {
      height: box.height,
      top: box.top,
      titleTop: title?.top,
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      labels
    };
  });
}
try {
  // 每种主题和断点均实际打开下拉和确认框；页签、首末页及空状态使用相同构建。
  for (const theme of ['light', 'dark'])
    for (const width of process.argv.includes('--interactions-only')
      ? []
      : [1440, 1024, 901, 900, 768, 390]) {
      const { context, page, state } = await fixture(width, theme);
      await page.getByRole('columnheader', { name: '出售情况', exact: true }).waitFor();
      await page.getByRole('columnheader', { name: '出售标记时间', exact: true }).waitFor();
      const first = await dimensions(page);
      assert.ok(first.overflow <= 1, `${theme}/${width} 页面横向溢出`);
      assert.ok(
        first.labels.every((x) => x.offset <= 2),
        '筛选标签和控件未对齐'
      );
      const modal = await action(page, state.rows[2], '标记已出售');
      await modal.getByText(/仍可充值和续费/).waitFor();
      assert.ok((await modal.boundingBox()).width <= width, '确认框超出窄屏');
      await page.screenshot({ path: resolve(output, `${theme}-${width}.png`) });
      await modal.getByRole('button', { name: '取消', exact: true }).click();
      await modal.waitFor({ state: 'hidden' });
      assert.equal(state.writes.length, 0, '取消确认不得保存');
      await page.locator('.el-pagination .btn-next').click();
      await page.getByText(state.rows[20].emailMasked, { exact: true }).waitFor();
      const last = await dimensions(page);
      assert.ok(Math.abs(last.height - first.height) <= 2, '末页列表高度跳动');
      await page.getByPlaceholder('邮箱或备注').fill('不存在的合成账号');
      await page.getByRole('button', { name: '搜索', exact: true }).click();
      await page.getByText('暂无 ChatGPT 账号', { exact: true }).waitFor();
      const empty = await dimensions(page);
      assert.ok(Math.abs(empty.height - first.height) <= 2, '空状态列表高度跳动');
      assert.ok(empty.overflow <= 1, '空状态页面溢出');
      checks.push({ name: `layout-${theme}-${width}`, first, last, empty });
      await context.close();
    }
  const { context, page, state } = await fixture();
  await row(page, state.rows[0]).getByRole('button', { name: '更多操作', exact: true }).click();
  assert.equal(
    await page
      .getByRole('menuitem', { name: '标记已出售', exact: true })
      .getAttribute('aria-disabled'),
    'true'
  );
  await page.getByText('账号清单', { exact: true }).click();
  await page.locator('.el-dropdown-menu:visible').waitFor({ state: 'hidden' });
  checks.push({ name: 'unregistered-disabled' });

  // 失败保留确认框与原状态，重试期间保护关闭与重复提交。
  const modal = await action(page, state.rows[2], '标记已出售');
  state.fail = true;
  await modal.getByRole('button', { name: '标记已出售', exact: true }).click();
  await modal.getByRole('alert').filter({ hasText: '合成保存失败' }).waitFor();
  assert.equal(state.rows[2].saleStatus, 'unsold');
  state.delay = 700;
  await modal.getByRole('button', { name: '标记已出售', exact: true }).click();
  await modal.locator('button.is-loading').waitFor();
  assert.ok(await modal.getByRole('button', { name: '取消', exact: true }).isDisabled());
  await modal.waitFor({ state: 'hidden' });
  await row(page, state.rows[2]).getByText('已出售', { exact: true }).waitFor();
  assert.equal(state.writes.length, 2);
  checks.push({ name: 'failure-retry-and-submit-protection' });

  await tab(page, '已出售');
  await page.getByText(state.rows[2].emailMasked, { exact: true }).waitFor();
  assert.equal(await rows(page).count(), 3);
  assert.ok((await rows(page).first().textContent()).includes(state.rows[2].emailMasked));
  await page.reload();
  await page.getByText(state.rows[0].emailMasked, { exact: true }).waitFor();
  await row(page, state.rows[2]).getByText('已出售', { exact: true }).waitFor();
  await tab(page, '待用账号');
  await page.getByText(state.rows[3].emailMasked, { exact: true }).waitFor();
  assert.equal(await row(page, state.rows[2]).count(), 0);
  await tab(page, '已出售');
  await page.getByText(state.rows[2].emailMasked, { exact: true }).waitFor();
  const unsoldModal = await action(page, state.rows[2], '改为未出售');
  await unsoldModal.getByRole('button', { name: '改为未出售', exact: true }).click();
  await unsoldModal.waitFor({ state: 'hidden' });
  await page.getByText(state.rows[23].emailMasked, { exact: true }).waitFor();
  assert.equal(await row(page, state.rows[2]).count(), 0);
  assert.equal(state.rows[2].soldAt, null);
  checks.push({ name: 'all-sold-pending-reload-and-reverse' });

  // 待用最后一页的最后一行售出后，页码回到有效页。
  await tab(page, '待用账号');
  await page.getByText(state.rows[2].emailMasked, { exact: true }).waitFor();
  await page.locator('.el-pagination .btn-next').click();
  await page.getByText(state.rows[21].emailMasked, { exact: true }).waitFor();
  const lastModal = await action(page, state.rows[21], '标记已出售');
  await lastModal.getByRole('button', { name: '标记已出售', exact: true }).click();
  await lastModal.waitFor({ state: 'hidden' });
  await page.getByText(state.rows[0].emailMasked, { exact: true }).waitFor();
  assert.equal((await page.locator('.el-pagination .number.is-active').textContent()).trim(), '1');
  checks.push({ name: 'sold-last-row-page-clamp' });

  await tab(page, '回收站');
  await page.getByText(state.rows[24].emailMasked, { exact: true }).waitFor();
  assert.equal(
    await row(page, state.rows[24]).getByRole('button', { name: '更多操作', exact: true }).count(),
    0
  );
  checks.push({ name: 'recycle-readonly' });
  await tab(page, '全部账号');
  await page.getByText(state.rows[5].emailMasked, { exact: true }).waitFor();
  const conflictModal = await action(page, state.rows[5], '标记已出售');
  state.rows[5].updatedAt = '2026-10-16T02:00:00.000Z';
  await conflictModal.getByRole('button', { name: '标记已出售', exact: true }).click();
  await conflictModal.getByRole('alert').filter({ hasText: '账号资料已变化' }).waitFor();
  assert.equal(state.rows[5].saleStatus, 'unsold');
  await conflictModal.getByRole('button', { name: '取消', exact: true }).click();
  await conflictModal.waitFor({ state: 'hidden' });
  checks.push({ name: 'concurrent-change-keeps-original-confirmation' });

  await tab(page, '全部账号');
  await page.getByText(state.rows[0].emailMasked, { exact: true }).waitFor();
  await page.getByRole('button', { name: '列设置', exact: true }).click();
  const drawer = page.getByRole('dialog').filter({ hasText: '列显示设置' });
  await drawer.getByText('出售情况', { exact: true }).click();
  assert.equal(
    await drawer.getByRole('checkbox', { name: '出售情况', exact: true }).isChecked(),
    false
  );
  await drawer.getByRole('button', { name: '保存设置', exact: true }).click();
  await drawer.waitFor({ state: 'hidden' });
  assert.equal(await page.getByRole('columnheader', { name: '出售情况', exact: true }).count(), 0);
  await page.reload();
  await page.getByText(state.rows[0].emailMasked, { exact: true }).waitFor();
  assert.equal(await page.getByRole('columnheader', { name: '出售情况', exact: true }).count(), 0);
  checks.push({ name: 'column-settings-persist' });
  await context.close();
  assert.deepEqual(errors, []);
  assert.deepEqual(unexpectedWrites, []);
  writeFileSync(
    resolve(output, 'result.json'),
    JSON.stringify({ status: 'PASS', checks, errors, unexpectedWrites, realWrites: 0 }, null, 2)
  );
  console.log(JSON.stringify({ status: 'PASS', checks: checks.length, output }));
} catch (error) {
  writeFileSync(
    resolve(output, 'result.json'),
    JSON.stringify(
      { status: 'FAIL', checks, errors, unexpectedWrites, error: String(error) },
      null,
      2
    )
  );
  throw error;
} finally {
  await browser.close();
  await new Promise((done) => server.close(done));
}

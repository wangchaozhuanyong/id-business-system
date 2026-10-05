#!/usr/bin/env node
/* global document, window */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';

const root = fileURLToPath(new URL('..', import.meta.url));
const projectRoot = root.includes('/.codex-worktrees/')
  ? root.split('/.codex-worktrees/')[0]
  : root;
const url = new URL(process.env.V2_ARCHIVE_UI_ADMIN_URL || 'http://127.0.0.1:5398');
assert.ok(['localhost', '127.0.0.1', '::1'].includes(url.hostname), '仅允许本机验收');
const output = path.resolve(root, process.argv[2] || '.runtime/order-archive-ui');
assert.ok(!path.relative(projectRoot, output).startsWith('..'), '验收产物必须归属当前项目');
mkdirSync(output, { recursive: true });
const now = '2026-10-05T01:00:00.000Z';
const user = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'archive-ui-fixture',
  displayName: '本地归档验收',
  roles: ['admin'],
  permissions: [],
  mustResetPassword: false
};
const checks = [],
  errors = [],
  requests = [];
let browser, server, lastPage;
const idOf = (index) => `22222222-2222-4222-8222-${String(index + 1).padStart(12, '0')}`;
function order(index) {
  const status = ['completed', 'refunded', 'cancelled', 'failed'][index] || 'pending';
  return {
    id: idOf(index),
    orderNo: `ORD-LOCAL-${String(index + 1).padStart(3, '0')}`,
    customer: { id: 'local-customer', name: '本地合成客户' },
    service: { id: 'local-service', code: 'local-service', name: '本地合成业务', parent: null },
    account: {
      id: 'local-account',
      displayAppleId: 'local***@example.invalid',
      appleIdMasked: 'local***@example.invalid',
      country: { id: 'local-country', code: 'US', name: '美国' }
    },
    settlementPlatform: { id: 'local-settlement', code: 'local-settlement', name: '本地结算' },
    platformOrderNo: null,
    maskedWebsiteAccount: null,
    displayWebsiteAccount: null,
    hasWebsiteAccount: false,
    receivedAmount: '130.00',
    receivedOriginalAmount: '130.00',
    receivedCurrency: 'CNY',
    receivedFxRateToCny: '1',
    receivedFxSnapshotId: null,
    receivedFinanceAccountId: null,
    receivedFinanceAccount: null,
    receivedAt: now,
    platformFeeAmount: '10.00',
    accountSource: 'inventory',
    sourceSoldOrderId: null,
    sourceSoldOrder: null,
    accountDisposition: 'retained',
    accountCostAmount: '50.00',
    appliedAccountCostAmount: '50.00',
    balanceAmount: '20.00',
    balanceCurrencyCode: 'USD',
    remainingRefundableBalanceAmount: '20.00',
    balanceCostAmount: '50.00',
    refundCostAmount: null,
    profitAmount: '70.00',
    profitRate: '53.85',
    status,
    statusChangedAt: now,
    openedAt: now,
    dueAt: '2026-11-05T01:00:00.000Z',
    remark: '纯本地合成验收资料',
    createdBy: user,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    activeLock: null,
    upgradeBalanceReturn: null,
    // 故意让归档响应保留旧写标志，验证界面本身仍会禁用业务写入口。
    operations: {
      canEdit: true,
      canEditCore: false,
      canEditPricing: true,
      canEditReceiptAccount: false,
      canConsume: false,
      canComplete: false,
      canRefund: true,
      canRecordUpgradeBalanceReturn: true,
      canReverseUpgradeBalanceReturn: false,
      canCancel: true,
      canDelete: true,
      canArchive: index < 4,
      canUnarchive: true
    }
  };
}

function customer(index) {
  return {
    id: `customer-${index}`,
    name: `本地客户 ${index + 1}`,
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
    contactDisplayModes: { phone: 'masked', wechat: 'masked', qq: 'masked', whatsapp: 'masked' },
    sourceOptionId: null,
    source: null,
    tagOptionIds: [],
    tags: [],
    serviceOptionIds: [],
    services: [],
    recordStatus: 'active',
    remark: '本地共享卡片回归',
    createdBy: null,
    createdAt: now,
    updatedAt: now
  };
}

try {
  if (!process.env.V2_ARCHIVE_UI_ADMIN_URL)
    server = spawn(
      process.execPath,
      [
        path.join(root, 'node_modules/vite/bin/vite.js'),
        '--host',
        url.hostname,
        '--port',
        url.port,
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
  const deadline = Date.now() + 30_000;
  while (!(await fetch(new URL('/login', url)).catch(() => null))?.ok) {
    assert.ok(Date.now() < deadline && server?.exitCode == null, '本地服务器未启动');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await chromium.launch();
  for (const theme of ['light', 'dark'])
    for (const width of [1440, 768, 390]) await verify(theme, width);
  assert.deepEqual(errors, []);
  const result = {
    ok: true,
    checks,
    errors,
    requests,
    businessWrites: 0,
    data: '仅本地合成夹具；全部 API 响应拦截；禁止外部访问'
  };
  writeFileSync(path.join(output, 'checks.json'), JSON.stringify(result, null, 2));
  console.log(
    JSON.stringify({
      ok: true,
      checks: checks.length,
      simulatedWrites: requests.length,
      businessWrites: 0,
      output
    })
  );
} catch (error) {
  if (lastPage && !lastPage.isClosed()) {
    await lastPage
      .screenshot({ path: path.join(output, 'failure.png'), fullPage: true })
      .catch(() => undefined);
    writeFileSync(
      path.join(output, 'failure-dom.txt'),
      await lastPage
        .locator('body')
        .innerText()
        .catch(() => '')
    );
  }
  writeFileSync(
    path.join(output, 'failure.json'),
    JSON.stringify({ checks, errors, requests, error: error.message }, null, 2)
  );
  throw error;
} finally {
  await browser?.close();
  server?.kill('SIGTERM');
}

async function verify(theme, width) {
  const page = (lastPage = await browser.newPage({ viewport: { width, height: 1000 } }));
  page.setDefaultTimeout(10_000);
  page.on('pageerror', (error) => errors.push(error.message));
  const record = (scenario, details = {}) => checks.push({ theme, width, scenario, ...details });
  const rows = Array.from({ length: 23 }, (_, index) => order(index));
  const customerRows = Array.from({ length: 21 }, (_, index) => customer(index));
  const originalBusiness = JSON.stringify(rows.map(businessFields));
  const receipts = new Map();
  let failOnce = true,
    revision = 0;
  await page.addInitScript(
    ({ user: value, theme: selectedTheme }) => {
      localStorage.setItem('apple_business_access_token', 'local-archive-fixture');
      localStorage.setItem('apple_business_current_user', JSON.stringify(value));
      localStorage.setItem('id-business-v2-theme', selectedTheme);
    },
    { user, theme }
  );
  await page.route('**/*', async (route) => {
    const request = route.request(),
      requestUrl = new URL(request.url()),
      p = requestUrl.pathname;
    assert.equal(requestUrl.origin, url.origin, '禁止访问外部系统');
    if (!p.startsWith('/api/')) return route.continue();
    const pageNumber = Number(requestUrl.searchParams.get('page') || 1);
    const pageSize = Number(requestUrl.searchParams.get('pageSize') || 20);
    let data = { items: [], total: 0, page: pageNumber, pageSize };
    if (request.method() !== 'GET') {
      assert.match(p, /\/orders\/[\w-]+\/(archive|unarchive)$/, '只能模拟归档与恢复');
      const action = p.endsWith('/unarchive') ? 'unarchive' : 'archive';
      const id = p.split('/').at(-2),
        payload = request.postDataJSON();
      const row = rows.find((item) => item.id === id);
      assert.ok(row, '逐行订单 ID 必须存在');
      assert.ok(payload.expectedUpdatedAt && payload.reason.length >= 2 && payload.idempotencyKey);
      requests.push({ theme, width, id, action, payload });
      await new Promise((resolve) => setTimeout(resolve, 80));
      if (action === 'archive' && id === idOf(1) && failOnce) {
        failOnce = false;
        return route.fulfill({
          status: 500,
          json: { success: false, message: '本地模拟一笔暂时失败' }
        });
      }
      if (receipts.has(payload.idempotencyKey))
        data = { ...receipts.get(payload.idempotencyKey), idempotentReplay: true };
      else {
        if (row.updatedAt !== payload.expectedUpdatedAt)
          return route.fulfill({
            status: 409,
            json: { success: false, message: '订单资料版本已变化，请重新核对' }
          });
        row.updatedAt = new Date(Date.parse(now) + ++revision * 1000).toISOString();
        row.archivedAt = action === 'archive' ? row.updatedAt : null;
        data = {
          id,
          archivedAt: row.archivedAt,
          updatedAt: row.updatedAt,
          idempotentReplay: false
        };
        receipts.set(payload.idempotencyKey, data);
      }
    } else if (/\/auth\/(me|session)$/.test(p)) data = user;
    else if (p.endsWith('/branding/public'))
      data = {
        appName: 'ID 业务管理',
        logoText: 'ID',
        logoUrl: '/brand/default-logo.svg',
        appSubtitle: '本地归档验收'
      };
    else if (p.endsWith('/time')) data = { now, timezone: 'Asia/Shanghai' };
    else if (p.endsWith('/change-versions')) data = { generatedAt: now, versions: {} };
    else if (p.endsWith('/renewals/warning-summary')) data = { total: 0, warningDays: 7 };
    else if (p.endsWith('/sensitive-access/approvals/summary')) data = { pending: 0 };
    else if (/\/orders(?:\/bootstrap)?$/.test(p)) {
      const archived = requestUrl.searchParams.get('archived') || 'active';
      const keyword = requestUrl.searchParams.get('keyword') || '';
      const filtered = rows.filter(
        (row) =>
          (archived === 'all' || Boolean(row.archivedAt) === (archived === 'archived')) &&
          row.orderNo.includes(keyword)
      );
      const list = {
        ...data,
        items: structuredClone(filtered.slice((pageNumber - 1) * pageSize, pageNumber * pageSize)),
        total: filtered.length
      };
      data = p.endsWith('/bootstrap')
        ? { list, options: { services: [], settlementPlatforms: [] } }
        : list;
    } else if (/\/orders\/[\w-]+$/.test(p))
      data = structuredClone(rows.find((row) => p.endsWith(row.id)));
    else if (/\/customers(?:\/bootstrap)?$/.test(p)) {
      const list = {
        ...data,
        items: customerRows.slice((pageNumber - 1) * pageSize, pageNumber * pageSize),
        total: customerRows.length
      };
      data = p.endsWith('/bootstrap')
        ? {
            list,
            options: { sources: [], tags: [], services: [] },
            sensitiveDisplayCatalog: [],
            sensitiveDisplayModeLabels: {}
          }
        : list;
    } else if (p.endsWith('/bootstrap'))
      data = {
        list: data,
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
    await route.fulfill({
      json: { success: true, data, message: 'OK', requestId: 'archive-fixture', timestamp: now }
    });
  });
  await page.goto(new URL('/v2/orders', url).href, { waitUntil: 'domcontentloaded' });
  await ready(page);
  assert.equal(await page.locator('html').getAttribute('data-v2-theme'), theme);
  const first = await measure(page);
  await page.screenshot({ path: path.join(output, `${theme}-${width}-first.png`), fullPage: true });
  await page.locator('.v2-records-page .el-pagination button.btn-next').click();
  await page.waitForFunction(
    () => document.querySelector('.v2-records-page .el-pager .is-active')?.textContent === '2'
  );
  await ready(page);
  const last = await measure(page);
  assert.ok(last.frame.height >= first.frame.height - 2, '末页列表框架不能缩小');
  record('first-and-last-page-stable-frame-and-text', { first, last });
  await page.locator('.v2-records-page .el-pagination button.btn-prev').click();
  await ready(page);
  await filter(page, '已归档');
  await page.getByText('暂无订单', { exact: true }).filter({ visible: true }).waitFor();
  const empty = await measure(page);
  assert.ok(empty.frame.height >= first.frame.height - 2, '空列表框架不能缩小');
  record('archived-empty-state-stable-frame', { empty });
  await filter(page, '当前订单');
  for (let index = 0; index < 4; index++) await visibleCheckbox(page, rows[index].orderNo).click();
  await page.getByRole('button', { name: '归档所选（4）', exact: true }).click();
  let dialog = page.locator('.el-dialog:visible');
  await dialog.getByRole('button', { name: '确认归档', exact: true }).click();
  await dialog.getByText('操作原因必须为 2 至 500 个字符', { exact: true }).waitFor();
  assert.equal(requests.filter((r) => r.theme === theme && r.width === width).length, 0);
  await dialog.locator('textarea').fill('清理本地测试订单列表');
  await assertFormAlignment(dialog);
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '归档所选（4）', exact: true }).click();
  assert.equal(await dialog.locator('textarea').inputValue(), '清理本地测试订单列表');
  await dialog.getByRole('button', { name: '取消', exact: true }).click();
  await navigate(page, '/v2/customers', '.v2-records-page');
  if (width <= 900) {
    const customerFirst = await measure(page);
    await page.locator('.v2-records-page .el-pagination button.btn-next').click();
    await page.waitForFunction(
      () => document.querySelector('.v2-records-page .el-pager .is-active')?.textContent === '2'
    );
    await ready(page);
    const customerLast = await measure(page);
    assert.ok(customerLast.frame.height >= customerFirst.frame.height - 2);
    record('shared-mobile-customer-first-last-frame-and-natural-card-content', {
      customerFirst,
      customerLast
    });
    await page.screenshot({
      path: path.join(output, `${theme}-${width}-customers-last.png`),
      fullPage: true
    });
  }
  await navigate(page, '/v2/orders', '.v2-records-page');
  await page.getByRole('button', { name: '归档所选（4）', exact: true }).click();
  dialog = page.locator('.el-dialog:visible');
  assert.equal(await dialog.locator('textarea').inputValue(), '清理本地测试订单列表');
  record('validation-close-and-route-draft-preservation');
  await dialog.getByRole('button', { name: '确认归档', exact: true }).click();
  await dialog.getByRole('button', { name: '重试未完成订单', exact: true }).waitFor();
  await dialog.locator('li').nth(1).waitFor({ state: 'detached' });
  assert.equal(await dialog.locator('li').count(), 1);
  assert.equal(await page.getByRole('button', { name: '归档所选（1）', exact: true }).count(), 1);
  await page.screenshot({
    path: path.join(output, `${theme}-${width}-partial.png`),
    fullPage: true
  });
  await dialog.getByRole('button', { name: '重试未完成订单', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await ready(page);
  const batch = requests.filter(
    (r) => r.theme === theme && r.width === width && r.action === 'archive'
  );
  assert.equal(batch.length, 5);
  assert.equal(batch.filter((r) => r.id === idOf(0)).length, 1);
  assert.deepEqual(batch[1].payload, batch[4].payload);
  record('four-explicit-orders-partial-failure-retry-only-failed-original-version-key');
  await filter(page, '已归档');
  assert.equal(rows.filter((row) => row.archivedAt).length, 4);
  const visibleList = page.locator('.v2-records-list');
  assert.equal(
    await visibleList
      .getByRole('button', { name: /修改|退款|更多操作|完成|取消|删除|扣减/ })
      .count(),
    0
  );
  assert.equal(await visibleList.getByRole('checkbox', { name: /选择归档订单/ }).count(), 0);
  record('archived-mobile-cards-keep-natural-height-and-reachable-actions', await measure(page));
  await page.screenshot({
    path: path.join(output, `${theme}-${width}-archived.png`),
    fullPage: true
  });
  await visibleList
    .getByRole('button', { name: /^(详情|查看详情)$/ })
    .filter({ visible: true })
    .first()
    .click();
  const detail = page.locator('.el-drawer:visible');
  await detail.getByText('列表归档', { exact: true }).waitFor();
  assert.equal(
    await detail.getByRole('button', { name: /修改|退款|完成|取消订单|删除|扣减/ }).count(),
    0
  );
  await detail.getByRole('button', { name: '恢复归档', exact: true }).click();
  dialog = page.locator('.el-dialog:visible');
  await dialog.locator('textarea').fill('恢复本地订单查阅');
  await dialog.getByRole('button', { name: '确认恢复', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await ready(page);
  await filter(page, '当前订单');
  await visibleCheckbox(page, rows[0].orderNo).click();
  await page.getByRole('button', { name: '归档所选（1）', exact: true }).click();
  dialog = page.locator('.el-dialog:visible');
  await dialog.locator('textarea').fill('再次归档已恢复订单');
  await dialog.getByRole('button', { name: '确认归档', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  assert.ok(rows[0].archivedAt);
  assert.equal(
    requests.filter(
      (r) => r.theme === theme && r.width === width && r.action === 'archive' && r.id === rows[0].id
    ).length,
    2
  );
  record('archive-restore-new-archive-round-no-stale-completed-skip');
  if (width === 1440) {
    await filter(page, '已归档');
    await restoreRow(page, rows[0].orderNo);
    await restoreRow(page, rows[1].orderNo);
    await filter(page, '当前订单');
    failOnce = true;
    const start = requests.length;
    await visibleCheckbox(page, rows[0].orderNo).click();
    await visibleCheckbox(page, rows[1].orderNo).click();
    await page.getByRole('button', { name: '归档所选（2）', exact: true }).click();
    dialog = page.locator('.el-dialog:visible');
    await dialog.locator('textarea').fill('跨批次归档测试订单');
    await dialog.getByRole('button', { name: '确认归档', exact: true }).click();
    await dialog.locator('li').nth(1).waitFor({ state: 'detached' });
    await dialog.getByRole('button', { name: '取消', exact: true }).click();
    await filter(page, '已归档');
    await restoreRow(page, rows[0].orderNo);
    await filter(page, '当前订单');
    await visibleCheckbox(page, rows[0].orderNo).click();
    await page.getByRole('button', { name: '归档所选（2）', exact: true }).click();
    dialog = page.locator('.el-dialog:visible');
    await dialog.locator('textarea').fill('跨批次归档测试订单');
    await dialog.getByRole('button', { name: '确认归档', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    const round = requests.slice(start).filter((request) => request.action === 'archive');
    assert.deepEqual(
      round.map((request) => request.id),
      [rows[0].id, rows[1].id, rows[1].id, rows[0].id]
    );
    assert.deepEqual(round[1].payload, round[2].payload);
    assert.notEqual(round[0].payload.expectedUpdatedAt, round[3].payload.expectedUpdatedAt);
    assert.ok(rows[0].archivedAt && rows[1].archivedAt);
    record('partial-close-restore-success-row-fresh-reselection-does-not-skip');
  }
  await filter(page, '全部订单');
  assert.ok((await visibleCheckbox(page, rows[4].orderNo).count()) === 0);
  assert.equal(
    JSON.stringify(rows.map(businessFields)),
    originalBusiness,
    '所有业务和金额字段必须原样保留'
  );
  await measure(page);
  record('all-filter-and-business-money-id-source-preserved');
  await page.close();
}

function businessFields(row) {
  const { archivedAt, updatedAt, ...business } = row;
  void archivedAt;
  void updatedAt;
  return business;
}
function visibleCheckbox(page, orderNo) {
  return page
    .locator('.el-checkbox')
    .filter({ hasText: `选择归档订单 ${orderNo}` })
    .filter({ visible: true });
}
async function ready(page) {
  await page
    .locator('.v2-records-page .v2-async-region[data-v2-query-phase="ready"]')
    .first()
    .waitFor({ timeout: 30_000 });
}
async function filter(page, label) {
  await page
    .locator('.el-select')
    .filter({ has: page.getByRole('combobox', { name: '筛选订单归档状态' }) })
    .click();
  await page.getByRole('option', { name: label, exact: true }).click();
  await ready(page);
}
async function restoreRow(page, orderNo) {
  const row = page
    .locator('.el-table__body tr, .v2-records-mobile-item')
    .filter({ hasText: orderNo })
    .filter({ visible: true });
  await row.getByRole('button', { name: '恢复归档', exact: true }).click();
  const dialog = page.locator('.el-dialog:visible');
  await dialog.locator('textarea').fill('恢复查阅以核对归档轮次');
  await dialog.getByRole('button', { name: '确认恢复', exact: true }).click();
  await dialog.waitFor({ state: 'hidden' });
  await ready(page);
}
async function navigate(page, target, selector) {
  await page
    .locator(`a[href="${target}"]`)
    .first()
    .evaluate((el) => el.click());
  await page.waitForURL(`**${target}`);
  await page.locator(selector).waitFor();
  await ready(page);
}
async function assertFormAlignment(dialog) {
  const geometry = await dialog.locator('.el-form-item').evaluate((item) => {
    const label = item.querySelector('label').getBoundingClientRect();
    const control = item.querySelector('textarea').getBoundingClientRect();
    return {
      label: { x: label.x, y: label.y, right: label.right },
      control: { x: control.x, y: control.y }
    };
  });
  assert.ok(
    geometry.label.x < geometry.control.x && geometry.label.right <= geometry.control.x + 1,
    '表单标签必须位于控件左侧'
  );
  assert.ok(Math.abs(geometry.label.y - geometry.control.y) < 8, '错误提示出现后仍对齐首行');
}
async function measure(page) {
  const result = await page.evaluate(() => {
    const frame = document.querySelector('.v2-records-list').getBoundingClientRect();
    const heading = document.querySelector('.v2-records-list > header');
    const text = [...heading.querySelectorAll('strong,span,h2')].filter(
      (node) => node.getBoundingClientRect().height
    );
    return {
      overflow: document.documentElement.scrollWidth - window.innerWidth,
      frame: { x: frame.x, y: frame.y, width: frame.width, height: frame.height },
      cards: [...document.querySelectorAll('.v2-records-mobile-item')]
        .filter((card) => card.getBoundingClientRect().width)
        .map((card) => {
          const header = card.querySelector('header'),
            box = card.getBoundingClientRect();
          const headerHeight = header.getBoundingClientRect().height;
          const contentHeight = Math.max(
            ...[...header.children].map((child) => child.getBoundingClientRect().height)
          );
          const footer = card.querySelector('footer')?.getBoundingClientRect();
          return {
            height: box.height,
            headerSlack: headerHeight - contentHeight,
            footerOffset: footer ? footer.top - box.top : null
          };
        }),
      texts: text.map((node) => {
        const box = node.getBoundingClientRect(),
          style = window.getComputedStyle(node);
        return {
          text: node.textContent.trim(),
          x: box.x,
          y: box.y,
          height: box.height,
          lineHeight: style.lineHeight,
          fontSize: style.fontSize
        };
      })
    };
  });
  assert.ok(result.overflow <= 1, `页面横向溢出 ${result.overflow}px`);
  assert.ok(result.texts.length > 1, '必须测量真实文字节点');
  assert.ok(
    result.cards.every((card) => card.headerSlack <= 2),
    '保留外框高度不能撑高卡片标题区或推远操作按钮'
  );
  return result;
}

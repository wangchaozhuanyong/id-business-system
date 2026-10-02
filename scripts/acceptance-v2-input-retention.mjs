#!/usr/bin/env node
/* global document, window */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
const root = fileURLToPath(new URL('..', import.meta.url));
const url = new URL(process.env.V2_INPUT_RETENTION_ADMIN_URL || 'http://127.0.0.1:5392');
assert.ok(['localhost', '127.0.0.1', '::1'].includes(url.hostname), '仅允许本机验收');
const output = path.resolve(
  root,
  process.argv[2] ?? '.runtime/global-input-retention-20261001/browser'
);
assert.ok(!path.relative(root, output).startsWith('..'), '验收产物必须位于当前项目');
mkdirSync(output, { recursive: true });
const user = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'input-fixture',
  displayName: '本地草稿验收',
  roles: ['admin'],
  permissions: [],
  mustResetPassword: false
};
const now = '2026-10-01T12:00:00.000Z';
const checks = [],
  errors = [];
let browser,
  server,
  simulatedWrites = 0;
const customer = (id, name) => ({
  id,
  name,
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
  remark: '服务端备注',
  createdBy: null,
  createdAt: now,
  updatedAt: now
});
const customerRows = [
  customer('22222222-2222-4222-8222-222222222222', '本地客户甲'),
  customer('33333333-3333-4333-8333-333333333333', '本地客户乙')
];
try {
  if (!process.env.V2_INPUT_RETENTION_ADMIN_URL)
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
    assert.ok(Date.now() < deadline && server?.exitCode == null, '本地验收服务器未启动');
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  browser = await chromium.launch();
  for (const width of [1440, 768, 390]) await verify(width);
  assert.deepEqual(errors, []);
  writeFileSync(
    path.join(output, 'checks.json'),
    JSON.stringify(
      {
        ok: true,
        checks,
        errors,
        simulatedWrites,
        businessWrites: 0,
        data: 'local synthetic fixtures; all API responses intercepted'
      },
      null,
      2
    )
  );
  console.log(
    JSON.stringify({
      ok: true,
      checks: checks.length,
      widths: 3,
      simulatedWrites,
      businessWrites: 0,
      output
    })
  );
} catch (error) {
  writeFileSync(
    path.join(output, 'failure.json'),
    JSON.stringify({ checks, errors, error: error.message }, null, 2)
  );
  throw error;
} finally {
  await browser?.close();
  server?.kill('SIGTERM');
}
async function verify(width) {
  const page = await browser.newPage({ viewport: { width, height: 1000 } });
  page.setDefaultTimeout(10_000);
  page.on('pageerror', (error) => errors.push(error.message));
  const record = (scenario) => checks.push({ width, scenario });
  let failSave = true;
  await page.addInitScript((value) => {
    localStorage.setItem('apple_business_access_token', 'local-input-fixture');
    localStorage.setItem('apple_business_current_user', JSON.stringify(value));
  }, user);
  await page.route('**/*', async (route) => {
    const request = route.request(),
      requestUrl = new URL(request.url());
    if (requestUrl.origin !== url.origin) {
      await route.abort();
      throw new Error('禁止访问外部系统');
    }
    if (!requestUrl.pathname.startsWith('/api/')) return route.continue();
    const p = requestUrl.pathname;
    let data = {
      items: [],
      total: 0,
      page: Number(requestUrl.searchParams.get('page') || 1),
      pageSize: Number(requestUrl.searchParams.get('pageSize') || 20)
    };
    if (request.method() !== 'GET') {
      assert.match(p, /\/customers(?:\/[\w-]+)?$/, '只能模拟客户表单保存');
      simulatedWrites++;
      await new Promise((resolve) => setTimeout(resolve, 150));
      if (failSave)
        return route.fulfill({
          status: 500,
          json: { success: false, message: '本地模拟保存失败' }
        });
      data = customer('44444444-4444-4444-8444-444444444444', request.postDataJSON().name);
    } else if (/\/auth\/(me|session)$/.test(p)) data = user;
    else if (p.endsWith('/branding/public'))
      data = {
        appName: 'ID 业务管理',
        logoText: 'ID',
        logoUrl: '/brand/default-logo.svg',
        appSubtitle: '草稿验收'
      };
    else if (p.endsWith('/time')) data = { now, timezone: 'Asia/Shanghai' };
    else if (p.endsWith('/change-versions')) data = { generatedAt: now, versions: {} };
    else if (p.endsWith('/renewals/warning-summary')) data = { total: 0, warningDays: 7 };
    else if (p.endsWith('/sensitive-access/approvals/summary')) data = { pending: 0 };
    else if (p.endsWith('/bootstrap'))
      data = {
        list: {
          ...data,
          items: p.includes('/customers/') ? customerRows : [],
          total: p.includes('/customers/') ? 42 : 0
        },
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
    else if (p.endsWith('/customers')) data = { ...data, items: customerRows, total: 42 };
    else if (/\/customers\/[\w-]+$/.test(p)) data = customerRows.find((row) => p.endsWith(row.id));
    await route.fulfill({
      json: { success: true, data, message: 'OK', requestId: 'input-fixture', timestamp: now }
    });
  });
  await page.goto(new URL('/v2/customers', url).href, { waitUntil: 'domcontentloaded' });
  await ready(page, '.v2-records-page');
  const search = page.getByRole('textbox', { name: '搜索客户' });
  await search.fill('保留未提交搜索');
  await navigate(page, '/v2/system/roles', '.v2-roles-page');
  await navigate(page, '/v2/customers', '.v2-records-page');
  assert.equal(await search.inputValue(), '保留未提交搜索');
  record('unsubmitted-search-survives-route-unmount');
  await page.getByRole('button', { name: '查询客户', exact: true }).click();
  await ready(page, '.v2-records-page');
  await page.locator('.v2-records-page .el-pagination button.btn-next').click();
  await page.waitForFunction(
    () => document.querySelector('.v2-records-page .el-pager .is-active')?.textContent === '2'
  );
  await navigate(page, '/v2/system/roles', '.v2-roles-page');
  await page.getByRole('textbox', { name: '搜索角色' }).fill('角色独立搜索');
  await navigate(page, '/v2/customers', '.v2-records-page');
  assert.equal(await search.inputValue(), '保留未提交搜索');
  assert.equal(
    (await page.locator('.v2-records-page .el-pager .is-active').textContent()).trim(),
    '2'
  );
  record('search-and-pagination-restore-independently');
  await page.getByRole('button', { name: '新增客户', exact: true }).first().click();
  let drawer = page.locator('.el-drawer:visible');
  await field(drawer, '客户名称', 'input').fill('新增客户草稿');
  await field(drawer, '备注', 'textarea').fill('新增备注草稿');
  await drawer.getByRole('button', { name: '关闭', exact: true }).click();
  await drawer.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '新增客户', exact: true }).first().click();
  assert.equal(
    await field(page.locator('.el-drawer:visible'), '客户名称', 'input').inputValue(),
    '新增客户草稿'
  );
  record('cancel-and-reopen-retains-form');
  await navigate(page, '/v2/system/roles', '.v2-roles-page');
  assert.equal(await page.locator('.el-drawer:visible').count(), 0);
  await navigate(page, '/v2/customers', '.v2-records-page');
  assert.equal(await page.locator('.el-drawer:visible').count(), 0);
  await page.getByRole('button', { name: '新增客户', exact: true }).first().click();
  drawer = page.locator('.el-drawer:visible');
  assert.equal(await field(drawer, '备注', 'textarea').inputValue(), '新增备注草稿');
  record('navigation-hides-drawer-but-restores-draft-on-open');
  await drawer.getByRole('button', { name: '关闭', exact: true }).click();
  await drawer.waitFor({ state: 'hidden' });
  const row = page
    .locator('.v2-records-page .el-table__body tr')
    .filter({ hasText: '本地客户甲' })
    .first();
  const mobileRow = page
    .locator('.v2-records-page article')
    .filter({ hasText: '本地客户甲' })
    .filter({ has: page.getByRole('button', { name: '编辑', exact: true }) })
    .first();
  const edit = (await row.isVisible())
    ? row.getByRole('button', { name: '编辑', exact: true })
    : mobileRow.getByRole('button', { name: '编辑', exact: true });
  await edit.click();
  drawer = page.locator('.el-drawer:visible');
  assert.equal(await field(drawer, '客户名称', 'input').inputValue(), '本地客户甲');
  await field(drawer, '备注', 'textarea').fill('甲的独立备注');
  await drawer.getByRole('button', { name: '关闭', exact: true }).click();
  await drawer.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '新增客户', exact: true }).first().click();
  drawer = page.locator('.el-drawer:visible');
  assert.equal(await field(drawer, '备注', 'textarea').inputValue(), '新增备注草稿');
  record('create-and-edit-record-drafts-are-isolated');
  await drawer.getByRole('button', { name: '确认新增', exact: true }).click();
  await page.getByText('本地模拟保存失败', { exact: false }).waitFor();
  assert.equal(await field(drawer, '客户名称', 'input').inputValue(), '新增客户草稿');
  record('failed-save-keeps-input');
  await drawer.getByRole('button', { name: '关闭', exact: true }).click();
  await drawer.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '新增客户', exact: true }).first().click();
  drawer = page.locator('.el-drawer:visible');
  assert.equal(await field(drawer, '备注', 'textarea').inputValue(), '新增备注草稿');
  failSave = false;
  await drawer.getByRole('button', { name: '确认新增', exact: true }).click();
  await drawer.waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '新增客户', exact: true }).first().click();
  drawer = page.locator('.el-drawer:visible');
  assert.equal(await field(drawer, '客户名称', 'input').inputValue(), '');
  record('successful-save-clears-only-submitted-draft');
  await drawer.getByRole('button', { name: '关闭', exact: true }).click();
  await drawer.waitFor({ state: 'hidden' });
  await edit.click();
  drawer = page.locator('.el-drawer:visible');
  assert.equal(await field(drawer, '备注', 'textarea').inputValue(), '甲的独立备注');
  record('successful-create-preserves-other-record-draft');
  await navigate(page, '/v2/system/roles', '.v2-roles-page');
  assert.equal(await page.getByRole('textbox', { name: '搜索角色' }).inputValue(), '角色独立搜索');
  record('other-module-search-retains-own-state');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await ready(page, '.v2-roles-page');
  assert.equal(await page.getByRole('textbox', { name: '搜索角色' }).inputValue(), '');
  record('browser-reload-clears-session-input');
  await navigate(page, '/v2/customers', '.v2-records-page');
  assert.equal(await search.inputValue(), '');
  await page.getByRole('button', { name: '新增客户', exact: true }).first().click();
  drawer = page.locator('.el-drawer:visible');
  assert.equal(await field(drawer, '客户名称', 'input').inputValue(), '');
  record('browser-reload-clears-form-and-filter');
  const persisted = await page.evaluate(() =>
    Object.values({ ...localStorage, ...sessionStorage }).join('\n')
  );
  assert.ok(!persisted.includes('备注草稿') && !persisted.includes('角色独立搜索'));
  record('draft-content-never-written-to-browser-storage');
  await page.screenshot({ path: path.join(output, `customers-${width}.png`), fullPage: true });
  await page.close();
}
function field(scope, label, type) {
  return scope
    .locator('.el-form-item')
    .filter({ hasText: new RegExp(`^\\s*${label}`) })
    .locator(type)
    .first();
}
async function ready(page, selector) {
  await page
    .locator(`${selector} .v2-async-region[data-v2-query-phase="ready"]`)
    .first()
    .waitFor({ timeout: 30_000 });
}
async function navigate(page, target, selector) {
  await page
    .locator(`a[href="${target}"]`)
    .first()
    .evaluate((el) => el.click());
  try {
    await page.waitForURL(`**${target}`, { timeout: 5000 });
  } catch (error) {
    writeFileSync(
      path.join(output, 'navigation-failure.json'),
      JSON.stringify(
        await page.evaluate(() => ({
          url: window.location.href,
          text: document.body.innerText.slice(0, 8000),
          links: [...document.querySelectorAll('a')].map((a) => ({
            href: a.getAttribute('href'),
            text: a.textContent
          })),
          route:
            document.querySelector('#app')?.__vue_app__?.config.globalProperties.$router
              .currentRoute.value.path
        })),
        null,
        2
      )
    );
    await page.screenshot({ path: path.join(output, 'navigation-failure.png'), fullPage: true });
    throw error;
  }
  await ready(page, selector);
}

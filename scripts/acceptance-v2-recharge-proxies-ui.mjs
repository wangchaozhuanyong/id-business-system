#!/usr/bin/env node
/* global document, window */
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';

const root = process.cwd();
const origin = 'http://127.0.0.1:5398';
const outputDir = path.join(root, '.runtime/recharge-proxies');
const now = '2026-09-30T12:00:00.000Z';
const user = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'proxy-acceptance',
  displayName: '代理验收管理员',
  roles: ['admin'],
  permissions: [],
  mustResetPassword: false
};
const rows = Array.from({ length: 21 }, (_, index) => ({
  id: `55555555-5555-4555-8555-${String(index + 1).padStart(12, '0')}`,
  countryCode: index === 20 ? 'PH' : 'US',
  kind: index === 20 ? 'mobile' : 'dynamic_residential',
  connectionMode: 'extraction',
  protocol: 'http',
  linkMask: `已保存 ···${String(index).padStart(6, '0')}`,
  status: 'active',
  remark1: index === 20 ? '最后一页代理' : `测试代理 ${index + 1}`,
  remark2: '',
  createdAt: now,
  updatedAt: now
}));
const initialRows = structuredClone(rows);
const mutations = [];
async function assertListLayout(page, state) {
  const geometry = await page
    .locator('.v2-records-list')
    .first()
    .evaluate((list) => {
      const header = list.querySelector(':scope > header');
      const title = header?.querySelector('.v2-section-heading__title');
      const count = header?.querySelector('.v2-section-heading__actions span');
      if (!header || !title) return null;
      const outer = list.getBoundingClientRect();
      const frame = header.getBoundingClientRect();
      const text = title.getBoundingClientRect();
      const countBox = count?.getBoundingClientRect();
      return {
        outerLeft: outer.left,
        outerRight: outer.right,
        frameLeft: frame.left,
        frameRight: frame.right,
        titleLeft: text.left,
        titleTop: text.top,
        titleBottom: text.bottom,
        frameTop: frame.top,
        frameBottom: frame.bottom,
        overlap: countBox
          ? text.right > countBox.left && text.top < countBox.bottom && countBox.top < text.bottom
          : false
      };
    });
  assert.ok(geometry, `${state} 缺少表格标题`);
  assert.ok(
    geometry.frameLeft >= geometry.outerLeft - 1 && geometry.frameRight <= geometry.outerRight + 1,
    `${state} 标题框超出列表`
  );
  assert.ok(
    geometry.titleLeft > geometry.frameLeft &&
      geometry.titleTop >= geometry.frameTop &&
      geometry.titleBottom <= geometry.frameBottom,
    `${state} 标题文字未对齐`
  );
  assert.equal(geometry.overlap, false, `${state} 标题与数量重叠`);
}
mkdirSync(outputDir, { recursive: true });
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
    env: { ...process.env, VITE_API_BASE_URL: '/api', VITE_V2_REALTIME_CHANGES_ENABLED: 'false' },
    stdio: 'ignore'
  }
);
let browser;
try {
  let ready = false;
  for (let attempt = 0; attempt < 120; attempt++) {
    if (server.exitCode !== null) throw new Error('Vite 提前退出');
    if ((await fetch(origin).catch(() => null))?.ok) {
      ready = true;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  assert.ok(ready, 'Vite 未启动');
  browser = await chromium.launch({ headless: true });
  for (const width of [1440, 390]) {
    rows.splice(0, rows.length, ...structuredClone(initialRows));
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    page.setDefaultTimeout(10000);
    const errors = [];
    const unexpected = [];
    page.on('pageerror', (error) => errors.push(error.message));
    await page.addInitScript((fixture) => {
      localStorage.setItem('apple_business_access_token', 'proxy-acceptance-token');
      localStorage.setItem('apple_business_current_user', JSON.stringify(fixture));
    }, user);
    await page.route('**/api/**', async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      const endpoint = url.pathname;
      const method = request.method();
      if (!endpoint.startsWith('/api/')) {
        await route.continue();
        return;
      }
      let data;
      if (endpoint.endsWith('/auth/me') || endpoint.endsWith('/auth/session')) data = user;
      else if (endpoint.endsWith('/id-business-v2/branding/public'))
        data = {
          appName: 'ID 业务管理',
          logoText: 'ID',
          logoUrl: '/brand/default-logo.svg',
          appSubtitle: '业务管理',
          documentTitleSuffix: 'ID 业务管理'
        };
      else if (endpoint.endsWith('/id-business-v2/time')) data = { now, timezone: 'Asia/Shanghai' };
      else if (endpoint.endsWith('/id-business-v2/change-versions'))
        data = { generatedAt: now, versions: {} };
      else if (endpoint.endsWith('/id-business-v2/table-preferences')) data = { items: [] };
      else if (endpoint.endsWith('/id-business-v2/renewals/warning-summary'))
        data = {
          warningDays: 3,
          defaultWarningDays: 3,
          upcomingCount: 0,
          expiredCount: 0,
          totalCount: 0,
          evaluatedAt: now,
          revalidateAt: now
        };
      else if (endpoint.endsWith('/id-business-v2/bank-recharge/renewal-warnings'))
        data = {
          warningDays: 3,
          upcomingCount: 0,
          expiredCount: 0,
          totalCount: 0,
          items: [],
          evaluatedAt: now,
          revalidateAt: now
        };
      else if (endpoint.endsWith('/id-business-v2/sensitive-access/approvals/summary'))
        data = { pendingCount: 0, items: [], generatedAt: now };
      else if (endpoint.endsWith('/auto-recharge/proxies/countries'))
        data = { items: ['US', 'PH'] };
      else if (endpoint.endsWith('/auto-recharge/proxies/import') && method === 'POST') {
        const input = request.postDataJSON();
        assert.equal(input.proxies.length, 1);
        mutations.push({ method, endpoint, input });
        rows.unshift({
          ...rows[0],
          id: '66666666-6666-4666-8666-666666666666',
          countryCode: input.proxies[0].countryCode,
          kind: input.proxies[0].kind,
          remark1: input.proxies[0].remark1
        });
        data = { imported: 1 };
      } else if (endpoint.endsWith('/auto-recharge/proxies') && method === 'POST') {
        const input = request.postDataJSON();
        mutations.push({ method, endpoint, input });
        rows.push({
          ...rows[0],
          id: '77777777-7777-4777-8777-777777777777',
          countryCode: input.countryCode,
          kind: input.kind,
          remark1: input.remark1
        });
        data = { id: rows.at(-1).id };
      } else if (endpoint.endsWith('/auto-recharge/proxies') && method === 'GET') {
        const filtered = rows.filter(
          (item) =>
            (!url.searchParams.get('keyword') ||
              `${item.countryCode} ${item.remark1}`.includes(url.searchParams.get('keyword'))) &&
            (!url.searchParams.get('countryCode') ||
              item.countryCode === url.searchParams.get('countryCode')) &&
            (!url.searchParams.get('kind') || item.kind === url.searchParams.get('kind')) &&
            (!url.searchParams.get('status') || item.status === url.searchParams.get('status'))
        );
        const pageNumber = Number(url.searchParams.get('page') || 1);
        const pageSize = Number(url.searchParams.get('pageSize') || 20);
        data = {
          items: filtered.slice((pageNumber - 1) * pageSize, pageNumber * pageSize),
          total: filtered.length,
          page: pageNumber,
          pageSize
        };
      } else if (/\/auto-recharge\/proxies\/[^/]+$/.test(endpoint)) {
        const id = endpoint.split('/').at(-1);
        const item = rows.find((row) => row.id === id);
        assert.ok(item, `未知代理 ${id}`);
        if (method === 'GET')
          data = { ...item, url: 'https://proxy.example.invalid/get?token=synthetic' };
        else if (method === 'PATCH') {
          const input = request.postDataJSON();
          mutations.push({ method, endpoint, input });
          Object.assign(item, input);
          data = { id };
        } else if (method === 'DELETE') {
          mutations.push({ method, endpoint });
          rows.splice(rows.indexOf(item), 1);
          data = { id };
        }
      }
      if (data === undefined) {
        unexpected.push(`${method} ${endpoint}`);
        await route.fulfill({
          status: 500,
          contentType: 'application/json',
          body: JSON.stringify({ success: false, message: 'Unexpected acceptance request' })
        });
      } else {
        await route.fulfill({
          status: 200,
          contentType: 'application/json',
          body: JSON.stringify({
            success: true,
            data,
            message: 'OK',
            requestId: 'proxy-acceptance',
            timestamp: now
          })
        });
      }
    });
    await page.goto(`${origin}/v2/auto-recharge/proxies`, { waitUntil: 'domcontentloaded' });
    try {
      await page
        .getByText('测试代理 1', { exact: true })
        .waitFor({ state: 'visible', timeout: 12000 });
    } catch (cause) {
      await page.screenshot({ path: path.join(outputDir, `${width}-debug.png`), fullPage: true });
      throw new Error(
        `代理页未加载：${page.url()}；请求=${unexpected.join(', ')}；错误=${errors.join(', ')}；页面=${(await page.locator('body').innerText()).slice(0, 900)}`,
        { cause }
      );
    }
    await assertListLayout(page, `${width}px 首页`);
    await page.screenshot({ path: path.join(outputDir, `${width}-first.png`), fullPage: true });
    await page.getByRole('button', { name: '下一页' }).click();
    await page.getByText('最后一页代理').waitFor({ state: 'visible' });
    await assertListLayout(page, `${width}px 末页`);
    await page.screenshot({ path: path.join(outputDir, `${width}-last.png`), fullPage: true });
    await page.getByRole('button', { name: '上一页' }).click();
    const first = page
      .locator('.v2-records-table tbody tr')
      .filter({ hasText: '测试代理 1' })
      .first();
    await first.getByRole('button', { name: '详细' }).click();
    await page
      .getByText('https://proxy.example.invalid/get?token=synthetic')
      .waitFor({ state: 'visible' });
    await page
      .getByLabel('代理 IP 详细')
      .getByRole('button', { name: 'Close' })
      .click()
      .catch(async () => {
        await page.keyboard.press('Escape');
      });
    await page.getByRole('button', { name: '批量导入' }).click();
    await page
      .getByLabel('粘贴代理 IP 资料')
      .fill('菲律宾\thttps://proxy.example.invalid/another\t移动代理\t导入验收\t-');
    await page.getByRole('button', { name: '导入代理 IP' }).click();
    await page.getByText('导入验收').first().waitFor({ state: 'visible' });
    await page.getByPlaceholder('国家代码或备注').fill('不存在');
    await page.getByRole('button', { name: '搜索', exact: true }).click();
    await page.getByPlaceholder('国家代码或备注').press('Enter');
    try {
      await page.getByText('暂无代理 IP').waitFor({ state: 'visible' });
    } catch (cause) {
      await page.screenshot({
        path: path.join(outputDir, `${width}-search-debug.png`),
        fullPage: true
      });
      throw new Error(
        `代理空状态未显示：${width}px；请求=${unexpected.join(', ')}；错误=${errors.join(', ')}；页面=${(await page.locator('body').innerText()).slice(-900)}`,
        { cause }
      );
    }
    await assertListLayout(page, `${width}px 空状态`);
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth > window.innerWidth + 1
    );
    assert.equal(overflow, false, `${width}px 页面横向溢出`);
    assert.deepEqual(unexpected, []);
    assert.deepEqual(errors, []);
    await page.screenshot({ path: path.join(outputDir, `${width}-empty.png`), fullPage: true });
    await context.close();
  }
  assert.ok(mutations.some((entry) => entry.endpoint.endsWith('/import')));
  console.log(
    JSON.stringify({
      ok: true,
      widths: [1440, 390],
      states: ['first', 'last', 'detail', 'import', 'empty'],
      outputDir
    })
  );
} finally {
  await browser?.close();
  server.kill('SIGTERM');
  await Promise.race([
    new Promise((resolve) => server.once('close', resolve)),
    new Promise((resolve) => setTimeout(resolve, 3000))
  ]);
  if (server.exitCode === null) server.kill('SIGKILL');
}

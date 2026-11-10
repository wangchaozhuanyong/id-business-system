import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { interceptDesign, origin, root, settle, separatorSnapshot } from './helpers/offline-design.mjs';

const output = root + '/.runtime/ui-mailbox-spacing-20261109';
await mkdir(output, { recursive: true });
const browser = await chromium.launch();
const results = [];
const fixture = Array.from({ length: 5 }, (_, index) => ({
  id: `layout-${index}`, email: `layout-${index}@example.test`, provider: 'google',
  active: true, label: '合成布局资料', expiresAt: '2099-01-01T00:00:00Z'
}));
try {
  for (const width of [2080, 1440, 1024, 901, 900, 768, 390, 320]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 1000 }, serviceWorkers: 'block' });
    const requests = await interceptDesign(context, { localFixtures: {}, actor: { id: 'layout-admin', name: '布局验收', role: 'admin' } });
    let reads = 0, fail = false;
    const errors = [], writes = [];
    await context.route(origin + '/api/local/tools/mailbox-pool', route => {
      const request = route.request();
      if (request.method() === 'GET') return route.fulfill({ json: { version: 1, defaultValidDays: 30, items: fixture } });
      if (request.method() === 'POST') {
        const { ids, version } = request.postDataJSON(), code = 'MBX-SYNTHETIC-LAYOUT-ONLY';
        return route.fulfill({ json: ids ? { version, items: ids.map(id => ({ id, code })) } : { code } });
      }
      writes.push(request.method());
      return route.abort();
    });
    await context.route(origin + '/api/local/tools/mailbox-query', route => {
      reads++;
      return route.fulfill(fail ? { status: 503, json: { error: '合成查询失败，请重试' } }
        : { json: { items: [{ subject: '合成查询结果', from: 'sender@example.test', to: 'layout@example.test', body: '仅用于离线布局验收。' }] } });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/#/plugins/mailboxes');
    await page.locator('.mailbox-account').first().waitFor();
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    const pool = page.locator('#ops-mailbox-pool'), drawer = page.locator('#drawer');
    async function measure(state, scope = '#main') {
      await settle(page);
      const separation = await separatorSnapshot(page, scope);
      assert.deepEqual(separation.findings, [], `${width}/${theme}/${state}: 控件贴住分隔线`);
      const bounds = await page.locator(scope).evaluate(el => {
        const box = el.getBoundingClientRect();
        const controls = [...el.querySelectorAll('.button,input:not([type=hidden]),select,textarea,summary')]
          .filter(node => node.checkVisibility() && !node.closest('table,.table-viewport,[popover]'));
        const rects = controls.map(node => ({ node, rect: node.getBoundingClientRect() }));
        const clipped = rects.filter(({rect}) => rect.left < box.left - 1 || rect.right > box.right + 1);
        const overlaps = [];
        rects.forEach((a, i) => rects.slice(i + 1).forEach(b => {
          if (a.node.contains(b.node) || b.node.contains(a.node)) return;
          if (Math.min(a.rect.right, b.rect.right) - Math.max(a.rect.left, b.rect.left) > 1 &&
              Math.min(a.rect.bottom, b.rect.bottom) - Math.max(a.rect.top, b.rect.top) > 1)
            overlaps.push([a.node.id || a.node.textContent, b.node.id || b.node.textContent]);
        }));
        return { clipped: clipped.map(({node}) => node.id || node.textContent), overlaps,
          overflow: document.documentElement.scrollWidth > innerWidth + 1,
          width: box.width, right: box.right };
      });
      assert.deepEqual(bounds.clipped, []);
      assert.deepEqual(bounds.overlaps, []);
      assert.equal(bounds.overflow, false);
      results.push({ width, theme, state, separation, bounds });
    }
    assert.equal(await page.locator('#plugin-tool-host [role=tab]').count(), 0, '邮箱池为单一主页面');
    assert.equal(await drawer.isVisible(), false);
    await measure('pool');
    const topInset = await pool.evaluate(node => node.getBoundingClientRect().top - node.closest('.panel').getBoundingClientRect().top);
    assert(topInset <= 24, '隐藏查询表单不应留下空页签或空分隔行');
    if ([1440, 390].includes(width)) {
      await page.screenshot({ path: `${output}/after-${width}-${theme}.png` });
      await page.locator('#plugin-tool-host').screenshot({ path: `${output}/mailbox-panel-${width}-${theme}.png` });
    }
    if (width === 2080) {
      const centers = await pool.locator('.list-controls--filters').evaluate(el =>
        [...el.querySelectorAll('.section-title-row,input,select,.mailbox-pool-actions > .button')]
          .map(node => { const b = node.getBoundingClientRect(); return b.y + b.height / 2; }));
      assert(Math.max(...centers) - Math.min(...centers) <= 1, '宽屏筛选与操作应在同一行对齐');
    }
    await pool.getByRole('searchbox', { name: '搜索邮箱池' }).fill('layout-0');
    await pool.getByRole('button', { name: '邮箱查询', exact: true }).click();
    await drawer.getByRole('heading', { name: '邮箱查询', exact: true }).waitFor();
    assert.equal(await page.locator('#ops-managed-mail-query').count(), 1);
    assert(page.url().endsWith('#/plugins/mailboxes'));
    await measure('query-drawer', '#drawer');
    const position = await drawer.boundingBox();
    assert(Math.abs(position.x + position.width - width) <= 1, '查询抽屉靠右');
    await drawer.locator('#ops-managed-query-limit').fill('8');
    await drawer.locator('#ops-managed-query-code').fill('MBX-SYNTHETIC-LAYOUT');
    await drawer.getByRole('button', { name: '查询邮件', exact: true }).click();
    await drawer.getByText('合成查询结果', { exact: true }).waitFor();
    await measure('query-results', '#drawer');
    if ([1440, 390].includes(width)) await page.screenshot({ path: `${output}/query-${width}-${theme}.png` });
    fail = true;
    await drawer.getByRole('button', { name: '立即刷新', exact: true }).click();
    await drawer.getByText('合成查询失败，请重试', { exact: true }).waitFor();
    assert(await drawer.getByText('合成查询结果', { exact: true }).isVisible());
    await measure('query-failure', '#drawer');
    fail = false;
    await drawer.getByRole('button', { name: '重试', exact: true }).click();
    await drawer.getByText('合成查询失败，请重试', { exact: true }).waitFor({ state: 'hidden' });
    assert.equal(reads, 3);
    await drawer.getByRole('button', { name: '关闭抽屉', exact: true }).click();
    await drawer.waitFor({ state: 'hidden' });
    assert.equal(await pool.getByRole('searchbox', { name: '搜索邮箱池' }).inputValue(), 'layout-0');
    await pool.getByRole('button', { name: '邮箱查询', exact: true }).click();
    assert.equal(await drawer.locator('#ops-managed-query-limit').inputValue(), '8', '普通查询选项保留');
    assert.equal(await drawer.locator('#ops-managed-query-code').inputValue(), '', '查询码不保留');
    assert.equal(await drawer.getByText('合成查询结果', { exact: true }).count(), 0, '邮件正文不保留');
    await drawer.getByRole('button', { name: '关闭抽屉', exact: true }).click();
    await drawer.waitFor({ state: 'hidden' });
    await pool.getByRole('button', { name: '相关入口', exact: true }).click();
    assert(await page.getByRole('menuitem', { name: '打开买家查询页', exact: true }).isVisible());
    await page.keyboard.press('Escape');
    assert.deepEqual(errors, []);
    assert.deepEqual(writes, []);
    assert.deepEqual(requests.external, []);
    assert.deepEqual(requests.unavailable, []);
    await context.close();
  }
  // The existing employee boundary continues to allow code queries without loading the pool.
  const context = await browser.newContext();
  await interceptDesign(context, { localFixtures: {}, actor: { id: 'layout-employee', name: '合成员工', role: 'employee' } });
  const forbidden = [];
  await context.route(origin + '/api/local/tools/mailbox-pool', route => { forbidden.push(route.request().method()); return route.abort(); });
  const page = await context.newPage();
  await page.goto(origin + '/#/plugins/mailboxes');
  await page.getByRole('button', { name: '邮箱查询', exact: true }).click();
  await page.locator('#drawer #ops-managed-query-code').waitFor();
  assert.equal(await page.locator('#ops-mailbox-pool').count(), 0);
  assert.deepEqual(forbidden, []);
  await context.close();
  await writeFile(output + '/mailbox-query-layout.json', JSON.stringify({ results, realRequests: 0, businessWrites: 0 }, null, 2));
  console.log(JSON.stringify({ status: 'passed', scenarios: results.length, themes: 2, widths: 8, employeeBoundary: true, realRequests: 0 }));
} finally {
  await browser.close();
}

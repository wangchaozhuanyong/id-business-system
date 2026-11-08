import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { root, origin, interceptDesign, settle } from './helpers/offline-design.mjs';
const { chromium } = await import(process.env.ID_RECHARGE_QA_PLAYWRIGHT ? pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href : 'playwright');
const output = process.env.ID_LAYOUT_QA_OUTPUT || path.join(root, '.runtime/mailbox-rows-20261107');
await mkdir(output, { recursive: true });
const browser = await chromium.launch({ headless: true }), results = [];
const providers = ['google', 'apple', 'microsoft'];
const fixture = Array.from({ length: 2003 }, (_, i) => ({
  id: `fixture-${i}`, email: i === 0 ? 'layout-0000.with-a-long-synthetic-address@example.test' : `layout-${String(i).padStart(4, '0')}@example.test`,
  label: i === 0 ? '合成资料：长备注用于检查换行，不是真实邮箱。'.repeat(2) : `合成记录 ${i}`,
  provider: providers[i % 3], active: i !== 2, authFailed: i === 3,
  expiresAt: i === 1 ? '2020-01-01T00:00:00Z' : '2099-01-01T00:00:00Z', lastQueriedAt: '2026-11-07T03:00:00Z'
}));
try {
  for (const width of (process.env.ID_QA_WIDTHS || '1440,1024,901,900,768,390,320').split(',').map(Number)) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block', permissions: ['clipboard-read', 'clipboard-write'] });
    const requests = await interceptDesign(context, { localFixtures: {}, actor: { id: 'synthetic', name: '离线验收', role: 'admin' } });
    let rows = fixture, fail = false;
    const codeReads = [], mutations = [], errors = [];
    await context.route(origin + '/api/local/tools/mailbox-pool', route => {
      const request = route.request();
      if (request.method() === 'GET') return route.fulfill(fail ? { status: 502, json: { error: '合成读取失败，请重试' } } : { json: { version: 1, defaultValidDays: 30, items: rows } });
      if (request.method() === 'POST') {
        const { id } = request.postDataJSON(); codeReads.push(id);
        return route.fulfill({ json: { code: `SYNTHETIC-${id}-LAYOUT-ONLY` } });
      }
      mutations.push(request.method());
      return route.fulfill({ status: 422, json: { error: '本测试不执行写入' } });
    });
    const page = await context.newPage(); page.setDefaultTimeout(8000);
    page.on('pageerror', e => errors.push(e.message));
    await page.goto(origin + '/#/overview');
    if (theme === 'dark') await page.locator('#theme-toggle').click();
    const drawer = page.locator('#plugin-tool-host');
    await page.goto(origin + '/#/plugins/mailboxes');
    await drawer.getByRole('tab', { name: '邮箱池管理', exact: true }).click();
    const pool = drawer.locator('#ops-mailbox-pool'), list = pool.locator('.online-tool-mail-list');
    const waitCodes = () => page.waitForFunction(() => {
      const codes = [...document.querySelectorAll('[data-mailbox-code]')];
      return codes.length && codes.every(n => n.textContent.startsWith('SYNTHETIC-'));
    });
    const measure = async label => {
      await settle(page);
      const geometry = await drawer.evaluate(el => {
        const body = el.querySelector('.drawer-body'), viewport = el.querySelector('.online-tool-mail-list');
        const rows = [...el.querySelectorAll('.mailbox-account')].map(n => {
          const r = n.getBoundingClientRect();
          return { x: r.x, y: r.y, width: r.width, height: r.height, bottom: r.bottom };
        });
        const pager = el.querySelector('.mailbox-pool-pagination');
        const clipped = pager ? [...pager.querySelectorAll('button,input,select')].some(n => { const r = n.getBoundingClientRect(), p = pager.getBoundingClientRect(); return r.left < p.left - 1 || r.right > p.right + 1; }) : false;
        return { rows, overflow: el.scrollWidth > el.clientWidth + 1 || body.scrollWidth > body.clientWidth + 1, clipped, tableOverflow: viewport ? viewport.scrollWidth > viewport.clientWidth : false };
      });
      assert(!geometry.overflow && !geometry.clipped, `${width}/${theme}/${label} overflow`);
      assert(geometry.rows.every((r, i, all) => !i || (Math.abs(r.x - all[0].x) < 1 && r.y >= all[i-1].bottom - 1)), '每个账号必须独占一行');
      assert(geometry.rows.every(r => r.height <= (width <= 900 ? 61 : 54)), `所有记录单行显示，不被长内容撑高 ${width}/${theme}/${label}`);
      results.push({ width, theme, label, geometry, codeReads: codeReads.length });
      if ([1440,390].includes(width)) await page.screenshot({ path: path.join(output, `${label}-${width}-${theme}.png`) });
    };
    await waitCodes();
    assert.equal(await pool.locator('.mailbox-account').count(), 20);
    assert.deepEqual(codeReads, fixture.slice(0,20).map(r => r.id), '只读取当前页查询码');
    await measure('first-page');
    const firstRow = pool.locator('.mailbox-account').first();
    const rowHeight = (await firstRow.boundingBox()).height;
    const compact = await firstRow.evaluate(row => {
      const code = row.querySelector('[data-mailbox-code]'), copy = row.querySelector('[data-action="ops-mailbox-pool-copy-existing"]');
      const c = code.getBoundingClientRect(), b = copy.getBoundingClientRect();
      const email = row.querySelector('strong');
      return { codeElided: code.scrollWidth > code.clientWidth && getComputedStyle(code).textOverflow === 'ellipsis', emailElided: email.scrollWidth > email.clientWidth, title: email.title, copy: copy.textContent, centerDifference: Math.abs((c.top+c.bottom-b.top-b.bottom)/2), codeHeight:c.height };
    });
    assert(compact.codeElided && compact.emailElided);
    assert.equal(compact.title, fixture[0].email);
    assert.equal(compact.copy, '复制');
    assert(compact.centerDifference < 1 && compact.codeHeight <= 20);
    await pool.locator('.mailbox-account__more').first().click();
    const actions = pool.locator('.mailbox-account__actions:popover-open');
    await actions.getByRole('button', { name: '更新授权', exact: true }).waitFor();
    await settle(page);
    assert.equal((await firstRow.boundingBox()).height, rowHeight, '浮层操作不能撑高数据行');
    assert(await actions.evaluate(el => {
      const r = el.getBoundingClientRect();
      return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight && [...el.querySelectorAll('button')].every(button => { const b = button.getBoundingClientRect(); return b.left >= r.left && b.right <= r.right && b.width >= 44; });
    }), `浮层操作必须完整可用 ${width}/${theme}`);
    await pool.locator('.mailbox-account__more').first().press('Escape');
    assert.equal(await actions.count(), 0);
    await pool.locator('.mailbox-account__more').first().click();
    await actions.waitFor();
    await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
    await page.waitForFunction(() => !document.querySelector('.mailbox-account__actions:popover-open'));
    await pool.locator('.mailbox-account__more').first().click();
    await pool.getByRole('button', { name: '更新授权', exact: true }).first().click();
    assert.equal(await actions.count(), 0);
    const operation = page.locator('#drawer[open]');
    assert(await operation.locator('#ops-managed-pool-form').isVisible());
    await operation.getByLabel('查看应用专用密码说明', { exact: true }).click();
    assert(await operation.locator('#ops-managed-pool-form a[href="https://myaccount.google.com/apppasswords"]').isVisible());
    await operation.getByLabel('查看应用专用密码说明', { exact: true }).press('Escape');
    const editorRect = await operation.locator('#ops-managed-pool-form').boundingBox();
    assert(editorRect.y >= (await operation.locator('.drawer-body').boundingBox()).y - 1 && editorRect.y < 900);
    await operation.getByRole('button', { name: '取消', exact: true }).click();
    await pool.locator('[data-action="ops-mailbox-pool-copy-existing"]').first().click();
    await page.waitForFunction(async () => await navigator.clipboard.readText() === 'SYNTHETIC-fixture-0-LAYOUT-ONLY');
    await pool.getByRole('button', { name: '下一页', exact: true }).click(); await waitCodes();
    assert.equal(await pool.locator('.mailbox-account').first().locator('strong').textContent(), fixture[20].email);
    await measure('second-page');
    for (const size of [50,100]) {
      const before = codeReads.length;
      await pool.getByLabel('邮箱池每页条数', { exact: true }).selectOption(String(size)); await waitCodes();
      assert.equal(await pool.locator('.mailbox-account').count(), size);
      assert.deepEqual(codeReads.slice(before), fixture.slice(0,size).map(r => r.id));
    }
    await pool.getByLabel('邮箱池页码', { exact: true }).fill('21');
    await pool.getByRole('button', { name: '跳转', exact: true }).click(); await waitCodes();
    assert.equal(await pool.locator('.mailbox-account').count(), 3);
    assert.equal(await pool.locator('.mailbox-account').last().locator('strong').textContent(), fixture[2002].email);
    assert(await pool.getByRole('button', { name: '下一页', exact: true }).isDisabled());
    await measure('last-page');
    await pool.locator('.mailbox-account__more').last().click();
    await actions.waitFor();
    await settle(page);
    assert(await actions.evaluate(el => { const r = el.getBoundingClientRect(); return r.top >= 0 && r.bottom <= innerHeight; }), '末行操作浮层不能越出屏幕');
    const scrollBeforeOperation = await page.evaluate(() => ({ window: scrollY, panel: document.querySelector('#plugin-tool-host .drawer-body').scrollTop }));
    await actions.getByRole('button', { name: '更新授权', exact: true }).click();
    await operation.locator('#ops-managed-pool-form').waitFor();
    await operation.getByRole('button', { name: '取消', exact: true }).click();
    await operation.waitFor({ state: 'hidden' });
    assert.equal(await actions.count(), 0);
    assert.equal(await pool.getByLabel('邮箱池页码', { exact: true }).inputValue(), '21', '关闭行操作保留最后一页');
    assert.equal(await pool.locator('.mailbox-account').count(), 3);
    assert.deepEqual(await page.evaluate(() => ({ window: scrollY, panel: document.querySelector('#plugin-tool-host .drawer-body').scrollTop })), scrollBeforeOperation, '关闭抽屉保留列表滚动位置');
    await page.goto(origin + '/#/plugins/websites');
    await page.goto(origin + '/#/plugins/mailboxes');
    await drawer.getByRole('tab', { name: '邮箱池管理', exact: true }).click(); await waitCodes();
    assert.equal(await pool.getByLabel('邮箱池每页条数', { exact: true }).inputValue(), '100');
    assert.equal(await pool.getByLabel('邮箱池页码', { exact: true }).inputValue(), '21');
    await pool.getByLabel('搜索邮箱池', { exact: true }).fill('layout-1999'); await waitCodes();
    assert.equal(await pool.locator('.mailbox-account').count(), 1);
    assert.equal(await pool.locator('.mailbox-account strong').textContent(), fixture[1999].email);
    await measure('search');
    await pool.getByLabel('搜索邮箱池', { exact: true }).fill('');
    await pool.getByLabel('邮箱类型', { exact: true }).selectOption('apple');
    await pool.getByLabel('邮箱状态', { exact: true }).selectOption('expired'); await waitCodes();
    assert.equal(await pool.locator('.mailbox-account').count(), 1);
    await pool.getByLabel('搜索邮箱池', { exact: true }).fill('不存在');
    await pool.getByText('没有匹配的邮箱', { exact: true }).waitFor(); await measure('no-match');
    // The title help opens in the top layer, includes actual official destinations, and never shifts the form.
    await pool.getByRole('button', { name: '登记邮箱', exact: true }).click();
    await pool.locator('#ops-managed-email').fill('draft@example.test');
    const fieldTop = (await pool.locator('#ops-managed-email').boundingBox()).y;
    await pool.getByLabel('查看邮箱池说明', { exact: true }).click();
    const help = pool.locator('#mailbox-pool-help');
    await help.getByRole('link', { name: '前往 Google 生成', exact: true }).waitFor();
    for (const [name, href] of [['前往 Google 生成','https://myaccount.google.com/apppasswords'], ['登录 Apple 账户生成','https://account.apple.com/'], ['登录 Microsoft 账户','https://account.microsoft.com/']]) {
      assert.equal(await help.getByRole('link', { name, exact: true }).getAttribute('href'), href);
      assert.equal(await help.getByRole('link', { name, exact: true }).getAttribute('target'), '_blank');
    }
    assert.equal((await pool.locator('#ops-managed-email').boundingBox()).y, fieldTop);
    if ([1440,390].includes(width)) await page.screenshot({ path: path.join(output, `help-${width}-${theme}.png`) });
    await pool.getByLabel('查看邮箱池说明', { exact: true }).press('Escape');
    const editor = pool.locator('#ops-managed-pool-form');
    for (const provider of providers) {
      await editor.locator('#ops-managed-provider').selectOption(provider);
      const href = provider === 'google' ? 'https://myaccount.google.com/apppasswords' : provider === 'apple' ? 'https://account.apple.com/' : 'https://account.microsoft.com/';
      if (provider !== 'microsoft') await editor.getByLabel('查看应用专用密码说明', { exact: true }).click();
      await editor.locator(`a[href="${href}"]`).last().waitFor();
      assert(await editor.locator(`a[href="${href}"]`).last().isVisible(), `${width}/${theme}/${provider} 指引应可查看`);
      if (provider !== 'microsoft') await editor.getByLabel('查看应用专用密码说明', { exact: true }).press('Escape');
    }
    await editor.getByRole('button', { name: '取消', exact: true }).click();
    await pool.getByRole('button', { name: '批量导入', exact: true }).click();
    await editor.getByLabel('查看收信服务商说明', { exact: true }).click();
    for (const provider of providers) {
      await editor.locator('#ops-managed-batch-provider').selectOption(provider);
      assert(await editor.locator('[data-mailbox-batch-help] a').first().isVisible());
    }
    await editor.getByRole('button', { name: '取消', exact: true }).click();
    await pool.getByRole('button', { name: '登记邮箱', exact: true }).click();
    assert.equal(await editor.locator('#ops-managed-email').inputValue(), 'draft@example.test');
    await editor.getByRole('button', { name: '取消', exact: true }).click();
    await pool.getByLabel('搜索邮箱池', { exact: true }).fill(''); await waitCodes();
    fail = true;
    await pool.getByRole('button', { name: '刷新', exact: true }).click();
    await pool.getByText('合成读取失败，请重试', { exact: false }).waitFor();
    assert.equal(await pool.locator('.mailbox-account').count(), 1, '刷新失败保留已有结果');
    fail = false; rows = [];
    await pool.getByRole('button', { name: '重试', exact: true }).click();
    await pool.getByText('邮箱池暂无记录', { exact: true }).waitFor(); await measure('empty');
    assert.deepEqual(errors, []); assert.deepEqual(mutations, []);
    assert.deepEqual(requests.external, []); assert.deepEqual(requests.unavailable, []);
    await context.close();
  }
  await writeFile(path.join(output, 'geometry.json'), JSON.stringify(results,null,2));
  console.log(JSON.stringify({ status:'passed', scenarios:results.length, records:fixture.length, widths:new Set(results.map(r=>r.width)).size, themes:2 }));
} finally { await browser.close(); }

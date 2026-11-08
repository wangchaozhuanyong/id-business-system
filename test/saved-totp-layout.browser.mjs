import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { root, origin, interceptDesign, settle } from './helpers/offline-design.mjs';

test('2FA saved accounts stay compact and pasted keys recover from a failed calculator load', { timeout: 120_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL, headless: true });
  t.after(() => browser.close());
  const output = process.env.ID_LAYOUT_QA_OUTPUT || path.join(root, '.runtime/totp-compact-20261108');
  await mkdir(output, { recursive: true });
  const measurements = [];
  // Public RFC 6238 fixture only; never use a user's authenticator key here.
  const key = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
  for (const width of [1440, 768, 390, 320]) for (const theme of ['light', 'dark']) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block', permissions: ['clipboard-read', 'clipboard-write'] });
    const requests = await interceptDesign(context, { localFixtures: {}, actor: { id: 'fixture', name: '离线验收', role: 'admin' } });
    const accounts = Array.from({ length: 9 }, (_, index) => ({ id: 'fixture-' + index, name: index === 8 ? '离线验收长账号名称'.repeat(8) : '合成账号 ' + (index + 1), issuer: '公开测试资料 · 离线验收' }));
    await context.route(origin + '/api/local/saved-totp', route => {
      assert.equal(route.request().method(), 'GET', 'Layout QA must not save or delete accounts');
      return route.fulfill({ json: { version: 1, items: accounts } });
    });
    await context.route(origin + '/api/local/saved-totp/code', route => route.fulfill({ json: { code: '12345678', serverNow: Date.now(), expiresAt: Date.now() + 30_000 } }));
    const attempts = [];
    await context.route(origin + '/assets/tools/totp.mjs?*', async route => {
      attempts.push(route.request().url());
      if (attempts.length === 1) return route.fulfill({ status: 503, contentType: 'text/plain', body: 'Synthetic transient module outage' });
      return route.fallback();
    });
    const page = await context.newPage(), errors = [];
    page.setDefaultTimeout(6000);
    page.on('pageerror', error => errors.push(error.message));
    await page.goto(origin + '/#/overview');
    if (theme === 'dark') await page.locator('#theme-toggle').click();
    await page.getByRole('button', { name: '在线工具', exact: true }).click();
    await page.evaluate(() => window.IDDesignModules.find(module => module.id === 'operations').onClick('tool-open', { dataset: { name: '计算 2FA 验证码' } }));
    const drawer = page.locator('#drawer'), saved = drawer.locator('#ops-saved-totp');
    await saved.locator('[data-saved-totp-code] .ops-code').nth(7).waitFor();
    await page.evaluate(value => navigator.clipboard.writeText(value), key);
    await drawer.locator('[data-action="ops-tool-paste"]').click();
    await drawer.getByText('验证码组件暂时加载失败，输入已保留，请点击重试。', { exact: true }).waitFor();
    assert.equal(await drawer.locator('#ops-totp-secret').inputValue(), key);
    assert(await drawer.evaluate(node => node.scrollWidth <= node.clientWidth + 1), 'Failed load must keep retry reachable');
    await drawer.getByRole('button', { name: '重试', exact: true }).click();
    await drawer.locator('#ops-totp-result .ops-code').filter({ hasText: /^\d{6}$/ }).waitFor();
    assert.equal(await drawer.locator('#ops-totp-secret').inputValue(), '');
    assert.equal(attempts.length, 2);
    assert.notEqual(attempts[0], attempts[1], 'Retry must bypass the document failed-import cache');
    await drawer.locator('#ops-totp-secret').fill(key.toLowerCase());
    await drawer.locator('#ops-totp-secret').press('Enter');
    await drawer.locator('#ops-totp-result .ops-code').filter({ hasText: /^\d{6}$/ }).waitFor();
    assert.equal(attempts.length, 2, 'Successful module loads stay shared');
    const calculated = drawer.locator('#ops-totp-result tbody tr');
    assert.equal(await calculated.count(), 1);
    assert((await calculated.boundingBox()).height <= 80, '临时计算结果同样一行显示');

    await drawer.locator('#ops-totp-secret').press('Enter');
    assert.equal(await drawer.locator('#ops-totp-result .ops-code').filter({ hasText: /^\d{6}$/ }).count(), 1, 'Enter after successful paste must retain the current result');
    await saved.locator('[data-action="ops-totp-copy"]').first().click();
    assert.equal(await page.evaluate(() => navigator.clipboard.readText()), '12345678');
    await settle(page);
    const measure = async () => saved.locator('.saved-totp-table tbody tr').evaluateAll(nodes => nodes.map(node => {
      const rect = selector => node.querySelector(selector).getBoundingClientRect().toJSON();
      return { row: node.getBoundingClientRect().toJSON(), code: rect('.ops-code'), countdown: rect('.totp-countdown'), copy: rect('[data-action="ops-totp-copy"]') };
    }));
    const rows = await measure();
    assert.equal(rows.length, 8);
    for (const row of rows) {
      assert(row.row.height <= 80, `${width} table row too tall: ${row.row.height}`);
      assert(row.code.right + 3 <= row.countdown.left, `${width} code overlaps countdown`);
      assert(row.countdown.right + 6 <= row.copy.left, `${width} countdown overlaps copy`);
      assert(row.copy.height >= (width <= 900 ? 44 : 36));
      if (width >= 768) assert(await saved.locator('[data-action="ops-totp-copy"]').first().evaluate(node => { const r = node.getBoundingClientRect(); return document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2)?.closest('button') === node; }), '复制按钮不可被固定操作列遮挡');
    }
    const controls = await drawer.locator('.totp-input-actions').evaluate(node => ({ overflow: node.scrollWidth > node.clientWidth + 1, input: node.querySelector('input').getBoundingClientRect().toJSON(), buttons: [...node.querySelectorAll('button:not([hidden])')].map(n => n.getBoundingClientRect().toJSON()) }));
    assert(!controls.overflow, `${width} input toolbar overflow`);
    if (width > 520) assert(controls.buttons.every(box => Math.abs(box.top - controls.input.top) <= 1));
    else assert(controls.buttons.every(box => box.top >= controls.input.bottom + 6));
    assert(await drawer.evaluate(node => node.scrollWidth <= node.clientWidth + 1));
    await saved.locator('[data-action="ops-saved-totp-edit"]').first().click();
    assert.equal(await saved.locator('#ops-totp-name').inputValue(), accounts[0].name);
    await saved.getByRole('button', { name: '取消', exact: true }).click();
    await saved.locator('[data-action="ops-saved-totp-page"]').filter({ hasText: '下一页' }).click();
    await saved.locator('[data-saved-totp-code] .ops-code').waitFor();
    assert.equal(await saved.locator('.saved-totp-table tbody tr').count(), 1);
    assert((await measure()).every(row => row.row.height <= 80));
    await saved.locator('#ops-saved-totp-search').fill('不存在的合成账号');
    await saved.getByText('没有匹配的账号', { exact: true }).waitFor();
    await saved.locator('#ops-saved-totp-search').fill('');
    await saved.locator('[data-saved-totp-code] .ops-code').nth(7).waitFor();
    await drawer.locator('#ops-totp-secret').fill(' ');
    await drawer.locator('#ops-totp-secret').fill('');
    await drawer.locator('#ops-totp-secret').scrollIntoViewIfNeeded();
    await page.screenshot({ path: path.join(output, `compact-${width}-${theme}.png`), fullPage: false });
    measurements.push({ width, theme, rows, controls, moduleAttempts: attempts.length });
    assert.deepEqual(errors, []);
    assert.deepEqual(requests.unavailable, []);
    assert.deepEqual(requests.external, []);
    await context.close();
  }
  await writeFile(path.join(output, 'geometry.json'), JSON.stringify(measurements, null, 2));
});

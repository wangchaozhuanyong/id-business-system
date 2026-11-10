import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { pageAuditRows } from '../server/local-business.mjs';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

test('audit and system login have separate paged views and recover from a failed page', { timeout: 30_000 }, async (t) => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const rows = Array.from({ length: 42 }, (_, index) => ({
    id: 42 - index, at: '2026-11-05T08:10:00Z',
    domain: index % 2 ? 'auth' : 'settings',
    action: index % 2 ? 'auth_login' : 'fee_rules_save',
    actorName: '合成账号 ' + (42 - index), summary: index % 2 ? '员工登录' : '更新规则'
  }));
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const actor = { id: 'fixture-admin', role: 'admin', name: '合成管理员' };
    await interceptDesign(context, { actor, localFixtures: { 'auth/session': { actor, configured: true } } });
    let failNextPage = true;
    const reads = [];
    await context.route(origin + '/api/local/audit/page?*', route => {
      const params = new URL(route.request().url()).searchParams;
      reads.push(Object.fromEntries(params));
      if (failNextPage && params.get('page') === '2') {
        failNextPage = false;
        return route.fulfill({ status: 503, json: { error: '合成读取失败' } });
      }
      return route.fulfill({ json: pageAuditRows(rows, params) });
    });
    const page = await context.newPage();
    await page.goto(origin + '/#/settings/audit');
    const main = page.locator('#main');
    const pager = main.locator('[data-pagination="operations-audit"]');
    await main.getByText('合成账号 42', { exact: true }).waitFor();
    assert.equal(await pager.getAttribute('data-page'), '1');
    assert.equal(reads[0].pageSize, '20');
    await pager.getByRole('button', { name: '下一页', exact: true }).click();
    await main.getByText('日志读取失败。已保留上次结果和页码。请重试。').waitFor();
    assert.equal(await pager.getAttribute('data-page'), '1');
    assert(await main.getByText('合成账号 42', { exact: true }).isVisible());
    await main.getByRole('button', { name: '重试读取', exact: true }).click();
    await main.getByText('合成账号 22', { exact: true }).waitFor();
    assert.equal(await pager.getAttribute('data-page'), '2');
    assert.deepEqual(reads[1], reads[2]);
    await main.getByRole('button', { name: '查看详情', exact: true }).first().click();
    const dialog = page.locator('#drawer');
    assert(await dialog.getByText('合成账号 22', { exact: true }).isVisible());
    await dialog.getByRole('button', { name: '关闭抽屉', exact: true }).click();

    const search = main.getByRole('textbox', { name: '搜索当前列表' });
    await search.fill('合成账号 41');
    await main.getByText('合成账号 41', { exact: true }).waitFor();
    assert.equal(await pager.getAttribute('data-page'), '1');
    assert(await search.evaluate(node => node === document.activeElement));
    assert.equal(await search.inputValue(), '合成账号 41');
    await page.goto(origin + '/#/settings/login-logs');
    const loginPager = main.locator('[data-pagination="operations-login"]');
    await loginPager.waitFor();
    assert.equal(await loginPager.getAttribute('data-total'), '21');
    assert.equal(reads.at(-1).view, 'login');
    assert.equal(reads.at(-1).query, '');
    assert.equal(await main.getByText('合成账号 42', { exact: true }).count(), 0);
    await context.close();
  }
});

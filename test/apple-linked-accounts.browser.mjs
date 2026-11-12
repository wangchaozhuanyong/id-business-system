import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { interceptDesign, origin, separatorSnapshot, toggleDesignTheme } from './helpers/offline-design.mjs';

const actor = { id: 'apple-linked-qa-admin', name: '合成管理员', role: 'admin' };
const account = 'subscriber-with-a-long-account-name-for-lookup@example.test';
const output = fileURLToPath(new URL('../.runtime/apple-linked-accounts-20261112/linked/', import.meta.url));
const order = (id, appleIdId = 'used', changes = {}) => ({
  id, orderNo: 'SYN-' + id, appleIdId, email: account, customerId: 'customer-one',
  product: 'Gemini', plan: 'Google AI Pro', businessType: '首次开通', payment: '苹果内购',
  paidConfirmed: true, paidAmount: '20', paidCurrency: 'USD', saleAmount: '200', saleCurrency: 'CNY',
  receiptConfirmed: true, start: '2026-11-01T12:00', expiry: '2026-12-01T12:00',
  entitlementStatus: 'active', appleFunding: { bound: true, region: 'US', expected: '20' },
  appleStoreRegion: 'US', billingChannel: 'app_store', billingCountry: '美国', billingCycle: 'month', loginMethod: 'google',
  refunds: [], bankReturns: [], corrections: [], version: 1, ...changes
});
function fixtures() {
  const ids = ['used', 'multi', 'pending', 'orphan', 'unused'];
  return {
    inventory: { version: 1, data: {
      mailboxes: ids.map(id => ({ id, email: id + '-apple@example.test', type: 'apple',
        status: '正常', health: 'normal', country: '美国', appStoreRegion: 'US', version: 1 })),
      accounts: [], batches: [], returnRecords: [], importRecords: [], registrationRecords: [], tableSettings: [], undo: []
    } },
    commerce: { version: 1, data: {
      customers: [{ id: 'customer-one', name: '合成客户甲', active: true }],
      orders: [...Array.from({ length: 23 }, (_, i) => order('history-' + i)),
        order('multi-one', 'multi', { email: 'first-subscriber@example.test' }),
        order('multi-two', 'multi', { email: 'second-subscriber@example.test', cancelled: true }),
        order('pending-order', 'pending', { email: 'pending-subscriber@example.test', paidConfirmed: false, appleFunding: undefined })],
      tenants: [], operating: [], rentBatches: [], logs: []
    } },
    appleBalance: { version: 1, data: {
      wallets: ids.map(id => ({ id, balance: '80', version: 1, currency: 'USD' })),
      allocations: [{ orderId: 'missing-order', orderNo: 'SYN-MISSING', appleIdId: 'orphan',
        email: 'historic-subscriber@example.test', amount: '20', returned: '0' }], movements: [{
        id: 'long-movement', appleIdId: 'used', orderId: 'history-0', orderNo: 'SYN-history-0',
        email: account, kind: 'order-charge', label: '订单扣款', amount: '-20', before: '100', after: '80',
        actor: '合成操作员', at: '2026-11-01 12:00', reason: '用于检查完整长记录在手机上能够换行显示。'.repeat(12), versionAfter: 1
      }], refunds: []
    } },
    settings: { version: 1, data: { mailboxTypes: [], applePaidPrices: { Gemini: { 'Google AI Pro': { US: '20' } } } } }
  };
}
const playwright = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
const { chromium } = await import(playwright ? pathToFileURL(playwright).href : 'playwright');
const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL || undefined });
await mkdir(output, { recursive: true });
const measurements = [];
const clippedCells = table => table.locator('tbody td > div').evaluateAll(nodes => nodes.flatMap(node => {
  const text = node.getBoundingClientRect(), cell = node.parentElement.getBoundingClientRect();
  return text.left < cell.left - 1 || text.right > cell.right + 1 || text.top < cell.top - 1 || text.bottom > cell.bottom + 1
    ? [{ text: node.textContent.slice(0, 60), content: text.toJSON(), cell: cell.toJSON() }] : [];
}));
test.after(async () => {
  await writeFile(output + 'layout-results.json', JSON.stringify(measurements, null, 2));
  await browser.close();
});

for (const width of [1440, 1024, 901, 900, 768, 390, 320]) for (const theme of ['light', 'dark']) {
  test(`苹果 ID 关联查询 ${width}px ${theme}：原单、历史、多关联、分页与空结果`, async t => {
    const context = await browser.newContext({ viewport: { width, height: 920 }, locale: 'zh-CN' });
    t.after(() => context.close());
    const fixture = fixtures(), mock = await interceptDesign(context, { localFixtures: fixture, actor, skipRechargeAssets: true });
    const page = await context.newPage(), errors = [], writes = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('request', request => { if (request.method() !== 'GET') writes.push(request.url()); });
    page.setDefaultTimeout(8000);
    await page.goto(origin + '/#/accounts/apple-balances');
    if (theme === 'dark') await toggleDesignTheme(page);
    const row = id => page.locator('[data-table="苹果ID余额"] tr[data-row-id="' + id + '"]');
    const drawer = page.locator('#drawer[open]');
    await row('used').getByRole('button', { name: account, exact: true }).waitFor();
    await row('used').getByRole('button', { name: account, exact: true }).click();
    await drawer.getByRole('heading', { name: '苹果 ID 关联账号', exact: true }).waitFor();
    const linkedTable = drawer.getByRole('table', { name: '苹果 ID 关联账号记录' });
    await linkedTable.waitFor();
    assert.equal(await linkedTable.locator('tbody tr').count(), 20);
    assert.equal(await linkedTable.getByText(account, { exact: true }).count(), 20);
    const help = drawer.locator('.drawer-header .title-help'), note = help.locator('.title-description');
    assert.equal(await note.isVisible(), false);
    const contentBefore = await linkedTable.boundingBox();
    await help.locator('summary').focus();
    await page.keyboard.press('Enter');
    await note.waitFor({ state: 'visible' });
    const contentAfter = await linkedTable.boundingBox();
    assert.equal(contentAfter.y, contentBefore.y, '说明浮层不得挤动关联记录');
    await page.keyboard.press('Escape');
    await note.waitFor({ state: 'hidden' });
    const headingBox = await drawer.getByRole('heading', { name: '苹果 ID 关联账号', exact: true }).evaluate(node => {
      const range = document.createRange(); range.selectNodeContents(node); return range.getBoundingClientRect().toJSON();
    });
    const helpBox = await help.locator('summary').boundingBox();
    assert.ok(helpBox.x >= headingBox.right && helpBox.x - headingBox.right <= 16 &&
      Math.abs(helpBox.y + helpBox.height / 2 - headingBox.y - headingBox.height / 2) < 4,
    JSON.stringify({ headingBox, helpBox }));
    const spacing = await separatorSnapshot(page, '#drawer');
    assert.deepEqual(spacing.findings, []);
    const overflow = await drawer.locator('.drawer-body').evaluate(node => node.scrollWidth > node.clientWidth + 1);
    assert.equal(overflow, false, '关联详情不得横向溢出');
    assert.deepEqual(await clippedCells(linkedTable), [], '账号、字段及操作完整显示在所属单元格内');
    measurements.push({ width, theme, spacing: spacing.measurements, overflow });
    if ([1440, 390].includes(width)) await page.screenshot({ path: output + `linked-${width}-${theme}.png` });
    await drawer.getByRole('button', { name: '下一页', exact: true }).click();
    assert.equal(await linkedTable.locator('tbody tr').count(), 3);
    assert.equal(await drawer.locator('[data-pagination="apple-linked"]').getAttribute('data-page'), '2');
    const search = drawer.getByRole('textbox', { name: '搜索关联账号记录' });
    await search.fill('SYN-history-22');
    await search.press('Enter');
    assert.equal(await linkedTable.locator('tbody tr').count(), 1);
    await search.fill('没有匹配的合成关键词');
    await search.press('Enter');
    await drawer.getByText('没有匹配的关联记录', { exact: true }).waitFor();
    await search.fill('SYN-history-0');
    await search.press('Enter');
    await drawer.getByRole('button', { name: '查看订单', exact: true }).click();
    await page.waitForURL('**/#/orders/detail/history-0');
    await page.locator('#main').getByText(account, { exact: true }).first().waitFor();
    await page.evaluate(() => window.IDDesignAPI.go('accounts/apple-balances'));
    await row('used').getByRole('button', { name: account, exact: true }).click();
    await drawer.getByRole('button', { name: '余额变动', exact: true }).click();
    const ledgerTable = drawer.getByRole('table', { name: '苹果 ID 余额变动' });
    await ledgerTable.waitFor();
    assert.deepEqual(await clippedCells(ledgerTable), [], '余额流水共用表格的长记录也应完整显示');
    await drawer.getByRole('button', { name: '关闭', exact: true }).click();
    await row('multi').getByRole('button', { name: '2 个关联账号', exact: true }).click();
    await linkedTable.getByText('first-subscriber@example.test', { exact: true }).waitFor();
    await linkedTable.getByText('second-subscriber@example.test', { exact: true }).waitFor();
    await linkedTable.getByText('已付款 · 已撤单', { exact: true }).waitFor();
    await drawer.getByRole('button', { name: '关闭', exact: true }).click();
    await row('pending').getByRole('button', { name: 'pending-subscriber@example.test', exact: true }).click();
    await linkedTable.getByText('待付款', { exact: true }).waitFor();
    await drawer.getByRole('button', { name: '关闭', exact: true }).click();
    await row('orphan').getByRole('button', { name: 'historic-subscriber@example.test', exact: true }).click();
    await linkedTable.getByText('原订单缺失', { exact: true }).waitFor();
    assert.equal(await linkedTable.getByRole('button', { name: '查看订单', exact: true }).count(), 0);
    await drawer.getByRole('button', { name: '关闭', exact: true }).click();
    await row('unused').getByRole('button', { name: '更多操作', exact: true }).click();
    await page.locator('.row-action-menu:popover-open').getByRole('menuitem', { name: '关联账号', exact: true }).click();
    await drawer.getByText('暂无关联账号', { exact: true }).waitFor();
    await drawer.getByRole('button', { name: '关闭', exact: true }).click();
    const mainSearch = page.getByRole('textbox', { name: '搜索苹果 ID', exact: true });
    await mainSearch.fill('SYN-history-22');
    await mainSearch.press('Enter');
    assert.equal(await page.locator('[data-table="苹果ID余额"] tbody tr[data-row-id]').count(), 1);
    await row('used').waitFor();
    assert.deepEqual(errors, []);
    assert.deepEqual(writes, []);
    assert.deepEqual(mock.external, []);
    assert.deepEqual(mock.unavailable, []);
  });
}

test('按苹果 ID 使用状态的徽标对应完整分类，搜索只影响列表命中数', async t => {
  const context = await browser.newContext({ viewport: { width: 390, height: 920 } });
  t.after(() => context.close());
  const fixture = fixtures();
  fixture.commerce.data.orders.push(order('unrecorded', '', {
    email: 'unrecorded-subscriber@example.test', appleFunding: undefined
  }));
  await interceptDesign(context, { localFixtures: fixture, actor, skipRechargeAssets: true });
  const page = await context.newPage();
  await page.goto(origin + '/#/subscriptions/apple-ids');
  const tabs = page.getByRole('tablist', { name: '苹果 ID 使用状态', exact: true });
  const pager = page.locator('[data-pagination="apple-management"]');
  await pager.waitFor();
  const all = tabs.getByRole('tab', { name: '全部状态', exact: true });
  assert.equal(await all.locator('.tab-count').textContent(), '6');
  for (const label of ['未使用', '待付款占用', '已使用', '待核对', '未登记苹果 ID']) {
    const tab = tabs.getByRole('tab', { name: label, exact: true });
    const count = await tab.locator('.tab-count').textContent();
    await tab.click();
    assert.equal(await tab.getAttribute('aria-selected'), 'true');
    assert.equal(await pager.getAttribute('data-total'), count);
  }
  const search = page.getByRole('textbox', { name: '搜索苹果 ID 使用记录', exact: true });
  await search.fill('no-match-example');
  await search.press('Enter');
  assert.equal(await pager.getAttribute('data-total'), '0');
  assert.equal(await tabs.getByRole('tab', { name: '未登记苹果 ID', exact: true }).locator('.tab-count').textContent(), '1');
  assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
});

test('关联读取失败可重试，重读失败保留结果，关闭抽屉后迟到响应不重开', async t => {
  const context = await browser.newContext({ viewport: { width: 1440, height: 920 } });
  t.after(() => context.close());
  const fixture = fixtures();
  await interceptDesign(context, { localFixtures: fixture, actor, skipRechargeAssets: true });
  let fail = true, release, started;
  await context.route('**/api/local/commerce', async route => {
    if (release) { started?.(); await release.promise; }
    await route.fulfill(fail ? { status: 503, json: { error: '合成读取失败' } } : { json: fixture.commerce });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  await page.goto(origin + '/#/accounts/apple-balances');
  const row = page.locator('[data-table="苹果ID余额"] tr[data-row-id="used"]');
  await row.getByRole('button', { name: '读取失败，重试', exact: true }).click();
  const drawer = page.locator('#drawer[open]');
  await drawer.getByText('关联账号读取失败', { exact: true }).waitFor();
  assert.equal(await drawer.locator('[data-pagination="apple-linked"]').count(), 0);
  fail = false;
  await drawer.getByRole('button', { name: '刷新', exact: true }).click();
  const table = drawer.getByRole('table', { name: '苹果 ID 关联账号记录' });
  await table.waitFor();
  fail = true;
  await drawer.getByRole('button', { name: '刷新', exact: true }).click();
  await drawer.getByText('关联资料读取失败。已读取的记录保留，可点击刷新重试。', { exact: true }).waitFor();
  assert.equal(await table.locator('tbody tr').count(), 20);
  fail = false;
  const began = new Promise(resolve => { started = resolve; });
  release = {};
  release.promise = new Promise(resolve => { release.resolve = resolve; });
  await drawer.getByRole('button', { name: '刷新', exact: true }).click();
  await began;
  await drawer.getByRole('button', { name: '关闭', exact: true }).click();
  release.resolve();
  await page.waitForFunction(() => !document.querySelector('#main [aria-busy="true"]'));
  assert.equal(await page.locator('#drawer[open]').count(), 0);
  fixture.commerce.data.orders.push(order('fresh-renewal'));
  fixture.commerce.version++;
  const refreshed = page.waitForResponse(response => response.url().endsWith('/api/local/commerce'));
  await page.locator('#main [data-action="apple-reload"]').click();
  await refreshed;
  const mainSearch = page.getByRole('textbox', { name: '搜索苹果 ID', exact: true });
  await mainSearch.fill('SYN-fresh-renewal');
  await mainSearch.press('Enter');
  await row.waitFor();
});

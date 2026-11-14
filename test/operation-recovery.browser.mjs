import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createLocalBusinessStore } from '../server/local-business.mjs';
import { localBusinessRequest } from './helpers/local-business-request.mjs';
import { interceptDesign, origin, separatorSnapshot, toggleDesignTheme } from './helpers/offline-design.mjs';

const actor = { id: 'browser-admin', name: '合成管理员', role: 'admin' };
const base = origin + '/api/local/';
const seedOrder = (id, extra = {}) => ({
  id, orderNo: id === 'order-draft' ? 'WD-001' : 'WD-002', product: 'GPT', plan: 'Plus', businessType: '续费',
  email: id + '@example.test', payment: '银行卡', source: '手工录单', status: 'draft', cancelled: false,
  corrections: [], refunds: [], bankReturns: [], compensations: [], cancellationEvents: [],
  paidConfirmed: false, receiptConfirmed: false, version: 1, ...extra
});

async function environment(context) {
  const store = createLocalBusinessStore(':memory:');
  const { version, data } = store.load('commerce');
  const empty = { customers: [], tenants: [], orders: [], operating: [], rentBatches: [], logs: [] };
  store.saveBatch([{ domain: 'commerce', version, action: '新增独立订单',
    data: { ...(data || empty), orders: [seedOrder('order-draft')] } }], { actor });
  const first = store.load('commerce');
  store.saveBatch([{ domain: 'commerce', version: first.version, action: '新增独立订单', data: {
    ...first.data, orders: [...first.data.orders, seedOrder('order-paid',
      { paidConfirmed: true, paidAmount: '20', paidCurrency: 'USD' })]
  } }], { actor });
  const mailbox = { id: 'synthetic-google', type: 'google', email: 'archive-mail@example.test',
    status: '正常', health: 'normal', inventoryState: 'available', version: 1, country: '马来西亚',
    createdAt: '2026-11-12 10:00', importId: 'IMPORT-original', usageLinks: [], inventoryHistory: [] };
  const importRecord = { id: mailbox.importId, type: 'google', time: '2026-11-12 10:00', actor: actor.name,
    total: 1, success: 1, failed: 0, status: '已导入', results: [{
      id: 'line-original', line: 1, email: mailbox.email, type: 'google', result: '已导入'
    }] };
  store.saveBatch([{ domain: 'inventory', version: 0, action: 'inventory_create', data: {
    mailboxes: [mailbox], accounts: [], batches: [], returnRecords: [], importRecords: [importRecord],
    registrationRecords: [], tableSettings: [], undo: []
  } }], { actor });
  await interceptDesign(context, { actor, skipRechargeAssets: true, businessLists: true, documentDelta: true,
    localFixtures: { 'auth/session': { actor, configured: true } } });
  const requests = [];
  let verified = false, confirmationCount = 0, lostArchive = 0;
  await context.route(base + '**', async route => {
    const request = route.request(), url = new URL(request.url());
    const path = url.pathname.slice('/api/local/'.length);
    if (!/^(commerce|inventory)(?:\/page)?$|^inventory\/archive$|^audit\/page$|^audit\/\d+\/recovery$/.test(path))
      return route.fallback();
    const method = request.method(), body = request.postDataJSON() ?? undefined;
    const operationId = request.headers()['x-id-operation'];
    requests.push({ path, method, body, operationId, query: Object.fromEntries(url.searchParams) });
    const result = await localBusinessRequest(store, path + url.search, {
      method, body, operationId, actor, publicOrigin: origin, authorizeSensitive: () => verified
    });
    if (method === 'POST' && path === 'inventory/archive' && result.status === 200 && lostArchive > 0) {
      lostArchive--;
      return route.abort('connectionreset');
    }
    return route.fulfill({ status: result.status, json: result.body });
  });
  const page = await context.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(7000);
  await page.exposeFunction('testVerifyArchive', () => { confirmationCount++; verified = true; return true; });
  await page.addInitScript(() => { window.IDAccountSecurity = { verify: () => window.testVerifyArchive() }; });
  return { page, store, mailbox, requests, errors, lostArchive: count => { lostArchive = count; },
    confirmations: () => confirmationCount };
}

test('导入批次可逐条归档，手机和桌面都能从原归档恢复，网络中断可继续确认', { timeout: 50_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  for (const [width, dark] of [[1440, false], [390, true]]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const { page, store, mailbox, requests, errors, lostArchive, confirmations } = await environment(context);
    try {
      await page.goto(origin + '/#/mailboxes/google');
      if (dark) await toggleDesignTheme(page);
      const main = page.locator('#main'), dialog = page.locator('#drawer');
      const more = main.locator('[data-action="inventory-more"][data-id="' + mailbox.id + '"]');
      await more.click();
      const menu = page.locator('.row-action-menu:popover-open');
      assert.equal(await menu.getByRole('menuitem', { name: '永久删除' }).count(), 0);
      await menu.getByRole('menuitem', { name: '归档资料', exact: true }).click();
      await dialog.getByText(mailbox.email, { exact: true }).waitFor();
      await page.keyboard.press('Escape');
      await dialog.waitFor({ state: 'hidden' });
      await main.getByRole('tab', { name: '导入记录' }).click();
      await main.locator('[data-action="inventory-import-detail"]').click();
      await dialog.getByRole('button', { name: '核对归档' }).click();
      await dialog.getByText(mailbox.email, { exact: true }).waitFor();
      await dialog.getByRole('button', { name: '确认归档', exact: true }).click();
      await dialog.getByText('请选择归档原因。').waitFor();
      assert.equal(requests.filter(row => row.path === 'inventory/archive' && row.method === 'POST').length, 0);
      await dialog.getByLabel('归档原因').selectOption('wrong_import');
      lostArchive(2);
      await dialog.getByRole('button', { name: '确认归档', exact: true }).click();
      await dialog.getByText(/暂时无法确认归档结果/).waitFor();
      assert.equal(store.load('inventory').data.mailboxes.length, 0);
      await dialog.getByRole('button', { name: '重试归档', exact: true }).click();
      await dialog.getByRole('button', { name: '查看归档记录', exact: true }).click();
      await page.locator('#main[data-layout-route="settings/audit"]').waitFor();
      await dialog.getByText('误导入', { exact: true }).waitFor();
      await dialog.getByText('已归档', { exact: true }).waitFor();
      const writes = requests.filter(row => row.path === 'inventory/archive' && row.method === 'POST');
      assert.equal(writes.length, 4);
      assert.match(writes[0].operationId, /^[\da-f-]{36}$/);
      assert.deepEqual(writes, Array(writes.length).fill(writes[0]));
      assert.equal(confirmations(), 1);
      assert.deepEqual((await separatorSnapshot(page)).findings, []);
      const bounds = await dialog.locator('.drawer-body').evaluate(node => [node.scrollWidth, node.clientWidth]);
      assert(bounds[0] <= bounds[1] + 1);
      await dialog.getByLabel('恢复原因').selectOption('accidental_archive');
      await dialog.getByRole('button', { name: '确认恢复', exact: true }).click();
      await dialog.getByRole('heading', { name: '恢复回执' }).waitFor();
      assert.equal(store.load('inventory').data.mailboxes[0].id, mailbox.id);
      await dialog.getByRole('button', { name: '查看原操作', exact: true }).click();
      await dialog.getByRole('heading', { name: '已恢复', exact: true }).waitFor();
      await dialog.getByRole('button', { name: '查看恢复回执', exact: true }).click();
      await dialog.getByRole('heading', { name: '恢复回执' }).waitFor();
      await page.keyboard.press('Escape');
      assert.equal(await main.getByRole('combobox', { name: '恢复模块' }).inputValue(), 'mailbox');
      const search = main.getByRole('textbox', { name: '搜索当前列表' });
      assert.match(await search.inputValue(), /^#\d+$/);
      const filtered = page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.pathname.endsWith('/audit/page') && url.searchParams.get('module') === 'mailbox' &&
          !url.searchParams.get('query');
      });
      await search.fill('');
      const filteredRows = await (await filtered).json();
      assert.equal(filteredRows.total, 2);
      assert(filteredRows.items.every(row => row.subject === '邮箱库存'));
      assert.deepEqual(errors, []);
    } finally { await context.close(); store.close(); }
  }
});

test('订单日志打开原单操作，结算记录保持只读，撤单和恢复走原确认与服务器事务', { timeout: 35_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, serviceWorkers: 'block' });
  const { page, store, requests, errors } = await environment(context);
  try {
    await page.goto(origin + '/#/settings/audit');
    const main = page.locator('#main'), dialog = page.locator('#drawer'), confirm = page.locator('#confirm-dialog');
    await main.getByRole('combobox', { name: '日志范围' }).selectOption('recovery');
    await main.getByRole('combobox', { name: '恢复模块' }).selectOption('order');
    const search = main.getByRole('textbox', { name: '搜索当前列表' });
    const matching = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname.endsWith('/audit/page') && url.searchParams.get('query') === 'WD-002';
    });
    await search.fill('WD-002');
    assert.equal((await matching).status(), 200);
    await main.getByRole('button', { name: '查看恢复', exact: true }).click();
    await dialog.getByText(/已有付款、实收/).waitFor();
    assert.equal(await dialog.getByRole('button', { name: '业务撤单', exact: true }).count(), 0);
    await dialog.getByRole('button', { name: '查看原订单', exact: true }).click();
    await dialog.getByRole('heading', { name: '订单详情', exact: true }).waitFor();
    assert.equal(await dialog.getByRole('tab', { name: '操作记录' }).getAttribute('aria-selected'), 'true');
    await page.keyboard.press('Escape');
    const findLog = async keyword => {
      const requested = page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.pathname.endsWith('/audit/page') && url.searchParams.get('query') === keyword;
      });
      await search.fill(keyword);
      await requested;
      await main.getByRole('button', { name: '查看恢复', exact: true }).click();
    };
    await findLog('WD-001');
    await dialog.getByRole('button', { name: '业务撤单', exact: true }).click();
    await dialog.getByRole('heading', { name: '业务撤单' }).waitFor();
    await dialog.getByLabel('独立操作原因').fill('核对后撤单');
    await dialog.getByRole('button', { name: '核对并记录' }).click();
    await confirm.getByRole('heading', { name: '确认业务撤单' }).waitFor();
    assert.equal(requests.some(row => row.path === 'commerce' && row.method === 'PUT'), false);
    await confirm.getByRole('button', { name: '确认操作', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.equal(store.load('commerce').data.orders[0].cancelled, true);
    await findLog('业务撤单');
    await dialog.getByRole('button', { name: '恢复已撤订单', exact: true }).click();
    await dialog.getByRole('heading', { name: '恢复已撤业务订单' }).waitFor();
    await dialog.getByLabel('独立操作原因').fill('核对后恢复');
    await dialog.getByRole('button', { name: '核对并记录' }).click();
    await confirm.getByRole('button', { name: '确认操作', exact: true }).click();
    await dialog.waitFor({ state: 'hidden' });
    assert.deepEqual(store.load('commerce').data.orders[0].cancellationEvents.map(row => row.action), ['业务撤单', '恢复业务订单']);
    assert.equal(store.load('commerce').data.orders[1].paidAmount, '20');
    assert.equal(requests.some(row => row.path.endsWith('/recovery') && row.method === 'POST'), false);
    assert.deepEqual(errors, []);
  } finally { await context.close(); store.close(); }
});

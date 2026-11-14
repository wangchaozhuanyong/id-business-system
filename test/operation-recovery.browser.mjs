import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { Readable } from 'node:stream';
import { createLocalBusinessStore } from '../server/local-business.mjs';
import { createRenewalHandoff, renewalHandoffDomain } from '../server/renewal-handoff.mjs';
import { createOrderExpenseHandler } from '../server/finance/expense-receipts.mjs';
import { describeWriteOperation } from '../server/write-operation.mjs';
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

async function environment(context, { actor: acting = actor, setup } = {}) {
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
  await setup?.(store);
  await interceptDesign(context, { actor: acting, skipRechargeAssets: true, businessLists: true, documentDelta: true,
    localFixtures: { 'auth/session': { actor: acting, configured: true } } });
  const requests = [];
  let verified = false, confirmationCount = 0, lostArchive = 0, lostRecovery = 0;
  const renewals = createRenewalHandoff({ store, publicOrigin: origin, getAuth: () => ({
    recentlyVerified: () => verified, orderOwners: () => [acting]
  }) });
  const expenses = createOrderExpenseHandler({ store, publicOrigin: origin });
  await context.route(base + '**', async route => {
    const request = route.request(), url = new URL(request.url());
    const path = url.pathname.slice('/api/local/'.length);
    const businessHandler = path === 'renewals' ? renewals : path === 'finance/expense-receipts' ? expenses : undefined;
    if (!businessHandler && !/^(commerce|inventory|appleBalance)(?:\/page)?$|^inventory\/archive$|^audit\/page$|^audit\/\d+\/recovery$/.test(path))
      return route.fallback();
    const method = request.method(), body = request.postDataJSON() ?? undefined;
    const operationId = request.headers()['x-id-operation'];
    requests.push({ path, method, body, operationId, query: Object.fromEntries(url.searchParams) });
    if (businessHandler) {
      const stream = Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]);
      Object.assign(stream, { method, url: url.pathname + url.search, headers: { ...request.headers(), origin } });
      let status, data;
      await businessHandler(stream, { writeHead(code) { status = code; }, end(result) { data = JSON.parse(result); } }, acting);
      return route.fulfill({ status, json: data });
    }
    const result = await localBusinessRequest(store, path + url.search, {
      method, body, operationId, actor: acting, publicOrigin: origin, authorizeSensitive: () => verified
    });
    if (method === 'POST' && path === 'inventory/archive' && result.status === 200 && lostArchive > 0) {
      lostArchive--;
      return route.abort('connectionreset');
    }
    if (method === 'POST' && path.startsWith('audit/') && result.status === 200 && lostRecovery > 0) {
      lostRecovery--;
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
    lostRecovery: count => { lostRecovery = count; },
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

test('手机与桌面通过原库存入口误标状态，再从原日志预览、确认及重试', { timeout: 50_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  for (const [width, dark] of [[1440, false], [390, true]]) {
    const context = await browser.newContext({ viewport: { width, height: 900 }, serviceWorkers: 'block' });
    const { page, store, mailbox, requests, errors, lostRecovery, confirmations } = await environment(context);
    try {
      await page.goto(origin + '/#/mailboxes/google');
      if (dark) await toggleDesignTheme(page);
      const main = page.locator('#main'), drawer = page.locator('#drawer');
      const more = main.locator('[data-action="inventory-more"][data-id="' + mailbox.id + '"]');
      await more.click();
      await page.locator('.row-action-menu:popover-open').getByRole('menuitem', { name: '移入死号', exact: true }).click();
      const confirm = page.locator('#confirm-dialog[open]');
      await confirm.getByRole('heading', { name: '确认账号状态变化' }).waitFor();
      const saved = page.waitForResponse(response =>
        response.url() === base + 'inventory' && response.request().method() === 'PUT');
      await confirm.locator('[data-action="confirm-accept"]').click();
      assert.equal((await saved).status(), 200);
      assert.equal(store.load('inventory').data.mailboxes[0].health, 'dead');
      const { id } = store.audit().find(record => record.action === 'inventory_health_change');
      await page.goto(origin + '/#/settings/audit');
      await main.getByRole('combobox', { name: '日志范围' }).selectOption('recovery');
      await main.getByRole('combobox', { name: '恢复模块' }).selectOption('mailbox');
      const search = main.getByRole('textbox', { name: '搜索当前列表' });
      const filtered = page.waitForResponse(response => {
        const url = new URL(response.url());
        return url.pathname.endsWith('/audit/page') && url.searchParams.get('module') === 'mailbox' &&
          url.searchParams.get('query') === '#' + id;
      });
      await search.fill('#' + id);
      await search.press('Enter');
      assert.deepEqual((await (await filtered).json()).items.map(row => row.id), [String(id)]);
      await main.getByRole('button', { name: '查看恢复', exact: true }).click();
      await drawer.getByRole('heading', { name: '健康状态' }).waitFor();
      assert.equal(await drawer.getByText('死号', { exact: true }).count(), 1);
      assert.equal(await drawer.getByText('正常', { exact: true }).count(), 1);
      assert.equal(await drawer.getByText('谷歌邮箱 · a***@example.test', { exact: true }).count(), 1);
      assert.equal(await drawer.getByText(mailbox.email, { exact: true }).count(), 0);
      assert.deepEqual((await separatorSnapshot(page)).findings, []);
      const bounds = await drawer.locator('.drawer-body').evaluate(node => [node.scrollWidth, node.clientWidth]);
      assert(bounds[0] <= bounds[1] + 1);
      await drawer.getByRole('button', { name: '确认恢复', exact: true }).click();
      await drawer.getByText('请选择恢复原因。').waitFor();
      await drawer.getByLabel('恢复原因').selectOption('wrong_record');
      lostRecovery(2);
      await drawer.getByRole('button', { name: '确认恢复', exact: true }).click();
      await drawer.getByText(/暂时无法确认恢复结果/).waitFor();
      assert.equal(store.load('inventory').data.mailboxes[0].health, 'normal');
      await drawer.getByRole('button', { name: '重试恢复', exact: true }).click();
      await drawer.getByRole('heading', { name: '恢复回执' }).waitFor();
      await drawer.getByText('选错库存资料', { exact: true }).waitFor();
      const writes = requests.filter(row => row.path === 'audit/' + id + '/recovery' && row.method === 'POST');
      assert.equal(writes.length, 4);
      assert.deepEqual(writes[0].body, { version: 2, reason: 'wrong_record' });
      assert.match(writes[0].operationId, /^[\da-f-]{36}$/);
      assert.deepEqual(writes, Array(writes.length).fill(writes[0]));
      assert.equal(confirmations(), 1);
      assert.equal(store.audit().filter(record => record.action === 'inventory_restore_health').length, 1);
      await drawer.getByRole('button', { name: '查看原操作', exact: true }).click();
      await drawer.getByRole('heading', { name: '已恢复', exact: true }).waitFor();
      await drawer.getByRole('button', { name: '查看恢复回执', exact: true }).click();
      await drawer.getByRole('heading', { name: '恢复回执' }).waitFor();
      assert.deepEqual(errors, []);
    } finally { await context.close(); store.close(); }
  }
});

test('从操作日志打开续费办理、费用作废和苹果余额补偿的原入口', { timeout: 50_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const acting = { ...actor, role: 'super' };
  const context = await browser.newContext({ viewport: { width: 390, height: 900 }, serviceWorkers: 'block' });
  const order = { id: 'order-paid', number: 'WD-002', customer: '合成客户', account: 'source@example.test',
    product: 'GPT', plan: 'Plus', payment: '银行卡', expiry: '2026-11-18T10:00', start: '2026-10-18T10:00' };
  const seed = { id: 'renewal-target', version: 2, status: 'processing', order,
    source: 'synthetic-original-order', submittedBy: { id: 'another-user', name: '合成员工' },
    submittedAt: '2026-11-14T04:00:00Z', processingBy: { id: actor.id, name: actor.name }, paymentReview: true };
  const { page, store, errors, requests, confirmations } = await environment(context, { actor: acting, setup(store) {
    const unrelated = { ...seed, id: 'renewal-other', order: { ...order, number: 'WD-OTHER', id: 'other-order' } };
    store.saveRenewalQueue(0, store.load('commerce').version, [unrelated, seed], {
      action: 'renewal_claim', actor: acting, ids: [seed.id], operation: describeWriteOperation('synthetic-renewal-receipt', acting, [seed.id])
    });
    const expense = { id: 'expense-synthetic', category: 'kyc', chargedOn: '2026-11-14',
      source: '合成账单', reference: 'FIXTURE-FEE-1', amount: '22.5', currency: 'MYR', recordedAt: '2026-11-14T04:00:00Z' };
    store.saveFeatureDocument('order-expense-receipts', 0, { items: [expense] },
      { action: 'order_expense_record', actor: acting, targetId: expense.id });
    const { version, data } = store.load('inventory');
    const wallet = { id: 'wallet-synthetic', type: 'apple', email: 'balance@example.test', appStoreRegion: 'US',
      source: '线上购买', status: '正常', health: 'normal', inventoryState: 'available', version: 1 };
    store.saveBatch([{ domain: 'inventory', version, action: 'inventory_create', data: {
      ...data, mailboxes: [wallet, ...data.mailboxes]
    } }], { actor: acting });
    store.saveBatch([{ domain: 'appleBalance', version: 0, action: 'apple_adjust', data: {
      wallets: [{ id: wallet.id, currency: 'USD', version: 2, balance: '10' }], allocations: [], refunds: [],
      movements: [{ id: 'manual-synthetic', appleIdId: wallet.id, kind: 'manual', label: '人工余额入账',
        amount: '10', before: '0', after: '10', versionAfter: 2, orderId: '', orderNo: '', reason: '合成余额',
        actor: actor.name, at: '2026-11-14 12:00' }]
    } }], { actor: acting });
  } });
  const originalOrders = store.load('commerce');
  const main = page.locator('#main'), drawer = page.locator('#drawer');
  async function openLog(action, module) {
    const { id } = store.audit().find(row => row.action === action);
    await page.goto(origin + '/#/settings/audit');
    await main.getByRole('combobox', { name: '日志范围' }).selectOption('recovery');
    await main.getByRole('combobox', { name: '恢复模块' }).selectOption(module);
    const search = main.getByRole('textbox', { name: '搜索当前列表' });
    const received = page.waitForResponse(response => {
      const url = new URL(response.url());
      return url.pathname.endsWith('/audit/page') && url.searchParams.get('module') === module &&
        url.searchParams.get('query') === '#' + id;
    });
    await search.fill('#' + id);
    await search.press('Enter');
    assert.equal((await (await received).json()).items[0].id, String(id));
    await main.getByRole('button', { name: '查看恢复', exact: true }).click();
  }
  try {
    await openLog('renewal_claim', 'renewal');
    await drawer.getByText('付款结果待核对，请由经办人核对付款凭证。').waitFor();
    await drawer.getByRole('button', { name: '查看续费办理记录' }).click();
    await main.getByText('WD-002', { exact: true }).waitFor();
    assert.equal(await main.getByText('WD-OTHER', { exact: true }).count(), 0);
    const reads = requests.filter(row => row.path === 'renewals' && row.method === 'GET').length;
    await page.evaluate(() => window.IDDesignAPI.render());
    await main.getByRole('button', { name: '查看全部续费', exact: true }).waitFor();
    await main.getByText('WD-002', { exact: true }).waitFor();
    assert.equal(requests.filter(row => row.path === 'renewals' && row.method === 'GET').length, reads);
    await main.getByRole('button', { name: '退回', exact: true }).click();
    await drawer.getByLabel('退回原因').fill('合成退回测试');
    await drawer.getByRole('button', { name: '登记未付款并退回', exact: true }).click();
    await main.getByText('财务已退回', { exact: true }).waitFor();
    assert.equal(store.featureDocument(renewalHandoffDomain).data.items.find(row => row.id === seed.id).returned, '合成退回测试');
    assert.equal(confirmations(), 1);
    await main.getByRole('button', { name: '查看全部续费', exact: true }).click();
    await main.getByRole('tab', { name: '处理中', exact: true }).click();
    await main.locator('tr[data-row-id="renewal-other"]').waitFor();
    await openLog('order_expense_record', 'finance');
    await drawer.getByRole('button', { name: '查看费用凭据' }).click();
    await drawer.getByText('合成账单 · FIXTURE-FEE-1', { exact: true }).waitFor();
    await drawer.getByRole('button', { name: '作废凭据', exact: true }).click();
    await drawer.getByLabel('作废原因').fill('合成作废原因');
    await drawer.getByRole('button', { name: '确认作废', exact: true }).click();
    await drawer.waitFor({ state: 'hidden' });
    await openLog('order_expense_void', 'finance');
    await drawer.getByRole('button', { name: '查看费用凭据' }).click();
    await drawer.getByText('合成作废原因', { exact: true }).waitFor();
    assert.equal(await drawer.getByRole('button', { name: '作废凭据', exact: true }).count(), 0);
    await page.keyboard.press('Escape');
    await openLog('apple_adjust', 'finance');
    await drawer.getByRole('button', { name: '查看余额流水' }).click();
    await drawer.getByRole('button', { name: '补偿撤回', exact: true }).click();
    await drawer.getByLabel('撤回原因').fill('合成补偿原因');
    await drawer.getByRole('button', { name: '核对补偿撤回' }).click();
    await page.locator('#confirm-dialog [data-action="confirm-accept"]').click();
    await drawer.getByText('合成补偿原因', { exact: true }).waitFor();
    assert.equal(store.load('appleBalance').data.movements.length, 2);
    assert.equal(store.load('appleBalance').data.wallets[0].balance, '0.0000');
    assert.deepEqual(store.load('commerce'), originalOrders);
    assert.equal(requests.filter(row => row.method === 'POST' && /^audit\/\d+\/recovery$/.test(row.path)).length, 0);
    assert.deepEqual(errors, []);
  } finally { await context.close(); store.close(); }
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

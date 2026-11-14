import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { createHash } from 'node:crypto';
import { interceptDesign, origin, settle } from './helpers/offline-design.mjs';
import { readOrdersPage, readInventoryPage } from '../server/business-lists.mjs';
import { mergeRecordEdit } from '../server/record-edit.mjs';
import { recordFingerprintInput } from '../modules/data/record-edit.mjs';

const actor = { id: 'synthetic-admin', name: '测试管理员', role: 'admin' };
const now = () => Date.now();
const makeOrder = index => ({
  id: 'test-order-' + index, orderNo: 'Test order ' + index, email: `fixture${index}@example.test`,
  product: 'GPT', plan: 'Plus', notes: '合成备注', version: 1, customerId: 'customer', origin: 'fixture',
  payment: '其他', saleAmount: '220', saleCurrency: 'CNY', paidAmount: '112', paidCurrency: 'CNY',
  refunds: [], corrections: [], bankReturns: [], createdAt: '2026-09-08 15:00', start: '2026-09-09 15:00',
  expiry: '2026-10-09 15:00', businessType: '首次开通', source: '管理员手工', paidConfirmed: true, receiptConfirmed: true
});
const makeMailbox = index => ({
  id: 'test-mail-' + index, type: 'google', email: `fixture${index}@example.test`, country: index % 2 ? '美国' : '马来西亚',
  notes: '隔离邮箱', version: 1, status: '正常', health: 'normal', inventoryState: 'available',
  inventoryHistory: [], usageLinks: [], registered: '2026-09-08 14:00', createdAt: '2026-09-08 15:00'
});

test('orders and stock request only the visible page, preserve mobile navigation and refresh independently edited records',
  { timeout: 45_000 }, async t => {
    const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
    const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
    t.after(() => browser.close());
    const context = await browser.newContext({ viewport: { width: 1440, height: 850 } });
    let commerce = { version: 1, data: { orders: Array.from({ length: 55 }, (_, i) => makeOrder(i + 1)),
      customers: [{ id: 'customer', name: '分页验收客户' }], tenants: [], operating: [], rentBatches: [], logs: [] } };
    const inventory = { version: 1, data: { mailboxes: Array.from({ length: 55 }, (_, i) => makeMailbox(i + 1)),
      accounts: [], batches: [], returnRecords: [], importRecords: [], registrationRecords: [], tableSettings: [], undo: [] } };
    const network = await interceptDesign(context, { actor, businessLists: true, documentDelta: true, skipRechargeAssets: true,
      changeEvents: true, dataVersions: { commerce: '1', inventory: '1' },
      localFixtures: { commerce, inventory, 'renewal-sidebar': { count: 0 }, 'auth/display-names': { items: [actor] } } });
    const requests = [], writes = [], errors = [];
    const respond = (route, json, status = 200) => route.fulfill({ json, status }).catch(() => {});
    await context.route(origin + '/api/local/**', async route => {
      const request = route.request();
      const path = new URL(request.url()).pathname.replace('/api/local/', '');
      const body = request.postDataJSON();
      requests.push({ path, method: request.method(), body });
      if (path === 'change-events') return route.fulfill({
        body: 'event: snapshot\ndata: ' + JSON.stringify({ schema: 1, versions: {
          commerce: String(commerce.version), inventory: String(inventory.version)
        } }) + '\n\n', contentType: 'text/event-stream'
      });
      if (path === 'commerce/page') {
        if (body.query === '迟到') await new Promise(resolve => setTimeout(resolve, 800));
        if (body.query === '暂时失败' && requests.filter(row => row.body?.query === '暂时失败').length === 1)
          return respond(route, { error: '暂时失败' }, 503);
        return respond(route, readOrdersPage(body, { snapshot: commerce, managers: true, inventory: inventory.data, at: now() }));
      }
      if (path === 'inventory/page') {
        const page = readInventoryPage(body, inventory, commerce.data, now());
        return respond(route, { ...page, mailboxPool: { version: 1, inventoryVersion: inventory.version, items: [] }, mailboxTotal: 55 });
      }
      if (path !== 'commerce') return route.fallback();
      if (request.method() === 'GET') return respond(route, commerce);
      writes.push(body);
      if (!body.recordEdit) return respond(route, { error: '预期是单条记录保存' }, 400);
      try {
        const result = mergeRecordEdit('commerce', body.action, body.recordEdit, commerce, actor);
        commerce = { version: commerce.version + 1, data: result.data };
        return respond(route, commerce);
      } catch (error) { return respond(route, { error: error.message }, error.status || 500); }
    });
    const page = await context.newPage();
    page.on('pageerror', error => errors.push(error.message));
    const rows = page.locator('#main tbody tr[data-row-id]');
    const pager = page.locator('#main [data-pagination="main-list"]');
    const assertNoBulkReads = () => {
      assert.equal(requests.filter(row => ['commerce', 'inventory', 'appleBalance', 'tools/mailbox-pool',
        'finance/expense-receipts'].includes(row.path)).length, 0);
    };
    await page.goto(origin + '/#/orders/gpt');
    await rows.first().waitFor();
    assert.equal(await rows.count(), 20);
    assert.equal(await rows.first().getAttribute('data-row-id'), 'test-order-55');
    commerce = { version: 2, data: { ...commerce.data, orders: [...commerce.data.orders, makeOrder(56)] } };
    await page.evaluate(() => window.IDLocalData.acceptChangeVersions({ commerce: '2' }));
    await page.locator('#main tr[data-row-id="test-order-56"]').waitFor();
    const readsAfterEvent = requests.filter(row => row.path === 'commerce/page').length;
    await page.evaluate(() => window.IDLocalData.acceptChangeVersions({ commerce: '2' }));
    await settle(page);
    assert.equal(requests.filter(row => row.path === 'commerce/page').length, readsAfterEvent);
    await pager.getByRole('button', { name: '下一页' }).click();
    await page.locator('#main [data-pagination="main-list"][data-page="2"]').waitFor();
    assert.equal(await rows.first().getAttribute('data-row-id'), 'test-order-36');
    const search = page.locator('#commerce-search');
    await search.fill('迟到');
    await page.waitForRequest(req => req.url().endsWith('/commerce/page') && req.postDataJSON()?.query === '迟到');
    await search.fill('fixture1@example.test');
    await page.locator('#main tr[data-row-id="test-order-1"]').waitFor();
    await settle(page);
    assert.equal(await rows.count(), 1);
    assert.equal(await search.evaluate(node => document.activeElement === node), true);
    await search.fill('暂时失败');
    await page.getByRole('heading', { name: '订单暂时无法读取' }).waitFor();
    assert.equal(await rows.first().getAttribute('data-row-id'), 'test-order-1');
    await page.getByRole('button', { name: '重试', exact: true }).click();
    await page.getByRole('heading', { name: '暂无符合条件的记录' }).waitFor();
    assertNoBulkReads();

    await page.evaluate(() => { location.hash = '#/mailboxes/google'; });
    await page.locator('#main tr[data-row-id="test-mail-55"]').waitFor();
    assert.equal(await rows.count(), 20);
    await page.locator('#inventory-country').selectOption('马来西亚');
    await page.locator('#main tr[data-row-id="test-mail-54"]').waitFor();
    assert.match(await pager.locator('.pagination-count').textContent(), /27 条/);
    await page.setViewportSize({ width: 390, height: 844 });
    const cards = page.locator('#main .mobile-records');
    await cards.waitFor();
    await pager.getByRole('button', { name: '下一页' }).click();
    await page.locator('#main [data-pagination="main-list"][data-page="2"]').waitFor();
    assert(await pager.evaluate(node => {
      const bounds = node.getBoundingClientRect();
      return bounds.left >= 0 && bounds.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth;
    }));
    assertNoBulkReads();
    assert.equal(requests.filter(row => row.path.endsWith('/page')).every(row => row.method === 'POST'), true);

    await page.setViewportSize({ width: 1440, height: 850 });
    await page.evaluate(() => { location.hash = '#/orders/gpt'; });
    await page.locator('#commerce-search').fill('fixture1@example.test');
    const row = page.locator('#main tr[data-row-id="test-order-1"]');
    await row.getByRole('button', { name: '详情', exact: true }).click();
    await page.getByRole('button', { name: '修改备注', exact: true }).click();
    const prior = commerce.data.orders[1];
    const unrelated = mergeRecordEdit('commerce', '更正订单', { collection: 'orders', id: prior.id, expectedVersion: prior.version,
      expectedFingerprint: createHash('sha256').update(recordFingerprintInput('commerce', prior)).digest('hex'),
      changes: { notes: '另一位管理员已保存' }, eventId: 'unrelated-event', logId: 'unrelated-log', reason: '合成编辑'
    }, commerce, actor);
    commerce = { version: commerce.version + 1, data: unrelated.data };
    await page.locator('#commerce-notes').fill('独立保存');
    await page.locator('#commerce-correctionReason').fill('隔离验收');
    await page.getByRole('button', { name: '保存备注' }).click();
    await page.getByText('备注已保存', { exact: true }).waitFor();
    assert.equal(commerce.data.orders[0].notes, '独立保存');
    assert.equal(commerce.data.orders[1].notes, '另一位管理员已保存');
    assert.equal(writes.length, 1);
    assert(writes[0].recordEdit && !writes[0].data);
    await page.getByRole('button', { name: '修改备注', exact: true }).click();
    const first = commerce.data.orders[0];
    commerce = { version: commerce.version + 1, data: { ...commerce.data,
      orders: commerce.data.orders.toSpliced(0, 1, { ...first, version: first.version + 1, notes: '同一条已更新' }) } };
    await page.locator('#commerce-notes').fill('我的未保存输入');
    await page.locator('#commerce-correctionReason').fill('再次核对');
    await page.getByRole('button', { name: '保存备注' }).click();
    await page.getByText('同一条已更新', { exact: true }).waitFor();
    assert.equal(await page.locator('#commerce-notes').inputValue(), '我的未保存输入');
    assert.equal(commerce.data.orders[0].notes, '同一条已更新');
    assert.deepEqual(errors, []);
    assert.deepEqual(network.external, []);
  });

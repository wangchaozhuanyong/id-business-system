import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { Readable } from 'node:stream';
import test from 'node:test';
import { pathToFileURL } from 'node:url';

import { createSubscriptionHandler } from '../server/subscription-management.mjs';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

const actor = { id: 'sort-fixture-admin', name: '排序验收', role: 'super' };
const tableRows = id => `#main table[data-table="${id}"] tbody tr[data-row-id]`;
const timed = index => index < 22 ? `2026-11-${String(index + 1).padStart(2, '0')} 09:00` : '';
const evaluatedAt = Date.parse('2026-11-25T02:00:00Z');

function attachSubscriptionRead(context, fixture) {
  const snapshots = { commerce: fixture.commerce, inventory: fixture.inventory,
    subscriptions: { version: 0, data: null }, mailboxes: { version: 0, data: { items: [] } } };
  const handler = createSubscriptionHandler({
    store: { withSubscriptions(_actor, read) { return read(snapshots, () => {}); } },
    publicOrigin: origin, clock: () => evaluatedAt
  });
  return context.route(origin + '/api/local/subscriptions/list', async route => {
    const request = Object.assign(Readable.from([Buffer.from(route.request().postData())]), {
      method: 'POST', headers: { host: new URL(origin).host, origin,
        'sec-fetch-site': 'same-origin', 'content-type': 'application/json' }
    });
    let status, output;
    await handler(request, {
      writeHead(code) { status = code; }, end(body) { output = body; }
    }, '/api/local/subscriptions/list', actor);
    await route.fulfill({ status, contentType: 'application/json', body: output });
  });
}

test('业务表先按业务时点排序再分页，订阅页签使用各自的默认顺序', { timeout: 60_000 }, async t => {
  const runtime = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
  const { chromium } = await import(runtime ? pathToFileURL(runtime).href : 'playwright');
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const width of [1440, 390]) await t.test(`${width}px`, async t => {
    const context = await browser.newContext({ viewport: { width, height: 900 }, timezoneId: 'UTC' });
    t.after(() => context.close());
    const fixture = JSON.parse(await readFile(
      new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url), 'utf8'));
    const customer = fixture.commerce.data.customers[0];
    const order = fixture.commerce.data.orders.find(row => row.product === 'GPT');
    const mailbox = fixture.inventory.data.mailboxes.find(row => row.type === 'google');
    fixture.commerce.data.customers = Array.from({ length: 23 }, (_, index) => ({
      ...customer, id: 'sort-customer-' + index, name: '合成客户 ' + index, active: true, createdAt: timed(index)
    }));
    fixture.commerce.data.orders = Array.from({ length: 23 }, (_, index) => ({
      ...order, id: 'sort-order-' + index, orderNo: 'SORT-' + index, email: `order-${index}@example.test`,
      customerId: 'sort-customer-' + index, createdAt: timed(index), start: timed(index),
      expiry: ['2026-11-25 13:00', '2026-11-26 10:00', '2026-11-24 10:00'][index] || (index < 22 ? '2026-12-25 10:00' : ''),
      source: '管理员手工', accountId: '', draft: false, cancelled: false, paidConfirmed: true,
      payment: '银行卡', cardId: `recharge:${index + 1}`, receiptConfirmed: true,
      entitlementStatus: index < 22 ? 'active' : 'pending'
    }));
    fixture.inventory.data.mailboxes = Array.from({ length: 23 }, (_, index) => ({
      ...mailbox, id: 'sort-mailbox-' + index, email: `mailbox-${index}@example.test`,
      createdAt: timed(index), importedAt: '', registered: '', health: 'normal', inventoryState: 'available',
      used: false, usageLinks: []
    }));
    fixture['subscription-card-status'] = { items: [], frozen: [
      { id: 'freeze-older', frozenAt: timed(0), counts: {} },
      { id: 'freeze-newer', frozenAt: timed(1), counts: {} }
    ] };
    fixture['auth/employees'] = { employees: Array.from({ length: 23 }, (_, index) => ({
      id: 'sort-employee-' + index, name: `合成员工 ${index}`, email: `staff-${index}@example.test`,
      role: 'employee', active: true, createdAt: timed(index)
    })) };
    await interceptDesign(context, { localFixtures: fixture, actor, skipRechargeAssets: true });
    await attachSubscriptionRead(context, fixture);
    const page = await context.newPage();
    await page.clock.setFixedTime(evaluatedAt);
    const errors = [];
    page.on('pageerror', error => errors.push(error.message));
    const go = async route => {
      await page.evaluate(route => { location.hash = '#/' + route; }, route);
      await page.locator(`#main[data-layout-route="${route}"]`).waitFor();
    };
    const readIds = table => page.locator(tableRows(table)).evaluateAll(rows => rows.map(row => row.dataset.rowId));
    const assertPages = async (table, prefix) => {
      await page.locator(`${tableRows(table)}[data-row-id="${prefix}21"]`).waitFor();
      assert.deepEqual(await readIds(table), Array.from({ length: 20 }, (_, index) => prefix + (21 - index)));
      await page.locator('#main [data-pagination="main-list"]').getByRole('button', { name: '下一页' }).click();
      await page.locator('#main [data-pagination="main-list"][data-page="2"]').waitFor();
      assert.deepEqual(await readIds(table), [prefix + 1, prefix + 0, prefix + 22]);
    };

    await page.goto(origin + '/#/customers/list');
    await assertPages('commerce-customers', 'sort-customer-');
    await go('orders/gpt');
    await assertPages('commerce-orders-GPT', 'sort-order-');
    await go('mailboxes/google');
    await assertPages('谷歌邮箱库存', 'sort-mailbox-');

    await go('subscriptions/all');
    const sort = page.locator('#subscription-sort');
    const emails = page.locator(`${tableRows('subscription-accounts')} td[data-column="email"]`);
    const expectFirstEmail = async email => {
      await page.waitForFunction(({ selector, email }) => document.querySelector(selector)?.textContent.trim() === email,
        { selector: `${tableRows('subscription-accounts')} td[data-column="email"]`, email });
      assert.equal((await emails.first().textContent()).trim(), email);
    };
    await expectFirstEmail('order-21@example.test');
    assert.equal(await sort.inputValue(), 'recent');
    await page.locator('#main [data-pagination="subscription-accounts"]').getByRole('button', { name: '下一页' }).click();
    await expectFirstEmail('order-1@example.test');
    await page.getByRole('tab', { name: '即将到期' }).click();
    await expectFirstEmail('order-0@example.test');
    assert.deepEqual((await emails.allTextContents()).map(value => value.trim()), ['order-0@example.test', 'order-1@example.test']);
    assert.equal(await sort.inputValue(), 'expiry_asc');
    await sort.selectOption('expiry_desc');
    await expectFirstEmail('order-1@example.test');
    await page.getByRole('tab', { name: '全部订阅' }).click();
    await expectFirstEmail('order-21@example.test');
    assert.equal(await sort.inputValue(), 'recent');
    await page.getByRole('tab', { name: '即将到期' }).click();
    await expectFirstEmail('order-1@example.test');
    assert.equal(await sort.inputValue(), 'expiry_desc');
    for (const [tab, label] of [['无邮箱', '最新订单优先'], ['死号', '最新死号优先']]) {
      await page.getByRole('tab', { name: tab, exact: true }).click();
      assert.equal(await sort.inputValue(), 'recent');
      assert.equal(await sort.locator('option:checked').textContent(), label);
    }

    await go('subscriptions/bank-cards');
    await page.getByRole('tab', { name: '订阅用卡明细' }).click();
    const cardTable = 'commerce-subscription-cards';
    await page.locator(`${tableRows(cardTable)}[data-row-id="sort-order-0"]`).waitFor();
    const firstPage = await readIds(cardTable);
    assert.deepEqual(firstPage.slice(0, 2), ['sort-order-0', 'sort-order-1']);
    assert.equal(firstPage.length, 20);
    assert.ok(!firstPage.includes('sort-order-2'), '过期用卡留到有效订阅之后');
    await page.locator('#main [data-pagination="main-list"]').getByRole('button', { name: '下一页' }).click();
    await page.locator('#main [data-pagination="main-list"][data-page="2"]').waitFor();
    assert.deepEqual(await readIds(cardTable), ['sort-order-3', 'sort-order-2', 'sort-order-22']);
    await page.getByRole('tab', { name: '冻结银行卡' }).click();
    await page.locator(`${tableRows('commerce-frozen-cards')}[data-row-id="freeze-newer"]`).waitFor();
    assert.deepEqual(await readIds('commerce-frozen-cards'), ['freeze-newer', 'freeze-older']);

    await page.addScriptTag({ url: origin + '/local-auth.js' });
    await go('settings/accounts');
    await assertPages('local-employee-accounts', 'sort-employee-');
    assert.deepEqual(errors, []);
  });
});

import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin, settle } from './helpers/offline-design.mjs';

const { chromium } = await import(process.env.ID_RECHARGE_QA_PLAYWRIGHT
  ? pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href : 'playwright');
const id = 'apple-browser-1';
const apple = 'apple-wallet-with-a-long-account-name@example.test';
const email = 'subscriber-with-a-long-account-name@example.test';
const expiry = new Date(Date.now() + 86400000 * 30).toISOString().slice(0, 16);
const fixture = {
  inventory: { version: 1, data: { mailboxes: [
    { id, email: apple, type: 'apple', status: '正常', country: '美国', appStoreRegion: 'US' }
  ], accounts: [], batches: [], returnRecords: [], importRecords: [], registrationRecords: [], tableSettings: [], undo: [] } },
  commerce: { version: 1, data: {
    customers: [{ id: 'fixture-customer', name: '合成客户', phone: '0000000' }],
    orders: [{
      id: 'fixture-order', orderNo: 'SYNTHETIC-APPLE-ORDER-123456', customerId: 'fixture-customer', email,
      product: 'Gemini', plan: 'Google AI Pro', businessType: '首次开通', expiry,
      payment: '苹果内购', paidConfirmed: true, paidAmount: '20', paidCurrency: 'USD', appleIdId: id,
      appleStoreRegion: 'US', appleFunding: { region: 'US', expected: '20', bound: true },
      billingChannel: 'app_store', billingCountry: '美国', billingCycle: 'month', loginMethod: 'google',
      entitlementStatus: 'active', version: 1
    }],
    tenants: [], operating: [], rentBatches: [], logs: []
  } },
  settings: { version: 1, data: { mailboxTypes: [], applePaidPrices: { Gemini: { 'Google AI Pro': { US: '20' } } } } },
  appleBalance: { version: 1, data: { wallets: [{ id, balance: '30', version: 3, currency: 'USD' }],
    allocations: [{ orderId: 'fixture-order', appleIdId: id, amount: '20', returned: '0' }], refunds: [],
    movements: [{ id: 'fixture-charge', appleIdId: id, kind: 'order-charge', label: '订单扣款', amount: '-20',
      before: '50', after: '30', orderId: 'fixture-order', orderNo: 'SYNTHETIC-APPLE-ORDER-123456',
      actor: '合成操作员', at: '2026-11-09 12:30', reason: '合成账单核对记录。'.repeat(18), versionAfter: 3 }] } }
};
for (let n = 0; n < 22; n++) {
  fixture.inventory.data.mailboxes.push({
    id: 'unused-fixture-' + n, email: 'unused-' + n + '@example.test', type: 'apple',
    status: '正常', country: '美国', appStoreRegion: 'US'
  });
}
const browser = await chromium.launch({ headless: true });
const withinWidth = locator => locator.evaluate(el => el.scrollWidth <= el.clientWidth + 1);
try {
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const requests = await interceptDesign(context, { localFixtures: fixture,
      actor: { id: 'browser-admin', name: '离线操作员', role: 'admin' }, skipRechargeAssets: true });
    const page = await context.newPage(), errors = [];
    page.on('pageerror', error => errors.push(error.message));
    page.setDefaultTimeout(8000);
    await page.goto(origin + '/#/data-management/apple-ids');
    if (width < 500) await page.locator('#theme-toggle').click();
    const main = page.locator('#main');
    await main.getByText(email, { exact: true }).waitFor();
    await main.getByText('20 USD', { exact: true }).waitFor();
    const table = main.getByRole('table', { name: '苹果 ID 管理' });
    assert.ok(await withinWidth(table));
    assert.ok(await withinWidth(main));
    const boundRow = table.getByRole('row').filter({ hasText: email });
    await boundRow.getByRole('button', { name: '更多操作' }).click();
    await page.getByText('余额变动', { exact: true }).filter({ visible: true }).last().click();
    const drawer = page.locator('#drawer[open]');
    await drawer.getByText('合成操作员', { exact: true }).waitFor();
    assert.ok(await withinWidth(drawer.locator('.drawer-body')));
    for (const text of ['变动前余额', '变动后余额', '登记人', '原因或依据']) {
      assert.ok(await drawer.getByText(text, { exact: true }).filter({ visible: true }).count(), text);
    }
    await drawer.getByRole('button', { name: '关闭', exact: true }).last().click();
    await boundRow.getByRole('button', { name: '更多操作' }).click();
    await page.locator('[data-action="apple-topup"]').click();
    await drawer.locator('#apple-reason').waitFor();
    await drawer.getByRole('button', { name: '取消', exact: true }).click();
    await boundRow.getByRole('button', { name: '更多操作' }).click();
    await page.getByText('续费', { exact: true }).filter({ visible: true }).last().click();
    await settle(page);
    assert.equal(await page.locator('#commerce-appleIdId').inputValue(), id);
    assert.equal(await page.locator('#commerce-appleStoreRegion').inputValue(), 'US');
    await page.reload();
    await page.waitForFunction(id => document.querySelector('#commerce-appleIdId')?.value === id, id);
    await page.evaluate(() => location.hash = '#/data-management/apple-ids');
    await table.waitFor();
    await main.getByRole('button', { name: '下一页', exact: true }).click();
    assert.equal(await main.locator('[data-pagination="apple-management"]').getAttribute('data-page'), '2');
    assert.ok(await withinWidth(main));
    const search = main.getByRole('textbox', { name: '搜索苹果 ID 使用记录' });
    await search.fill('匹配不到的合成关键词');
    await main.getByText('暂无符合条件的记录', { exact: true }).waitFor();
    assert.ok(await withinWidth(main));
    await page.evaluate(() => location.hash = '#/accounts/apple-balances');
    await main.locator('[data-action="apple-add"]').click();
    await drawer.locator('#inventory-appStoreRegion').waitFor();
    assert.equal(await drawer.locator('#inventory-appleOpeningBalance').inputValue(), '0.00');
    await drawer.getByRole('button', { name: '取消', exact: true }).click();
    await page.evaluate(() => location.hash = '#/settings/payment-countries');
    await main.getByRole('tab', { name: '苹果内购代付价' }).click();
    await main.locator('#commerce-paid-product').selectOption('Gemini');
    assert.equal(await main.locator('#commerce-paid-price-1').inputValue(), '20');
    assert.deepEqual(errors, []);
    assert.deepEqual(requests.external, []);
    await context.close();
    console.log(`苹果 ID 离线验收通过（${width}px）`);
  }
} finally {
  await browser.close();
}

import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { checkAppleLedger } from '../server/local-business-integrity.mjs';
import { interceptDesign, origin, settle, toggleDesignTheme } from './helpers/offline-design.mjs';

const id = 'synthetic-us-apple';
const fixtures = (balance = '250') => ({
  inventory: { version: 1, data: { mailboxes: [{ id, type: 'apple', email: 'synthetic-wallet@example.test',
    country: '马来西亚', appStoreRegion: 'US', status: '正常', health: 'normal', source: '自己注册' }],
    accounts: [], batches: [], returnRecords: [], importRecords: [], registrationRecords: [], tableSettings: [], undo: [] } },
  commerce: { version: 1, data: { customers: [], orders: [], tenants: [], operating: [], rentBatches: [], logs: [] } },
  settings: { version: 1, data: { applePaidPrices: { 'Claude Max': { 'Max 20x': { US: '250' } } } } },
  appleBalance: { version: 1, data: { wallets: [{ id, balance, currency: 'USD', version: 2 }],
    allocations: [], refunds: [], movements: [{ id: 'synthetic-opening', appleIdId: id, kind: 'opening',
      amount: balance, before: '0', after: balance, versionAfter: 2, reason: '合成期初余额' }] } }
});

async function session(browser, width = 1440, balance = '250') {
  const data = fixtures(balance), writes = [], errors = [];
  const context = await browser.newContext({ viewport: { width, height: 960 }, serviceWorkers: 'block' });
  const requests = await interceptDesign(context, { localFixtures: data, skipRechargeAssets: true,
    actor: { id: 'synthetic-admin', name: '合成管理员', role: 'admin' } });
  await context.route(origin + '/api/local/appleBalance', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: data.appleBalance });
    const command = route.request().postDataJSON();
    assert.equal(command.action, 'apple_topup');
    assert.equal(checkAppleLedger(data.appleBalance.data, command.data, data.inventory.data, data.commerce.data), undefined);
    writes.push(command);
    data.appleBalance = { version: data.appleBalance.version + 1, data: command.data };
    return route.fulfill({ json: data.appleBalance });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(6500);
  page.on('pageerror', error => errors.push(error.message));
  return { context, page, data, writes, errors, requests };
}
async function openOrder(page) {
  await page.goto(origin + '/#/workspace/order/claude');
  await page.locator('#commerce-plan').selectOption('Max 20x');
  await page.locator('#commerce-businessType').selectOption('成品交付');
  await page.locator('#commerce-payment').selectOption('苹果内购');
  await page.locator('#commerce-appleStoreRegion').selectOption('US');
}

test('苹果 ID 的候选、到账依据和地区区分覆盖桌面手机及深浅主题', { timeout: 120_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const width of [1440, 390]) for (const theme of ['light', 'dark']) await t.test(`${width}px ${theme}`, async () => {
    const { context, page, data, writes, errors, requests } = await session(browser, width);
    try {
      await page.goto(origin + '/#/accounts/apple-balances');
      if (theme === 'dark') await toggleDesignTheme(page);
      const table = page.getByRole('table', { name: '苹果ID余额', exact: true });
      await table.getByRole('columnheader', { name: '注册地区', exact: true, includeHidden: true }).waitFor({ state: 'attached' });
      await table.locator('[data-action="apple-edit"]').click();
      const drawer = page.locator('#drawer[open]');
      assert.equal(await drawer.locator('#inventory-country-edit').inputValue(), '马来西亚');
      assert.equal(await drawer.locator('#inventory-appStoreRegion').inputValue(), 'US');
      assert.match(await drawer.locator('label[for="inventory-country-edit"]').innerText(), /注册地区/);
      assert.equal(await drawer.locator('.title-help[open]').count(), 0);
      await drawer.getByRole('button', { name: '取消', exact: true }).click();
      await table.locator('[data-action="apple-more"]').click();
      await page.locator('[data-action="apple-topup"]').click();
      assert.equal(await drawer.locator('label[for="apple-reason"]').innerText(), '到账依据');
      await drawer.locator('#apple-amount').fill('250');
      assert.equal(await drawer.locator('#apple-reason').inputValue(), '');
      await drawer.getByRole('button', { name: '保存余额变动', exact: true }).click();
      assert.equal(await page.locator('#confirm-dialog[open]').count(), 0);
      await page.waitForFunction(() => document.querySelector('#drawer')?.textContent.includes('500.00'));
      assert.equal(writes.length, 1);
      assert.equal(writes[0].data.movements.at(-1).reason, '');
      assert.equal(data.appleBalance.data.wallets[0].balance, '500.0000');
      await page.keyboard.press('Escape');

      // A fresh isolated read starts with exactly $250 and no saved customer.
      const orderSession = await session(browser, width);
      try {
        await openOrder(orderSession.page);
        if (theme === 'dark') await toggleDesignTheme(orderSession.page);
        const orderPage = orderSession.page;
        await orderPage.waitForFunction(id => [...document.querySelector('#commerce-appleIdId').options].some(option => option.value === id), id);
        assert.equal(await orderPage.locator('#commerce-customerId').inputValue(), '');
        await orderPage.locator('#commerce-appleIdId-picker').click();
        await orderPage.locator('#commerce-appleIdId-options').getByRole('option', { name: /synthetic-wallet@example\.test/ }).click();
        assert.equal(await orderPage.locator('#commerce-appleIdId').inputValue(), id);
        assert.match(await orderPage.locator('[data-apple-match-notice]').innerText(), /参考代付 250 USD/);
        assert.deepEqual(orderSession.writes, []);
        assert.deepEqual(orderSession.errors, []);
        assert.deepEqual(orderSession.requests.external, []);
        assert.deepEqual(orderSession.requests.unavailable, []);
        if (process.env.ID_LAYOUT_QA_OUTPUT) {
          await mkdir(process.env.ID_LAYOUT_QA_OUTPUT, { recursive: true });
          await settle(orderPage);
          await orderPage.locator('#commerce-appleIdId-picker').scrollIntoViewIfNeeded();
          await orderPage.screenshot({ path: join(process.env.ID_LAYOUT_QA_OUTPUT, `apple-250-${width}-${theme}.png`) });
        }
      } finally { await orderSession.context.close(); }
      assert.deepEqual(errors, []);
      assert.deepEqual(requests.external, []);
      assert.deepEqual(requests.unavailable, []);
    } finally { await context.close(); }
  });
  await t.test('余额不够时显示具体原因', async () => {
    const { context, page } = await session(browser, 1440, '249');
    try {
      await openOrder(page);
      await page.getByText('苹果 ID 余额不足', { exact: true }).waitFor();
      assert.equal(await page.locator('#commerce-appleIdId option').count(), 1);
    } finally { await context.close(); }
  });
});

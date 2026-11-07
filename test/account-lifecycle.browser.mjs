import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';
import { interceptDesign, origin, root, settle } from './helpers/offline-design.mjs';
import { lifecycleFixture } from './helpers/account-lifecycle-fixture.mjs';
import { accountLifecycleSummaries, changeAccountLifecycle, applyAccountOrderLifecycle } from '../server/account-lifecycle.mjs';
import { checkStockDeliveries } from '../server/local-business-integrity.mjs';

const actor = { id: 'admin', name: '隔离管理员', role: 'admin' };
const now = new Date('2026-11-07T08:00:00Z');

test('GPT／Claude 回库、历史资料、再交付、续费归属与停止复用完整流程', { timeout: 90_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const base = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  const output = root + '/.runtime/account-lifecycle-20261107';
  await mkdir(output, { recursive: true });
  for (const type of ['gpt', 'claude']) for (const width of [1440, 390]) for (const theme of ['light', 'dark']) {
    await t.test(`${type} ${width}px ${theme}`, async () => {
      const f = lifecycleFixture(type);
      f.inventory = { ...structuredClone(base.inventory.data), ...f.inventory };
      f.commerce.orders[0] = { ...base.commerce.data.orders.find(row => row.product === 'GPT'), ...f.commerce.orders[0] };
      const original = structuredClone(f.commerce.orders[0]);
      let inventoryVersion = 1, commerceVersion = 1, heldResponse;
      const snapshot = () => ({ version: inventoryVersion, commerceVersion, data: f.inventory,
        usageReview: [], accountSummaries: accountLifecycleSummaries(f.inventory, f.commerce, now.getTime()) });
      const context = await browser.newContext({ viewport: { width, height: 1000 } });
      await interceptDesign(context, { localFixtures: base, actor });
      await context.route(origin + '/api/local/inventory', route => route.fulfill({ json: snapshot() }));
      await context.route(origin + '/api/local/commerce', route => {
        assert.equal(route.request().method(), 'GET', '此专项不创建真实付款订单');
        return route.fulfill({ json: { version: commerceVersion, data: f.commerce } });
      });
      await context.route(origin + '/api/local/inventory/account-lifecycle', async route => {
        try {
          const body = route.request().postDataJSON();
          if (body.version !== inventoryVersion || body.commerceVersion !== commerceVersion)
            return route.fulfill({ status: 409, json: { error: '库存或客户订单已变化，请重新打开核对' } });
          const { changed } = changeAccountLifecycle(f.inventory, f.commerce, body.data, actor, now);
          if (changed) inventoryVersion++;
          if (heldResponse) await heldResponse.promise;
          return route.fulfill({ json: snapshot() });
        } catch (error) { return route.fulfill({ status: error.status || 500, json: { error: error.message } }); }
      });
      const page = await context.newPage();
      page.setDefaultTimeout(6000);
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      const go = async route => {
        await page.goto(origin + '/#/' + route);
        await page.locator(`#main[data-layout-route="${route}"]`).waitFor();
      };
      const drawer = page.locator('#drawer[open]');
      const chooseCustomer = async id => {
        await page.locator('#commerce-customerId-picker').click();
        await page.locator(`#commerce-customerId-options [data-value="${id}"]`).click();
      };
      const more = () => page.locator('[data-action="inventory-more"][data-id="account-a"]').click();
      const checks = async () => {
        for (const name of ['controlled', 'access', 'tasks']) await page.locator(`#inventory-lifecycle-${name}`).check();
      };
      const submit = async title => {
        await page.locator('[form="inventory-account-lifecycle-form"][type="submit"]').click();
        await page.locator('#confirm-dialog[open]').getByRole('button', { name: '确认继续', exact: true }).or(
          page.locator('#confirm-dialog[open] [data-action="confirm-accept"]')).first().click();
      };
      await go(`accounts/${type}`);
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      await page.getByRole('tab', { name: /已使用/ }).click();
      await more();
      await page.locator('.row-action-menu:popover-open').getByRole('menuitem', { name: '恢复可用库存', exact: true }).click();
      const reason = page.locator('#inventory-lifecycle-reason');
      await reason.fill('客户已结束使用，回收后再次分配');
      await drawer.getByRole('button', { name: '关闭抽屉', exact: true }).click();
      await more();
      await page.locator('.row-action-menu:popover-open').getByRole('menuitem', { name: '恢复可用库存', exact: true }).click();
      assert.equal(await reason.inputValue(), '客户已结束使用，回收后再次分配', '关闭重开保留输入');
      await checks();
      commerceVersion++;
      await submit();
      await page.locator('#inventory-lifecycle-error').getByRole('button', { name: '重新核对' }).waitFor();
      assert.equal(f.inventory.accounts[0].inventoryState, 'used', '版本冲突不回库');
      assert.equal(await reason.inputValue(), '客户已结束使用，回收后再次分配');
      await page.getByRole('button', { name: '重新核对', exact: true }).click();
      await page.waitForFunction(() => document.querySelector('[name="inventory-lifecycle-commerce-version"]')?.value === '2' &&
        !document.querySelector('#inventory-lifecycle-controlled')?.checked);
      assert.equal(await page.locator('#inventory-lifecycle-controlled').isChecked(), false);
      await checks();
      await submit();
      await page.locator('#drawer').waitFor({ state: 'hidden' });
      await page.getByRole('tab', { name: /可用库存/ }).click();
      await page.getByRole('row').filter({ hasText: 'owned@example.test' }).waitFor();
      assert.deepEqual(f.commerce.orders[0], original, '回库不修改原订单及财务');
      await page.locator('[data-action="inventory-detail"][data-id="account-a"]').filter({ hasText: '详情' }).click();
      assert.equal(await drawer.getByRole('heading', { name: '账号使用与回收', exact: true }).count(), 1);
      await drawer.getByText('已回收可用', { exact: true }).first().waitFor();
      await drawer.getByRole('heading', { name: '历史订单、付款与认证资料', exact: true }).waitFor();
      if (type === 'claude') {
        await drawer.getByText('待重新核实', { exact: true }).waitFor();
        assert.match(await drawer.innerText(), /历史认证人/);
        assert.match(await drawer.innerText(), /000000/);
      }
      await settle(page);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      await page.screenshot({ path: `${output}/${type}-history-${width}-${theme}.png` });
      await drawer.getByRole('heading', { name: '历史订单、付款与认证资料', exact: true }).scrollIntoViewIfNeeded();
      assert.equal(await drawer.locator('.account-lifecycle-history td').evaluateAll(cells =>
        cells.every(cell => getComputedStyle(cell).whiteSpace === 'nowrap')), true, '历史订单每格保持单行');
      await page.screenshot({ path: `${output}/${type}-orders-${width}-${theme}.png` });
      await drawer.getByRole('button', { name: '关闭抽屉', exact: true }).click();
      await go(`workspace/order/${type}`);
      await page.locator('#commerce-customerId option[value="customer-a"]').waitFor({ state: 'attached' });
      await chooseCustomer('customer-a');
      assert.equal(await page.locator('#commerce-email').inputValue(), '', '回收账号不自动推荐为可续费账号');
      await page.locator('#commerce-email').fill('owned@example.test');
      await page.getByRole('button', { name: '核对并保存', exact: true }).click();
      assert.match(await page.locator('#commerce-email-error').innerText(), /回收|重新分配/);
      await page.locator('#commerce-businessType').selectOption('成品交付');
      await page.locator('#commerce-emailHistory-picker').click();
      await page.getByRole('searchbox', { name: '搜索可用账号' }).fill('owned');
      await page.locator('#commerce-emailHistory-options [data-value="owned@example.test"]').click();
      assert.equal(await page.locator('#commerce-accountId').inputValue(), 'account-a', '回收账号可以再次成品交付');

      const priorInventory = structuredClone(f.inventory), previous = structuredClone(f.commerce);
      const assigned = { ...structuredClone(original), id: 'order-b', orderNo: 'QA-2', customerId: 'customer-b',
        start: '2026-11-07T12:00', expiry: '2026-11-08T12:00', createdAt: '2026-11-07T12:00' };
      f.commerce.orders.push(assigned);
      f.inventory.accounts[0].inventoryState = 'used';
      f.inventory.accounts[0].used = true;
      f.inventory.accounts[0].version++;
      f.inventory.accounts[0].usageLinks.push({ kind: 'order-sale', orderId: 'order-b', label: '再次交付', time: '2026-11-07 12:00' });
      assert.equal(checkStockDeliveries(previous, f.commerce, priorInventory, f.inventory, actor), undefined);
      applyAccountOrderLifecycle(previous, f.commerce, f.inventory, actor, now);
      inventoryVersion++; commerceVersion++;
      await page.reload();
      await go(`workspace/order/${type}`);
      await page.locator('#commerce-businessType').selectOption('续费');
      await chooseCustomer('customer-a');
      await page.locator('#commerce-email').fill('owned@example.test');
      await page.getByRole('button', { name: '核对并保存', exact: true }).click();
      assert.match(await page.locator('#commerce-email-error').innerText(), /其他客户/);
      await chooseCustomer('customer-b');
      assert.equal(await page.locator('#commerce-email').inputValue(), 'owned@example.test', '当前客户可沿用原账号续费');
      await go(`accounts/${type}`);
      await page.getByRole('tab', { name: /已使用/ }).click();
      await more();
      await page.locator('.row-action-menu:popover-open').getByRole('menuitem', { name: '停止复用', exact: true }).click();
      await reason.fill('本次结束后不再交付');
      await checks();
      await page.locator('#inventory-lifecycle-early').check();
      let releaseResponse;
      heldResponse = { promise: new Promise(resolve => { releaseResponse = resolve; }) };
      await submit();
      await page.waitForFunction(() => document.querySelector('[form="inventory-account-lifecycle-form"][type="submit"]')?.disabled);
      await reason.fill('提交之后的新输入应保留');
      releaseResponse();
      await page.getByText('账号使用处理已保存，原历史资料保留', { exact: true }).waitFor();
      assert.equal(await reason.inputValue(), '提交之后的新输入应保留', '迟到的成功响应不清除后续输入');
      await drawer.getByRole('button', { name: '关闭抽屉', exact: true }).click();
      await go(`accounts/${type}`);
      await page.getByRole('tab', { name: /已使用/ }).click();
      await page.getByRole('row').filter({ hasText: '不再复用' }).waitFor();
      assert.equal(f.inventory.accounts[0].inventoryState, 'used');
      assert.equal(f.commerce.orders.length, 2);
      assert.deepEqual(f.commerce.orders[0], original);
      assert.deepEqual(errors, []);
      await context.close();
    });
  }
});

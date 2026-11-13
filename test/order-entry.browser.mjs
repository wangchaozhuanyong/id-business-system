import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { applyOrderCompletion, readOrderCompletion } from '../server/order-completion.mjs';
import { interceptDesign, origin, toggleDesignTheme } from './helpers/offline-design.mjs';

test('自动订单证据缺失时可以补资料并保留原始证据', { timeout: 15_000 }, async (t) => {
  const playwright = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
  const { chromium } = await import(playwright ? pathToFileURL(playwright).href : 'playwright');
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  const prior = {
    ...fixture.commerce.data.orders.find((row) => row.product === 'GPT'),
    id: 'test-auto-incomplete', orderNo: 'OD-LOCAL-9999', taskId: 'test-provider-session',
    source: '线上代充', product: 'GPT', plan: 'Plus', businessType: '续费', accountSource: '客户自有',
    email: 'fixture@example.test', accountId: '', payment: '银行卡', paymentId: '', cardId: '',
    paidAmount: '', paidCurrency: '', start: '', expiry: '', paidConfirmed: false,
    customerId: '', saleAmount: '100', saleCurrency: 'CNY', notes: '', receiptConfirmed: false, entitlementStatus: 'active',
    costBasis: 'standard', issueFeeSnapshot: { cardId: '', applied: false, pending: true },
    createdBy: '自动充值', createdById: 'employee-test', version: 1, refunds: [], bankReturns: [], corrections: []
  };
  fixture.commerce.data.orders.unshift(prior);
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await interceptDesign(context, { localFixtures: fixture });
  const writes = [];
  await context.route('**/api/local/commerce', async (route) => {
    if (route.request().method() === 'GET') return route.fallback();
    const request = route.request().postDataJSON();
    writes.push(request);
    return route.fulfill({ json: { version: request.version + 1, data: request.data } });
  });

  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(`${origin}/#/orders/detail/${prior.id}`);
  await page.getByRole('button', { name: '编辑资料', exact: true }).click();
  const form = page.locator('#drawer[open] #commerce-order-form');
  assert.equal(await form.locator('#commerce-paidCurrency').inputValue(), '');
  assert.equal(await form.locator('#commerce-start').inputValue(), '');
  assert.equal(await form.locator('#commerce-includeIssueFee').count(), 0);
  assert.equal(await form.locator('#commerce-email').getAttribute('readonly'), '');
  await form.locator('#commerce-notes').fill('合成业务补充');
  await form.locator('#commerce-correctionReason').fill('补充业务备注');
  assert.equal(await form.locator('#commerce-saleAmount').inputValue(), '', '定价参考不会预填为实际收款');
  await page.locator('#drawer[open] button[form="commerce-order-form"][type="submit"]').click();
  const response = page.waitForResponse((entry) => entry.request().method() === 'PUT' &&
    new URL(entry.url()).pathname === '/api/local/commerce');
  await page.locator('#confirm-dialog [data-action="confirm-accept"]').click();
  await response;
  assert.equal(writes.length, 1);
  const saved = writes[0].data.orders.find((row) => row.id === prior.id);
  for (const field of ['source', 'taskId', 'createdBy', 'createdById', 'paidAmount', 'paidCurrency', 'start', 'expiry', 'paymentId'])
    assert.equal(saved[field], prior[field], field);
  assert.equal(saved.notes, '合成业务补充');
  assert.equal(saved.paidConfirmed || saved.receiptConfirmed, false);
  assert.equal(saved.saleAmount, prior.saleAmount);
  assert.equal(saved.entitlementStatus, 'active');
  assert.deepEqual(saved.issueFeeSnapshot, prior.issueFeeSnapshot);

  await page.locator('#drawer[open]').waitFor({ state: 'hidden' });
  await page.getByRole('button', { name: '编辑资料', exact: true }).click();
  await form.locator('#commerce-saleAmount').fill('120');
  await page.locator('#drawer[open] button[form="commerce-order-form"][type="submit"]').click();
  await page.locator('#confirm-dialog[open]').getByText(/客户实收 120\.00 .*代付以任务回执为准/).waitFor();
  const receipt = page.waitForResponse(entry => entry.request().method() === 'PUT' &&
    new URL(entry.url()).pathname === '/api/local/commerce');
  await page.locator('#confirm-dialog [data-action="confirm-accept"]').click();
  await receipt;
  const confirmed = writes.at(-1).data.orders.find(row => row.id === prior.id);
  assert.equal(confirmed.paidConfirmed, false);
  assert.equal(confirmed.receiptConfirmed, true);
  assert.deepEqual(confirmed.financialEvidence.map(entry => entry.kind), ['receipt']);
  assert.deepEqual(errors, []);
});

test('员工审批边界及 GPT 代充原单、来源颜色和跨页关联', { timeout: 40_000 }, async (t) => {
  const playwright = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
  const { chromium } = await import(playwright ? pathToFileURL(playwright).href : 'playwright');
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const requests = [];
  const code = 'SYNTHETIC-RECHARGE-ONLY';
  const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  const customer = { id: 'sync-customer', name: '合成代充客户', active: true, version: 1 };
  const staff = { id: 'employee', name: '当前员工昵称', role: 'employee' };
  const now = Date.now(), hour = 3_600_000;
  const start = new Date(now - hour).toISOString();
  const synced = {
    ...fixture.commerce.data.orders.find(row => row.product === 'GPT'),
    id: 'synced-order', orderNo: 'OD-LOCAL-9201', taskId: 'fixture-task', source: '线上代充',
    email: 'synced-customer@example.test', customerId: '', product: 'GPT', plan: 'Plus', businessType: '续费',
    accountSource: '客户自有', accountId: '', start, expiry: new Date(now + 24 * hour).toISOString(),
    rechargeCompletedAt: start, cardId: '', paymentId: '', paidAmount: '', paidCurrency: '',
    ownerId: '', rechargeOwnerId: staff.id, createdById: staff.id,
    paidConfirmed: false, receiptConfirmed: false, costConfirmed: false, saleAmount: '120', saleCurrency: 'CNY',
    cancelled: false, subscriptionEnded: false, refunds: [], bankReturns: [], corrections: [], financialEvidence: [], version: 1
  };
  for (const [role, width] of [['employee', 390], ['super', 1440]]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const actor = { id: role, name: '离线测试', email: 'fixture@example.test', role };
    const localFixtures = structuredClone(fixture);
    localFixtures.commerce.data.customers.push(customer);
    const manual = localFixtures.commerce.data.orders.find(row => row.product === 'GPT' && !row.cancelled);
    manual.source = '管理员手工';
    localFixtures.commerce.data.orders.unshift(structuredClone(synced));
    await interceptDesign(context, { localFixtures, actor });
    let syncReads = 0;
    const corrections = [];
    await context.route((url) => url.pathname === '/api/local/order-completion', async route => {
      const request = route.request();
      const ledger = localFixtures.commerce;
      const settings = localFixtures.settings?.data;
      if (request.method() === 'GET') return route.fulfill({
        json: readOrderCompletion(ledger.data, settings, actor, new URL(request.url()).searchParams, () => [staff, actor])
      });
      const command = request.postDataJSON();
      const { order, completion } = applyOrderCompletion(ledger.data, settings, actor, command, () => [staff, actor], start);
      assert.equal(order.id, synced.id);
      assert.equal(order.customerId, customer.id);
      assert.equal(order.paidConfirmed, false);
      corrections.push(order);
      ledger.data.orders = ledger.data.orders.map(row => row.id === order.id ? order : row);
      return route.fulfill({ json: { orderId: order.id, version: ++ledger.version, state: completion.state } });
    });
    await context.route('**/api/local/auth/display-names', (route) =>
      route.fulfill({ json: { items: [{ id: 'employee', name: '当前员工昵称' }] } }));
    await context.route((url) => url.pathname === '/api/local/recharge-codes', (route) => {
      const canApprove = role === 'super';
      if (route.request().method() === 'POST') {
        const command = route.request().postDataJSON();
        if (command.action === 'request') {
          assert.equal(command.plan, 'plus');
          assert.equal(command.count, 2);
          assert.ok(command.requestKey);
          requests.unshift({ id: 'request-a', status: 'pending', plan: 'plus', count: 2, applicantId: 'employee' });
        } else {
          assert.equal(command.action, 'approve');
          assert.equal(canApprove, true);
          requests[0].status = 'issued';
        }
        return route.fulfill({ json: { request: requests[0] } });
      }
      const showCodes = new URL(route.request().url()).searchParams.get('view') === 'codes';
      return route.fulfill({ json: showCodes ? { canApprove, items: [{
        id: 'fixture-code-item', requestId: 'request-a', ...(!canApprove && { code }), last4: 'ONLY', status: 'unused', plan: 'plus', applicantId: 'employee'
      }] } : { canApprove, requests, stock: { plus: requests[0]?.status === 'issued' ? 0 : 2, pro100: 0, pro200: 1, pro500: 0 } } });
    });
    await context.route('**/api/local/order-sync', (route) => {
      syncReads++;
      return route.fulfill({ status: 500, json: { error: '前端无须访问同步表' } });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.setDefaultTimeout(4500);
    await page.goto(origin + '/#/workspace/recharge-codes');
    const remaining = page.locator('#recharge-request-stock');
    const submit = page.getByRole('button', { name: '提交申请', exact: true });
    await remaining.getByText(/剩余可提取 2 个/).waitFor();
    if (role === 'employee') {
      await page.locator('#recharge-request-plan').selectOption('pro100');
      assert.match(await remaining.textContent(), /剩余可提取 0 个/);
      assert.equal(await submit.isDisabled(), true);
      await page.locator('#recharge-request-plan').selectOption('plus');
      await page.locator('#recharge-request-count').fill('3');
      assert.equal(await submit.isDisabled(), true);
      await page.locator('#recharge-request-count').fill('2');
      await submit.click();
      await page.locator('#recharge-request-history').getByText('待审核', { exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: '批准', exact: true }).count(), 0);
    } else {
      await page.getByRole('button', { name: '批准', exact: true }).click();
      await page.locator('#drawer[open]').getByRole('button', { name: '批准并发码' }).click();
      await page.locator('#recharge-request-history').getByText('已发码', { exact: true }).waitFor();
      assert.match(await remaining.textContent(), /剩余可提取 0 个/);
      assert.equal(await submit.isDisabled(), true);
    }
    await page.goto(origin + '/#/workspace/my-recharge-codes');
    await page.locator('#recharge-codes-region [data-action="order-code-item-detail"]').click();
    await page.locator('#drawer').getByText('当前员工昵称', { exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭抽屉', exact: true }).click();
    assert.equal(await page.locator('#recharge-codes-region .recharge-code-text').getByText(code, { exact: true }).count(), role === 'employee' ? 1 : 0);
    await page.goto(origin + '/#/orders/gpt');
    const main = page.locator('#main');
    await page.getByRole('heading', { name: 'GPT 订单', exact: true }).waitFor();
    const search = page.locator('#commerce-search');
    const legend = main.locator('.gpt-order-origin-bar');
    await legend.getByText('线上代充', { exact: true }).waitFor();
    await legend.getByText('手工录单', { exact: true }).waitFor();
    assert.equal(await main.getByText('代充订单同步', { exact: true }).count(), 0);
    const automaticRow = main.locator(`tr[data-row-id="${synced.id}"]`);
    const manualRow = main.locator(`tr[data-row-id="${manual.id}"]`);
    assert.equal(await automaticRow.count(), 0);
    if (role === 'super') {
      const spacing = await legend.evaluate(node => {
        const box = node.getBoundingClientRect();
        const labels = [...node.querySelectorAll('[data-order-source]')].map(label => label.getBoundingClientRect());
        return { top: Math.min(...labels.map(label => label.top)) - box.top,
          bottom: box.bottom - Math.max(...labels.map(label => label.bottom)) };
      });
      assert(spacing.top >= 8 && spacing.bottom >= 8);
      await page.goto(origin + '/#/orders/gpt/recharge-sync');
      await page.waitForURL('**/#/orders/gpt');
      await automaticRow.locator('.gpt-order-origin-label').filter({ hasText: '线上代充' }).waitFor();
      assert.match(await main.locator('[data-action="commerce-order-tab"][data-tab="pending"]').getAttribute('class'), /active/);
      await automaticRow.getByRole('button', { name: '补全资料', exact: true }).click();
      await page.waitForURL('**/#/workspace/order-completion');
      const drawer = page.locator('#drawer[open]');
      await drawer.getByText(synced.orderNo, { exact: true }).waitFor();
      await drawer.locator('#completion-customer-query').fill(customer.name);
      await drawer.getByRole('button', { name: '选择客户 ' + customer.name, exact: true }).click();
      await drawer.locator('#completion-receipt-amount').fill('119.50');
      await drawer.getByRole('button', { name: '保存订单', exact: true }).click();
      await main.locator('.completion-saved').getByRole('button', { name: '查看此订单' }).click();
      await page.waitForURL('**/#/orders/detail/' + synced.id);
      await main.getByText(customer.name, { exact: true }).waitFor();
      assert.equal(corrections.length, 1);
      assert.equal(corrections[0].saleAmount, '119.50');
      assert.equal(localFixtures.commerce.data.orders.filter(row => row.taskId === synced.taskId).length, 1);

      await page.goto(origin + '/#/orders/gpt');
      await main.locator('[data-action="commerce-order-tab"][data-tab="all"]').click();
      await manualRow.locator('.gpt-order-origin-label').filter({ hasText: '手工录单' }).waitFor();
      await automaticRow.locator('.gpt-order-origin-label').filter({ hasText: '线上代充' }).waitFor();
      const background = (row, width) => (width > 760 ? row.locator('td[data-column="orderNo"]') : row)
        .evaluate(node => getComputedStyle(node).backgroundColor);
      assert.notEqual(await background(automaticRow, width), await background(manualRow, width));
      await toggleDesignTheme(page);
      assert.notEqual(await background(automaticRow, width), await background(manualRow, width));
      await page.setViewportSize({ width: 320, height: 900 });
      assert.notEqual(await background(automaticRow, 320), await background(manualRow, 320));
      assert.equal(await legend.evaluate(node => node.scrollWidth <= node.clientWidth + 1), true);
      await page.setViewportSize({ width, height: 900 });

      await page.goto(origin + '/#/customers/list');
      await search.fill(customer.name);
      await page.locator(`[data-action="commerce-contact-services"][data-id="${customer.id}"]`).click();
      await page.locator('#drawer table[data-table="commerce-contact-services"]').getByText(synced.orderNo).waitFor();
      await page.goto(origin + '/#/workspace/order/gpt');
      await page.locator('#commerce-customerId-picker').click();
      await page.locator('#commerce-customerId-popover input').fill(customer.name);
      await page.locator(`#commerce-customerId-options [data-value="${customer.id}"]`).click();
      assert.equal(await page.locator('#commerce-email').inputValue(), synced.email);
      await page.goto(origin + '/#/workspace/renewals/reminders');
      await search.fill(synced.email);
      await main.locator(`[data-action="commerce-renewal-select"][data-id="${synced.id}"]`).click();
      await main.getByRole('region', { name: '当前选中客户' }).getByText(synced.email, { exact: true }).waitFor();
    } else {
      await page.goto(origin + '/#/orders/recharge-sync');
      await page.waitForURL('**/#/orders/gpt');
      await automaticRow.locator('.gpt-order-origin-label').filter({ hasText: '线上代充' }).waitFor();
      assert.equal(await main.locator('[data-action="commerce-order-complete"]').count(), 1);
      assert.equal(await main.locator('[data-action="commerce-order-edit"]').count(), 0);
    }
    assert.equal(syncReads, 0);
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await context.close();
  }
});

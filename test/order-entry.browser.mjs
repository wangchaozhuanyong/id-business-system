import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

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
    customerId: '', saleAmount: '', saleCurrency: 'CNY', notes: '', receiptConfirmed: false,
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
  await page.goto(`${origin}/#/orders/gpt`);
  await page.locator(`[data-action="commerce-order-edit"][data-id="${prior.id}"]`).click();
  const form = page.locator('#drawer[open] #commerce-order-form');
  assert.equal(await form.locator('#commerce-paidCurrency').inputValue(), '');
  assert.equal(await form.locator('#commerce-start').inputValue(), '');
  assert.equal(await form.locator('#commerce-includeIssueFee').count(), 0);
  assert.equal(await form.locator('#commerce-email').getAttribute('readonly'), '');
  await form.locator('#commerce-notes').fill('合成业务补充');
  await form.locator('#commerce-correctionReason').fill('补充业务备注');
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
  assert.deepEqual(saved.issueFeeSnapshot, prior.issueFeeSnapshot);
  assert.deepEqual(errors, []);
});

test('员工审批边界及 GPT 同步入单后共用客户、录单和续费资料', { timeout: 40_000 }, async (t) => {
  const playwright = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
  const { chromium } = await import(playwright ? pathToFileURL(playwright).href : 'playwright');
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const requests = [];
  const syncCommands = [];
  const code = 'SYNTHETIC-RECHARGE-ONLY';
  const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  const customer = { id: 'sync-customer', name: '合成代充客户', active: true, version: 1 };
  const now = Date.now(), hour = 3_600_000;
  const start = new Date(now - hour).toISOString();
  const synced = {
    ...fixture.commerce.data.orders.find(row => row.product === 'GPT'),
    id: 'synced-order', orderNo: 'OD-LOCAL-9201', taskId: 'fixture-task', source: '线上代充',
    email: 'synced-customer@example.test', customerId: '', product: 'GPT', plan: 'Plus', businessType: '续费',
    accountSource: '客户自有', accountId: '', start, expiry: new Date(now + 24 * hour).toISOString(),
    rechargeCompletedAt: start, cardId: '', paymentId: '', paidAmount: '', paidCurrency: '',
    paidConfirmed: false, receiptConfirmed: false, costConfirmed: false, saleAmount: '120', saleCurrency: 'CNY',
    cancelled: false, subscriptionEnded: false, refunds: [], bankReturns: [], corrections: [], financialEvidence: [], version: 1
  };
  for (const [role, width] of [['employee', 390], ['super', 1440]]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const actor = { id: role, name: '离线测试', email: 'fixture@example.test', role };
    const localFixtures = structuredClone(fixture);
    localFixtures.commerce.data.customers.push(customer);
    await interceptDesign(context, { localFixtures, actor });
    let failLedgerRead = false, syncReads = 0, savedSyncRow;
    const corrections = [];
    await context.route('**/api/local/commerce', route => {
      if (route.request().method() === 'GET') {
        if (!failLedgerRead) return route.fallback();
        failLedgerRead = false;
        return route.fulfill({ status: 503, json: { error: '合成订单读取失败' } });
      }
      const command = route.request().postDataJSON();
      const rows = command.data.orders.filter(row => row.taskId === synced.taskId);
      assert.equal(command.version, localFixtures.commerce.version);
      assert.equal(rows.length, 1);
      assert.equal(rows[0].id, synced.id);
      assert.equal(rows[0].customerId, customer.id);
      assert.equal(rows[0].paidConfirmed, false);
      corrections.push(rows[0]);
      localFixtures.commerce = { version: command.version + 1, data: command.data };
      return route.fulfill({ json: localFixtures.commerce });
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
      if (route.request().method() !== 'POST')
        return route.fulfill({ json: { rows: savedSyncRow ? [savedSyncRow] : [] } });
      const command = route.request().postDataJSON();
      syncCommands.push(command);
      const row = { jobKey: synced.taskId, orderNo: '', needs: ['实扣金额待核对'] };
      if (command.mode === 'apply') {
        localFixtures.commerce.data.orders.unshift(structuredClone(synced));
        localFixtures.commerce.version++;
        failLedgerRead = true;
        row.orderNo = synced.orderNo;
        savedSyncRow = row;
      }
      return route.fulfill({ json: { rows: [row] } });
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
      await page.locator('#confirm-dialog').getByRole('button', { name: '批准并发码' }).click();
      await page.locator('#recharge-request-history').getByText('已发码', { exact: true }).waitFor();
      assert.match(await remaining.textContent(), /剩余可提取 0 个/);
      assert.equal(await submit.isDisabled(), true);
    }
    await page.goto(origin + '/#/workspace/my-recharge-codes');
    await page.locator('#recharge-codes-region [data-action="order-code-item-detail"]').click();
    await page.locator('#drawer').getByText('当前员工昵称', { exact: true }).waitFor();
    await page.getByRole('button', { name: '关闭抽屉', exact: true }).click();
    assert.equal(await page.getByRole('cell', { name: code, exact: true }).count(), role === 'employee' ? 1 : 0);
    await page.goto(origin + '/#/orders/gpt');
    const workspace = page.getByRole('navigation', { name: 'GPT 订单视图' });
    await page.getByRole('heading', { name: 'GPT 订单', exact: true }).waitFor();
    if (role === 'super') {
      const listTab = workspace.getByRole('link', { name: '订单列表', exact: true });
      const syncTab = workspace.getByRole('link', { name: '代充订单同步', exact: true });
      const search = page.locator('#commerce-search');
      const taskInput = page.getByLabel('指定代充任务编号');
      assert.equal(await listTab.getAttribute('aria-current'), 'page');
      await search.fill(synced.orderNo);
      await syncTab.click();
      assert.equal(await syncTab.getAttribute('aria-current'), 'page');
      assert.equal(await page.locator('#sidebar a[href="#/orders/gpt"]').getAttribute('aria-current'), 'page');
      assert.equal(await page.locator('#sidebar a[href*="recharge-sync"]').count(), 0);
      await taskInput.fill(synced.taskId);
      await listTab.click();
      assert.equal(await search.inputValue(), synced.orderNo);
      await syncTab.click();
      assert.equal(await taskInput.inputValue(), synced.taskId);
      await page.getByRole('button', { name: '预览', exact: true }).click();
      await page.getByRole('cell', { name: synced.taskId, exact: true }).waitFor();
      await listTab.click();
      await syncTab.click();
      await page.getByRole('cell', { name: synced.taskId, exact: true }).waitFor();
      await page.getByRole('button', { name: '同步入单', exact: true }).click();
      await page.locator('#confirm-dialog').getByRole('button', { name: '确认同步' }).click();
      await page.getByRole('button', { name: '重读订单', exact: true }).click();
      await page.getByText('同步批次已处理，业务订单暂未刷新。').waitFor({ state: 'hidden' });
      assert(await page.getByRole('button', { name: '同步入单', exact: true }).isDisabled());
      await page.getByRole('button', { name: synced.orderNo, exact: true }).click();
      await page.getByRole('heading', { name: '订单详情', exact: true }).waitFor();
      const detailUrl = page.url();
      assert.match(await page.locator('#main').innerText(), /客户待补充/);
      await page.getByRole('button', { name: '编辑资料', exact: true }).click();
      const form = page.locator('#drawer[open] #commerce-order-form');
      await form.locator('#commerce-customerId-picker').click();
      await form.locator('#commerce-customerId-popover input').fill(customer.name);
      await form.locator(`#commerce-customerId-options [data-value="${customer.id}"]`).click();
      await form.locator('#commerce-correctionReason').fill('核实代充任务的客户归属');
      await page.locator('#drawer[open] button[form="commerce-order-form"][type="submit"]').click();
      await page.locator('#confirm-dialog').getByRole('button', { name: '确认', exact: false }).click();
      await page.locator('#toast').filter({ hasText: '订单修改成功' }).waitFor();
      assert.equal(page.url(), detailUrl, '编辑后保留订单详情页');
      assert.match(await page.locator('#main').innerText(), new RegExp(customer.name));
      assert.equal(corrections.length, 1);

      await page.goto(origin + '/#/customers/list');
      await search.fill(customer.name);
      await page.locator(`[data-action="commerce-contact-services"][data-id="${customer.id}"]`).click();
      await page.locator('#drawer table[data-table="commerce-contact-services"]').getByText(synced.orderNo).waitFor();
      await page.goto(origin + '/#/workspace/order/gpt');
      await page.locator('#commerce-customerId-picker').click();
      await page.locator('#commerce-customerId-popover input').fill(customer.name);
      await page.locator(`#commerce-customerId-options [data-value="${customer.id}"]`).click();
      assert.equal(await page.locator('#commerce-email').inputValue(), synced.email);
      await page.goto(origin + '/#/workspace/renewals');
      await search.fill(synced.email);
      await page.locator('table[data-table="commerce-renewals"]').getByText(synced.orderNo, { exact: true }).waitFor();
      savedSyncRow = { ...savedSyncRow, needs: [...savedSyncRow.needs, '首次开卡费待核对'] };
      await page.setViewportSize({ width: 320, height: 900 });
      await page.goto(origin + '/#/orders/recharge-sync');
      await syncTab.waitFor();
      const syncedCard = page.locator(`table[data-table="recharge-order-sync"] tr[data-row-id="${synced.taskId}"]`);
      await syncedCard.locator('td[data-column="needs"]').getByText('实扣金额待核对、首次开卡费待核对', { exact: true }).waitFor();
      assert(await page.getByRole('button', { name: synced.orderNo, exact: true }).isVisible());
      assert.equal(new URL(page.url()).hash, '#/orders/gpt/recharge-sync');
    } else {
      assert.equal(await workspace.count(), 0);
      await page.goto(origin + '/#/orders/recharge-sync');
      await page.getByRole('heading', { name: '访问受限', exact: true }).waitFor();
      assert.equal(syncReads, 0);
    }
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await context.close();
  }
  assert.deepEqual(syncCommands, [{ mode: 'preview' }, { mode: 'apply', jobKeys: ['fixture-task'] }]);
});

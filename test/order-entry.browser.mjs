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

test('员工申请、管理员审批和同步确认使用各自的权限及任务范围', { timeout: 20_000 }, async (t) => {
  const playwright = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
  const { chromium } = await import(playwright ? pathToFileURL(playwright).href : 'playwright');
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const requests = [];
  const syncCommands = [];
  const code = 'SYNTHETIC-RECHARGE-ONLY';
  const index = await readFile(new URL('../frontend/index.html', import.meta.url), 'utf8');
  for (const [role, width] of [['employee', 390], ['super', 1440]]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const actor = { id: role, name: '离线测试', email: 'fixture@example.test', role };
    await interceptDesign(context, { localFixtures: {} });
    await context.route((url) => url.origin === origin && url.pathname === '/', (route) => route.fulfill({
      contentType: 'text/html',
      body: index.replace('<head>', `<head><meta name="id-local-auth" content="required"><meta name="id-local-actor" content="${encodeURIComponent(JSON.stringify(actor))}">`)
        .replace('<script src="./prototype.js', '<script src="/local-data.js" defer></script><script src="./prototype.js')
    }));
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
        ...(!canApprove && { code }), last4: 'ONLY', status: 'unused', plan: 'plus', applicantId: 'employee'
      }] } : { canApprove, requests } });
    });
    await context.route('**/api/local/order-sync', (route) => {
      if (route.request().method() !== 'POST') return route.fulfill({ json: { rows: [] } });
      const command = route.request().postDataJSON();
      syncCommands.push(command);
      return route.fulfill({ json: { rows: [{
        jobKey: 'fixture-task', orderNo: command.mode === 'apply' ? 'OD-LOCAL-0001' : '',
        needs: ['实扣金额待核对']
      }] } });
    });
    const page = await context.newPage();
    const errors = [];
    page.on('pageerror', (error) => errors.push(error.message));
    page.setDefaultTimeout(4500);
    await page.goto(origin + '/#/workspace/recharge-codes');
    if (role === 'employee') {
      await page.locator('#recharge-request-count').fill('2');
      await page.getByRole('button', { name: '提交申请', exact: true }).click();
      await page.getByRole('cell', { name: '待审核', exact: true }).waitFor();
      assert.equal(await page.getByRole('button', { name: '批准', exact: true }).count(), 0);
    } else {
      await page.getByRole('button', { name: '批准', exact: true }).click();
      await page.locator('#confirm-dialog').getByRole('button', { name: '批准并发码' }).click();
      await page.getByRole('cell', { name: '已发码', exact: true }).waitFor();
    }
    await page.goto(origin + '/#/workspace/my-recharge-codes');
    await page.getByRole('cell', { name: '当前员工昵称', exact: true }).waitFor();
    assert.equal(await page.getByRole('cell', { name: code, exact: true }).count(), role === 'employee' ? 1 : 0);
    if (role === 'super') {
      await page.goto(origin + '/#/orders/recharge-sync');
      await page.getByRole('button', { name: '预览', exact: true }).click();
      await page.getByRole('cell', { name: 'fixture-task', exact: true }).waitFor();
      await page.getByRole('button', { name: '同步入单', exact: true }).click();
      await page.locator('#confirm-dialog').getByRole('button', { name: '确认同步' }).click();
      await page.getByRole('cell', { name: 'OD-LOCAL-0001', exact: true }).waitFor();
    }
    assert.deepEqual(errors, []);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);
    await context.close();
  }
  assert.deepEqual(syncCommands, [{ mode: 'preview' }, { mode: 'apply', jobKeys: ['fixture-task'] }]);
});

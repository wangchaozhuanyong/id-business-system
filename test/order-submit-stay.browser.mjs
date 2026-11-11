import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { automaticProvider, calculateConfirmedNetReceipt, createAutomaticOrderSnapshot } from '../modules/finance/accounting.mjs';
import { projectSubscriptions } from '../server/subscription-management.mjs';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
const actor = { id: 'submit-stay', name: '离线录单员', role: 'admin' };
const sampleCard = '4242424242424242';
async function setup(browser, slug = 'gpt', width = 1440, seed) {
  const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  fixture.commerce.data.orders = [];
  fixture['auth/order-owners'] = { items: [actor] };
  fixture['auth/display-names'] = { items: [actor] };
  seed?.(fixture);
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const traffic = await interceptDesign(context, { actor, localFixtures: fixture, skipRechargeAssets: true });
  const writes = [], control = { fail: false, hold: null, started: null };
  await context.route('**/api/local/commerce', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: fixture.commerce });
    const body = route.request().postDataJSON();
    writes.push(body); control.started?.resolve();
    if (control.hold) await control.hold.promise;
    if (control.fail) return route.fulfill({ status: 400, json: { error: '模拟提交失败' } });
    fixture.commerce = { version: body.version + 1, data: body.data };
    return route.fulfill({ json: fixture.commerce });
  });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(6000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/#/workspace/order/' + slug);
  await page.locator('#commerce-ownerId option[value="submit-stay"]').waitFor({ state: 'attached' });
  await page.locator('#commerce-customerId').evaluate((select, id) => {
    select.value = id; select.dispatchEvent(new Event('change', { bubbles: true }));
  }, fixture.commerce.data.customers[0].id);
  const submit = async () => {
    const form = page.locator('#main #commerce-order-form');
    const customer = form.locator('#commerce-customerId');
    if (!await customer.inputValue()) await customer.evaluate((select, id) => {
      select.value = id; select.dispatchEvent(new Event('change', { bubbles: true }));
    }, fixture.commerce.data.customers[0].id);
    for (const [id, value] of [['paidAmount', '20'], ['saleAmount', '100']]) {
      const input = form.locator('#commerce-' + id);
      if (!await input.inputValue()) await input.fill(value);
    }
    await page.locator('button[form="commerce-order-form"][type="submit"]').click();
    await page.locator('#confirm-dialog[open] [data-action="confirm-accept"]').click();
  };
  const success = () => page.locator('#toast').filter({ hasText: '订单提交成功' }).waitFor();
  return { context, page, fixture, control, writes, errors, traffic, submit, success };
}

test('五类订单提交后留在录入页，刷新最近记录并可连续录单', { timeout: 60_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const products = [
    ['gpt', 'GPT'], ['claude', 'Claude Pro', 'Pro'], ['claude', 'Claude Max', 'Max 5x'],
    ['gemini', 'Gemini'], ['grok', 'Grok']
  ];
  for (const [slug, product, plan] of products) {
    await t.test(product, async () => {
      const { context, page, fixture, writes, errors, traffic, submit, success } = await setup(browser, slug, product === 'Grok' ? 390 : 1440, fixture => {
        fixture['card-types'] = {
          version: 1,
          items: [{ id: 'qa-default-type', name: 'vccwc999', active: true }, { id: 'qa-wise-type', name: 'wise潘', active: true }],
          assignments: { 'recharge:71': 'qa-wise-type' }
        };
        fixture['order-cards'] = { items: [
          { id: 'recharge:71', last4: '0171', active: true, status: '正常' },
          { id: 'recharge:72', last4: '0172', active: true, status: '正常' }
        ] };
      });
      try {
        if (plan) await page.locator('#commerce-plan').selectOption(plan);
        const materialMode = page.locator('#commerce-proMaterialMode');
        assert.equal(await materialMode.inputValue(), 'manual_card');
        const cardType = page.locator('#commerce-cardTypeId');
        await cardType.locator('option[value="qa-default-type"]').waitFor({ state: 'attached' });
        assert.equal(await cardType.inputValue(), product === 'GPT' ? 'qa-default-type' : '');
        if (product === 'GPT') {
          await materialMode.selectOption('');
          const picker = page.locator('#commerce-cardId-picker');
          await page.locator('#commerce-cardId option[value="recharge:72"]').waitFor({ state: 'attached' });
          for (const [tail, expected] of [['0171', 'qa-wise-type'], ['0172', 'qa-default-type']]) {
            await picker.click();
            await page.locator('#commerce-cardId-options').getByRole('option', { name: new RegExp(tail) }).click();
            assert.equal(await cardType.inputValue(), expected);
          }
        } else await page.locator('#commerce-proCardNumber').fill(sampleCard);
        await page.locator('#commerce-email').fill('stay-' + slug + '@example.test');
        await page.locator('#commerce-notes').fill('本次提交的草稿');
        const now = Date.now(), day = 86_400_000;
        const beijing = at => new Date(at + 28_800_000).toISOString().slice(0, 16);
        await page.locator('#commerce-start').fill(beijing(now - 2 * day));
        await page.locator('#commerce-expiry').fill(beijing(now + day));
        await page.locator('#commerce-saleCurrency').selectOption('CNY');
        await page.locator('#commerce-saleAmount').fill('100');
        assert.equal(await page.locator('[data-action="commerce-order-pending"], #commerce-appleGoogleVerified').count(), 0);
        const url = page.url();
        await submit(); await success();
        assert.equal(page.url(), url, '成功后不能自动跳到管理页面');
        assert.equal(writes.length, 1);
        const saved = writes[0].data.orders[0];
        assert.equal(saved.product, product);
        assert.equal(saved.entitlementStatus, 'active');
        assert.equal(saved.paidConfirmed && saved.receiptConfirmed, true);
        assert.equal(calculateConfirmedNetReceipt(saved), '100.0000');
        const [subscription] = projectSubscriptions({ ...fixture, mailboxes: { data: null } }, now);
        assert.equal(subscription.status, 'active');
        assert.equal(subscription.series[0].confirmed, true);
        const orderStatus = await page.evaluate(id => window.IDDesignAPI.modules.commerce.getOrderStatuses(id).subscription, saved.id);
        assert.equal(orderStatus, '有效');
        assert.equal(await page.evaluate(() => window.IDDesignAPI.modules.commerce.renewalReminderCount()), 1);
        assert.equal(await materialMode.inputValue(), 'manual_card');
        if (product === 'GPT') {
          assert.equal(saved.cardTypeId, 'qa-default-type');
          assert.equal(await cardType.inputValue(), 'qa-default-type');
          await cardType.selectOption('');
        }
        assert.equal(await page.locator('#main #commerce-email').inputValue(), '', '只清理本次已保存草稿');
        assert.equal(await page.locator('#main #commerce-notes').inputValue(), '');
        const recent = page.locator('#commerce-entry-records');
        const mobileRecords = page.getByRole('tab', { name: '最近订单', exact: true });
        if (await mobileRecords.isVisible()) {
          await mobileRecords.click();
          await recent.getByRole('button', { name: '更多资料', exact: true }).click();
        }
        await recent.getByText('本次提交的草稿', { exact: true }).waitFor();
        if (await mobileRecords.isVisible()) await page.getByRole('tab', { name: '填写资料', exact: true }).click();
        await page.locator('#commerce-email').fill('next-' + slug + '@example.test');
        await page.evaluate(() => { location.hash = '#/customers/new'; });
        await page.locator('#commerce-contact-name').waitFor();
        await page.evaluate(slug => { location.hash = '#/workspace/order/' + slug; }, slug);
        assert.equal(await page.locator('#commerce-email').inputValue(), 'next-' + slug + '@example.test', '后续新草稿仍可切页保留');
        if (product === 'GPT') assert.equal(await cardType.inputValue(), '', '手动选未填写后返回草稿仍保留');
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(origin + '/#/customers/list');
        const customer = page.locator(`#main tr[data-row-id="${saved.customerId}"]`);
        const drawer = page.locator('#drawer[open]');
        await customer.locator('[data-action="commerce-contact-orders"]').click();
        await drawer.locator(`[data-action="commerce-order-detail"][data-id="${saved.id}"]`).waitFor();
        await drawer.getByRole('button', { name: '关闭抽屉', exact: true }).click();
        await customer.locator('[data-action="commerce-contact-services"]').click();
        await drawer.locator('[data-column="orderNos"]').getByText(saved.orderNo, { exact: true }).waitFor();
        assert.deepEqual(errors, []); assert.deepEqual(traffic.external, []);
      } finally { await context.close(); }
    });
  }
});

test('续费提交保留当前页，已完成提醒只能主动返回续费管理', { timeout: 20_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const { context, page, writes, errors, traffic } = await setup(browser, 'renew/stay-renewal', 1440, fixture => {
    fixture.commerce.data.orders.push({
      id: 'stay-renewal', orderNo: 'QA-RENEW-STAY', product: 'GPT', plan: 'Plus',
      businessType: '新购', email: 'renewal@example.test', customerId: fixture.commerce.data.customers[0].id,
      ownerId: actor.id, owner: actor.name, start: '2026-09-01T10:00', expiry: '2026-10-01T10:00',
      payment: '银行卡', paidAmount: '20', paidCurrency: 'USD', saleAmount: '100', saleCurrency: 'CNY',
      paidConfirmed: true, receiptConfirmed: true, entitlementStatus: 'active', version: 1, refunds: [], corrections: [], bankReturns: []
    });
  });
  t.after(() => context.close());
  const url = page.url();
  await page.locator('#commerce-order-form').waitFor();
  await page.locator('#commerce-paidAmount').fill('20');
  await page.locator('#commerce-saleAmount').fill('100');
  assert.equal(await page.locator('#main [name="commerce-paidConfirmed"]').count(), 0);
  await page.locator('#main button[form="commerce-order-form"][type="submit"]').click();
  await page.locator('#confirm-dialog[open]').getByText(/请确认充值已成功.*实际代付 20\.00 .*客户实收 100\.00 /).waitFor();
  await page.locator('#confirm-dialog[open] [data-action="confirm-accept"]').click();
  await page.locator('#main').getByText('续费提醒已变化', { exact: true }).waitFor();
  assert.equal(page.url(), url);
  assert.equal(writes.length, 1);
  const renewed = writes[0].data.orders[0];
  assert.equal(renewed.paidConfirmed, true);
  assert.equal(renewed.receiptConfirmed, true);
  assert.equal(renewed.costConfirmed, true);
  assert(writes[0].data.logs.some(row => row.type === '关联续费订单' &&
    row.entityId === 'stay-renewal' && row.relatedOrderId === renewed.id));
  await page.getByRole('button', { name: '返回续费管理', exact: true }).click();
  assert.equal(new URL(page.url()).hash, '#/workspace/renewals');
  assert.deepEqual(errors, []); assert.deepEqual(traffic.external, []);
});

test('旧单一次确认收付款，用覆盖原时点的报价补出列表收益', { timeout: 25_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const id = 'historic-settlement';
  const { context, page, fixture, writes, errors, traffic } = await setup(browser, 'gpt', 1440, fixture => {
    fixture.commerce.data.orders.push({
      id, orderNo: 'QA-HISTORIC-SETTLEMENT', product: 'GPT', plan: 'Plus', businessType: '续费',
      source: '管理员手工', email: 'settled@example.test', customerId: fixture.commerce.data.customers[0].id,
      payment: '银行卡', cardId: '', paymentId: '5813', paidAmount: '20', paidCurrency: 'USD',
      saleAmount: '100', saleCurrency: 'CNY', paidConfirmed: false, receiptConfirmed: false, costConfirmed: false,
      costBasis: 'actual', actualCostAmount: '80', actualCostCurrency: 'CNY',
      costSettings: { ...fixture.settings.data.costSettings, version: 1, currency: 'CNY' },
      start: '2026-11-04T10:30', expiry: '2026-12-04T10:30', version: 1, refunds: [], bankReturns: [], corrections: []
    });
  });
  t.after(() => context.close());
  const quotes = [];
  await context.route('**/api/local/finance/auto-snapshot', route => {
    const command = route.request().postDataJSON();
    quotes.push(command);
    const order = fixture.commerce.data.orders.find(row => row.id === command.orderId);
    assert.equal(order?.version, command.version);
    assert.equal(order?.paidConfirmed && order?.receiptConfirmed, true);
    order.fxSnapshot = createAutomaticOrderSnapshot({
      provider: automaticProvider.id, source: automaticProvider.source, quoteId: 'fxq-' + 'a'.repeat(64),
      at: '2026-11-04T00:00:00Z', expiresAt: '2026-11-04T23:59:00Z', fetchedAt: '2026-11-04T01:00:00Z',
      rates: { CNY: '1', USD: '7.2', MYR: '1.6' }
    }, order, Date.parse('2026-11-10T08:00:00Z'), { historical: true });
    order.version++;
    fixture.commerce.version++;
    return route.fulfill({ json: fixture.commerce });
  });
  await page.evaluate(async () => {
    const accounting = await import('/assets/finance/accounting.mjs');
    window.IDDesignAPI.modules.commerce.installFinance({
      ...accounting,
      requestAutomaticSnapshot: (orderId, version) => fetch('/api/local/finance/auto-snapshot', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ orderId, version })
      }).then(response => response.json())
    });
  });
  await page.goto(origin + '/#/orders/gpt');
  const row = page.locator(`#main tr[data-row-id="${id}"]`);
  const profit = row.locator('[data-column="profit"]');
  assert.equal(await profit.textContent(), '—');
  await row.getByRole('button', { name: '编辑', exact: true }).click();
  assert.equal(await page.locator('#drawer [data-commerce-field="confirmations"]').count(), 0);
  await page.locator('#drawer button[form="commerce-order-form"][type="submit"]').click();
  const dialog = page.locator('#confirm-dialog[open]');
  await dialog.getByText(/实际代付 20\.00 .*客户实收 100\.00 .*实际总成本 80\.00 /).waitFor();
  assert.equal(writes.length, 0);
  await dialog.locator('[data-action="confirm-accept"]').click();
  await profit.getByText('20.00', { exact: true }).waitFor();
  assert.equal(await row.locator('[data-column="paymentStatus"]').textContent(), '已付款');
  assert.deepEqual(quotes, [{ orderId: id, version: 2 }]);
  const saved = writes[0].data.orders.find(row => row.id === id);
  assert.equal(saved.paidConfirmed && saved.receiptConfirmed && saved.costConfirmed, true);
  assert.equal(saved.paymentId, '5813');
  assert.deepEqual(saved.financialEvidence.map(entry => entry.kind).sort(), ['payment', 'receipt']);
  assert.deepEqual(errors, []);
  assert.deepEqual(traffic.external, []);
});

test('提交失败可重试，迟到成功不会清除后续输入或抢回页面', { timeout: 30_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const { context, page, control, writes, submit, success, errors, traffic } = await setup(browser);
  t.after(() => context.close());
  await page.locator('#commerce-proCardNumber').fill(sampleCard);
  await page.locator('#commerce-email').fill('retry@example.test');
  await page.locator('#commerce-notes').fill('失败保留');
  const url = page.url();
  control.fail = true;
  await submit();
  await page.locator('#toast').filter({ hasText: '服务器保存失败' }).waitFor();
  assert.equal(page.url(), url);
  assert.equal(await page.locator('#commerce-email').inputValue(), 'retry@example.test');
  assert.equal(await page.locator('#commerce-notes').inputValue(), '失败保留');
  control.fail = false;
  await submit(); await success();
  assert.equal(page.url(), url);
  assert.equal(writes.length, 2);
  await page.locator('#commerce-proCardNumber').fill(sampleCard);
  await page.locator('#commerce-email').fill('late@example.test');
  control.hold = Promise.withResolvers(); control.started = Promise.withResolvers();
  await submit(); await control.started.promise;
  await page.locator('#commerce-notes').fill('等待响应时继续编辑');
  control.hold.resolve();
  await page.locator('#toast').filter({ hasText: '后续输入已保留' }).waitFor();
  assert.equal(await page.locator('#commerce-notes').inputValue(), '等待响应时继续编辑');
  assert.equal(page.url(), url);
  await page.locator('#commerce-email').fill('route@example.test');
  control.hold = Promise.withResolvers(); control.started = Promise.withResolvers();
  await submit(); await control.started.promise;
  await page.evaluate(() => { location.hash = '#/customers/new'; });
  await page.locator('#commerce-contact-name').fill('另一个页面的新草稿');
  control.hold.resolve();
  await page.locator('#toast').filter({ hasText: '后续输入已保留' }).waitFor();
  assert.equal(new URL(page.url()).hash, '#/customers/new');
  assert.equal(await page.locator('#commerce-contact-name').inputValue(), '另一个页面的新草稿');
  assert.deepEqual(errors, []); assert.deepEqual(traffic.external, []);
});

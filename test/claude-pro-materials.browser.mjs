import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

const entry = '/#/workspace/order/claude';
const fixturePath = new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url);
const actor = { id: 'pro-qa-admin', name: '合成管理员', role: 'admin' };
const syntheticCard = '4242424242424242';
const syntheticSerial = '00042-QA';

test('Claude Pro 银行卡资料切换、草稿、独立保存与 Max／Apple 边界', { timeout: 60_000 }, async t => {
  const playwright = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
  const { chromium } = await import(playwright ? pathToFileURL(playwright).href : 'playwright');
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  const customer = fixture.commerce.data.customers.find(row => row.active !== false);
  const tenant = { id: 'claude-fixture-tenant', name: '合成认证人', phone: '00000000', active: true, version: 1 };
  const tenantCard = { id: 'tenant:claude-fixture', last4: '0042', active: true };
  fixture.commerce.data.tenants.push(tenant);
  fixture['tenant-cards'] = { version: 1, items: [tenantCard] };
  const mock = await interceptDesign(context, { localFixtures: fixture, actor });
  const writes = [];
  await context.route('**/api/local/auth/order-owners', route => route.fulfill({ json: { items: [actor] } }));
  await context.route('**/api/local/auth/display-names', route => route.fulfill({ json: { items: [actor] } }));
  await context.route('**/api/local/commerce', route => {
    if (route.request().method() === 'GET') return route.fallback();
    const command = route.request().postDataJSON();
    writes.push(command);
    fixture.commerce = { version: command.version + 1, data: command.data };
    return route.fulfill({ json: fixture.commerce });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(6500);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + entry);
  const field = name => page.locator(`#main #commerce-${name}`);
  const mode = field('proMaterialMode');
  const card = field('proCardNumber');
  const serial = field('proCardSerial');
  const phone = field('phone');
  await card.waitFor();
  assert.equal(await mode.inputValue(), 'manual_card');
  assert.equal(await field('product').inputValue(), 'Claude Pro');
  assert.equal(await field('payment').inputValue(), '银行卡');
  await card.fill(syntheticCard);
  await serial.fill(syntheticSerial);
  await mode.selectOption('people');
  assert.equal(await card.isVisible(), false);
  await phone.fill('+60123456789');
  await mode.selectOption('manual_card');
  assert.equal(await card.inputValue(), syntheticCard);
  assert.equal(await serial.inputValue(), syntheticSerial);
  assert.equal(await phone.isVisible(), false);
  await mode.selectOption('people');
  assert.equal(await phone.inputValue(), '+60123456789');
  await page.goto(origin + '/#/workspace/order/gpt');
  await field('product').waitFor({ state: 'attached' });
  assert.equal(await mode.isVisible(), true);
  await page.goto(origin + entry);
  await mode.waitFor();
  assert.equal(await mode.inputValue(), 'people');
  assert.equal(await phone.inputValue(), '+60123456789');
  await field('product').selectOption('Claude Max');
  assert.equal(await mode.isVisible(), true);
  await mode.selectOption('');
  assert.equal(await card.isVisible(), false);
  await field('product').selectOption('Claude Pro');
  await field('payment').selectOption('苹果内购');
  assert.equal(await mode.isVisible(), false);
  assert.equal(await serial.isVisible(), false);
  await field('payment').selectOption('银行卡');
  await mode.selectOption('manual_card');
  for (const [width, dark] of [[1440, false], [1024, true], [768, false], [390, true]]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(value => { document.documentElement.dataset.theme = value ? 'dark' : 'light'; }, dark);
    const layout = await page.evaluate(() => {
      const rect = name => document.querySelector(`#main #commerce-${name}`).getBoundingClientRect();
      const payment = rect('payment'), type = rect('cardTypeId');
      const number = rect('proCardNumber'), serial = rect('proCardSerial');
      return { overflow: document.documentElement.scrollWidth > innerWidth + 1,
        paymentRow: Math.abs(payment.top - type.top) < 3 && payment.right <= type.left,
        cardFieldsFit: number.right <= serial.left + 1 || number.bottom <= serial.top + 1 };
    });
    assert.equal(layout.overflow, false, String(width));
    assert(layout.cardFieldsFit, '卡号与序列号可以换行，控件不重叠');
    if (width === 1440) assert(layout.paymentRow, '桌面付款方式与卡类型同排');
  }
  await field('email').fill('claude-pro-materials@example.test');
  await field('paidAmount').fill('20');
  await field('saleAmount').fill('500');
  await card.fill(syntheticCard);
  await serial.fill(syntheticSerial);
  await page.locator('[data-action="commerce-order-pending"]').click();
  await page.locator('#confirm-dialog [data-action="confirm-accept"]').click();
  await page.waitForFunction(() => !document.querySelector('#confirm-dialog[open]'));
  assert.equal(writes.length, 1);
  const order = writes[0].data.orders.find(row => row.email === 'claude-pro-materials@example.test');
  assert.equal(order.proMaterialMode, 'manual_card');
  assert.equal(order.proCardNumber, syntheticCard);
  assert.equal(order.proCardSerial, syntheticSerial);
  assert.equal(Boolean(order.cardId || order.tenantId || order.phone), false);
  assert.equal(order.ownerId, actor.id, '保留可信订单归属人');
  assert.equal(order.paidConfirmed, false);
  assert.equal(order.receiptConfirmed, false);
  await page.goto(origin + '/#/orders/pro');
  await page.locator('#commerce-search').fill(syntheticSerial);
  const details = page.locator(`[data-action="commerce-order-detail"][data-id="${order.id}"]`);
  await details.click();
  await page.locator('#drawer[open] .property-row').filter({ hasText: '卡序列号' })
    .getByText(syntheticSerial, { exact: true }).waitFor();
  await page.locator('#drawer [data-action="drawer-close"]').first().click();
  await page.locator(`[data-action="commerce-order-more"][data-id="${order.id}"]`).click();
  await page.locator(`[data-action="commerce-order-renew"][data-id="${order.id}"]:visible`).click();
  const renewal = page.locator('#drawer[open] #commerce-order-form');
  await renewal.locator('#commerce-proCardNumber').waitFor();
  assert.equal(await renewal.locator('#commerce-proCardNumber').inputValue(), '');
  assert.equal(await renewal.locator('#commerce-proCardSerial').inputValue(), '');
  assert.equal(await renewal.locator('[name="commerce-paidConfirmed"], [name="commerce-receiptConfirmed"]').count(), 0);
  await page.locator('#drawer [data-action="drawer-close"]').first().click();
  await page.locator(`[data-action="commerce-order-edit"][data-id="${order.id}"]`).click();
  const edit = page.locator('#drawer[open] #commerce-order-form');
  await edit.locator('#commerce-proMaterialMode').selectOption('people');
  await edit.locator('#commerce-phone').fill('+60123456789');
  await edit.locator('#commerce-correctionReason').fill('合成资料更正');
  await page.locator('#drawer[open] [data-action="commerce-order-pending"]').click();
  await page.locator('#confirm-dialog [data-action="confirm-accept"]').click();
  await page.waitForFunction(() => !document.querySelector('#confirm-dialog[open]'));
  assert.equal(writes.length, 2);
  const corrected = writes[1].data.orders.find(row => row.id === order.id);
  assert.equal(corrected.proMaterialMode, 'people');
  assert.equal(corrected.phone, '+60123456789');
  assert.equal(Object.hasOwn(corrected, 'proCardNumber'), false);
  assert.equal(Object.hasOwn(corrected, 'proCardSerial'), false);
  assert.equal(corrected.version, order.version + 1);
  assert.deepEqual(corrected.costSettings, order.costSettings);

  const choose = async (name, id) => {
    await field(name + '-picker').click();
    await page.locator('#commerce-' + name + '-popover [data-value="' + id + '"]').click();
  };
  for (const [product, email] of [
    ['Claude Pro', 'claude-pro-paid@example.test'],
    ['Claude Max', 'claude-max-paid@example.test']
  ]) {
    await page.goto(origin + entry);
    await field('product').selectOption(product);
    await choose('customerId', customer.id);
    await field('email').fill(email);
    if (product === 'Claude Pro') {
      await mode.selectOption('manual_card');
      await card.fill(syntheticCard);
      await serial.fill(syntheticSerial);
    } else {
      await mode.selectOption('');
      await choose('tenantId', tenant.id);
      await choose('cardId', tenantCard.id);
    }
    await field('paidAmount').fill('20');
    await field('saleAmount').fill('500');
    await page.locator('button[form="commerce-order-form"][type="submit"]:visible').click();
    const confirmation = page.locator('#confirm-dialog[open]');
    await confirmation.getByText(/请确认充值已成功.*实际代付 20\.00 .*客户实收 500\.00 /).waitFor();
    await confirmation.getByRole('button', { name: '确认保存', exact: true }).click();
    await page.locator('#toast').filter({ hasText: '订单提交成功' }).waitFor();
    assert.equal(page.url(), origin + entry);
    const saved = writes.at(-1).data.orders.find(row => row.email === email);
    assert.equal(saved.product, product);
    assert.equal(saved.paidConfirmed, true);
    assert.equal(saved.receiptConfirmed, true);
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(mock.external, []);
  await context.close();
});

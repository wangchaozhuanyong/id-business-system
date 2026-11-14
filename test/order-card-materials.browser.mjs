import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import test from 'node:test';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

const number = '4242424242424242', replacement = '4000000000000002';
const actor = { id: 'card-qa-admin', name: '合成超管', role: 'super' };
const output = fileURLToPath(new URL('../.runtime/order-card-snapshots-20261110/', import.meta.url));
const cases = [
  ['GPT', 'gpt', 'gpt'], ['Claude Pro', 'claude', 'pro'], ['Claude Max', 'claude', 'max'],
  ['Gemini', 'gemini', 'gemini'], ['Grok', 'grok', 'grok']
];

async function setup(t) {
  const module = await import(process.env.ID_RECHARGE_QA_PLAYWRIGHT
    ? pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href : 'playwright');
  const { chromium } = module.default || module;
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
  const mock = await interceptDesign(context, { localFixtures: fixture, actor, skipRechargeAssets: true });
  await context.addInitScript(() => document.addEventListener('DOMContentLoaded', () => {
    window.qaOrderSounds = [];
    window.IDInteractionSound = { play: kind => window.qaOrderSounds.push(kind) };
  }, { once: true }));
  const writes = [];
  let cards = [{ id: 'recharge:7', last4: '4242', active: true, usageCount: 1, status: '正常' }];
  await context.route('**/api/local/order-cards', route => route.fulfill({ json: { items: cards } }));
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
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const submit = async (scope, completed = false) => {
    const before = writes.length;
    const soundCount = await page.evaluate(() => window.qaOrderSounds.length);
    const url = page.url();
    const existing = await scope.locator('#commerce-id').inputValue();
    await scope.locator('button[form="commerce-order-form"][type="submit"]').click();
    const dialog = page.locator('#confirm-dialog[open]');
    assert.equal(await dialog.count(), 0);
    await page.waitForFunction(start => window.qaOrderSounds.length > start, soundCount);
    await page.locator('#toast').filter({ hasText: existing ? '订单修改成功' : '订单提交成功' }).waitFor();
    assert.equal(page.url(), url);
    await page.locator('#drawer[open]').waitFor({ state: 'hidden' });
    assert.equal(writes.length, before + 1);
    assert.deepEqual(await page.evaluate(start => window.qaOrderSounds.slice(start), soundCount), ['success'], url);
    if (completed) {
      const [saved] = writes.at(-1).data.orders;
      assert.equal(Number(saved.paidAmount), 20);
      assert.equal(Number(saved.saleAmount), 100);
      assert(saved.paidConfirmed && saved.receiptConfirmed);
    }
  };
  return { page, fixture, writes, errors, mock, submit, removePool: () => { cards = []; } };
}

test('所有录单入口默认手填并可编辑卡号，卡序列号选填，切页和切换保留草稿', { timeout: 90_000 }, async t => {
  const { page, fixture, writes, errors, mock, submit } = await setup(t);
  const customer = fixture.commerce.data.customers.find(row => row.active !== false);
  const main = page.locator('#main');
  const created = [];
  for (const [product, entry, list] of cases) {
    await page.goto(`${origin}/#/workspace/order/${entry}`);
    let form = main.locator('#commerce-order-form');
    await form.locator('#commerce-proMaterialMode').waitFor();
    if (entry === 'claude') await form.locator('#commerce-plan').selectOption(product === 'Claude Pro' ? 'Pro' : 'Max 5x');
    assert.equal(await form.locator('#commerce-proMaterialMode').inputValue(), 'manual_card');
    const card = form.locator('#commerce-proCardNumber');
    await card.fill(number);
    assert.equal(await card.isEditable(), true);
    const serial = form.locator('#commerce-proCardSerial');
    const serialValue = product.startsWith('Claude') ? '' : '00042-' + list;
    assert.equal(await form.locator('[data-commerce-field="proCardSerial"] .required').count(), 0);
    assert.equal(await serial.inputValue(), '');
    await serial.fill(serialValue);
    if (product === 'GPT') {
      await card.fill('1234');
      await main.locator('button[form="commerce-order-form"][type="submit"]').click();
      assert.equal(await page.locator('#confirm-dialog[open]').count(), 0);
      assert.equal(writes.length, 0);
      assert.deepEqual(await page.evaluate(() => window.qaOrderSounds), []);
      assert.ok((await form.locator('[data-commerce-field="proCardNumber"]').textContent()).includes('12 至 19 位'));
      await card.fill(number);
      await form.locator('#commerce-proMaterialMode').selectOption('');
      assert.equal(await card.isVisible(), false);
      assert.equal(await serial.isVisible(), true);
      await page.goto(`${origin}/#/orders/gpt`);
      await page.goto(`${origin}/#/workspace/order/gpt`);
      assert.equal(await form.locator('#commerce-proMaterialMode').inputValue(), '');
      await form.locator('#commerce-proMaterialMode').selectOption('manual_card');
      assert.equal(await card.inputValue(), number);
      await page.goto(`${origin}/#/orders/gpt`);
      await page.goto(`${origin}/#/workspace/order/gpt`);
      form = main.locator('#commerce-order-form');
      await form.locator('#commerce-proCardNumber').waitFor();
      assert.equal(await form.locator('#commerce-proCardNumber').inputValue(), number);
      assert.equal(await form.locator('#commerce-proCardSerial').inputValue(), serialValue);
    }
    await form.locator('#commerce-customerId').evaluate((node, id) => {
      node.value = id; node.dispatchEvent(new Event('change', { bubbles: true }));
    }, customer.id);
    const email = `card-${list}@example.test`;
    await form.locator('#commerce-email').fill(email);
    await form.locator('#commerce-paidAmount').fill('20');
    await form.locator('#commerce-saleAmount').fill('100');
    if (['Gemini', 'Grok'].includes(product)) {
      await form.locator('#commerce-start').fill('2026-11-10T10:00');
      await form.locator('#commerce-expiry').fill('2026-12-10T10:00');
    }
    assert.equal(await form.locator('[data-commerce-field="confirmations"]').count(), 0);
    await submit(main, true);
    const saved = writes.at(-1).data.orders.find(row => row.email === email);
    assert.ok(saved, product);
    assert.equal(saved.product, product);
    assert.equal(saved.proCardNumber, number);
    assert.equal(saved.paymentId, '4242');
    assert.equal(saved.cardId, '');
    assert.equal(saved.proCardSerial || '', serialValue);
    assert.equal(saved.paidConfirmed, true);
    assert.equal(saved.receiptConfirmed, true);
    assert.equal(saved.costConfirmed, true);
    created.push([saved, list]);
  }
  for (const [original, list] of created) {
    await page.goto(`${origin}/#/orders/${list}`);
    await page.locator(`#commerce-search`).fill(original.email);
    await page.locator(`[data-action="commerce-order-edit"][data-id="${original.id}"]`).click();
    const drawer = page.locator('#drawer[open]');
    const card = drawer.locator('#commerce-proCardNumber');
    await card.fill(replacement);
    await drawer.locator('#commerce-correctionReason').fill('核对银行卡号');
    await submit(drawer);
    const saved = writes.at(-1).data.orders.find(row => row.id === original.id);
    assert.equal(saved.proCardNumber, replacement);
    assert.equal(saved.paymentId, '0002');
    assert.equal(saved.proCardSerial || '', original.proCardSerial || '');
    assert.equal(saved.corrections.at(-1).previous.proCardNumber, number);
    assert.deepEqual(saved.financialEvidence.filter(row => row.kind === 'payment'),
      original.financialEvidence.filter(row => row.kind === 'payment'));
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(mock.external, []);
});

test('租户银行卡锁定真实卡，新单和更正均保存固定类型', { timeout: 30_000 }, async t => {
  const { page, fixture, writes, errors, mock, submit } = await setup(t);
  const customer = fixture.commerce.data.customers.find(row => row.active !== false);
  const tenant = { id: 'tenant-real-type', name: '合成租户', phone: '00000000', active: true };
  const cardId = 'tenant:real-type-test';
  const realType = { id: 'existing-real-type', name: '真实卡', active: true };
  const customType = { id: 'custom-test-type', name: '合成类型', active: true };
  fixture.commerce.data.orders = [];
  fixture.commerce.data.tenants = [tenant];
  fixture['card-types'] = { version: 1, items: [realType, customType], assignments: { [cardId]: customType.id } };
  fixture['tenant-cards'] = { version: 1, items: [{ id: cardId, tenantId: tenant.id, last4: '4242', active: true }] };
  await page.route('**/api/local/tenant-cards*', route => {
    if (route.request().method() === 'POST' && route.request().postDataJSON().action === 'reveal')
      return route.fulfill({ json: { number } });
    return route.fallback();
  });
  await page.goto(origin + '/#/workspace/order/claude');
  const main = page.locator('#main');
  const form = main.locator('#commerce-order-form');
  const field = name => form.locator('#commerce-' + name);
  const choose = async (name, id) => {
    await field(name + '-picker').click();
    await page.locator(`#commerce-${name}-options [data-value="${id}"]`).click();
  };
  await field('plan').selectOption('Max 5x');
  await choose('customerId', customer.id);
  await field('email').fill('tenant-type@example.test');
  await field('cardTypeId').selectOption(customType.id);
  await field('proMaterialMode').selectOption('tenant_card');
  assert.equal(await field('cardTypeId').inputValue(), realType.id);
  assert.equal(await field('cardTypeId').isDisabled(), true);
  await page.goto(origin + '/#/customers/new');
  await page.goto(origin + '/#/workspace/order/claude');
  assert.equal(await field('cardTypeId').inputValue(), realType.id);
  await field('proMaterialMode').selectOption('manual_card');
  assert.equal(await field('cardTypeId').isDisabled(), false);
  assert.equal(await field('cardTypeId').inputValue(), customType.id);
  await field('proMaterialMode').selectOption('tenant_card');
  await choose('tenantId', tenant.id);
  await field('cardId').locator(`option[value="${cardId}"]`).waitFor({ state: 'attached' });
  await choose('cardId', cardId);
  await field('paidAmount').fill('20');
  await field('saleAmount').fill('100');
  await submit(main, true);
  const saved = writes.at(-1).data.orders[0];
  assert.equal(saved.cardId, cardId);
  assert.equal(saved.cardTypeId, realType.id);

  // Read a historical order whose original classification predates the lock.
  fixture.commerce = { ...fixture.commerce, data: { ...fixture.commerce.data, orders: [
    { ...saved, cardTypeId: customType.id, cardTypeName: customType.name }
  ] } };
  await page.goto(origin + '/#/orders/claude');
  await page.reload();
  await page.locator(`[data-action="commerce-order-edit"][data-id="${saved.id}"]`).click();
  const drawer = page.locator('#drawer[open]');
  const editType = drawer.locator('#commerce-cardTypeId');
  await editType.locator(`option:checked[value="${realType.id}"]`).waitFor({ state: 'attached' });
  assert.equal(await editType.isDisabled(), true);
  await drawer.locator('#commerce-correctionReason').fill('核对租户银行卡类型');
  await submit(drawer);
  const corrected = writes.at(-1).data.orders.find(row => row.id === saved.id);
  assert.equal(corrected.cardTypeId, realType.id);
  assert.equal(corrected.corrections.at(-1).previous.cardTypeId, customType.id);

  await page.goto(origin + '/#/settings/payment-countries');
  await page.getByRole('tab', { name: '银行卡类型', exact: true }).click();
  const fixed = main.locator(`[data-table="commerce-card-types"] tr[data-row-id="${realType.id}"]`);
  await fixed.getByText('固定启用', { exact: true }).waitFor();
  assert.equal(await fixed.locator('[data-action="commerce-card-type-edit"], [data-action="commerce-card-type-remove"]').count(), 0);
  await main.locator(`[data-action="commerce-card-type-edit"][data-id="${customType.id}"]`).waitFor();
  assert.deepEqual(errors, []);
  assert.deepEqual(mock.external, []);
});

test('已选卡池资料删除后仍可编辑，自动订单更正卡号保留任务和付款证据', { timeout: 45_000 }, async t => {
  const { page, fixture, writes, removePool, submit, errors } = await setup(t);
  const order = { ...fixture.commerce.data.orders.find(row => row.product === 'GPT'),
    id: 'saved-pool-card', orderNo: 'TEST-CARD-DELETE', email: 'deleted-card@example.test',
    source: '线上代充', taskId: 'fixture-task', plan: 'Plus', businessType: '续费',
    cardId: 'recharge:7', payment: '银行卡', paymentId: '4242', proCardNumber: number,
    paidAmount: '20', paidCurrency: 'USD', paidConfirmed: true, receiptConfirmed: false, costBasis: 'standard',
    customerId: fixture.commerce.data.customers[0].id, accountId: '', accountSource: '客户自有',
    proMaterialMode: undefined, proCardSerial: undefined, refunds: [], bankReturns: [], corrections: [],
    financialEvidence: [{ kind: 'payment', cardId: 'recharge:7', amount: '20', currency: 'USD', payment: '银行卡' }] };
  fixture.commerce.data.orders.unshift(order);
  removePool();
  await page.goto(`${origin}/#/orders/gpt`);
  await page.locator('[data-action="commerce-order-tab"][data-tab="pending"]').click();
  await page.locator('#commerce-search').fill(order.email);
  const edit = async () => {
    await page.locator(`[data-action="commerce-order-more"][data-id="${order.id}"]`).click();
    await page.locator(`[data-action="commerce-order-edit"][data-id="${order.id}"]`).click();
  };
  await edit();
  let drawer = page.locator('#drawer[open]');
  await drawer.locator('#commerce-notes').fill('卡池删除后补充备注');
  await drawer.locator('#commerce-correctionReason').fill('核对订单备注');
  await submit(drawer);
  let saved = writes.at(-1).data.orders.find(row => row.id === order.id);
  assert.equal(saved.proCardNumber, number);
  assert.equal(saved.paymentId, '4242');
  await edit();
  drawer = page.locator('#drawer[open]');
  await drawer.locator('#commerce-proMaterialMode').selectOption('manual_card');
  assert.equal(await drawer.locator('#commerce-proCardNumber').inputValue(), number);
  await drawer.locator('#commerce-proCardNumber').fill(replacement);
  await drawer.locator('#commerce-correctionReason').fill('核对登记卡号');
  await submit(drawer);
  saved = writes.at(-1).data.orders.find(row => row.id === order.id);
  assert.equal(saved.proCardNumber, replacement);
  assert.equal(saved.taskId, order.taskId);
  assert.equal(saved.source, order.source);
  assert.equal(saved.paidAmount, order.paidAmount);
  assert.deepEqual(saved.financialEvidence, order.financialEvidence);
  assert.deepEqual(errors, []);
});

test('银行卡输入在深浅主题和宽窄屏不重叠、不溢出，标签位于控件上方', { timeout: 60_000 }, async t => {
  const { page, errors } = await setup(t);
  await mkdir(output, { recursive: true });
  for (const entry of ['gpt', 'claude', 'gemini', 'grok']) {
    await page.goto(`${origin}/#/workspace/order/${entry}`);
    assert.equal(await page.locator('#main #commerce-proMaterialMode').inputValue(), 'manual_card');
    await page.locator('#main #commerce-proCardNumber').fill(number);
    for (const width of [1440, 1024, 901, 900, 768, 390, 320]) for (const theme of ['light', 'dark']) {
      await page.setViewportSize({ width, height: 1100 });
      await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
      const result = await page.locator('#main .order-payment-options').evaluate(root => {
        const fields = [...root.children].filter(node => !node.hidden && node.matches('.field'));
        const rectangles = fields.map(node => node.getBoundingClientRect());
        const overlap = rectangles.some((a, i) => rectangles.some((b, j) => i !== j &&
          Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 &&
          Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1));
        const labelsLeft = fields.every(node => {
          const label = node.querySelector('label'), control = node.querySelector('input:not([type="hidden"]), select, button');
          if (!label || !control) return true;
          return getComputedStyle(label).clipPath !== 'none' || label.getBoundingClientRect().bottom <= control.getBoundingClientRect().top + 1;
        });
        const bounds = name => root.querySelector(`[data-commerce-field="${name}"]`).getBoundingClientRect();
        const payment = bounds('payment'), mode = bounds('proMaterialMode');
        const cardType = bounds('cardTypeId'), number = bounds('proCardNumber');
        const columns = getComputedStyle(root).gridTemplateColumns.split(' ').length;
        const sameRow = (left, right) => Math.abs(left.top - right.top) <= 1 &&
          right.left >= left.right && Math.abs(left.width - right.width) <= 1;
        const rowWithMode = Math.abs(payment.top - mode.top) <= 1;
        const placement = rowWithMode
          ? sameRow(payment, mode) && (Math.abs(cardType.top - payment.top) <= 1 || cardType.top >= payment.bottom) && number.top >= cardType.bottom
          : mode.top >= payment.bottom && cardType.top >= mode.bottom && number.top >= cardType.bottom;
        return { overlap, labelsLeft, placement, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
      });
      assert.deepEqual(result, { overlap: false, labelsLeft: true, placement: true, overflow: false }, `${entry}/${width}/${theme}`);
      if (entry === 'claude' && [1440, 390].includes(width))
        await page.locator('#main .order-payment-options').screenshot({ path: output + `claude-card-${width}-${theme}.png` });
    }
  }
  assert.deepEqual(errors, []);
});

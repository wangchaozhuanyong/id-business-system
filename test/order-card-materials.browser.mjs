import assert from 'node:assert/strict';
import { readFile, mkdir } from 'node:fs/promises';
import test from 'node:test';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

const number = '4242424242424242', replacement = '4000000000000002';
const actor = { id: 'card-qa-admin', name: '合成管理员', role: 'admin' };
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
    const url = page.url();
    const existing = await scope.locator('#commerce-id').inputValue();
    await scope.locator(completed ? 'button[form="commerce-order-form"][type="submit"]' :
      '[data-action="commerce-order-pending"]').click();
    const dialog = page.locator('#confirm-dialog[open]');
    if (completed) await dialog.getByText(/请确认充值已成功.*实际代付 20\.00 .*客户实收 100\.00 /).waitFor();
    await dialog.locator('[data-action="confirm-accept"]').click();
    await page.locator('#toast').filter({ hasText: existing ? '订单修改成功' : '订单提交成功' }).waitFor();
    assert.equal(page.url(), url);
    await page.locator('#drawer[open]').waitFor({ state: 'hidden' });
    assert.equal(writes.length, before + 1);
  };
  return { page, fixture, writes, errors, mock, submit, removePool: () => { cards = []; } };
}

test('所有录单入口可手填和编辑卡号，卡序列号选填，切页和切换保留草稿', { timeout: 90_000 }, async t => {
  const { page, fixture, writes, errors, mock, submit } = await setup(t);
  const customer = fixture.commerce.data.customers.find(row => row.active !== false);
  const main = page.locator('#main');
  const created = [];
  for (const [product, entry, list] of cases) {
    await page.goto(`${origin}/#/workspace/order/${entry}`);
    let form = main.locator('#commerce-order-form');
    await form.locator('#commerce-proMaterialMode').waitFor();
    if (entry === 'claude') await form.locator('#commerce-plan').selectOption(product === 'Claude Pro' ? 'Pro' : 'Max 5x');
    await form.locator('#commerce-proMaterialMode').selectOption('manual_card');
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
      await main.locator('[data-action="commerce-order-pending"]').click();
      assert.equal(await page.locator('#confirm-dialog[open]').count(), 0);
      assert.equal(writes.length, 0);
      assert.ok((await form.locator('[data-commerce-field="proCardNumber"]').textContent()).includes('12 至 19 位'));
      await card.fill(number);
      await form.locator('#commerce-proMaterialMode').selectOption('');
      assert.equal(await card.isVisible(), false);
      assert.equal(await serial.isVisible(), true);
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
  await page.locator('#commerce-search').fill(order.email);
  await page.locator(`[data-action="commerce-order-edit"][data-id="${order.id}"]`).click();
  let drawer = page.locator('#drawer[open]');
  await drawer.locator('#commerce-notes').fill('卡池删除后补充备注');
  await drawer.locator('#commerce-correctionReason').fill('核对订单备注');
  await submit(drawer);
  let saved = writes.at(-1).data.orders.find(row => row.id === order.id);
  assert.equal(saved.proCardNumber, number);
  assert.equal(saved.paymentId, '4242');
  await page.locator(`[data-action="commerce-order-edit"][data-id="${order.id}"]`).click();
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

test('银行卡输入在深浅主题和宽窄屏不重叠、不溢出，标签位于控件左侧', { timeout: 60_000 }, async t => {
  const { page, errors } = await setup(t);
  await mkdir(output, { recursive: true });
  for (const entry of ['gpt', 'claude', 'gemini', 'grok']) {
    await page.goto(`${origin}/#/workspace/order/${entry}`);
    await page.locator('#main #commerce-proMaterialMode').selectOption('manual_card');
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
          return label.getBoundingClientRect().right <= control.getBoundingClientRect().left + 1;
        });
        return { overlap, labelsLeft, overflow: document.documentElement.scrollWidth > innerWidth + 1 };
      });
      assert.deepEqual(result, { overlap: false, labelsLeft: true, overflow: false }, `${entry}/${width}/${theme}`);
      if (entry === 'claude' && [1440, 390].includes(width))
        await page.locator('#main .order-payment-options').screenshot({ path: output + `claude-card-${width}-${theme}.png` });
    }
  }
  assert.deepEqual(errors, []);
});

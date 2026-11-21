import { chooseOrderCustomer } from './helpers/order-customer.mjs';
import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { calculateConfirmedNetReceipt } from '../modules/finance/accounting.mjs';
import { applyDocumentDelta, documentDelta } from '../modules/data/document-delta.mjs';
import { projectSubscriptions } from '../server/subscription-management.mjs';
import { checkManualRenewalLink } from '../server/order-policy.mjs';
import { interceptDesign, origin } from './helpers/offline-design.mjs';
import { assertOrderWorkspace } from './helpers/order-workspace.mjs';

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
  const traffic = await interceptDesign(context, { actor, localFixtures: fixture, skipRechargeAssets: true, documentDelta: true });
  const writes = [], control = { fail: false, hold: null, started: null };
  await context.route('**/api/local/commerce', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: fixture.commerce });
    const body = route.request().postDataJSON();
    const data = body.delta ? applyDocumentDelta('commerce', fixture.commerce.data, body.delta) : body.data;
    assert(data, 'ordinary save payload must reconstruct the current business data');
    writes.push({ ...body, data }); control.started?.resolve();
    if (control.hold) await control.hold.promise;
    if (control.fail) return route.fulfill({ status: 400, json: { error: '模拟提交失败' } });
    const version = body.version + 1;
    const delta = body.delta && documentDelta('commerce', fixture.commerce.data, data);
    fixture.commerce = { version, data };
    return route.fulfill({ json: delta ? { version, delta } : fixture.commerce });
  });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(6000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/#/workspace/order/' + slug);
  await page.locator('#commerce-ownerId option[value="submit-stay"]').waitFor({ state: 'attached' });
  await chooseOrderCustomer(page, fixture.commerce.data.customers[0]);
  const submit = async () => {
    const form = page.locator('#main #commerce-order-form');
    const customer = form.locator('#commerce-customerId');
    if (!await customer.inputValue()) await chooseOrderCustomer(form, fixture.commerce.data.customers[0]);
    for (const [id, value] of [['paidAmount', '20'], ['saleAmount', '100']]) {
      const input = form.locator('#commerce-' + id);
      if (!await input.inputValue()) await input.fill(value);
    }
    await page.locator('button[form="commerce-order-form"][type="submit"]').click();
    assert.equal(await page.locator('#confirm-dialog[open]').count(), 0);
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
          { id: 'recharge:71', number: '4000000000000171', last4: '0171', active: true, status: '正常' },
          { id: 'recharge:72', number: '4000000000000172', last4: '0172', active: true, status: '正常' }
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
          for (const [number, expected] of [['4000000000000171', 'qa-wise-type'], ['4000000000000172', 'qa-default-type']]) {
            await picker.click();
            await page.locator('#commerce-cardId-options').getByRole('option', { name: new RegExp(number) }).click();
            assert.equal(await page.locator('#commerce-selectedCardNumber').inputValue(), number);
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
        const mobileRecords = page.getByRole('button', { name: '最近订单', exact: true });
        const mobile = await mobileRecords.isVisible();
        if (mobile) {
          await mobileRecords.click();
        }
        await recent.getByText('本次提交的草稿', { exact: true }).waitFor();
        if (mobile) await page.getByRole('button', { name: '返回填写', exact: true }).click();
        await page.locator('#commerce-email').fill('next-' + slug + '@example.test');
        await page.evaluate(() => { location.hash = '#/customers/new'; });
        await page.locator('#commerce-contact-name').waitFor();
        await page.evaluate(slug => { location.hash = '#/workspace/order/' + slug; }, slug);
        assert.equal(await page.locator('#commerce-email').inputValue(), 'next-' + slug + '@example.test', '后续新草稿仍可切页保留');
        if (product === 'GPT') assert.equal(await cardType.inputValue(), '', '手动选未填写后返回草稿仍保留');
        await page.setViewportSize({ width: 1440, height: 900 });
        await page.goto(origin + '/#/customers/list');
        const customerName = fixture.commerce.data.customers.find(row => row.id === saved.customerId).name;
        await page.locator('#commerce-search').fill(customerName);
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

test('邮箱和银行卡留空时，预填金额与周期可直接提交', { timeout: 20_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const { context, page, writes, submit, success } = await setup(browser, 'gpt', 1440, fixture => {
    fixture.settings.data.gptPaidPrices = { Plus: { PHP: '1000' } };
    fixture.settings.data.orderPrices = { GPT: { Plus: { CNY: '130' } } };
  });
  t.after(() => context.close());
  const form = page.locator('#commerce-order-form');
  await page.waitForFunction(() => document.querySelector('#commerce-paidAmount')?.value === '1000' &&
    document.querySelector('#commerce-saleAmount')?.value === '130');
  assert.equal(await form.locator('#commerce-email').inputValue(), '');
  assert.equal(await form.locator('#commerce-proCardNumber').inputValue(), '');
  const start = await form.locator('#commerce-start').inputValue();
  const expiry = await form.locator('#commerce-expiry').inputValue();
  assert.ok(start && expiry > start);
  await submit();
  await success();
  const saved = writes[0].data.orders[0];
  assert.deepEqual([saved.email, saved.cardId, saved.paidAmount, saved.saleAmount, saved.start, saved.expiry],
    ['', '', '1000', '130', start, expiry]);
});

test('从原单进入已完成续费登记，仅在提交时新建一笔', { timeout: 20_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const id = 'stay-renewal', email = 'renewal-fixture@example.test';
  const { context, page, fixture, writes, errors, traffic, submit, success } = await setup(browser, 'gpt', 1440, fixture => {
    const date = offset => new Date(Date.now() + 8 * 3_600_000 + offset * 86_400_000).toISOString().slice(0, 16);
    fixture.commerce.data.orders.push({ id, orderNo: 'QA-RENEWAL-ORIGINAL', version: 1,
      product: 'GPT', plan: 'Plus', businessType: '续费', source: '管理员手工',
      customerId: fixture.commerce.data.customers[0].id, email, payment: '银行卡', proMaterialMode: 'none',
      start: date(-31), expiry: date(-1), paidAmount: '20', paidCurrency: 'USD', saleAmount: '100', saleCurrency: 'CNY',
      paidConfirmed: true, receiptConfirmed: true, entitlementStatus: 'active',
      refunds: [], bankReturns: [], corrections: [] });
  });
  t.after(() => context.close());
  const original = structuredClone(fixture.commerce.data.orders[0]);
  await page.goto(origin + '/#/workspace/order/renew/' + id);
  const form = page.locator('#main #commerce-order-form');
  await assertOrderWorkspace(page, 'GPT');
  assert.equal(await form.locator('#commerce-customerId').inputValue(), original.customerId);
  assert.equal(await form.locator('#commerce-email').inputValue(), email);
  assert.equal(await form.locator('#commerce-businessType').inputValue(), '续费');
  assert.equal(await form.locator('#commerce-businessType').isEditable(), false);
  assert.equal(writes.length, 0);
  await form.locator('#commerce-notes').fill('按旧原单核对的草稿');
  const updated = { ...original, version: original.version + 1, wechat: '更新后的微信' };
  fixture.commerce = { version: fixture.commerce.version + 1,
    data: { ...fixture.commerce.data, orders: [updated] } };
  const reread = page.waitForResponse(response => response.request().method() === 'GET' &&
    new URL(response.url()).pathname === '/api/local/commerce');
  await page.getByRole('button', { name: '刷新最近录入记录' }).click();
  await reread;
  await submit();
  const reload = page.getByRole('button', { name: '重新带入最新原单', exact: true });
  await reload.waitFor();
  assert.equal(writes.length, 0, '过期版本不能提交订单');
  assert.deepEqual(fixture.commerce.data.orders, [updated]);
  await reload.click();
  assert.equal(await form.locator('#commerce-notes').inputValue(), '');
  assert.equal(await form.locator('#commerce-wechat').inputValue(), updated.wechat);
  assert.equal(writes.length, 0, '显式带入最新资料只更新表单');
  await submit();
  await success();
  assert.equal(writes.length, 1);
  const [saved, retained] = writes[0].data.orders;
  assert.equal(saved.previousOrderId, id);
  assert.equal(saved.paidConfirmed, true);
  assert.equal(saved.receiptConfirmed, true);
  assert.equal(saved.renewalSourceVersion, updated.version);
  assert.deepEqual(retained, updated);
  assert.deepEqual(errors, []);
  assert.deepEqual(traffic.external, []);
});

test('Claude 原单在产品工作台登记续费，切换和重试保留独立草稿', { timeout: 30_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const id = 'claude-renew-layout', email = 'renew-claude@example.test';
  const { context, page, fixture, control, writes, submit, success } = await setup(browser, 'claude', 390, fixture => {
    const day = 86_400_000;
    fixture.commerce.data.orders = [{ id, orderNo: 'QA-CLAUDE-SOURCE', version: 3,
      customerId: fixture.commerce.data.customers[0].id, product: 'Claude Pro', plan: 'Pro',
      email, source: '管理员手工', businessType: '首次开通', payment: '银行卡', proMaterialMode: 'none',
      start: new Date(Date.now() - 31 * day).toISOString(), expiry: new Date(Date.now() - day).toISOString(),
      paidConfirmed: true, receiptConfirmed: true, entitlementStatus: 'active', paidCurrency: 'USD',
      saleCurrency: 'CNY', paidAmount: '20', saleAmount: '100', refunds: [], bankReturns: [], corrections: [] }];
  });
  t.after(() => context.close());
  const original = structuredClone(fixture.commerce.data.orders[0]);
  const form = page.locator('#main #commerce-order-form');
  const notes = form.locator('#commerce-notes');
  await notes.fill('Claude 普通录单草稿');
  const sourceURL = origin + '/#/workspace/order/renew/' + id;
  await page.goto(sourceURL);
  await assertOrderWorkspace(page, 'Claude');
  const details = form.locator('details').filter({ has: page.locator('summary', { hasText: /^Claude 补充资料$/ }) });
  assert.equal(await details.getAttribute('open'), null);
  await details.locator('summary').click();
  const phone = details.locator('#commerce-phone');
  await phone.fill('+60123456789');
  assert.equal(await details.locator('#commerce-kyc').isVisible(), false);
  assert.equal(await form.locator('#commerce-email').inputValue(), email);
  assert.equal(await form.locator('#commerce-claudeRenewalId').inputValue(), id);
  assert.equal(await form.locator('#commerce-plan').inputValue(), 'Pro');
  assert.equal(await form.locator('#commerce-paidAmount').inputValue(), '');
  assert.equal(await form.locator('#commerce-saleAmount').inputValue(), '');
  await notes.fill('此原单续费的草稿');
  await page.getByRole('navigation', { name: '订单提交业务切换' }).getByRole('link', { name: 'GPT', exact: true }).click();
  assert.equal(await notes.inputValue(), '');
  await page.getByRole('navigation', { name: '订单提交业务切换' }).getByRole('link', { name: 'Claude', exact: true }).click();
  assert.equal(await notes.inputValue(), 'Claude 普通录单草稿');
  await page.goto(sourceURL);
  assert.equal(await notes.inputValue(), '此原单续费的草稿');
  assert.equal(writes.length, 0);
  control.fail = true;
  await submit();
  await page.locator('#toast').filter({ hasText: '模拟提交失败' }).waitFor();
  assert.equal(await notes.inputValue(), '此原单续费的草稿');
  assert.deepEqual(fixture.commerce.data.orders, [original]);
  control.fail = false;
  await submit();
  await success();
  assert.equal(writes.length, 2);
  const [saved, retained] = fixture.commerce.data.orders;
  assert.equal(writes[0].data.orders[0].id, saved.id);
  assert.equal(saved.previousOrderId, id);
  assert.equal(saved.renewalSourceVersion, original.version);
  assert.equal(saved.proRenewalSourceVersion, original.version);
  assert.equal(saved.phone, '+60123456789');
  assert.equal(saved.notes, '此原单续费的草稿');
  assert.deepEqual(retained, original);
});

test('两名经办人同时提交同一原单，仅产生一笔续费', { timeout: 20_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const fixtures = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  const day = 86_400_000, now = Date.now();
  const source = { id: 'shared-renewal', orderNo: 'QA-SHARED', version: 2,
    customerId: fixtures.commerce.data.customers[0].id, product: 'GPT', plan: 'Plus',
    email: 'shared-renewal@example.test', source: '管理员手工', businessType: '首次开通',
    payment: '银行卡', proMaterialMode: 'none', paidAmount: '20', paidCurrency: 'USD', saleAmount: '100', saleCurrency: 'CNY',
    start: new Date(now - 31 * day).toISOString(), expiry: new Date(now - day).toISOString(),
    paidConfirmed: true, receiptConfirmed: true, entitlementStatus: 'active', refunds: [], bankReturns: [], corrections: [] };
  fixtures.commerce.data.orders = [source];
  const base = structuredClone(fixtures.commerce);
  const reached = [], outcomes = [], bothReady = Promise.withResolvers();
  t.after(() => bothReady.resolve());
  const pages = [];
  for (const actorId of ['operator-a', 'operator-b']) {
    const operator = { id: actorId, name: actorId, role: 'admin' };
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    await interceptDesign(context, { actor: operator, localFixtures: fixtures, documentDelta: true, skipRechargeAssets: true });
    await context.route('**/api/local/commerce', async route => {
      const request = route.request();
      if (request.method() === 'GET') return route.fulfill({ json: fixtures.commerce });
      const body = request.postDataJSON();
      assert.equal(body.version, base.version, '两个经办人均基于同一版本提交');
      const proposed = body.delta ? applyDocumentDelta('commerce', base.data, body.delta) : body.data;
      const candidate = proposed.orders.find(row => row.id !== source.id);
      assert.equal(candidate.previousOrderId, source.id);
      reached.push(actorId);
      if (reached.length === 2) bothReady.resolve();
      await bothReady.promise;
      // In-memory commit order lets the production duplicate check see the first accepted order.
      const previous = new Map(fixtures.commerce.data.orders.map(row => [row.id, row]));
      const next = new Map([...previous, ...proposed.orders.map(row => [row.id, row])]);
      const issue = checkManualRenewalLink(candidate, previous, next, now);
      outcomes.push({ actorId, candidate: candidate.id, issue });
      if (issue) return route.fulfill({ status: 409, json: { error: issue } });
      fixtures.commerce = { version: base.version + 1, data: proposed };
      return route.fulfill({ json: fixtures.commerce });
    });
    const page = await context.newPage();
    page.setDefaultTimeout(6000);
    await page.goto(origin + '/#/workspace/order/renew/' + source.id);
    const form = page.locator('#main #commerce-order-form');
    await form.locator('#commerce-paidAmount').fill('20');
    await form.locator('#commerce-saleAmount').fill('100');
    await form.locator('#commerce-notes').fill(actorId);
    pages.push(page);
  }
  assert.deepEqual(reached, []);
  const responses = await Promise.all(pages.map(async page => {
    const response = page.waitForResponse(r => new URL(r.url()).pathname === '/api/local/commerce' && r.request().method() === 'PUT');
    await page.locator('button[form="commerce-order-form"][type="submit"]').click();
    return (await response).status();
  }));
  assert.deepEqual([...responses].sort(), [200, 409]);
  const accepted = outcomes.find(row => !row.issue), refused = outcomes.find(row => row.issue);
  assert.notEqual(accepted.candidate, refused.candidate);
  assert.equal(refused.issue, '该期订阅已有续费订单，请刷新后查看新单');
  const [saved, retained] = fixtures.commerce.data.orders;
  assert.equal(fixtures.commerce.data.orders.length, 2);
  assert.equal(saved.id, accepted.candidate);
  assert.equal(saved.notes, accepted.actorId);
  assert.deepEqual(retained, source);
  await pages[responses.indexOf(200)].locator('#toast').getByText('订单提交成功', { exact: true }).waitFor();
  await pages[responses.indexOf(409)].locator('#toast').filter({ hasText: refused.issue }).waitFor();
});

test('旧订单可单独修改备注，保留原来的空值、付款状态与成本', { timeout: 25_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const id = 'historic-note';
  const { context, page, writes, errors, traffic } = await setup(browser, 'gpt', 1440, fixture => {
    fixture.commerce.data.orders.push({
      id, orderNo: 'QA-HISTORIC-NOTE', product: 'GPT', plan: 'Plus', businessType: '续费',
      source: '历史入库', email: '', customerId: fixture.commerce.data.customers[0].id,
      payment: '银行卡', cardId: '', paymentId: '', paidAmount: '', paidCurrency: '', saleAmount: '', saleCurrency: '',
      paidConfirmed: false, receiptConfirmed: false, costConfirmed: false,
      costBasis: 'standard', start: '', expiry: '', version: 1, refunds: [], bankReturns: [], corrections: []
    });
  });
  t.after(() => context.close());
  await page.goto(origin + '/#/orders/gpt');
  const row = page.locator(`#main tr[data-row-id="${id}"]`);
  await row.getByRole('button', { name: '编辑', exact: true }).click();
  await page.locator('#drawer #commerce-notes').fill('补录一条说明');
  await page.locator('#drawer button[form="commerce-order-form"][type="submit"]').click();
  await page.locator('#drawer[open]').waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#confirm-dialog[open]').count(), 0);
  const saved = writes[0].data.orders.find(row => row.id === id);
  assert.equal(saved.notes, '补录一条说明');
  assert(writes[0].delta.some(change => change.collection === 'orders' && change.rows[0].id === id));
  for (const key of ['email', 'cardId', 'paidAmount', 'paidCurrency', 'saleAmount', 'saleCurrency', 'start', 'expiry'])
    assert.equal(saved[key], '', key);
  assert.equal(saved.paidConfirmed || saved.receiptConfirmed, false);
  assert.deepEqual(errors, []);
  assert.deepEqual(traffic.external, []);
});

test('手机端可编辑未登记银行卡的 Claude 订单，空卡池和空租户卡不阻止保存', { timeout: 25_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const id = 'manual-without-card';
  const { context, page, writes, errors } = await setup(browser, 'claude', 390, fixture => {
    fixture.commerce.data.orders.push({
      id, orderNo: 'QA-WITHOUT-CARD', product: 'Claude Pro', plan: 'Pro', businessType: '首次开通',
      source: '管理员手工', email: '', customerId: fixture.commerce.data.customers[0].id,
      payment: '银行卡', proMaterialMode: 'none', cardId: '', paymentId: '', paidAmount: '20', paidCurrency: 'USD',
      saleAmount: '100', saleCurrency: 'CNY', paidConfirmed: true, receiptConfirmed: true, costBasis: 'standard',
      start: '2026-11-05T10:00', expiry: '2026-12-05T10:00', version: 1, refunds: [], bankReturns: [], corrections: []
    });
  });
  t.after(() => context.close());
  await page.goto(origin + '/#/orders/claude');
  for (const mode of ['manual_card', 'pool_card', 'tenant_card']) {
    await page.locator(`#main [data-action="commerce-order-more"][data-id="${id}"]`).click();
    await page.getByRole('menuitem', { name: '更正订单资料' }).click();
    const drawer = page.locator('#drawer[open]');
    await drawer.locator('#commerce-proMaterialMode').selectOption(mode);
    if (mode === 'manual_card') {
      await drawer.locator('#commerce-proCardNumber').fill('1234');
      await drawer.locator('button[form="commerce-order-form"][type="submit"]').click();
      await drawer.locator('#commerce-proCardNumber-error').getByText('请填写 12 至 19 位银行卡号').waitFor();
      assert.equal(writes.length, 0);
      await drawer.locator('#commerce-proCardNumber').fill('');
    }
    await drawer.locator('#commerce-notes').fill('只改备注 ' + mode);
    await drawer.locator('button[form="commerce-order-form"][type="submit"]').click();
    await drawer.waitFor({ state: 'hidden' });
    const saved = writes.at(-1).data.orders.find(row => row.id === id);
    assert.deepEqual([saved.email, saved.cardId, saved.proMaterialMode, saved.notes],
      ['', '', 'none', '只改备注 ' + mode]);
  }
  assert.equal(writes.length, 3);
  assert.deepEqual(errors, []);
});

test('财务续费已使用的 GPT 池卡在普通编辑中保留', { timeout: 25_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const id = 'finance-renewal-pool-card', cardId = 'recharge:72', last4 = '0172';
  const { context, page, writes, errors } = await setup(browser, 'gpt', 1440, fixture => {
    fixture['order-cards'] = { items: [] };
    fixture.commerce.data.orders.push({
      id, orderNo: 'QA-FINANCE-POOL', product: 'GPT', plan: 'Plus', businessType: '续费',
      source: '管理员手工', email: 'renewal-pool@example.test', customerId: fixture.commerce.data.customers[0].id,
      payment: '银行卡', proMaterialMode: 'pool_card', cardId, paymentId: last4, paidAmount: '20', paidCurrency: 'USD',
      proCardNumber: '4000000000000172', saleAmount: '100', saleCurrency: 'CNY', paidConfirmed: true, receiptConfirmed: true,
      costBasis: 'standard', start: '2026-11-05T10:00', expiry: '2026-12-05T10:00', version: 1, refunds: [], bankReturns: [],
      corrections: [], financialEvidence: [{ kind: 'payment', cardId, payment: '银行卡', amount: '20', currency: 'USD' }]
    });
  });
  t.after(() => context.close());
  await page.goto(origin + '/#/orders/gpt');
  await page.locator(`#main tr[data-row-id="${id}"]`).getByRole('button', { name: '编辑', exact: true }).click();
  const drawer = page.locator('#drawer[open]');
  assert.equal(await drawer.locator('#commerce-proMaterialMode').inputValue(), 'pool_card');
  assert.equal(await drawer.locator('#commerce-cardId').inputValue(), cardId);
  await drawer.locator('#commerce-notes').fill('保留财务已登记的付款资料');
  await drawer.locator('button[form="commerce-order-form"][type="submit"]').click();
  await drawer.waitFor({ state: 'hidden' });
  const saved = writes[0].data.orders.find(row => row.id === id);
  assert.deepEqual([saved.proMaterialMode, saved.cardId, saved.paymentId, saved.proCardNumber, saved.financialEvidence[0].cardId],
    ['pool_card', cardId, last4, '4000000000000172', cardId]);
  assert.deepEqual(errors, []);
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
  await page.locator('#toast').filter({ hasText: '模拟提交失败' }).waitFor();
  assert.equal(page.url(), url);
  assert.equal(await page.locator('#commerce-email').inputValue(), 'retry@example.test');
  assert.equal(await page.locator('#commerce-notes').inputValue(), '失败保留');
  control.fail = false;
  await submit(); await success();
  assert.equal(page.url(), url);
  assert.equal(writes.length, 2);
  assert.equal(writes[0].data.orders[0].id, writes[1].data.orders[0].id, '重试复用同一提交编号');
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
  assert.notEqual(writes.at(-2).data.orders[0].id, writes.at(-1).data.orders[0].id);
  assert.equal(await page.locator('#commerce-contact-name').inputValue(), '另一个页面的新草稿');
  assert.deepEqual(errors, []); assert.deepEqual(traffic.external, []);
});

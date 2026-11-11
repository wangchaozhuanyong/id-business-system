import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin, settle } from './helpers/offline-design.mjs';

const entry = '/#/workspace/order/claude';
const ordersPath = '/#/orders/claude';
const fixturePath = new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url);
const actor = { id: 'claude-qa-admin', name: '合成管理员', role: 'admin' };
const sampleCard = '4242424242424242';

test('统一 Claude 列表、三档套餐、独立认证与续费', { timeout: 90_000 }, async t => {
  const playwright = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
  const { chromium } = await import(playwright ? pathToFileURL(playwright).href : 'playwright');
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  const customer = fixture.commerce.data.customers.find(row => row.active !== false);
  const verifier = { id: 'qa-verifier', name: '合成认证人', phone: '+60123456780', active: true, version: 1 };
  const payer = { id: 'qa-payer', name: '合成用卡人', phone: '+60123456781', active: true, version: 1 };
  const tenantCard = { id: 'tenant:qa-claude-card', last4: '4242', active: true };
  fixture.commerce.data.tenants.push(verifier, payer);
  fixture['tenant-cards'] = { version: 1, items: [tenantCard] };
  fixture.commerce.data.orders = fixture.commerce.data.orders.filter(row => row.product.startsWith('Claude'));
  const maxExample = fixture.commerce.data.orders.find(row => row.plan === 'Max 5x' && !row.cancelled);
  fixture.commerce.data.orders.push({ ...maxExample, id: 'qa-max-20x-existing', orderNo: 'QA-MAX-20',
    plan: 'Max 20x', email: 'qa-max-20x-existing@example.test' });
  fixture.commerce.data.rentBatches = [{
    id: 'RENT-QA-001', at: '2026-11-09 09:00', notes: '合成付租批次',
    items: [{ id: 'qa-rent', email: 'claude-rent@example.test', tenantId: payer.id,
      period: '2026-10-01 至 2026-11-01', status: '已发放', notes: '' }]
  }];
  const mock = await interceptDesign(context, { localFixtures: fixture, actor, skipRechargeAssets: true });
  const writes = [];
  await context.route('**/api/local/auth/order-owners', route => route.fulfill({ json: { items: [actor] } }));
  await context.route('**/api/local/auth/display-names', route => route.fulfill({ json: { items: [actor] } }));
  await context.route('**/api/local/commerce', route => {
    if (route.request().method() === 'GET') return route.fallback();
    const command = route.request().postDataJSON();
    writes.push(command);
    const data = structuredClone(command.data);
    for (const row of data.orders) delete row.claudeVerifierId;
    fixture.commerce = { version: command.version + 1, data };
    return route.fulfill({ json: fixture.commerce });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(7500);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.setFixedTime(new Date('2026-11-11T04:00:00Z'));
  await page.goto(origin + '/#/orders/pro');
  const table = page.locator('[data-table="commerce-orders-Claude"]');
  const rows = table.locator('tbody tr[data-row-id]');
  const filter = page.locator('#commerce-order-filter-plan');
  const pagination = page.locator('#main [data-pagination="main-list"]');
  await table.waitFor();
  assert.equal(page.url(), origin + ordersPath);
  const menuItems = await page.evaluate(() => window.IDDesignAPI.navigation.find(group => group[0] === '订单管理')[2]
    .filter(([label]) => label.startsWith('Claude')).map(([label, route]) => [label, route]));
  assert.deepEqual(menuItems, [['Claude 订单', 'orders/claude']]);
  assert.equal(await filter.inputValue(), '');
  for (const plan of ['Pro', 'Max 5x', 'Max 20x']) {
    await filter.selectOption(plan);
    const shown = await rows.locator('[data-column="plan"]').allTextContents();
    assert(shown.length > 0, plan);
    assert(shown.every(value => value.trim() === plan), plan);
  }
  await filter.selectOption('');
  await pagination.getByRole('button', { name: '下一页' }).click();
  assert.equal(await pagination.getAttribute('data-page'), '2');
  for (const alias of ['/orders/max', '/orders/exclusive']) {
    await page.goto(origin + '/#' + alias);
    await table.waitFor();
    assert.equal(page.url(), origin + ordersPath);
  }
  await page.getByRole('button', { name: '付租批次', exact: true }).click();
  await page.getByText('合成付租批次', { exact: true }).waitFor();
  await page.getByRole('button', { name: '逐项处理', exact: true }).click();
  await page.getByRole('heading', { name: '租金发放批次详情', exact: true }).waitFor();
  await page.goto(origin + '/#/orders/exclusive/rentals/RENT-QA-001');
  await page.getByText('claude-rent@example.test', { exact: true }).waitFor();
  assert.equal(page.url(), origin + ordersPath + '/rentals/RENT-QA-001');

  await page.goto(origin + entry);
  const form = page.locator('#main #commerce-order-form');
  const field = name => form.locator('#commerce-' + name);
  const choose = async (form, name, id) => {
    await form.locator('#commerce-' + name + '-picker').click();
    await form.locator('#commerce-' + name + '-popover [data-value="' + id + '"]').click();
  };
  const submit = async (root = form) => {
    const scope = root === form ? page.locator('#main') : page.locator('#drawer[open]');
    assert.equal(await scope.locator('[data-action="commerce-order-pending"]').count(), 0);
    await scope.locator('button[form="commerce-order-form"][type="submit"]').click();
    const confirm = page.locator('#confirm-dialog[open]').getByRole('button', { name: '确认保存', exact: true });
    await confirm.click().catch(async error => {
      const fields = await root.locator('.field-error:visible').allTextContents();
      throw new Error([error.message, ...fields].join('\n'));
    });
    await page.locator('#toast').filter({ hasText: '订单提交成功' }).waitFor();
  };
  await field('plan').waitFor();
  assert.deepEqual(await field('plan').locator('option').evaluateAll(nodes => nodes.map(node => node.value)),
    ['', 'Pro', 'Max 5x', 'Max 20x']);
  assert.equal(await field('product').getAttribute('type'), 'hidden');
  assert.equal(await field('claudeVerifierId-picker').isVisible(), false);
  await field('plan').selectOption('Pro');
  await field('businessType').selectOption('首次开通');
  await choose(form, 'customerId', customer.id);
  await choose(form, 'claudeVerifierId', verifier.id);
  await field('kyc').selectOption('KYC 认证');
  assert.equal(await field('verifierPhone').inputValue(), verifier.phone);
  await field('proMaterialMode').selectOption('manual_card');
  await field('proCardNumber').fill(sampleCard);
  await field('proCardSerial').fill('00042-QA');
  await field('email').fill('qa-pro-first@example.test');
  await field('paidAmount').fill('20');
  await field('saleAmount').fill('500');

  await field('businessType').selectOption('续费');
  assert.equal(await field('claudeVerifierId-picker').isVisible(), false);
  await field('businessType').selectOption('首次开通');
  assert.equal(await field('verifierPhone').inputValue(), verifier.phone);
  assert.equal(await field('proCardSerial').inputValue(), '00042-QA');
  await page.goto(origin + '/#/workspace/order/gpt');
  await page.goto(origin + entry);
  await field('claudeVerifierId-picker').waitFor();
  assert.equal(await field('plan').inputValue(), 'Pro');
  assert.equal(await field('verifierPhone').inputValue(), verifier.phone);
  assert.equal(await field('saleAmount').inputValue(), '500');
  await submit();
  const pro = writes.at(-1).data.orders.find(row => row.email === 'qa-pro-first@example.test');
  assert.equal(pro.product, 'Claude Pro');
  assert.equal(pro.claudeVerifierId, verifier.id);
  assert.equal(pro.proCardSerial, '00042-QA');
  assert.equal(pro.paidConfirmed, true);

  await field('plan').selectOption('Max 20x');
  await field('businessType').selectOption('首次开通');
  await choose(form, 'customerId', customer.id);
  await field('email').fill('qa-max-first@example.test');
  await field('proMaterialMode').selectOption('tenant_card');
  await choose(form, 'tenantId', payer.id);
  await field('cardId').locator('option[value="' + tenantCard.id + '"]').waitFor({ state: 'attached' });
  await choose(form, 'cardId', tenantCard.id);
  await choose(form, 'claudeVerifierId', verifier.id);
  await field('kyc').selectOption('KYC 认证');
  await field('paidAmount').fill('200');
  await field('saleAmount').fill('900');
  await submit();
  const max = writes.at(-1).data.orders.find(row => row.email === 'qa-max-first@example.test');
  assert.equal(max.product, 'Claude Max');
  assert.equal(max.plan, 'Max 20x');
  assert.equal(max.tenantId, payer.id);
  assert.equal(max.claudeVerifierId, verifier.id);
  assert.equal(max.verifierPhone, verifier.phone);

  await field('plan').selectOption('Max 5x');
  await field('email').fill('qa-max-independent@example.test');
  await choose(form, 'customerId', customer.id);
  await field('proMaterialMode').selectOption('manual_card');
  await field('proCardNumber').fill(sampleCard);
  await field('paidAmount').fill('100');
  await field('saleAmount').fill('600');
  await submit();
  const standalone = writes.at(-1).data.orders.find(row => row.email === 'qa-max-independent@example.test');
  assert.equal(standalone.product, 'Claude Max');
  assert.equal(standalone.plan, 'Max 5x');
  assert.equal(standalone.paidConfirmed && standalone.receiptConfirmed, true);
  assert.equal(standalone.entitlementStatus, 'active');
  assert.equal(Boolean(standalone.claudeRenewalId || standalone.verifier || standalone.claudeVerifierId), false);

  await page.goto(origin + ordersPath);
  await table.waitFor();
  const search = page.locator('#commerce-search');
  await search.fill(max.email);
  const row = id => table.locator('[data-row-id="' + id + '"]');
  const more = id => row(id).locator('[data-action="commerce-order-more"]').click();
  const menu = page.locator('.row-action-menu:popover-open');
  await more(max.id);
  await menu.getByRole('menuitem', { name: '续费', exact: true }).click();
  const renewal = page.locator('#drawer[open] #commerce-order-form');
  await renewal.waitFor();
  assert.equal(await renewal.locator('#commerce-plan').inputValue(), 'Max 20x');
  assert.equal(await renewal.locator('#commerce-email').inputValue(), max.email);
  assert.equal(await renewal.locator('#commerce-claudeVerifierId-picker').isVisible(), false);
  assert.equal(await renewal.locator('#commerce-cardId').inputValue(), '');
  assert.equal(await renewal.locator('#commerce-expiry').inputValue(), '2027-01-11T12:00');
  await renewal.locator('#commerce-proMaterialMode').selectOption('manual_card');
  await renewal.locator('#commerce-proCardNumber').fill(sampleCard);
  await renewal.locator('#commerce-paidAmount').fill('200');
  await renewal.locator('#commerce-saleAmount').fill('900');
  await submit(renewal);
  const after = writes.at(-1).data.orders;
  const renewed = after.find(order => order.claudeRenewalId === max.id);
  assert.equal(renewed.proRenewalSourceVersion, max.version);
  assert.equal(renewed.email, max.email);
  assert.equal(Boolean(renewed.verifier || renewed.verifierPhone || renewed.kyc), false);
  assert.equal(after.find(order => order.id === max.id).verifier, verifier.name);
  await row(renewed.id).waitFor();
  assert.equal(await rows.count(), 2);
  assert.equal(await row(max.id).locator('input[data-select]').count(), 0);
  assert.equal(await row(renewed.id).locator('input[data-select]').count(), 1);
  await more(max.id);
  assert.equal(await menu.getByRole('menuitem', { name: '续费', exact: true }).count(), 0);
  await page.keyboard.press('Escape');
  await more(renewed.id);
  await menu.getByRole('menuitem', { name: '冻结', exact: true }).click();
  await page.locator('#confirm-dialog[open]').getByRole('button', { name: '确认操作' }).click();
  await row(renewed.id).locator('[data-column="accountStatus"]').getByText('冻结', { exact: true }).waitFor();
  await more(renewed.id);
  await menu.getByRole('menuitem', { name: '恢复使用', exact: true }).click();
  await page.locator('#confirm-dialog[open]').getByRole('button', { name: '确认操作' }).click();
  await row(renewed.id).locator('[data-column="accountStatus"]').getByText('使用中', { exact: true }).waitFor();
  await row(renewed.id).locator('input[data-select]').check();
  await page.getByRole('button', { name: '生成付租批次', exact: true }).click();
  const rental = page.locator('#drawer[open] #commerce-rent-create-form');
  assert.equal(await rental.locator('[name="commerce-ids"]').inputValue(), renewed.id);
  await page.locator('#drawer [data-action="drawer-close"]').first().click();

  for (const [width, theme] of [[1440, 'light'], [390, 'dark']]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(theme => { document.documentElement.dataset.theme = theme; }, theme);
    await search.fill('');
    await filter.selectOption('Max 20x');
    await settle(page);
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth + 1), false);
    await search.fill('qa-no-such-order');
    await table.getByText('暂无符合条件的记录', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: '查看 Claude 订阅', exact: true }).count(), 0);
  }
  assert.deepEqual(errors, []);
  assert.deepEqual(mock.external, []);
});

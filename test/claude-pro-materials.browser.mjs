import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin, settle } from './helpers/offline-design.mjs';

const entry = '/#/workspace/order/claude';
const ordersPath = '/#/orders/claude';
const fixturePath = new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url);
const actor = { id: 'claude-qa-admin', name: '合成管理员', role: 'admin' };
const sampleCard = '4000000000000003';

test('统一 Claude 列表、三档套餐、租户银行卡录入与续费', { timeout: 90_000 }, async t => {
  const playwright = process.env.ID_RECHARGE_QA_PLAYWRIGHT;
  const { chromium } = await import(playwright ? pathToFileURL(playwright).href : 'playwright');
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 }, locale: 'zh-CN' });
  const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
  const customer = fixture.commerce.data.customers.find(row => row.active !== false);
  const verifier = { id: 'qa-verifier', name: '合成认证人', phone: '+60123456780', active: true, version: 1 };
  const maxVerifier = { ...verifier, id: 'qa-verifier-max', name: '另一合成认证人', phone: '+60123456782' };
  const payer = { id: 'qa-payer', name: '合成用卡人', phone: '+60123456781', active: true, version: 1 };
  const tenantNumber = '4242424242424242', unusedNumber = '4000000000000002', newNumber = '5555555555554242';
  const tenantCard = { id: 'tenant:qa-claude-card', tenantId: payer.id, last4: '4242', active: true };
  fixture.commerce.data.tenants.push(verifier, maxVerifier, payer);
  const unusedCard = { id: 'tenant:unused-qa-claude-card', tenantId: payer.id, last4: '0002', active: true };
  const tenantCards = [tenantCard, unusedCard];
  const cardNumbers = new Map([[tenantCard.id, tenantNumber], [unusedCard.id, unusedNumber]]);
  const tenantName = id => fixture.commerce.data.tenants.find(row => row.id === id)?.name;
  const cardMatches = number => tenantCards.filter(row => cardNumbers.get(row.id) === number).map(row =>
    ({ ...row, cardId: row.id, tenantName: tenantName(row.tenantId) }));
  const duplicate = (route, matches) =>
    route.fulfill({ status: 409, json: { error: '已有此银行卡号，不能重复登记', matches } });
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
  const cardAdds = [];
  let revealSelected;
  const revealReady = new Promise(resolve => { revealSelected = resolve; });
  await context.route('**/api/local/tenant-cards*', async route => {
    if (route.request().method() === 'GET') {
      const id = new URL(route.request().url()).searchParams.get('tenantId');
      return route.fulfill({ json: { version: 1, tenantName: tenantName(id),
        items: tenantCards.filter(row => row.tenantId === id), kyc: { status: 'available', accounts: [] } } });
    }
    const command = route.request().postDataJSON();
    if (command.action === 'reveal') {
      await revealReady;
      return route.fulfill({ json: { number: cardNumbers.get(command.id) } });
    }
    const matches = cardMatches(command.number);
    if (command.action === 'lookup') return route.fulfill({ json: { matches } });
    cardAdds.push(command);
    return duplicate(route, matches);
  });
  await context.route('**/api/local/commerce', route => {
    if (route.request().method() === 'GET') return route.fallback();
    const command = route.request().postDataJSON();
    writes.push(command);
    const data = structuredClone(command.data);
    const duplicates = data.tenants.flatMap(row => row.initialCards || []).flatMap(card => cardMatches(card.number));
    if (duplicates.length) return duplicate(route, duplicates);
    for (const row of data.orders.filter(row => row.proMaterialMode === 'tenant_card')) {
      if (row.tenantCardNumber === newNumber && !row.cardId) {
        row.cardId = 'tenant:new-qa-claude-card';
        tenantCards.push({ id: row.cardId, tenantId: row.tenantId, last4: newNumber.slice(-4), active: true });
        cardNumbers.set(row.cardId, newNumber);
      }
      const card = tenantCards.find(card => card.id === row.cardId);
      if (!card) continue;
      delete row.tenantCardNumber;
      row.proCardNumber = cardNumbers.get(card.id);
      Object.assign(card, { used: true, firstUse: { orderNo: row.orderNo, at: '2026-11-11T04:00:00Z' } });
    }
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
  const openSupplement = async () => {
    const section = form.locator('details').filter({ hasText: 'Claude 补充资料' });
    if (await section.getAttribute('open') === null) await section.locator('summary').click();
  };
  const choose = async (form, name, id) => {
    if (name === 'claudeVerifierId') await openSupplement();
    await form.locator('#commerce-' + name + '-picker').click();
    await form.locator('#commerce-' + name + '-popover [data-value="' + id + '"]').click();
  };
  const submit = async (root = form, beforeSave) => {
    const scope = root === form ? page.locator('#main') : page.locator('#drawer[open]');
    const submitted = await root.elementHandle();
    assert.equal(await scope.locator('[data-action="commerce-order-pending"]').count(), 0);
    if (beforeSave) await beforeSave();
    const revision = writes.length;
    await scope.locator('button[form="commerce-order-form"][type="submit"]').click();
    await page.waitForFunction(node => !node.isConnected || node.closest('dialog')?.open === false, submitted).catch(async error => {
      const fields = await root.locator('.field-error:visible').allTextContents();
      throw new Error([error.message, ...fields].join('\n'));
    });
    await submitted.dispose();
    await page.locator('#toast [data-feedback-message]').getByText('订单提交成功', { exact: true }).waitFor();
    assert.equal(writes.length, revision + 1);
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
  await openSupplement();
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
  assert.equal(await field('proMaterialMode').locator('option:checked').textContent(), '租户银行卡');
  await choose(form, 'tenantId', payer.id);
  await field('cardId').locator('option[value="' + tenantCard.id + '"]').waitFor({ state: 'attached' });
  await choose(form, 'cardId', tenantCard.id);
  assert.equal(await field('proCardSerial').isVisible(), false);
  assert.equal(await field('paymentId').isVisible(), false);
  await choose(form, 'claudeVerifierId', maxVerifier.id);
  await field('kyc').selectOption('KYC 认证');
  await field('paidAmount').fill('200');
  await field('saleAmount').fill('900');
  await submit(form, async () => {
    assert.equal(await field('tenantCardNumber').inputValue(), '');
    revealSelected();
    await page.waitForFunction(number => document.querySelector('#commerce-tenantCardNumber').value === number, tenantNumber);
  });
  const max = writes.at(-1).data.orders.find(row => row.email === 'qa-max-first@example.test');
  assert.equal(max.product, 'Claude Max');
  assert.equal(max.plan, 'Max 20x');
  assert.equal(max.tenantId, payer.id);
  assert.equal(max.proCardSerial, undefined);
  assert.equal(max.tenantCardNumber, undefined, '选卡已足以保存');
  assert.equal(max.claudeVerifierId, maxVerifier.id);
  assert.equal(max.verifierPhone, maxVerifier.phone);

  await field('plan').selectOption('Max 5x');
  await field('businessType').selectOption('续费');
  await field('email').fill('qa-max-independent@example.test');
  await field('proMaterialMode').selectOption('none');
  assert.equal(await field('proCardSerial').inputValue(), '', '独立订单没有沿用上单序列号');
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

  await field('plan').selectOption('Pro');
  await choose(form, 'customerId', customer.id);
  await field('email').fill('qa-direct-card@example.test');
  await field('proMaterialMode').selectOption('tenant_card');
  await field('paidAmount').fill('20');
  await field('saleAmount').fill('500');
  const status = form.locator('[data-commerce-field="tenantCardNumber"] [data-tenant-card-status]');
  await field('tenantCardNumber').fill('4000-0000 0000 0002');
  await status.getByText('已匹配租户银行卡。', { exact: false }).waitFor();
  assert.equal(await field('tenantId').inputValue(), payer.id);
  assert.equal(await field('cardId').inputValue(), unusedCard.id);
  assert.equal(await form.evaluate(node => Object.hasOwn(window.IDDesignAPI.readDraft(node), 'commerce-tenantCardNumber')), false);
  await field('tenantCardNumber').fill(tenantNumber);
  await status.getByText('此卡已使用，请选其他银行卡。', { exact: false }).waitFor();
  assert.equal(await field('cardId').inputValue(), '');
  await field('tenantCardNumber').fill(newNumber);
  await status.getByText('未登记。选择租户后，银行卡随订单保存。', { exact: true }).waitFor();
  assert.equal(await field('tenantId').inputValue(), '');
  await choose(form, 'tenantId', verifier.id);
  assert.equal(await field('tenantCardNumber').inputValue(), newNumber);
  await form.locator('[data-commerce-field="tenantId"] [data-action="commerce-quick-tenant"]').click();
  const quick = page.locator('#drawer[open] #commerce-contact-form');
  await quick.locator('#commerce-contact-name').fill('合成新银行卡租户');
  await quick.locator('#commerce-contact-phone').fill('+60123456783');
  await page.locator('#drawer[open] button[form="commerce-contact-form"][type="submit"]').click();
  await page.locator('#confirm-dialog[open]').getByRole('button', { name: '确认保存', exact: true }).click();
  await quick.waitFor({ state: 'hidden' });
  const cardOwner = fixture.commerce.data.tenants.find(row => row.name === '合成新银行卡租户');
  assert.equal(await field('tenantId').inputValue(), cardOwner.id);
  assert.equal(await field('tenantCardNumber').inputValue(), newNumber);
  await submit();
  const direct = writes.at(-1).data.orders.find(row => row.email === 'qa-direct-card@example.test');
  assert.equal(direct.tenantId, cardOwner.id);
  assert.equal(direct.tenantCardNumber, newNumber);
  assert.equal(direct.cardId, '');

  await page.goto(origin + ordersPath);
  await table.waitFor();
  const search = page.locator('#commerce-search');
  const row = id => table.locator('[data-row-id="' + id + '"]');
  await search.fill(pro.proCardSerial);
  await row(pro.id).locator('[data-column="proCardSerial"]').getByText(pro.proCardSerial, { exact: true }).waitFor();
  assert.equal(await rows.count(), 1);
  await row(pro.id).locator('[data-action="commerce-order-detail"]').click();
  const drawer = page.locator('#drawer[open]');
  const serial = drawer.locator('.property-row').filter({ has: page.getByText('卡序列号', { exact: true }) });
  assert.equal(await serial.locator('strong').textContent(), pro.proCardSerial);
  await drawer.getByRole('button', { name: '关闭抽屉', exact: true }).click();
  await search.fill(max.email);
  await row(max.id).locator('[data-action="commerce-order-edit"]').click();
  assert.equal(await drawer.locator('#commerce-proCardSerial').isVisible(), false);
  await drawer.getByRole('button', { name: '关闭抽屉', exact: true }).click();
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
  await renewal.locator('#commerce-proMaterialMode').selectOption('tenant_card');
  await choose(renewal, 'tenantId', payer.id);
  await renewal.locator('#commerce-cardId option[value="' + unusedCard.id + '"]').waitFor({ state: 'attached' });
  await renewal.locator('#commerce-cardId-picker').click();
  const popup = renewal.locator('#commerce-cardId-popover');
  const usedChoice = popup.getByRole('option', { name: /使用中/ });
  await usedChoice.waitFor();
  assert.equal(await usedChoice.isDisabled(), true);
  assert.equal(await popup.getByRole('option', { name: /未使用/ }).isEnabled(), true);
  await popup.getByRole('searchbox', { name: '搜索租户银行卡' }).fill(unusedCard.last4);
  assert.equal(await usedChoice.count(), 0);
  assert.equal(await popup.getByRole('option', { name: /未使用/ }).count(), 1);
  await page.keyboard.press('Escape');
  assert.equal(await renewal.locator('#commerce-expiry').inputValue(), '2027-01-11T12:00');
  await renewal.locator('#commerce-proMaterialMode').selectOption('manual_card');
  assert.equal(await renewal.locator('#commerce-cardTypeId').inputValue(), '');
  await renewal.locator('#commerce-proCardNumber').fill(sampleCard);
  await renewal.locator('#commerce-paidAmount').fill('200');
  await renewal.locator('#commerce-saleAmount').fill('900');
  await submit(renewal);
  const after = writes.at(-1).data.orders;
  const renewed = after.find(order => order.claudeRenewalId === max.id);
  assert.equal(renewed.proRenewalSourceVersion, max.version);
  assert.equal(renewed.email, max.email);
  assert.equal(Boolean(renewed.verifier || renewed.verifierPhone || renewed.kyc), false);
  assert.equal(after.find(order => order.id === max.id).verifier, maxVerifier.name);
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
  await page.goto(origin + '/#/customers/tenants');
  const tenantRow = page.locator(`[data-table="commerce-tenants"] [data-row-id="${cardOwner.id}"]`);
  await tenantRow.getByRole('button', { name: '银行卡记录', exact: true }).click();
  await drawer.getByRole('heading', { name: '租户银行卡', exact: true }).waitFor();
  await drawer.getByText('可认证', { exact: true }).waitFor();
  const registry = drawer.locator('[data-table="commerce-tenant-cards"]');
  await registry.locator('[data-row-id="tenant:new-qa-claude-card"]').getByText('已使用', { exact: true }).waitFor();
  await drawer.locator('#commerce-tenant-card-number').fill(tenantNumber);
  await drawer.getByRole('button', { name: /查看合成用卡人银行卡/ }).waitFor();
  await drawer.getByRole('button', { name: '添加银行卡', exact: true }).click();
  await page.locator('#toast').filter({ hasText: '已有此银行卡号' }).waitFor();
  assert.equal(cardAdds.at(-1).tenantId, cardOwner.id);
  const usedCard = registry.locator(`[data-row-id="${tenantCard.id}"][aria-current="true"]`);
  await usedCard.getByText('已使用', { exact: true }).waitFor();
  await usedCard.getByText(tenantCard.last4, { exact: true }).waitFor();
  assert.equal(await usedCard.evaluate(node => document.activeElement === node), true);

  await drawer.getByRole('button', { name: '关闭抽屉', exact: true }).click();
  await page.locator('[data-action="commerce-contact-add"][data-kind="tenant"]').click();
  await quick.locator('#commerce-contact-name').fill('合成重复登记租户');
  await quick.locator('#commerce-contact-phone').fill('+60123456784');
  await quick.locator('[data-action="commerce-initial-card-add"]').click();
  await quick.locator('#commerce-initial-card-0-number').fill(tenantNumber);
  await quick.getByRole('button', { name: /查看合成用卡人银行卡/ }).waitFor();
  await drawer.locator('button[form="commerce-contact-form"][type="submit"]').click();
  await page.locator('#confirm-dialog[open]').getByRole('button', { name: '确认保存', exact: true }).click();
  await usedCard.waitFor();
  assert.equal(fixture.commerce.data.tenants.some(row => row.name === '合成重复登记租户'), false);
  assert.deepEqual(errors, []);
  assert.deepEqual(mock.external, []);
});

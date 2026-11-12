import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { interceptDesign, origin, root, settle, toggleDesignTheme } from './helpers/offline-design.mjs';

const products = [
  ['gpt', 'GPT', 'Plus', 'gpt', ''],
  ['pro', 'Claude Pro', 'Pro', 'claude', 'pool_card'],
  ['max', 'Claude Max', 'Max 5x', 'claude', 'tenant_card'],
  ['gemini', 'Gemini', 'Google AI Pro', 'gemini', ''],
  ['grok', 'Grok', 'SuperGrok', 'grok', '']
];
const actor = { id: 'payment-layout-admin', name: '合成管理员', role: 'admin' };
const output = process.env.ID_LAYOUT_QA_OUTPUT || root + '/.runtime/order-payment-layout-20261110';

test('所有录单、编辑与续费入口共用支付方式、填写方式、银行卡类型顺序', { timeout: 150_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ headless: true });
  t.after(() => browser.close());
  await mkdir(output, { recursive: true });
  const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  const base = fixture.commerce.data.orders[0], customer = fixture.commerce.data.customers[0];
  const tenant = { id: 'layout-tenant', name: '合成认证人', phone: '00000000', active: true, version: 1 };
  const time = Date.now();
  fixture.commerce.data.tenants = [tenant];
  fixture.commerce.data.orders = products.map(([key, product, plan, , mode]) => ({
    ...base, id: 'layout-' + key, orderNo: 'LAYOUT-' + key, product, plan,
    email: key + '@example.test', customerId: customer.id, tenantId: tenant.id,
    source: '管理员手工', taskId: '', businessType: '续费', accountSource: '客户自有', accountId: '',
    payment: '银行卡', cardTypeId: 'type-layout', cardTypeName: 'wise潘',
    cardId: key === 'max' ? 'tenant:layout' : 'recharge:1', paymentId: key === 'max' ? '4444' : '4242',
    proMaterialMode: mode, billingChannel: 'web', billingCycle: 'month', loginMethod: 'email', entitlementStatus: 'active',
    paidCurrency: 'PHP', paidAmount: '100', saleCurrency: 'CNY', saleAmount: '100',
    start: new Date(time - 20 * 86400000).toISOString(), expiry: new Date(time - 3600000).toISOString(),
    cancelled: false, paidConfirmed: true, receiptConfirmed: true, subscriptionEnded: false,
    corrections: [], refunds: [], bankReturns: [], financialEvidence: [], version: 1
  }));
  fixture['card-types'] = { version: 1, items: [{ id: 'type-layout', name: 'wise潘', active: true }],
    assignments: { 'recharge:1': 'type-layout', 'tenant:layout': 'type-layout' } };
  fixture['order-cards'] = { items: [{ id: 'recharge:1', last4: '4242', active: true, status: '正常', usageCount: 2 }] };
  fixture['tenant-cards'] = { version: 1, items: [{ id: 'tenant:layout', last4: '4444', active: true }] };
  fixture['auth/order-owners'] = { items: [actor] };
  fixture['auth/display-names'] = { items: [actor] };
  const results = [];
  for (const width of [2480, 1440, 1024, 768, 390, 320]) for (const theme of ['light', 'dark']) {
    await t.test(`${width} ${theme}`, async () => {
      const context = await browser.newContext({ viewport: { width, height: 1000 }, locale: 'zh-CN' });
      try {
        const traffic = await interceptDesign(context, { localFixtures: structuredClone(fixture), actor, skipRechargeAssets: true });
        const writes = [], errors = [], prepared = new Set();
        await context.route('**/api/local/**', route => {
          if (route.request().method() === 'GET') return route.fallback();
          const path = new URL(route.request().url()).pathname;
          if (path === '/api/local/subscriptions/lookup') return route.fallback();
          const command = route.request().postDataJSON();
          if (path === '/api/local/tenant-cards' && command.action === 'reveal')
            return route.fulfill({ json: { number: '5555555555554444' } });
          if (path === '/api/local/subscription-renewal-card' && command.action === 'prepare') {
            prepared.add(command.orderId);
            return route.fulfill({ json: { orderId: command.orderId, hasCard: false, availability: 'review' } });
          }
          writes.push(path);
          return route.abort();
        });
        const page = await context.newPage();
        page.setDefaultTimeout(6000);
        page.on('pageerror', error => errors.push(error.message));
        await page.goto(origin + '/#/workspace/order/gpt');
        if (theme === 'dark') await toggleDesignTheme(page);
        const go = async route => {
          await page.evaluate(route => window.IDDesignAPI.go(route), route);
          await page.locator(`#main[data-layout-route="${route}"]`).waitFor();
        };
        const choose = async (form, name, id) => {
          await form.locator(`#commerce-${name}-picker`).click();
          await page.locator(`#commerce-${name}-popover [data-value="${id}"]`).click();
        };
        const inspect = async (form, key, contextName, card = 'cardId') => {
          await form.locator('details.commerce-span-all').evaluateAll(groups => {
            for (const group of groups) group.open = true;
          });
          await settle(page);
          const number = key === 'max' ? 'tenantCardNumber' : 'paymentId';
          const measured = await form.evaluate((node, { card, number }) => {
            const field = name => node.querySelector(`[data-commerce-field="${name}"]`);
            const rect = el => el.getBoundingClientRect().toJSON();
            const label = el => {
              const range = document.createRange();
              range.selectNodeContents(el.querySelector(':scope > label'));
              return rect(range);
            };
            const next = field('tenantId')?.checkVisibility() ? 'tenantId' : card;
            const names = ['payment', 'cardTypeId', card, number, 'proMaterialMode', next, 'proCardSerial'];
            const fields = names.map(name => ({ name, box: rect(field(name)), text: label(field(name)) }));
            const rows = [...node.querySelectorAll('.field')].filter(row =>
              row.checkVisibility() && !row.closest('.order-financial-group')).map(row => {
              const customerPicker = row.querySelector('.order-customer-row .commerce-picker-trigger');
              return {
                name: row.closest('[data-commerce-field]').dataset.commerceField,
                box: rect(row),
                text: label(row),
                control: rect(row.querySelector(':scope > .field-control').firstElementChild),
                customerPicker: customerPicker ? rect(customerPicker) : null
              };
            });
            const finance = [...node.querySelectorAll('.order-financial-group')].map(group => {
              const bounds = rect(group);
              const title = group.querySelector('h3');
              const actions = group.querySelector('.order-financial-actions');
              const rows = [...group.querySelectorAll(':scope > .field')].map(row => {
                const field = rect(row);
                const text = label(row);
                const control = rect(row.querySelector('.field-control').firstElementChild);
                const summary = row.querySelector('.field-title-help summary');
                const help = summary ? rect(summary) : null;
                return {
                  name: row.dataset.commerceField,
                  labelInset: text.left - field.left,
                  controlInset: field.right - control.right,
                  spaceBeforeControl: control.left - (help?.right ?? text.right),
                  helpGap: help ? help.left - text.right : null,
                  helpSize: help ? Math.min(help.width, help.height) : null
                };
              });
              return { name: title.textContent, top: bounds.top,
                leftInset: rect(title).left - bounds.left, rightInset: bounds.right - rect(actions).right, rows };
            });
            return { fields, rows, finance, columns: getComputedStyle(field('payment').parentElement).gridTemplateColumns.split(' ').length,
              order: [...field('payment').parentElement.querySelectorAll(':scope > [data-commerce-field]')]
                .filter(el => el.checkVisibility()).map(el => el.dataset.commerceField),
              overflow: document.documentElement.scrollWidth > innerWidth + 1,
              management: node.querySelectorAll('[data-action="commerce-card-types"]').length,
              typeButtons: field('cardTypeId').querySelectorAll('.field-control button').length,
              ids: [...node.querySelectorAll('[id]')].map(el => el.id) };
          }, { card, number });
          assert.equal(measured.management, 0);
          assert.equal(measured.typeButtons, 0, '银行卡类型下拉不再混入管理操作');
          assert.equal(measured.overflow, false);
          assert.equal(new Set(measured.ids).size, measured.ids.length, '各产品控件 ID 唯一');
          assert.deepEqual(measured.order.slice(0, 3), ['payment', 'proMaterialMode', 'cardTypeId']);
          assert.equal(measured.order.indexOf(number), measured.order.indexOf(card) + 1, '卡号紧跟选卡');
          assert.equal(measured.order.includes('proCardSerial'), key !== 'max');
          const typeField = form.locator('#commerce-cardTypeId');
          assert.equal(await typeField.isDisabled(), key === 'max', '租户银行卡锁定类型');
          if (key === 'max') assert.equal(await typeField.locator('option:checked').textContent(), '真实卡');
          const [payment, type, picker, tail, mode, next, serial] = measured.fields;
          const sameRow = (left, right) => {
            assert(Math.abs(left.box.top - right.box.top) <= 1);
            assert(right.box.left > left.box.left);
            assert(Math.abs(left.text.top - right.text.top) <= 2, `${left.name} 与 ${right.name} 的标签应对齐`);
          };
          if (measured.columns === 2) {
            sameRow(payment, mode);
            sameRow(type, next);
            assert(Math.abs(type.box.width - next.box.width) <= 1, '卡类型与下一步各占半行');
            if (key === 'max') sameRow(picker, tail);
            else sameRow(tail, serial);
          } else {
            assert(mode.box.top >= payment.box.bottom - 1);
            assert(type.box.top >= mode.box.bottom - 1);
            assert(next.box.top >= type.box.bottom - 1);
            assert(tail.box.top >= picker.box.bottom - 1);
          }
          if (next.name !== picker.name) assert(picker.box.top >= next.box.bottom - 1);
          const plan = measured.rows.find(row => row.name === 'plan');
          const business = measured.rows.find(row => row.name === 'businessType');
          const references = measured.columns === 2 ? [plan, business] : [plan];
          const rightEdge = references.at(-1).control.right;
          if (measured.columns === 2) sameRow(plan, business);
          else assert(business.box.top >= plan.box.bottom - 1);
          for (const row of measured.rows) {
            const context = `${width}/${theme}/${key}/${contextName}/${row.name}`;
            const reference = references.find(column => Math.abs(column.box.left - row.box.left) <= 1);
            assert(reference, `${context} 行应沿同一列左边缘`);
            assert(Math.abs(row.text.left - reference.box.left) <= 1, `${context} 字段名靠左`);
            assert(Math.abs(row.control.left - reference.control.left) <= 1, `${context} 控件左边缘对齐`);
            assert([reference.control.right, rightEdge].some(edge => Math.abs(row.control.right - edge) <= 1),
              `${context} 控件右边缘对齐`);
            if (row.customerPicker)
              assert(Math.abs(row.text.top + row.text.height / 2 - row.customerPicker.top - row.customerPicker.height / 2) <= 2,
                `${context} 客户标签与选择框垂直对齐`);
          }
          for (const left of measured.rows.filter(row => Math.abs(row.box.left - plan.box.left) <= 1)) {
            const peer = measured.rows.find(row => row.box.left > left.box.left + 1 && Math.abs(row.box.top - left.box.top) <= 1);
            if (peer) {
              assert(Math.abs(peer.text.top - left.text.top) <= 2, `${left.name}/${peer.name} 同行标签对齐`);
              assert(Math.abs(peer.control.top - left.control.top) <= 1, `${left.name}/${peer.name} 同行控件对齐`);
            }
          }
          if (width === 2480 && contextName === 'entry')
            assert(measured.finance.every(group => Math.abs(group.top - measured.finance[0].top) <= 1));
          for (const group of measured.finance) {
            const context = `${width}/${theme}/${key}/${contextName}/${group.name}`;
            assert(group.leftInset >= 8 && Math.abs(group.leftInset - group.rightInset) <= 1, context);
            for (const row of group.rows) {
              assert(Math.abs(row.labelInset) <= 1 && Math.abs(row.controlInset) <= 1 && row.spaceBeforeControl >= -1,
                `${context}/${row.name} ${JSON.stringify(row)}`);
              if (row.helpGap !== null)
                assert(row.helpGap >= -1 && row.helpGap <= 8 && row.helpSize >= (width <= 900 ? 44 : 36), context);
            }
          }
          if (key === 'gpt' && contextName === 'entry' && [2480, 390].includes(width)) {
            const start = form.locator('[data-commerce-field="start"]');
            const help = start.locator('.field-title-help');
            const trigger = help.locator('summary');
            const control = start.locator('input');
            assert.equal(await help.getAttribute('open'), null);
            await trigger.focus();
            const before = await control.boundingBox();
            await trigger.press('Enter');
            await help.locator('.title-description:popover-open').waitFor();
            assert.deepEqual(await control.boundingBox(), before);
            await page.keyboard.press('Escape');
            assert.equal(await help.getAttribute('open'), null);
          }
          results.push({ width, theme, key, context: contextName, ...measured });
          await form.locator('details.commerce-span-all').evaluateAll(groups => {
            for (const group of groups) group.open = false;
          });
          if (key === 'gpt' && [1440, 1024, 390].includes(width) && ['entry', 'edit'].includes(contextName))
            await form.locator('.order-payment-options').first().screenshot({ path: `${output}/${contextName}-${key}-${width}-${theme}.png` });
        };
        for (const [key, product, plan, entry, mode] of products) {
          await go('workspace/order/' + entry);
          const form = page.locator('#main #commerce-order-form');
          await form.locator('#commerce-cardTypeId').waitFor();
          await form.locator('#commerce-plan').selectOption(plan);
          if (entry === 'claude') await form.locator('#commerce-payment').selectOption('银行卡');
          await form.locator('#commerce-proMaterialMode').selectOption(mode);
          if (key === 'max') await choose(form, 'tenantId', tenant.id);
          const card = mode === 'pool_card' ? 'proPoolCardId' : 'cardId';
          await choose(form, card, key === 'max' ? 'tenant:layout' : 'recharge:1');
          assert.equal(await form.locator('#commerce-paymentId').inputValue(), key === 'max' ? '4444' : '4242');
          if (key === 'max') await page.waitForFunction(() => document.querySelector('#commerce-tenantCardNumber').value === '5555555555554444');
          await inspect(form, key, 'entry', card);
          await form.locator('#commerce-payment').selectOption('苹果内购');
          assert.equal(await form.locator('#commerce-cardTypeId').isVisible(), false);
          assert.equal(await form.locator('#commerce-paymentId').isVisible(), false);
          assert.equal(await form.locator('#commerce-proCardSerial').isVisible(), false);
          if (key === 'max') assert.equal(await form.locator('#commerce-tenantCardNumber').isVisible(), false);
          await form.locator('#commerce-payment').selectOption('银行卡');

          await go('orders/' + (entry === 'claude' ? 'claude' : key));
          await page.locator(`[data-action="commerce-order-edit"][data-id="layout-${key}"]`).click();
          const edit = page.locator('#drawer[open] #commerce-order-form');
          await edit.locator('#commerce-cardTypeId').waitFor();
          await inspect(edit, key, 'edit', card);
          await page.locator('#drawer [data-action="drawer-close"]').first().click();
          await go('workspace/order/renew/layout-' + key);
          await form.locator('#commerce-cardTypeId').waitFor();
          await form.locator('#commerce-proMaterialMode').selectOption(mode);
          await inspect(form, key, 'renewal', card);
        }
        assert.deepEqual(errors, []);
        assert.deepEqual([...prepared].sort(), products.map(([key]) => 'layout-' + key).sort(), '续费录单只读核对原用卡');
        assert.deepEqual(writes, [], '布局验证不写入业务数据');
        assert.deepEqual(traffic.external, []);
        assert.deepEqual(traffic.unavailable, []);
      } finally { await context.close(); }
    });
  }
  await writeFile(output + '/results.json', JSON.stringify(results, null, 2));
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { orderCustomerCreateAction } from '../frontend/order-opening.mjs';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

const products = [
  ['gpt', 'GPT', 'Plus', 'history-gpt@example.test', 1440],
  ['claude', 'Claude Pro', 'Pro', 'history-claude@example.test', 1440],
  ['gemini', 'Gemini', 'Google AI Pro', 'history-gemini@example.test', 390],
  ['grok', 'Grok', 'The X Subscription Premium', '@history_grok', 320]
];
const actor = { id: 'match-admin', name: '隔离录单员', role: 'admin' };
const localTime = at => new Date(at + 28_800_000).toISOString().slice(0, 16);

test('四个录单入口匹配客户和历史账号，随单建档未提交不写入，失败后可重试', { timeout: 80_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  for (const [slug, product, plan, history, width] of products) await t.test(product, async () => {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    try {
      const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
      const sample = fixture.commerce.data.orders.find(row => row.product === 'GPT');
      fixture.commerce.data.customers = [
        { id: 'known', name: '合成老客户', wechat: 'known_wechat', phone: '+1 202 555 0101', active: true, version: 1 },
        { id: 'first', name: '合成同名', wechat: 'first', active: true, version: 1 },
        { id: 'second', name: '合成同名', wechat: 'second', active: true, version: 1 },
        { id: 'inactive', name: '合成停用', wechat: 'inactive', active: false, version: 1 },
        { id: 'incomplete', name: '微信未登记', active: true, version: 1 }
      ];
      const now = Date.now();
      fixture.commerce.data.orders = products.map(([id, product, plan, identity]) => ({
        ...sample, id: 'history-' + id, orderNo: 'HISTORY-' + id, product, plan, customerId: 'known',
        email: identity.startsWith('@') ? '' : identity, xHandle: identity.startsWith('@') ? identity : '',
        loginMethod: id === 'grok' ? 'x' : 'email', accountId: '', accountSource: '客户自有',
        businessType: '续费', entitlementStatus: 'active', start: localTime(now - 14 * 86_400_000),
        expiry: localTime(now - 86_400_000), cancelled: false, ownerId: actor.id, owner: actor.name
      }));
      fixture['auth/order-owners'] = { items: [actor] };
      fixture['auth/display-names'] = { items: [actor] };
      const traffic = await interceptDesign(context, { actor, localFixtures: fixture, skipRechargeAssets: true });
      const writes = [];
      let fail = false;
      await context.route('**/api/local/commerce', route => {
        if (route.request().method() === 'GET') return route.fulfill({ json: fixture.commerce });
        const body = route.request().postDataJSON();
        writes.push(body);
        if (body.version !== fixture.commerce.version)
          return route.fulfill({ status: 409, json: { error: '订单已在其他页面更新，请刷新后重试' } });
        if (fail) return route.fulfill({ status: 400, json: { error: '模拟拒绝订单' } });
        fixture.commerce = { version: body.version + 1, data: body.data };
        return route.fulfill({ json: fixture.commerce });
      });
      const page = await context.newPage(), errors = [];
      page.setDefaultTimeout(6000);
      page.on('pageerror', error => errors.push(error.message));
      const url = origin + '/#/workspace/order/' + slug;
      await page.goto(url);
      const form = page.locator('#main #commerce-order-form');
      const name = form.locator('#order-quick-customer-name');
      const wechat = form.locator('#order-quick-customer-wechat');
      const status = form.locator('#order-quick-customer-status');
      const add = form.locator('[data-action="commerce-quick-customer"]');
      const select = form.locator('#commerce-customerId');
      const email = form.locator('#commerce-email');
      const dialog = page.locator('#confirm-dialog[open]');
      const submit = page.locator('button[form="commerce-order-form"][type="submit"]');
      await select.locator('option[value="known"]').waitFor({ state: 'attached' });
      if (slug === 'claude') await form.locator('#commerce-plan').selectOption(plan);
      await form.locator('.order-quick-customer-disclosure > summary').click();
      assert(await add.isDisabled());
      if (slug === 'gpt') {
        await name.evaluate(input => {
          input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
          input.value = '合成老客户';
          input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
        });
        assert.equal(await select.inputValue(), '');
        await name.dispatchEvent('compositionend', { bubbles: true });
      } else await name.fill('合成老客户');
      assert.equal(await select.inputValue(), 'known');
      assert.equal(await form.locator('#commerce-wechat').inputValue(), 'known_wechat');
      assert.equal(await form.locator('#commerce-customerPhone').inputValue(), '+1 202 555 0101');
      assert.equal(await email.inputValue(), history);
      assert(await add.isDisabled());
      if (slug === 'gpt') {
        await page.evaluate(() => { location.hash = '#/customers/new'; });
        await page.locator('#commerce-contact-name').waitFor();
        await page.evaluate(() => { location.hash = '#/workspace/order/gpt'; });
        await name.waitFor();
        assert.equal(await name.inputValue(), '合成老客户');
        assert.equal(await select.inputValue(), 'known');
        assert.equal(await email.inputValue(), history);
        await email.fill('temporary@example.test');
        await email.fill(history);
        await name.fill('合成同名');
        assert.equal(await email.inputValue(), history, '手填与历史相同的邮箱仍按手填保留');
        await email.fill('');
        await name.fill('合成老客户');
        assert.equal(await email.inputValue(), history);
      }
      await name.press('Enter');
      assert.equal(await dialog.count(), 0);
      assert.equal(writes.length, 0);

      await name.fill('合成同名');
      assert.equal(await select.inputValue(), '');
      assert.equal(await email.inputValue(), '', '清除上一个客户带出的历史账号');
      assert.equal(await form.locator('#commerce-wechat').inputValue(), '');
      assert(await add.isDisabled());
      await wechat.fill('ＳＥＣＯＮＤ');
      assert.equal(await select.inputValue(), 'second');
      await email.fill(history);
      await wechat.fill('known_wechat');
      assert.match(await status.innerText(), /此微信已关联其他姓名/);
      assert.equal(await select.inputValue(), '');
      assert.equal(await email.inputValue(), history, '手填账号即使等于历史值也保留');
      await wechat.fill('');
      await name.fill('合成停用');
      assert.match(await status.innerText(), /停用/);
      assert(await add.isDisabled());

      if (slug === 'gpt') {
        await name.fill('合成同名');
        await wechat.fill('distinct_wechat');
        assert(await add.isEnabled());
        await add.click();
        await page.locator('#drawer[open] [data-action="drawer-close"]').first().click();
        await name.fill('微信未登记');
        assert(await add.isDisabled());
        await wechat.fill('');
        await name.fill('全量建档客户');
        await add.click();
        const drawer = page.locator('#drawer[open]');
        const contactWechat = drawer.locator('input#commerce-contact-wechat');
        await contactWechat.fill('known_wechat');
        await drawer.locator('button[form="commerce-contact-form"]').click();
        await drawer.locator('#commerce-contact-wechat-error').getByText(/此微信已关联其他姓名/).waitFor();
        assert.equal(writes.length, 0);
        await contactWechat.fill('full_customer');
        await drawer.locator('#commerce-contact-phone').fill('+1 202 555 0102');
        await drawer.locator('button[form="commerce-contact-form"]').click();
        await drawer.waitFor({ state: 'hidden' });
        const saved = fixture.commerce.data.customers.find(row => row.name === '全量建档客户');
        assert.equal(saved.wechat, 'full_customer');
        assert.equal(await select.inputValue(), saved.id);
      }

      const freshName = '随单客户 ' + slug;
      const fillQuickOrder = async (customerName, customerWechat) => {
        if (!(await name.isVisible())) await form.locator('.order-quick-customer-disclosure > summary').click();
        await name.fill(customerName);
        await wechat.fill(customerWechat);
        await status.getByText('提交订单时将新增客户。', { exact: true }).waitFor();
        assert.equal(await select.inputValue(), '');
        if (slug === 'claude') await form.locator('#commerce-plan').selectOption(plan);
        await form.locator('#commerce-proCardNumber').fill('4242424242424242');
        await email.fill('manual-' + slug + '@example.test');
        await form.locator('#commerce-start').fill(localTime(now));
        await form.locator('#commerce-expiry').fill(localTime(now + 86_400_000));
        await form.locator('#commerce-saleCurrency').selectOption('CNY');
        await form.locator('#commerce-saleAmount').fill('100');
        await form.locator('#commerce-paidAmount').fill('20');
        await form.locator('#commerce-notes').fill('保留本单备注');
      };
      if (width < 400) await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
      await fillQuickOrder(freshName, 'quick_' + slug);
      assert(await status.evaluate(node => {
        const box = node.getBoundingClientRect();
        return box.width > 0 && box.left >= 0 && box.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth;
      }), '窄屏状态文字在视口内');
      const count = writes.length;
      assert.equal(await dialog.count(), 0);
      assert(!fixture.commerce.data.customers.some(row => row.name === freshName));
      assert.equal(writes.length, count);

      if (slug === 'claude') {
        fail = true;
        await submit.click();
        await page.locator('#toast').getByText(/模拟拒绝订单/).waitFor();
        assert(!fixture.commerce.data.customers.some(row => row.name === freshName));
        assert.equal(await name.inputValue(), freshName);
        assert.equal(await form.locator('#commerce-notes').inputValue(), '保留本单备注');
        fail = false;
      }
      await submit.click();
      await page.locator('#toast').getByText(/订单提交成功/).waitFor();
      assert.equal(writes.length, count + (slug === 'claude' ? 2 : 1));
      assert.equal(page.url(), url);
      const write = writes.at(-1);
      assert.equal(write.action, orderCustomerCreateAction);
      const savedCustomer = write.data.customers.find(row => row.name === freshName);
      assert.equal(savedCustomer.wechat, 'quick_' + slug);
      assert.equal(write.data.orders[0].customerId, savedCustomer.id);
      assert.equal(write.data.orders[0].wechat, savedCustomer.wechat);
      assert.equal(await name.inputValue(), '');

      if (slug === 'grok') {
        await fillQuickOrder('另一页先登记', 'other_tab');
        fixture.commerce.data.customers.unshift({ id: 'other-tab', name: '另一页先登记', wechat: 'other_tab', active: true, version: 1 });
        fixture.commerce.version++;
        await submit.click();
        await page.locator('#toast').getByText(/本次未保存，请核对客户及订单后再提交/).waitFor();
        assert.equal(await select.inputValue(), 'other-tab');
        assert.equal(await email.inputValue(), 'manual-grok@example.test');
        assert.equal(await form.locator('#commerce-notes').inputValue(), '保留本单备注');
        assert(await add.isDisabled());
        await submit.click();
        await page.locator('#toast').getByText(/订单提交成功/).waitFor();
        assert.equal(await dialog.count(), 0);
        assert.equal(fixture.commerce.data.customers.filter(row => row.wechat === 'other_tab').length, 1);
        assert.equal(fixture.commerce.data.orders[0].customerId, 'other-tab');
      }
      assert.deepEqual(errors, []);
      assert.deepEqual(traffic.external, []);
    } finally {
      await context.close();
    }
  });
});

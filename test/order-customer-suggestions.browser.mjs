import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import test from 'node:test';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

const actor = { id: 'suggestion-admin', name: '合成录单员', role: 'admin' };
const routes = [
  ['gpt', 'GPT', 'Plus', 1440],
  ['claude', 'Claude Pro', 'Pro', 1440],
  ['gemini', 'Gemini', 'Google AI Pro', 390],
  ['grok', 'Grok', 'The X Subscription Premium', 320]
];
const chosenCustomer = {
  id: 'suggestion-selected', name: '联想同名客户', wechat: 'one_desk', phone: '+1 202 555 0101',
  qq: '1234567', telegram: '@test_selection', whatsapp: '+60 12 345 6789'
};
const customer = (id, name, wechat) => ({ id, name, wechat, active: true, version: 1 });
const fixtureUrl = new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url);
const routeUrl = slug => origin + '/#/workspace/order/' + slug;
const localTime = at => new Date(at + 28_800_000).toISOString().slice(0, 16);

async function orderFixtures(slug, product, plan, width) {
  const fixtures = JSON.parse(await readFile(fixtureUrl));
  fixtures.commerce.data.customers = [
    customer('rank-contains', '等级包含', 'x-ab-y'),
    customer('rank-prefix', '等级前缀', 'ab-west'),
    customer('rank-exact', '等级精确', 'AB'),
    ...Array.from({ length: 9 }, (_, index) =>
      customer('rank-extra-' + index, '等级客户' + index, 'group-ab-' + index)),
    { ...customer('inactive', '联想停用客户', 'inactive_desk'), active: false },
    customer('same-name', chosenCustomer.name, 'another_contact'),
    { ...customer(chosenCustomer.id, chosenCustomer.name, chosenCustomer.wechat), ...chosenCustomer },
    ...Array.from({ length: width < 640 ? 1000 : 10000 }, (_, index) =>
      customer('unrelated-' + index, '其他合成客户' + index, 'separate-' + index))
  ];
  const sample = fixtures.commerce.data.orders.find(row => row.product === 'GPT');
  const time = Date.now();
  fixtures.commerce.data.orders = [{
    ...sample, id: 'suggestion-history', orderNo: 'QA-SUGGESTION-HISTORY', product, plan,
    customerId: chosenCustomer.id, email: 'history-' + slug + '@example.test', xHandle: '',
    loginMethod: 'email', accountId: '', accountSource: '客户自有', businessType: '续费',
    entitlementStatus: 'active', start: localTime(time - 14 * 86_400_000),
    expiry: localTime(time - 86_400_000), cancelled: false, ownerId: actor.id, owner: actor.name
  }];
  fixtures['auth/order-owners'] = { items: [actor] };
  fixtures['auth/display-names'] = { items: [actor] };
  return fixtures;
}

test('四个手工录单入口支持客户联想、显式选择和草稿保留', { timeout: 70_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());

  for (const [slug, product, plan, width] of routes) await t.test(product, async () => {
    const mobile = width < 640;
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: mobile });
    try {
      const localFixtures = await orderFixtures(slug, product, plan, width);
      const traffic = await interceptDesign(context, { actor, localFixtures, skipRechargeAssets: true });
      const writes = [];
      context.on('request', request => {
        if (request.method() === 'PUT' && new URL(request.url()).pathname === '/api/local/commerce')
          writes.push(request.postDataJSON());
      });

      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.setDefaultTimeout(6000);
      await page.goto(routeUrl(slug));
      const form = page.locator('#main #commerce-order-form');
      const name = form.locator('#commerce-customerName');
      const wechat = form.locator('#commerce-wechat');
      const email = form.locator('#commerce-email');
      const notes = form.locator('#commerce-notes');
      const customerId = form.locator('#commerce-customerId');
      const nameList = form.locator('#commerce-customerName-suggestions');
      const wechatList = form.locator('#commerce-wechat-suggestions');
      const choice = list => list.getByRole('option').filter({ hasText: chosenCustomer.wechat });
      await form.locator('#commerce-ownerId option[value="suggestion-admin"]').waitFor({ state: 'attached' });
      if (mobile) await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });

      const manualEmail = 'manual-' + slug + '@example.test';
      await email.fill(manualEmail);
      await notes.fill('保留订单备注');

      if (slug === 'gpt') {
        await wechat.fill('a');
        assert.equal(await wechatList.isVisible(), false, '单字符微信不展开联想');
        await wechat.fill('ＡＢ');
        await wechatList.waitFor();
        const options = await wechatList.getByRole('option')
          .evaluateAll(nodes => nodes.map(node => node.dataset.orderCustomerSuggestion));
        assert.equal(options.length, 8);
        assert.deepEqual(options.slice(0, 2), ['rank-exact', 'rank-prefix']);
        assert(options.slice(2).every(id => id === 'rank-contains' || id.startsWith('rank-extra-')));
        await wechat.press('Escape');
        await wechatList.waitFor({ state: 'hidden' });
      }

      const trigger = mobile ? name : wechat;
      const list = mobile ? nameList : wechatList;
      if (slug === 'gemini') {
        await name.focus();
        await name.evaluate(input => {
          input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
          input.value = '联';
          input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
        });
        assert.equal(await nameList.isVisible(), false, '输入法组合期间不展开联想');
        await name.dispatchEvent('compositionend', { bubbles: true });
      } else {
        await trigger.fill(mobile ? '联' : 'e_desk');
      }
      await choice(list).waitFor();
      assert.equal(await customerId.inputValue(), '', '局部匹配只显示候选');
      assert.equal(await trigger.inputValue(), mobile ? '联' : 'e_desk');
      const results = await list.getByRole('option').allTextContents();
      const pickedText = await choice(list).innerText();
      assert.match(pickedText, /联想同名客户/);
      assert.match(pickedText, /one_desk/);
      assert.match(pickedText, /\*{2,}\s*01\b/);
      assert.doesNotMatch(pickedText.replace(/\D/g, ''), /2025550101/);
      assert(results.every(value => !value.includes('联想停用客户') && !value.includes('inactive_desk')));
      if (mobile) assert.equal(results.length, 2, '一字姓名查询能区分同名客户');

      if (slug === 'gpt') {
        const [inputBox, listBox] = await Promise.all([wechat.boundingBox(), wechatList.boundingBox()]);
        assert(listBox.y >= inputBox.y + inputBox.height && Math.abs(listBox.x - inputBox.x) <= 1,
          '宽屏有足够空间时，联想紧贴当前输入框下方');
        const qq = form.locator('#commerce-qq');
        const opened = await qq.boundingBox();
        await wechat.press('Escape');
        await wechatList.waitFor({ state: 'hidden' });
        const closed = await qq.boundingBox();
        assert(Math.abs(opened.y - closed.y) <= 1 && Math.abs(opened.x - closed.x) <= 1,
          '候选浮层的开合不会移动其他表单字段');
        assert.equal(await wechat.evaluate(node => node === document.activeElement), true);
        assert.equal(await wechat.inputValue(), 'e_desk');
        await wechat.fill('e_d');
        await choice(wechatList).waitFor();
        await wechat.press('ArrowDown');
        const activeOption = await wechat.getAttribute('aria-activedescendant');
        assert(activeOption);
        await wechat.press('ArrowUp');
        assert(await wechat.getAttribute('aria-activedescendant'));
        await wechat.press('Enter');
        assert.equal(await wechat.evaluate(node => node === document.activeElement), true);
      } else if (mobile) {
        const viewport = await list.boundingBox();
        assert(viewport && viewport.x >= 0 && viewport.x + viewport.width <= width + 1 &&
          viewport.y >= 0 && viewport.y + viewport.height <= 901);
        if (width === 320) {
          await page.evaluate(() => scrollTo(0, document.scrollingElement.scrollHeight));
          await page.waitForFunction(() => document.querySelector('#commerce-customerName').getBoundingClientRect().bottom < 0);
          await list.waitFor({ state: 'hidden' });
          assert.equal(await name.inputValue(), '联');
          await name.scrollIntoViewIfNeeded();
          await name.press('ArrowDown');
          await choice(list).waitFor();
        }
        await choice(list).tap();
      } else await choice(list).click();

      await list.waitFor({ state: 'hidden' });
      assert.equal(await customerId.inputValue(), chosenCustomer.id);
      assert.equal(await name.inputValue(), chosenCustomer.name);
      assert.equal(await wechat.inputValue(), chosenCustomer.wechat);
      assert.equal(await form.locator('#order-phone-prefix').inputValue(), '1');
      assert.equal(await form.locator('#commerce-customerPhone').inputValue(), '2025550101');
      assert.equal(await form.locator('#commerce-qq').inputValue(), chosenCustomer.qq);
      assert.equal(await form.locator('#commerce-telegram').inputValue(), chosenCustomer.telegram);
      assert.equal(await form.locator('#order-whatsapp-prefix').inputValue(), '60');
      assert.equal(await form.locator('#commerce-whatsapp').inputValue(), '123456789');
      assert.equal(await email.inputValue(), manualEmail);
      assert.equal(await notes.inputValue(), '保留订单备注');

      if (slug === 'gpt') {
        await page.evaluate(() => { location.hash = '#/customers/new'; });
        await page.locator('#commerce-contact-name').waitFor();
        await page.evaluate(() => { location.hash = '#/workspace/order/gpt'; });
        await form.waitFor();
        assert.equal(await customerId.inputValue(), chosenCustomer.id);
        assert.equal(await wechatList.isVisible(), false);
        assert.equal(await email.inputValue(), manualEmail);

        await name.fill('联');
        await nameList.getByRole('option').filter({ hasText: 'another_contact' }).click();
        assert.equal(await customerId.inputValue(), 'same-name');
        assert.equal(await wechat.inputValue(), 'another_contact');
        assert.equal(await form.locator('#commerce-customerPhone').inputValue(), '');
        assert.equal(await email.inputValue(), manualEmail);

        await wechat.fill('new_unmatched_wechat');
        assert.equal(await wechatList.getByRole('option').count(), 0);
        await name.fill('新录单客户');
        await notes.focus();
        assert.equal(await wechat.inputValue(), 'new_unmatched_wechat');
        assert.equal(await name.inputValue(), '新录单客户');
        assert.equal(await customerId.inputValue(), '');
      }
      assert.deepEqual(writes, []);
      if (slug === 'gpt') {
        await context.route('**/api/local/commerce', async route => {
          if (route.request().method() !== 'PUT') return route.fallback();
          const body = route.request().postDataJSON();
          localFixtures.commerce = { version: body.version + 1, data: body.data };
          await route.fulfill({ json: localFixtures.commerce });
        });
        await wechat.fill('e_desk');
        await choice(wechatList).click();
        const now = Date.now();
        await form.locator('#commerce-proCardNumber').fill('4242424242424242');
        await form.locator('#commerce-start').fill(localTime(now));
        await form.locator('#commerce-expiry').fill(localTime(now + 86_400_000));
        await form.locator('#commerce-saleCurrency').selectOption('CNY');
        await form.locator('#commerce-saleAmount').fill('100');
        await form.locator('#commerce-paidAmount').fill('20');
        await page.locator('button[form="commerce-order-form"][type="submit"]').click();
        await page.locator('#toast').getByText(/订单提交成功/).waitFor();
        assert.equal(writes.length, 1);
        const [saved] = writes[0].data.orders;
        assert.equal(saved.customerId, chosenCustomer.id);
        assert.equal(saved.customerMatchReview.decision, 'matched');
        assert.equal(saved.email, manualEmail);
        assert.equal(saved.notes, '保留订单备注');
      }
      assert.deepEqual(traffic.external, []);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
});

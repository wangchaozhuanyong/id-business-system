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

test('六个客户字段支持部分匹配，收起后按原输入重新联想', { timeout: 40_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());

  for (const [slug, product, plan, width] of [routes[0], routes[2]]) await t.test(product, async () => {
    const mobile = width < 640;
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: mobile });
    try {
      const regionalCustomer = {
        ...customer('regional-contact', '区号验收客户', 'regional_contact'),
        phone: '+86 138 2555 0101', whatsapp: '+86 138 3456 7890'
      };
      const localFixtures = await orderFixtures(slug, product, plan, width);
      localFixtures.commerce.data.customers.push(regionalCustomer,
        customer('literal-contact', '示例 <em>Ａ&</em> 客户', 'literal_contact'));
      const traffic = await interceptDesign(context, { actor, localFixtures, skipRechargeAssets: true });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.setDefaultTimeout(6000);
      await page.goto(routeUrl(slug));
      const form = page.locator('#main #commerce-order-form');
      const heading = form.getByRole('heading', { name: '客户与账号', exact: true });
      const customerId = form.locator('#commerce-customerId');
      const locate = id => ({
        input: form.locator('#commerce-' + id),
        list: form.locator('#commerce-' + id + '-suggestions')
      });
      const click = locator => mobile ? locator.tap() : locator.click();
      const option = (list, id) => list.locator(`[data-order-customer-suggestion="${id}"]`);
      const matchesOnly = async (list, id) => {
        await option(list, id).waitFor();
        assert.deepEqual(await list.getByRole('option').evaluateAll(nodes =>
          nodes.map(node => node.dataset.orderCustomerSuggestion)), [id]);
      };
      await form.locator('#commerce-ownerId option[value="suggestion-admin"]').waitFor({ state: 'attached' });

      if (!mobile) {
        for (const [id, partial, highlighted, hidden] of [
          ['wechat', 'e_desk', 'e_desk'], ['customerName', '联', '联'],
          ['qq', '３４５', '345', chosenCustomer.qq], ['telegram', '@ＳＥＬＥＣ', 'selec', chosenCustomer.telegram]
        ]) {
          const { input, list } = locate(id);
          await input.fill(partial);
          const result = option(list, chosenCustomer.id);
          await result.waitFor();
          assert.equal(await result.locator('mark').innerText(), highlighted);
          if (hidden) {
            assert.match(await result.innerText(), /\*{4}/);
            assert(!(await result.innerHTML()).includes(hidden), id + ' 仅高亮已经输入的文本');
          }
          assert.equal(await customerId.inputValue(), '', id + ' 的部分命中等候点选');
          await click(heading);
          await list.waitFor({ state: 'hidden' });
          assert.equal(await input.inputValue(), partial);
          await click(input);
          await option(list, chosenCustomer.id).waitFor();
          assert.equal(await input.getAttribute('aria-expanded'), 'true');
          await input.fill('');
        }
        const name = locate('customerName');
        await name.input.fill('<em>a&');
        const literal = option(name.list, 'literal-contact');
        assert.equal(await literal.locator('mark').innerText(), '<em>Ａ&');
        assert.equal(await literal.locator('em').count(), 0, '候选原文中的标签字符仅作为文本显示');
        await name.input.fill('');
      }

      for (const [id, kind, code, tooShort, partial, highlighted, hidden] of [
        ['customerPhone', 'phone', '1', '５', '５５-０１', '5501', '2025550101'],
        ['whatsapp', 'whatsapp', '60', '４', '４５ ６７', '4567', '123456789']
      ]) {
        const { input, list } = locate(id);
        await input.fill(tooShort);
        assert.equal(await list.isVisible(), false, id + ' 一个数字不足以展开候选');
        await input.fill(partial);
        await matchesOnly(list, regionalCustomer.id);
        assert.equal(await customerId.inputValue(), '');
        await form.locator('#order-' + kind + '-prefix').selectOption(code);
        await click(input);
        await matchesOnly(list, chosenCustomer.id);
        const result = option(list, chosenCustomer.id);
        assert.equal(await result.locator('mark').innerText(), highlighted);
        assert.match(await result.innerText(), /\*{4}/);
        assert(!(await result.innerHTML()).includes(hidden), id + ' 隐藏档案保存的完整号码');
        await click(heading);
        await list.waitFor({ state: 'hidden' });
        assert.equal(await input.inputValue(), partial);
        await click(input);
        await matchesOnly(list, chosenCustomer.id);
        assert.equal(await input.getAttribute('aria-expanded'), 'true');
        if (mobile) {
          const box = await list.boundingBox();
          assert(box && box.x >= 0 && box.x + box.width <= width + 1);
        }
        await input.fill('');
      }

      const whatsapp = locate('whatsapp');
      await form.locator('#order-whatsapp-prefix').selectOption('86');
      await whatsapp.input.fill('https://wa.me/60123456789');
      assert.equal(await form.locator('#order-whatsapp-prefix').inputValue(), '60');
      assert.equal(await whatsapp.input.inputValue(), '123456789');
      const exact = option(whatsapp.list, chosenCustomer.id);
      await exact.waitFor();
      assert.match(await exact.locator('mark').innerText(), /^\+6\*{4}89$/);
      assert(!(await exact.innerHTML()).includes('123456789'), '完整匹配也保留遮罩');
      await whatsapp.input.fill('4567');
      assert.equal(await customerId.inputValue(), '');
      if (mobile) {
        await option(whatsapp.list, chosenCustomer.id).tap();
      } else {
        await whatsapp.input.press('ArrowDown');
        assert(await whatsapp.input.getAttribute('aria-activedescendant'));
        await whatsapp.input.press('Enter');
      }
      await whatsapp.list.waitFor({ state: 'hidden' });
      assert.equal(await customerId.inputValue(), chosenCustomer.id);
      assert.equal(await locate('wechat').input.inputValue(), chosenCustomer.wechat);
      assert.equal(await locate('customerPhone').input.inputValue(), '2025550101');
      assert.deepEqual(traffic.external, []);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
});

test('核对同一客户时可采用档案、继续填写或明确更新档案', { timeout: 40_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const archived = {
    ...chosenCustomer, id: 'review-customer', active: true, version: 1, wechat: '示例核对微信',
    name: '用于验证手机窄屏下长客户名称的合成客户档案'
  };
  const enteredName = '本次录单填写的称呼';
  const enteredPhone = '13912345678';
  const enteredQQ = '7654321';
  const otherQQ = '8675309';

  for (const width of [1440, 320]) await t.test(width + 'px', async () => {
    const mobile = width < 640;
    const context = await browser.newContext({ viewport: { width, height: 900 }, hasTouch: mobile });
    try {
      const localFixtures = await orderFixtures('gpt', 'GPT', 'Plus', width);
      localFixtures.commerce.data.customers.push(archived,
        { ...customer('conflicting-qq', '另一位虚构客户', 'other_review_contact'), qq: otherQQ });
      const traffic = await interceptDesign(context, { actor, localFixtures, skipRechargeAssets: true });
      const writes = [];
      await context.route('**/api/local/commerce', route => {
        if (route.request().method() === 'GET') return route.fallback();
        writes.push(route.request().method());
        return route.fulfill({ status: 400, json: { error: '测试只验证核对与取消提交' } });
      });
      const page = await context.newPage();
      const errors = [];
      page.on('pageerror', error => errors.push(error.message));
      page.setDefaultTimeout(6000);
      await page.goto(routeUrl('gpt'));
      const form = page.locator('#main #commerce-order-form');
      const field = id => form.locator('#commerce-' + id);
      const status = form.locator('#order-customer-status');
      const useCustomer = status.getByRole('button', { name: '使用客户「' + archived.name + '」', exact: true });
      const continueFilling = status.getByRole('button', { name: '继续填写', exact: true });
      const reselect = status.getByRole('button', { name: '重新选择', exact: true });
      const updateProfile = status.getByRole('button', { name: '更新客户资料', exact: true });
      const click = locator => mobile ? locator.tap() : locator.click();
      const name = field('customerName'), wechat = field('wechat');
      const phone = field('customerPhone'), qq = field('qq'), customerId = field('customerId');
      const phoneCode = form.locator('#order-phone-prefix');
      const assertEntered = async () => {
        assert.equal(await name.inputValue(), enteredName);
        assert.equal(await wechat.inputValue(), archived.wechat);
        assert.equal(await phone.inputValue(), enteredPhone);
        assert.equal(await phoneCode.inputValue(), '86');
        assert.equal(await qq.inputValue(), enteredQQ);
      };
      await form.locator('#commerce-ownerId option[value="suggestion-admin"]').waitFor({ state: 'attached' });
      await field('email').fill('review-draft@example.test');
      await field('notes').fill('核对客户时保留订单草稿');
      await wechat.fill('核对微信');
      await click(form.locator('#commerce-wechat-suggestions [data-order-customer-suggestion="review-customer"]'));
      await click(updateProfile);
      assert.equal(await wechat.inputValue(), archived.wechat, '联想输入片段只用于查找，不成为档案差异');
      assert.equal(await status.locator('.order-customer-difference').count(), 0);
      await click(status.getByRole('button', { name: '取消更新', exact: true }));
      await click(reselect);
      assert.equal(await wechat.inputValue(), '核对微信', '重新选择恢复联想输入');
      assert.equal(await customerId.inputValue(), '');

      await name.fill(enteredName);
      await phone.fill(enteredPhone);
      await qq.fill(enteredQQ);
      await wechat.fill(archived.wechat);
      await wechat.press('Escape');
      await useCustomer.waitFor();
      assert.match(await status.innerText(), /微信「示例核对微信」与已有客户完全一致/);
      assert.match(await status.innerText(), new RegExp(enteredName));
      assert.equal(await customerId.inputValue(), '');
      await assertEntered();

      const layout = await status.evaluate(panel => {
        const nodes = ['commerce-order-customer-choose', 'commerce-order-customer-continue']
          .map(action => panel.querySelector('[data-action="' + action + '"]'));
        const panelBox = panel.getBoundingClientRect();
        const within = nodes.every(node => {
          const box = node.getBoundingClientRect();
          const range = document.createRange();
          range.selectNodeContents(node);
          return box.width > 0 && box.left >= panelBox.left && box.right <= panelBox.right &&
            box.left >= 0 && box.right <= innerWidth &&
            [...range.getClientRects()].every(rect => rect.left >= box.left - 1 && rect.right <= box.right + 1);
        });
        const [primary, secondary] = nodes.map(node => node.getBoundingClientRect());
        return { within, order: primary.top < secondary.top - 1 || primary.left < secondary.left,
          viewportFits: document.documentElement.scrollWidth <= innerWidth };
      });
      assert.deepEqual(layout, { within: true, order: true, viewportFits: true }, '按钮与文案都不被裁切');
      assert.match(await useCustomer.getAttribute('class'), /\bprimary\b/);

      await click(continueFilling);
      assert.equal(await name.evaluate(node => node === document.activeElement), true);
      assert.equal(await customerId.inputValue(), '');
      await assertEntered();
      assert.deepEqual(writes, []);

      // A further edit returns to the review, with the original fields ready for an explicit decision.
      await name.fill(enteredName + '改');
      await name.fill(enteredName);
      await name.press('Escape');
      await click(useCustomer);
      await updateProfile.waitFor();
      assert.equal(await customerId.inputValue(), archived.id);
      assert.equal(await status.getAttribute('data-kind'), 'matched');
      assert.deepEqual(await Promise.all([name, wechat, phone, qq, field('telegram'), field('whatsapp')]
        .map(input => input.inputValue())), [archived.name, archived.wechat, '2025550101', archived.qq,
        archived.telegram, '123456789']);
      assert.equal(await phoneCode.inputValue(), '1');
      assert.equal(await form.locator('#order-whatsapp-prefix').inputValue(), '60');
      assert.equal(await field('email').inputValue(), 'review-draft@example.test');
      assert.equal(await field('notes').inputValue(), '核对客户时保留订单草稿');
      assert.deepEqual(writes, []);

      await qq.fill(otherQQ);
      assert.equal(await status.getAttribute('data-kind'), 'conflict');
      assert.equal(await customerId.inputValue(), '', '另一位客户的 QQ 不得自动替换已选档案');
      assert.equal(await wechat.inputValue(), archived.wechat);
      assert.equal(await name.inputValue(), archived.name);
      await qq.fill(archived.qq);
      assert.equal(await status.getAttribute('data-kind'), 'matched');
      assert.equal(await customerId.inputValue(), archived.id);
      assert.equal(await phone.inputValue(), '2025550101');

      await click(reselect);
      await useCustomer.waitFor();
      await assertEntered();
      assert.equal(await customerId.inputValue(), '');
      await click(useCustomer);
      await click(updateProfile);
      await assertEntered();
      assert.equal(await customerId.inputValue(), archived.id);
      assert.equal(await status.getAttribute('data-kind'), 'calibrate');
      assert.deepEqual(writes, []);
      await click(status.getByRole('button', { name: '取消更新', exact: true }));
      await updateProfile.waitFor();
      assert.equal(await status.getAttribute('data-kind'), 'matched');
      assert.equal(await name.inputValue(), archived.name);
      assert.equal(await phone.inputValue(), '2025550101');

      if (!mobile) {
        await click(updateProfile);
        await assertEntered();
        const now = Date.now();
        await field('proCardNumber').fill('4242424242424242');
        await field('start').fill(localTime(now));
        await field('expiry').fill(localTime(now + 86_400_000));
        await field('saleCurrency').selectOption('CNY');
        await field('saleAmount').fill('100');
        await field('paidAmount').fill('20');
        const submit = page.locator('button[form="commerce-order-form"][type="submit"]');
        const confirmation = page.locator('#confirm-dialog[open]');
        await qq.fill(otherQQ);
        assert.equal(await status.getAttribute('data-kind'), 'conflict');
        assert.equal(await customerId.inputValue(), '');
        await status.getByRole('button', { name: '修改QQ', exact: true }).click();
        assert.equal(await qq.evaluate(node => node === document.activeElement), true);
        await submit.click();
        await form.getByText('请核对上方匹配结果并选择客户', { exact: true }).waitFor();
        assert.equal(await confirmation.count(), 0);
        assert.deepEqual(writes, []);
        await qq.fill(enteredQQ);
        assert.equal(await status.getAttribute('data-kind'), 'calibrate');
        assert.equal(await customerId.inputValue(), archived.id);
        await submit.click();
        await confirmation.getByRole('heading', { name: '确认更新客户资料' }).waitFor();
        assert((await confirmation.innerText()).includes(enteredName));
        assert.deepEqual(writes, []);
        await confirmation.getByRole('button', { name: '返回修改' }).click();
        await confirmation.waitFor({ state: 'hidden' });
        await assertEntered();

        const latestPhone = '+1 202 555 0199';
        const profileIndex = localFixtures.commerce.data.customers.indexOf(archived);
        localFixtures.commerce.data.customers[profileIndex] = { ...archived, phone: latestPhone, version: 2 };
        localFixtures.commerce.version++;
        assert.equal(await page.evaluate(() => window.IDDesignAPI.modules.commerce.refreshCommerce()), true);
        await status.getByText('客户档案已变化，请按最新资料重新核对', { exact: true }).waitFor();
        assert((await status.innerText()).includes(latestPhone));
        await assertEntered();
        assert.equal(await customerId.inputValue(), '');
        await submit.click();
        assert.equal(await confirmation.count(), 0);
        assert.deepEqual(writes, []);
        await status.getByRole('button', { name: '核对最新档案', exact: true }).click();
        await assertEntered();
        assert.equal(await customerId.inputValue(), archived.id);
        assert.equal(await status.getAttribute('data-kind'), 'calibrate');
      }
      assert.deepEqual(writes, []);
      assert.deepEqual(traffic.external, []);
      assert.deepEqual(errors, []);
    } finally {
      await context.close();
    }
  });
});

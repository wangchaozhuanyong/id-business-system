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
        { id: 'known', name: '合成老客户', wechat: 'known_wechat', phone: '+1 202 555 0101', qq: '1234567',
          whatsapp: '+60123456789', telegram: '@known_account', source: '网站', tags: [], active: true, version: 1 },
        { id: 'first', name: '合成同名', wechat: 'first', active: true, version: 1 },
        { id: 'second', name: '合成同名', wechat: 'second', active: true, version: 1 },
        { id: 'inactive', name: '合成停用', wechat: 'inactive', active: false, version: 1 },
        { id: 'incomplete', name: '微信未登记', active: true, version: 1 },
        { id: 'legacy-phone', name: '旧联系电话', phone: '13900003333', active: true, version: 1 }
      ];
      fixture.settings.data.customerTags = ['企业客户'];
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
      const name = form.locator('#commerce-customerName'), wechat = form.locator('#commerce-wechat');
      const select = form.locator('#commerce-customerId'), status = form.locator('#order-customer-status');
      const prefix = form.locator('#order-whatsapp-prefix'), phone = form.locator('#commerce-customerPhone');
      const phonePrefix = form.locator('#order-phone-prefix');
      const whatsapp = form.locator('#commerce-whatsapp'), telegram = form.locator('#commerce-telegram');
      const choose = id => form.locator(`[data-action="commerce-order-customer-choose"][data-id="${id}"]`);
      const email = form.locator('#commerce-email'), source = form.locator('#commerce-customerSource');
      const dialog = page.locator('#confirm-dialog[open]');
      const submit = page.locator('button[form="commerce-order-form"][type="submit"]');
      const ready = async () => {
        await form.locator('#commerce-ownerId option[value="match-admin"]').waitFor({ state: 'attached' });
      };
      const fresh = async () => { await page.reload(); await ready(); };
      const selected = id => page.waitForFunction(id => document.querySelector('#commerce-customerId')?.value === id, id);
      const fillOrder = async () => {
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
      const success = () => page.locator('#toast').getByText(/订单提交成功/).waitFor();
      await ready();
      assert.equal(await form.getByRole('button', { name: '匹配或新增' }).count(), 0);
      assert.equal(await form.locator('#commerce-customerId-picker').count(), 0);
      assert.equal(await prefix.locator('option:checked').innerText(), '+86');
      assert.equal(await phonePrefix.locator('option:checked').innerText(), '+86');
      const boxes = await form.evaluate(node => {
        return [...node.querySelectorAll('.order-customer-fields > .field')]
          .map(field => ({ key: field.dataset.commerceField, ...field.getBoundingClientRect().toJSON() }));
      });
      assert.deepEqual(boxes.map(box => box.key),
        ['wechat', 'customerName', 'customerPhone', 'qq', 'telegram', 'whatsapp', 'customerSource', 'orderTags']);
      assert(boxes.every(box => box.width > 0 && box.x >= 0 && box.right <= width));
      if (width < 640) assert(boxes.every((box, i) => !i || box.top >= boxes[i - 1].bottom));
      else {
        for (const index of [0, 1, 3, 4, 6]) {
          assert(Math.abs(boxes[index].top - boxes[index + 1].top) <= 1);
          assert(boxes[index].right < boxes[index + 1].left);
        }
        assert(boxes[3].top >= boxes[2].bottom);
        assert(boxes[6].top >= boxes[5].bottom);
      }
      if (slug === 'gpt') {
        for (const [field, value] of [[wechat, 'ＫＮＯＷＮ＿ＷＥＣＨＡＴ'], [phone, '+1 (202) 555-0101'],
          [form.locator('#commerce-qq'), '1234567'], [whatsapp, '+60 12-345 6789'], [telegram, 'known_account']]) {
          await field.fill(value);
          await selected('known');
          assert.equal(await name.inputValue(), '合成老客户');
          assert.equal(await email.inputValue(), history);
          assert.equal(await source.inputValue(), '网站');
          assert.equal(await prefix.locator('option:checked').innerText(), '+60');
          assert.equal(await phonePrefix.inputValue(), '1');
          assert.equal(await phone.inputValue(), '2025550101');
          if (field === wechat) {
            await source.selectOption({ index: 1 });
            if (await source.inputValue() === '网站') await source.selectOption({ index: 2 });
            assert.equal(await select.inputValue(), '', '只改来源也须明确选用档案或更新');
            await choose('known').click();
            await selected('known');
            await status.getByRole('button', { name: '更新客户资料' }).click();
            assert.equal(await status.getAttribute('data-kind'), 'calibrate');
            assert.equal(await choose('known').count(), 0);
          }
          await fresh();
        }
        await phone.fill('13900003333');
        await selected('legacy-phone');
        assert.equal(await name.inputValue(), '旧联系电话');
        assert.equal(await phonePrefix.inputValue(), '86');
        await fresh();
      }
      if (slug === 'gpt') {
        await name.evaluate(input => {
          input.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
          input.value = '合成同名';
          input.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
        });
        assert.equal(await choose('first').count(), 0);
        await name.dispatchEvent('compositionend', { bubbles: true });
      } else await name.fill('合成同名');
      await choose('first').waitFor();
      await choose('second').waitFor();
      assert.equal(await select.inputValue(), '');
      await choose('second').click();
      await selected('second');
      assert.equal(await wechat.inputValue(), 'second');
      await fresh();
      await name.fill('合成停用');
      await status.getByText(/停用/).first().waitFor();
      assert.equal(await select.inputValue(), '');
      await fresh();

      await wechat.fill('changed_' + slug);
      await name.fill('合成老客户');
      await choose('known').waitFor();
      assert.match(await status.innerText(), /known_wechat/);
      assert.match(await status.innerText(), new RegExp('changed_' + slug));
      assert.equal(await wechat.inputValue(), 'changed_' + slug);
      const layout = await status.evaluate(node => {
        const box = e => e.getBoundingClientRect();
        const section = node.closest('.order-customer-fields');
        const panel = box(node), grid = box(section);
        return { left: panel.left, right: panel.right, gridLeft: grid.left, gridRight: grid.right,
          afterContacts: panel.top >= box(section.querySelector('#commerce-whatsapp')).bottom,
          beforeSource: panel.bottom <= box(section.querySelector('#commerce-customerSource')).top,
          fits: node.scrollWidth <= node.clientWidth + 1 };
      });
      assert(layout.afterContacts && layout.beforeSource && layout.fits && Math.abs(layout.left - layout.gridLeft) <= 1 &&
        Math.abs(layout.right - layout.gridRight) <= 1, '换号提醒在联系方式下方独占整行，两侧与表单齐平');
      await choose('known').click();
      await selected('known');
      assert.equal(await wechat.inputValue(), 'known_wechat');
      assert.equal(await email.inputValue(), history);
      await status.getByRole('button', { name: '更新客户资料' }).click();
      assert.equal(await wechat.inputValue(), 'changed_' + slug);
      if (slug === 'gpt') {
        await page.evaluate(() => { location.hash = '#/customers/new'; });
        await page.locator('#commerce-contact-name').waitFor();
        await page.evaluate(() => { location.hash = '#/workspace/order/gpt'; });
        await selected('known');
        assert.equal(await wechat.inputValue(), 'changed_gpt');
        assert.equal(await email.inputValue(), history);
        await fillOrder();
        await submit.click();
        await dialog.waitFor();
        assert.match(await dialog.innerText(), /known_wechat/);
        assert.match(await dialog.innerText(), /changed_gpt/);
        await dialog.getByRole('button', { name: '返回修改' }).click();
        assert.equal(writes.length, 0);
        fail = true;
        await submit.click();
        await dialog.getByRole('button', { name: '确认更新并提交订单' }).click();
        await page.locator('#toast').getByText(/模拟拒绝订单/).waitFor();
        assert.equal(fixture.commerce.data.customers.find(row => row.id === 'known').wechat, 'known_wechat');
        assert.equal(await name.inputValue(), '合成老客户');
        assert.equal(await wechat.inputValue(), 'changed_gpt');
        assert.equal(await select.inputValue(), 'known');
        assert.equal(await form.locator('#commerce-notes').inputValue(), '保留本单备注');
        fail = false;
        await submit.click();
        await dialog.getByRole('button', { name: '确认更新并提交订单' }).click();
        await success();
        const updated = fixture.commerce.data.customers.find(row => row.id === 'known');
        assert.equal(updated.wechat, 'changed_gpt');
        assert.equal(updated.phone, '+1 202 555 0101');
        assert.equal(fixture.commerce.data.orders[0].customerId, 'known');
        assert.equal(writes.length, 2);
      }
      await fresh();
      if (slug === 'gpt') {
        await wechat.fill('first');
        await selected('first');
        await phone.fill('+1 202 555 0101');
        await fillOrder();
        await submit.click();
        assert.equal(writes.length, 2, '联系方式指向两档时不得保存或弹出可覆盖的确认');
        assert.equal(await dialog.count(), 0);
        assert.equal(await phonePrefix.inputValue(), '1');
        assert.equal(await phone.inputValue(), '2025550101');
        assert.match(await status.innerText(), /冲突|不同客户|多位客户/);
        assert.match(await status.innerText(), /微信「first」匹配到 合成同名/);
        assert.match(await status.innerText(), /联系电话.*匹配到 合成老客户/);
        await status.getByRole('button', { name: '修改联系电话' }).click();
        assert(await phone.evaluate(input => document.activeElement === input));
        await fresh();

        const stored = structuredClone(fixture.commerce.data.customers.find(row => row.id === 'known'));
        await wechat.fill(stored.wechat);
        await name.fill('合成');
        await choose('known').click();
        assert.equal(await name.inputValue(), stored.name);
        await fillOrder();
        await submit.click();
        await success();
        assert.equal(await dialog.count(), 0, '只采用档案时无更新客户确认');
        assert.equal(writes.length, 3);
        assert.equal(writes.at(-1).data.orders[0].customerMatchReview.decision, 'matched');
        assert.deepEqual(fixture.commerce.data.customers.find(row => row.id === 'known'), stored, '姓名片段和档案版本均未写回');
        assert.equal(fixture.commerce.data.orders[0].customerId, 'known');
        await fresh();
      }
      const freshName = slug === 'gemini' ? '合成同名' : '随单客户 ' + slug;
      if (width < 400) await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
      await wechat.fill('quick_' + slug);
      await name.fill(freshName);
      if (slug === 'gemini') await form.locator('[data-action="commerce-order-customer-new"]').click();
      await phone.fill('18000001234');
      assert.equal(await phonePrefix.inputValue(), '86');
      await form.locator('#commerce-qq').fill('7654321');
      await whatsapp.fill('13900001111');
      assert.equal(await prefix.locator('option:checked').innerText(), '+86');
      await telegram.fill('@new_account');
      await source.selectOption('网站');
      const tags = form.locator('[data-customer-tag-picker]');
      await tags.locator('summary').click();
      await tags.getByRole('checkbox', { name: '企业客户' }).check();
      await tags.locator('summary').click();
      assert(await status.evaluate(node => {
        const box = node.getBoundingClientRect();
        return box.width > 0 && box.left >= 0 && box.right <= innerWidth && document.documentElement.scrollWidth <= innerWidth;
      }), '表单内匹配状态在视口内');
      await fillOrder();
      const count = writes.length;
      assert(!fixture.commerce.data.customers.some(row => row.wechat === 'quick_' + slug));
      if (slug === 'claude') {
        fail = true;
        await submit.click();
        await page.locator('#toast').getByText(/模拟拒绝订单/).waitFor();
        assert.equal(await name.inputValue(), freshName);
        assert.equal(await form.locator('#commerce-notes').inputValue(), '保留本单备注');
        assert(!fixture.commerce.data.customers.some(row => row.wechat === 'quick_' + slug));
        fail = false;
      }
      await submit.click();
      await success();
      assert.equal(writes.length, count + (slug === 'claude' ? 2 : 1));
      assert.equal(page.url(), url);
      const write = writes.at(-1);
      assert.equal(write.action, orderCustomerCreateAction);
      const saved = write.data.customers.find(row => row.wechat === 'quick_' + slug);
      assert.deepEqual([saved.name, saved.phone, saved.qq, saved.whatsapp, saved.telegram, saved.source, saved.tags],
        [freshName, '+8618000001234', '7654321', '+8613900001111', '@new_account', '网站', ['企业客户']]);
      assert.equal(write.data.orders[0].customerId, saved.id);
      assert.equal(write.data.orders[0].wechat, saved.wechat);
      assert.equal(write.data.orders[0].customerPhone, saved.phone);
      assert.equal(await name.inputValue(), '');
      if (slug === 'claude') {
        await fillOrder();
        const count = writes.length;
        await submit.click();
        assert.equal(writes.length, count, '客户姓名必填');
        await name.fill('待补联系方式的客户');
        await email.fill('customer-contact@example.test');
        assert.equal(await prefix.locator('option:checked').innerText(), '+86');
        await phonePrefix.selectOption('60');
        assert.equal(await phone.inputValue(), '');
        await submit.click();
        await form.locator('#commerce-wechat-error').getByText(/至少填写一种联系方式/).waitFor();
        assert.equal(writes.length, count, '只填姓名和两个区号时不保存');
        await form.locator('#commerce-qq').fill('54321');
        assert.equal(await form.locator('#commerce-wechat-error').isVisible(), false);
        const savedResponse = page.waitForResponse(response => response.request().method() === 'PUT' &&
          new URL(response.url()).pathname === '/api/local/commerce' && response.ok());
        await submit.click();
        await savedResponse;
        await success();
        const qqOnly = fixture.commerce.data.customers.find(customer => customer.name === '待补联系方式的客户');
        assert.equal(qqOnly.qq, '54321');
        assert.equal(qqOnly.phone || '', '', '只选择电话区号不产生号码');
        assert.equal(qqOnly.whatsapp || '', '', '只显示默认区号不产生号码');
        assert.equal(fixture.commerce.data.orders[0].customerId, qqOnly.id);

        await name.fill('微信未登记');
        await choose('incomplete').click();
        await fillOrder();
        await email.fill('incomplete-contact@example.test');
        await submit.click();
        await form.locator('#commerce-wechat-error').getByText(/至少填写一种联系方式/).waitFor();
        assert.equal(writes.length, count + 1, '已选档案没有联系方式也需要补填');

        await name.fill('合成老客户');
        await choose('known').click();
        assert.equal(await wechat.inputValue(), 'known_wechat');
        assert.equal(await form.locator('#commerce-wechat-error').isVisible(), false);
        await email.fill('matched-contact@example.test');
        await submit.click();
        await success();
        assert.equal(writes.length, count + 2);
        assert.equal(fixture.commerce.data.orders[0].customerId, 'known', '按姓名匹配后带出的联系方式计入');
      }
      if (slug === 'grok') {
        await wechat.fill('other_tab');
        await name.fill('另一页先登记');
        await fillOrder();
        fixture.commerce.data.customers.unshift({ id: 'other-tab', name: '另一页先登记', wechat: 'other_tab', active: true, version: 1 });
        fixture.commerce.version++;
        await submit.click();
        await page.locator('#toast').getByText(/本次未保存，请核对客户及订单后再提交/).waitFor();
        await selected('other-tab');
        assert.equal(await email.inputValue(), 'manual-grok@example.test');
        assert.equal(await form.locator('#commerce-notes').inputValue(), '保留本单备注');
        await submit.click();
        await success();
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

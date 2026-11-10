import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
const actor = { id: 'submit-stay', name: '离线录单员', role: 'admin' };
async function setup(browser, slug = 'gpt', width = 1440, seed) {
  const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  fixture.commerce.data.orders = [];
  fixture['auth/order-owners'] = { items: [actor] };
  fixture['auth/display-names'] = { items: [actor] };
  seed?.(fixture);
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const traffic = await interceptDesign(context, { actor, localFixtures: fixture, skipRechargeAssets: true });
  const writes = [], control = { fail: false, hold: null, started: null };
  await context.route('**/api/local/commerce', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: fixture.commerce });
    const body = route.request().postDataJSON();
    writes.push(body); control.started?.resolve();
    if (control.hold) await control.hold.promise;
    if (control.fail) return route.fulfill({ status: 400, json: { error: '模拟提交失败' } });
    fixture.commerce = { version: body.version + 1, data: body.data };
    return route.fulfill({ json: fixture.commerce });
  });
  const page = await context.newPage(), errors = [];
  page.setDefaultTimeout(6000);
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/#/workspace/order/' + slug);
  await page.locator('#commerce-ownerId option[value="submit-stay"]').waitFor({ state: 'attached' });
  await page.locator('#commerce-customerId').evaluate((select, id) => {
    select.value = id; select.dispatchEvent(new Event('change', { bubbles: true }));
  }, fixture.commerce.data.customers[0].id);
  const submit = async () => {
    await page.locator('[data-action="commerce-order-pending"]').click();
    await page.locator('#confirm-dialog[open] [data-action="confirm-accept"]').click();
  };
  const success = () => page.locator('#toast').filter({ hasText: '订单提交成功' }).waitFor();
  return { context, page, fixture, control, writes, errors, traffic, submit, success };
}

test('五类订单提交后留在录入页，刷新最近记录并可连续录单', { timeout: 60_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  for (const [slug, product] of [['gpt', 'GPT'], ['claude', 'Claude Pro'], ['claude', 'Claude Max'], ['gemini', 'Gemini'], ['grok', 'Grok']]) {
    await t.test(product, async () => {
      const { context, page, writes, errors, traffic, submit, success } = await setup(browser, slug, product === 'Grok' ? 390 : 1440);
      try {
        if (slug === 'claude') await page.locator('#commerce-product').selectOption(product);
        if (product === 'Claude Pro') await page.locator('#commerce-proMaterialMode').selectOption('none');
        await page.locator('#commerce-email').fill('stay-' + slug + '@example.test');
        await page.locator('#commerce-notes').fill('本次提交的草稿');
        const url = page.url();
        await submit(); await success();
        assert.equal(page.url(), url, '成功后不能自动跳到管理页面');
        assert.equal(writes.length, 1);
        assert.equal(writes[0].data.orders[0].product, product);
        assert.equal(await page.locator('#main #commerce-email').inputValue(), '', '只清理本次已保存草稿');
        assert.equal(await page.locator('#main #commerce-notes').inputValue(), '');
        const recent = page.locator('#commerce-entry-records');
        const mobileRecords = page.getByRole('tab', { name: '最近订单', exact: true });
        if (await mobileRecords.isVisible()) {
          await mobileRecords.click();
          await recent.getByRole('button', { name: '更多资料', exact: true }).click();
        }
        await recent.getByText('本次提交的草稿', { exact: true }).waitFor();
        if (await mobileRecords.isVisible()) await page.getByRole('tab', { name: '填写资料', exact: true }).click();
        await page.locator('#commerce-email').fill('next-' + slug + '@example.test');
        await page.evaluate(() => { location.hash = '#/customers/new'; });
        await page.locator('#commerce-contact-name').waitFor();
        await page.evaluate(slug => { location.hash = '#/workspace/order/' + slug; }, slug);
        assert.equal(await page.locator('#commerce-email').inputValue(), 'next-' + slug + '@example.test', '后续新草稿仍可切页保留');
        assert.deepEqual(errors, []); assert.deepEqual(traffic.external, []);
      } finally { await context.close(); }
    });
  }
});

test('续费提交保留当前页，已完成提醒只能主动返回续费管理', { timeout: 20_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const { context, page, writes, submit, success, errors, traffic } = await setup(browser, 'renew/stay-renewal', 1440, fixture => {
    fixture.commerce.data.orders.push({
      id: 'stay-renewal', orderNo: 'QA-RENEW-STAY', product: 'GPT', plan: 'Plus',
      businessType: '新购', email: 'renewal@example.test', customerId: fixture.commerce.data.customers[0].id,
      ownerId: actor.id, owner: actor.name, start: '2026-09-01T10:00', expiry: '2026-10-01T10:00',
      payment: '银行卡', paidAmount: '20', paidCurrency: 'USD', saleAmount: '100', saleCurrency: 'CNY',
      paidConfirmed: true, version: 1, refunds: [], corrections: [], bankReturns: []
    });
  });
  t.after(() => context.close());
  const url = page.url();
  await submit(); await success();
  assert.equal(page.url(), url);
  await page.locator('#commerce-order-form').waitFor();
  await page.locator('#commerce-paidAmount').fill('20');
  await page.locator('#commerce-saleAmount').fill('100');
  await page.locator('#main [name="commerce-paidConfirmed"]').check();
  await page.locator('#main button[form="commerce-order-form"][type="submit"]').click();
  await page.locator('#confirm-dialog[open] [data-action="confirm-accept"]').click();
  await page.locator('#main').getByText('续费提醒已变化', { exact: true }).waitFor();
  assert.equal(page.url(), url);
  assert.equal(writes.length, 2);
  const renewed = writes[1].data.orders[0];
  assert.equal(renewed.paidConfirmed, true);
  assert(writes[1].data.logs.some(row => row.type === '关联续费订单' &&
    row.entityId === 'stay-renewal' && row.relatedOrderId === renewed.id));
  await page.getByRole('button', { name: '返回续费管理', exact: true }).click();
  assert.equal(new URL(page.url()).hash, '#/workspace/renewals');
  assert.deepEqual(errors, []); assert.deepEqual(traffic.external, []);
});

test('提交失败可重试，迟到成功不会清除后续输入或抢回页面', { timeout: 30_000 }, async t => {
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const { context, page, control, writes, submit, success, errors, traffic } = await setup(browser);
  t.after(() => context.close());
  await page.locator('#commerce-email').fill('retry@example.test');
  await page.locator('#commerce-notes').fill('失败保留');
  const url = page.url();
  control.fail = true;
  await submit();
  await page.locator('#toast').filter({ hasText: '服务器保存失败' }).waitFor();
  assert.equal(page.url(), url);
  assert.equal(await page.locator('#commerce-email').inputValue(), 'retry@example.test');
  assert.equal(await page.locator('#commerce-notes').inputValue(), '失败保留');
  control.fail = false;
  await submit(); await success();
  assert.equal(page.url(), url);
  assert.equal(writes.length, 2);
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
  assert.equal(await page.locator('#commerce-contact-name').inputValue(), '另一个页面的新草稿');
  assert.deepEqual(errors, []); assert.deepEqual(traffic.external, []);
});

import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

test('订单下拉框在展开后搜索，保留联动、草稿与快捷新增', { timeout: 60_000 }, async (t) => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  const customer = fixture.commerce.data.customers[0];
  fixture.commerce.data.customers = [
    { ...customer, id: 'qa-alpha', name: '合成张先生', wechat: 'Alpha_Sales', phone: '13800138000' },
    { ...customer, id: 'qa-beta', name: '合成李女士', wechat: 'Beta_Shop', phone: '13900139000' },
    { ...customer, id: 'qa-disabled', name: '停用客户', active: false }
  ];
  const editedOrder = fixture.commerce.data.orders.find(order => order.product === 'GPT');
  editedOrder.customerId = 'qa-alpha';
  await interceptDesign(context, { localFixtures: fixture });
  const writes = [];
  await context.route('**/api/local/commerce', (route) => {
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
  const trigger = page.locator('#commerce-customerId-picker');
  const popup = page.locator('#commerce-customerId-popover');
  const search = popup.getByRole('searchbox', { name: '搜索客户' });
  await page.goto(origin + '/#/workspace/order/gpt');
  await page.locator('#commerce-customerId option[value="qa-alpha"]').waitFor({ state: 'attached' });
  assert.equal(await search.isVisible(), false, '收起时只有一个选择控件');
  await page.locator('label[for="commerce-customerId-picker"]').click();
  await popup.getByRole('option').first().waitFor();
  assert.equal(await trigger.getAttribute('aria-expanded'), 'true');
  await search.fill('ALPHA 138');
  assert.equal(await popup.getByRole('option').count(), 1);
  await search.press('Enter');
  await popup.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#commerce-customerId').inputValue(), 'qa-alpha');
  assert.equal(await page.locator('#commerce-customerPhone').inputValue(), '13800138000');
  await trigger.click();
  await search.fill('没有匹配的虚构名字');
  await popup.getByRole('status').waitFor();
  await search.press('Enter');
  assert.equal(writes.length, 0, '搜索回车不得提交订单');
  await search.fill('beta');
  assert.equal(await popup.getByRole('option').count(), 1, '不保留不匹配的旧选中项');
  await search.press('ArrowDown');
  assert.equal(await page.evaluate(() => document.activeElement?.getAttribute('data-value')), 'qa-beta', '方向键应聚焦匹配选项');
  await page.keyboard.press('Enter');
  await popup.waitFor({ state: 'hidden' });
  assert.equal(await page.locator('#commerce-customerId').inputValue(), 'qa-beta');
  assert.equal(await page.locator('#commerce-wechat').inputValue(), 'Beta_Shop');
  await trigger.click();
  await search.fill('停用客户');
  assert.equal(await popup.getByRole('option').count(), 0);
  await page.keyboard.press('Escape');
  await popup.waitFor({ state: 'hidden' });
  assert(await trigger.evaluate(node => node === document.activeElement));
  await trigger.click();
  await search.waitFor();
  await page.locator('h1').click();
  await popup.waitFor({ state: 'hidden' });

  for (const width of [1440, 390, 320]) {
    await page.setViewportSize({ width, height: 900 });
    for (const dark of [false, true]) {
      await page.evaluate(dark => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; }, dark);
      for (const product of ['gpt', 'claude']) {
        await page.evaluate(product => { location.hash = '#/workspace/order/' + product; }, product);
        await page.locator(`#main[data-layout-route="workspace/order/${product}"]`).waitFor();
        await trigger.click();
        await search.fill('138');
        await popup.getByRole('option').waitFor();
        const { bounds, input, option } = await popup.evaluate(node => ({
          bounds: node.getBoundingClientRect().toJSON(),
          input: node.querySelector('input').getBoundingClientRect().toJSON(),
          option: node.querySelector('[role="option"]').getBoundingClientRect().toJSON()
        }));
        assert(bounds.x >= 0 && bounds.x + bounds.width <= width, '下拉面板不得横向溢出');
        assert(bounds.y >= 0 && bounds.y + bounds.height <= 900, '下拉面板不得被视口裁切');
        assert(input.y + input.height <= option.y, '搜索框必须在选项上方');
        await page.keyboard.press('Escape');
        await page.locator('#commerce-payment').selectOption('银行卡');
        if (product === 'claude')
          await page.locator('#commerce-proMaterialMode').selectOption('tenant_card');
        await page.locator('#commerce-cardId-picker').click();
        await page.getByRole('searchbox', { name: '搜索银行卡' }).waitFor();
        await page.keyboard.press('Escape');
        if (product === 'claude') {
          await page.locator('#commerce-tenantId-picker').click();
          await page.getByRole('searchbox', { name: '搜索租户' }).fill('没有匹配的合成租户');
          await page.locator('#commerce-tenantId-popover').getByRole('status').waitFor();
          await page.keyboard.press('Escape');
        }
        await page.locator('#commerce-payment').selectOption('苹果内购');
        await page.locator('#commerce-appleIdId-picker').click();
        await page.getByRole('searchbox', { name: '搜索苹果 ID' }).waitFor();
        await page.keyboard.press('Escape');
        assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.evaluate(() => { location.hash = '#/workspace/order/gpt'; });
  await page.locator('#main[data-layout-route="workspace/order/gpt"]').waitFor();
  assert.equal(await page.locator('#commerce-customerId').inputValue(), 'qa-beta', '切页返回恢复客户');
  await page.locator('#commerce-email').fill('draft-preserved@example.test');
  await page.locator('[data-action="commerce-quick-customer"]').click();
  await page.locator('#commerce-contact-name').fill('快捷新增合成客户');
  await page.locator('#commerce-contact-wechat').fill('qa_new_customer');
  await page.locator('#drawer').getByRole('button', { name: '核对并保存', exact: true }).click();
  await page.locator('#confirm-dialog [data-action="confirm-accept"]').click();
  await page.locator('#commerce-contact-form').waitFor({ state: 'hidden' });
  assert.equal(writes.length, 1);
  assert.match(await trigger.innerText(), /快捷新增合成客户/);
  assert.equal(await page.locator('#commerce-email').inputValue(), 'draft-preserved@example.test');
  assert.equal(await page.locator('#commerce-wechat').inputValue(), 'qa_new_customer');
  await page.evaluate(() => { location.hash = '#/orders/gpt'; });
  await page.locator(`[data-action="commerce-order-edit"][data-id="${editedOrder.id}"]`).click();
  const drawer = page.locator('#drawer[open]');
  await drawer.locator('#commerce-customerId-picker').click();
  await search.fill('138');
  await popup.getByRole('option').waitFor();
  await page.keyboard.press('Escape');
  await popup.waitFor({ state: 'hidden' });
  assert(await drawer.isVisible(), '关闭下拉不得关闭订单编辑抽屉');
  assert.deepEqual(errors, []);
});

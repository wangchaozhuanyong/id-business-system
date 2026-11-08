import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { interceptDesign, origin } from './helpers/offline-design.mjs';
import { validOrderCurrencyGroups, retainOrderCurrencySettings } from '../server/order-currency-settings.mjs';
import { validOrderPrices } from '../server/order-policy.mjs';

test('GPT 与 Claude 各自维护币种及套餐售价，标题右侧设置、草稿和旧单保留', { timeout: 90_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  const actor = { id: 'qa-admin', name: '合成管理员', role: 'admin' };
  let settings = { version: 1, data: { ...fixture.settings.data,
    orderCurrenciesByProduct: {
      GPT: [{ code: 'CNY', name: '人民币' }, { code: 'PHP', name: '菲律宾比索' }],
      Claude: [{ code: 'CNY', name: '人民币' }, { code: 'MYR', name: '马币' }]
    },
    orderPrices: { GPT: { Plus: { CNY: '101' } }, 'Claude Pro': { Pro: { CNY: '201' } }, 'Claude Max': { 'Max 5x': { CNY: '301' } } }
  } };
  const legacy = { ...fixture.commerce.data.orders.find(row => row.product === 'Claude Pro'),
    id: 'legacy-eur', email: 'legacy-eur@example.test', paidCurrency: 'EUR', saleCurrency: 'EUR',
    paidAmount: '30.1234', saleAmount: '60.1234', cancelled: false, version: 1 };
  fixture.commerce.data.orders.push(legacy);
  const originalOrders = structuredClone(fixture.commerce.data.orders);
  await interceptDesign(context, { localFixtures: fixture, actor });
  await context.route('**/api/local/auth/order-owners', route => route.fulfill({ json: { items: [actor] } }));
  await context.route('**/api/local/auth/display-names', route => route.fulfill({ json: { items: [actor] } }));
  let failSave = false;
  const writes = [], businessWrites = [];
  await context.route('**/api/local/settings', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: settings });
    const command = route.request().postDataJSON();
    writes.push(command);
    if (failSave) { failSave = false; return route.fulfill({ status: 503, json: { error: '模拟设置保存失败' } }); }
    if (command.version !== settings.version) return route.fulfill({ status: 409, json: { error: '设置版本已变化' } });
    assert(validOrderCurrencyGroups(command.data.orderCurrenciesByProduct));
    assert(validOrderPrices(command.data.orderPrices));
    settings = { version: command.version + 1, data: retainOrderCurrencySettings(command.data, settings.data) };
    return route.fulfill({ json: settings });
  });
  await context.route('**/api/local/commerce', route => {
    if (route.request().method() === 'GET') return route.fallback();
    businessWrites.push(route.request().method());
    return route.fulfill({ status: 500, json: { error: '此测试不保存订单' } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const paid = page.locator('#commerce-paidCurrency'), sale = page.locator('#commerce-saleCurrency');
  const group = index => page.locator('.order-financial-group').nth(index);
  const currencyForm = page.locator('#drawer[open] #commerce-currencies-form');
  const pending = currencyForm.locator('#commerce-currency-options-pending');
  const currencies = () => currencyForm.locator('#commerce-currency-options').evaluate(node => JSON.parse(node.value));
  const codes = node => node.locator('option').evaluateAll(nodes => nodes.map(node => node.value));
  async function add(text) { await pending.fill(text); await currencyForm.locator('[data-action="option-add"]').click(); }
  async function openCurrencies(index = 0) {
    await group(index).locator('[data-action="commerce-currency-settings"]').click();
    await currencyForm.waitFor();
  }
  async function close() {
    await page.locator('#drawer [data-action="drawer-close"]').first().click();
    await page.locator('#drawer:not([open])').waitFor({ state: 'attached' });
  }
  async function save(formId, status = 200) {
    await page.locator(`button[form="${formId}"][type="submit"]:visible`).click();
    const response = page.waitForResponse(r => r.request().method() === 'PUT' && new URL(r.url()).pathname === '/api/local/settings');
    await page.locator('#confirm-dialog [data-action="confirm-accept"]').click();
    assert.equal((await response).status(), status);
    if (status === 200) await page.locator('#drawer:not([open])').waitFor({ state: 'attached' });
    else await page.getByText('模拟设置保存失败', { exact: true }).waitFor();
  }
  await page.goto(origin + '/#/workspace/order/claude');
  await page.waitForFunction(() => document.querySelector('#commerce-saleAmount')?.value === '201');
  assert.deepEqual(await codes(paid), ['CNY', 'MYR']);
  assert.deepEqual(await codes(sale), ['CNY', 'MYR']);
  await page.locator('#commerce-email').fill('claude-draft@example.test');
  await page.locator('#commerce-paidAmount').fill('24.0001');
  await openCurrencies();
  await add('欧元 EUR');
  await currencyForm.getByRole('button', { name: '移除币种 马币 MYR', exact: true }).click();
  await close();
  await page.goto(origin + '/#/workspace/order/gpt');
  await page.waitForFunction(() => document.querySelector('#commerce-saleAmount')?.value === '101');
  assert.deepEqual(await codes(paid), ['CNY', 'PHP']);
  await openCurrencies(1);
  assert.deepEqual(await currencies(), ['人民币 CNY', '菲律宾比索 PHP'], 'GPT 草稿不混入 Claude 币种');
  await add('英镑 GBP');
  await close();
  await page.goto(origin + '/#/workspace/order/claude');
  assert.equal(await page.locator('#commerce-email').inputValue(), 'claude-draft@example.test');
  await openCurrencies(1);
  assert.deepEqual(await currencies(), ['人民币 CNY', '欧元 EUR'], 'Claude 设置草稿与 GPT 隔离');
  await save('commerce-currencies-form');
  assert.deepEqual(settings.data.orderCurrenciesByProduct.GPT.map(row => row.code), ['CNY', 'PHP']);
  assert.deepEqual(await codes(sale), ['CNY', 'EUR']);
  await page.goto(origin + '/#/workspace/order/gpt');
  await openCurrencies();
  assert((await currencies()).includes('英镑 GBP'));
  const before = writes.length;
  await page.locator('button[form="commerce-currencies-form"][type="submit"]').click();
  await page.locator('#confirm-dialog [data-action="confirm-accept"]').click();
  await page.getByText('币种设置已变化，输入已保留；请读取最新清单后重新编辑', { exact: true }).waitFor();
  assert.equal(writes.length, before, '旧版本不能覆盖另一页刚保存的设置');
  await page.locator('[data-action="commerce-currency-reload"]').click();
  await page.locator('#confirm-dialog [data-action="confirm-accept"]').click();
  await page.waitForFunction(() => !document.querySelector('#commerce-currency-options')?.value.includes('GBP'));
  await add('英镑 GBP');
  failSave = true;
  await save('commerce-currencies-form', 503);
  assert((await currencies()).includes('英镑 GBP'));
  await save('commerce-currencies-form');
  assert.deepEqual(settings.data.orderCurrenciesByProduct.GPT.map(row => row.code), ['CNY', 'PHP', 'GBP']);
  assert.deepEqual(settings.data.orderCurrenciesByProduct.Claude.map(row => row.code), ['CNY', 'EUR']);
  assert(!await sale.locator('option[value="EUR"]').count());

  await page.goto(origin + '/#/workspace/order/claude');
  await group(1).locator('[data-action="commerce-price-settings"]').click();
  const prices = page.locator('#drawer[open] #commerce-prices-form');
  await prices.waitFor();
  assert.deepEqual(await prices.locator('[data-price-product]').evaluateAll(nodes => [...new Set(nodes.map(node => node.dataset.priceProduct))]), ['Claude Pro', 'Claude Max']);
  await prices.locator('[data-price-product="Claude Pro"][data-price-currency="EUR"]').fill('49.9900');
  await prices.locator('[data-price-product="Claude Max"][data-price-plan="Max 5x"][data-price-currency="EUR"]').fill('99.1234');
  await save('commerce-prices-form');
  assert.equal(settings.data.orderPrices.GPT.Plus.CNY, '101');
  await sale.selectOption('EUR');
  assert.equal(await page.locator('#commerce-saleAmount').inputValue(), '49.9900');
  await page.locator('#commerce-product').selectOption('Claude Max');
  assert.equal(await sale.inputValue(), 'EUR');
  assert.equal(await page.locator('#commerce-saleAmount').inputValue(), '99.1234');
  await page.goto(origin + '/#/workspace/order/gpt');
  await group(1).locator('[data-action="commerce-price-settings"]').click();
  await prices.waitFor();
  assert.deepEqual(await prices.locator('[data-price-product]').evaluateAll(nodes => [...new Set(nodes.map(node => node.dataset.priceProduct))]), ['GPT']);
  await prices.locator('[data-price-plan="Plus"][data-price-currency="CNY"]').fill('111.1111');
  await save('commerce-prices-form');
  assert.equal(settings.data.orderPrices['Claude Pro'].Pro.EUR, '49.9900');
  assert.equal(settings.data.orderPrices['Claude Max']['Max 5x'].EUR, '99.1234');

  const evidence = new URL('../.runtime/order-product-settings-20261108/', import.meta.url);
  const screenshots = process.env.ID_ORDER_SETTINGS_SCREENSHOTS === '1';
  if (screenshots) await mkdir(evidence, { recursive: true });
  for (const product of ['gpt', 'claude']) {
    await page.goto(origin + '/#/workspace/order/' + product);
    for (const width of [1440, 1024, 390, 320]) for (const dark of [false, true]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.waitForFunction(() => innerWidth > 900 || document.querySelector('#sidebar').getBoundingClientRect().right <= 0);
      await page.evaluate(dark => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; }, dark);
      const geometry = await page.locator('.order-financial-group').evaluateAll(groups => groups.map(group => {
        const rect = group.getBoundingClientRect(), title = group.querySelector('h3').getBoundingClientRect();
        const actions = [...group.querySelectorAll('.order-financial-actions button')].map(node => node.getBoundingClientRect());
        return { top: rect.top, left: rect.left, right: rect.right, titleY: title.top + title.height / 2,
          actionsFit: actions.every(a => a.left >= title.right && a.right <= rect.right && a.height > 0) };
      }));
      assert(geometry.every(row => row.actionsFit && row.left >= 0 && row.right <= width), JSON.stringify({ product, width, dark, geometry }));
      if (width === 1440) assert(geometry.every(row => Math.abs(row.titleY - geometry[0].titleY) <= 1), '并排标题文字居中模型一致');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (screenshots && product === 'claude' && !dark && [1440, 390].includes(width)) {
        await page.locator('.order-financial-groups').screenshot({ path: fileURLToPath(new URL(`claude-${width}-light.png`, evidence)) });
      }
    }
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.goto(origin + '/#/orders/pro');
  await page.locator('#commerce-search').fill('legacy-eur@example.test');
  await page.locator('[data-action="commerce-order-edit"][data-id="legacy-eur"]').click();
  assert.equal(await paid.inputValue(), 'EUR');
  assert.equal(await page.locator('#commerce-paidAmount').inputValue(), '30.1234');
  await openCurrencies();
  await currencyForm.getByRole('button', { name: '移除币种 欧元 EUR', exact: true }).click();
  await page.locator('button[form="commerce-currencies-form"][type="submit"]').click();
  const saved = page.waitForResponse(r => r.request().method() === 'PUT' && new URL(r.url()).pathname === '/api/local/settings');
  await page.locator('#confirm-dialog [data-action="confirm-accept"]').click();
  assert.equal((await saved).status(), 200);
  await page.locator('#drawer[open] #commerce-order-form').waitFor();
  assert.equal(await paid.inputValue(), 'EUR', '编辑原单在移除币种后仍保留原值');
  assert.match(await paid.locator('option:checked').textContent(), /已移出选项/);
  assert.equal(await page.locator('#commerce-paidAmount').inputValue(), '30.1234');
  assert.deepEqual(fixture.commerce.data.orders, originalOrders);
  assert.deepEqual(businessWrites, []);
  assert.deepEqual(errors, []);
});

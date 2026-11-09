import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { interceptDesign, origin } from './helpers/offline-design.mjs';
import { validOrderCurrencyGroups, retainOrderCurrencySettings } from '../server/order-currency-settings.mjs';
import { validClaudePaidPrices, validGptPaidPrices, validOrderPrices } from '../server/order-policy.mjs';

test('GPT 与 Claude 各自维护币种及套餐售价，系统设置集中维护，代付预设、草稿和旧单保留', { timeout: 90_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL,
    ignoreDefaultArgs: ['--hide-scrollbars'] });
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
  let failSave = false, rateVersion = 1, phpRate = '0.125';
  const writes = [], businessWrites = [];
  await context.route('**/api/local/finance/collection?**', route => route.fulfill({ json: {
    version: rateVersion,
    now: '2026-11-09T13:00:00Z',
    rows: [
      { currency: 'PHP', rate: phpRate, status: 'valid', source: 'ExchangeRate-API', at: '2026-11-09T12:00:00Z', expiresAt: '2026-11-10T12:00:00Z' },
      { currency: 'CLP', rate: '0.008', status: 'expired', at: '2026-11-08T12:00:00Z', expiresAt: '2026-11-09T12:00:00Z' }
    ]
  } }));
  await context.route('**/api/local/settings', route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: settings });
    const command = route.request().postDataJSON();
    writes.push(command);
    if (failSave) { failSave = false; return route.fulfill({ status: 503, json: { error: '模拟设置保存失败' } }); }
    if (command.version !== settings.version) return route.fulfill({ status: 409, json: { error: '设置版本已变化' } });
    assert(validOrderCurrencyGroups(command.data.orderCurrenciesByProduct));
    assert(validOrderPrices(command.data.orderPrices));
    if ('gptPaidPrices' in command.data) assert(validGptPaidPrices(command.data.gptPaidPrices));
    if ('claudePaidPrices' in command.data) assert(validClaudePaidPrices(command.data.claudePaidPrices));
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
  const currencyForm = page.locator('#drawer[open] #commerce-currencies-form');
  const pending = currencyForm.locator('#commerce-currency-options-pending');
  const currencies = () => currencyForm.locator('#commerce-currency-options').evaluate(node => JSON.parse(node.value));
  const codes = node => node.locator('option').evaluateAll(nodes => nodes.map(node => node.value));
  async function add(text) { await pending.fill(text); await currencyForm.locator('[data-action="option-add"]').click(); }
  async function settingsTab(label) {
    if (!page.url().endsWith('#/settings/payment-countries')) await page.goto(origin + '/#/settings/payment-countries');
    await page.getByRole('tab', { name: label, exact: true }).click();
  }
  async function openCurrencies(family) {
    await settingsTab('订单币种');
    await page.getByRole('button', { name: family + ' 币种设置', exact: true }).click();
    await currencyForm.waitFor();
  }
  async function openPrices(family) {
    await settingsTab('套餐售价');
    await page.getByRole('button', { name: family + ' 套餐售价设置', exact: true }).click();
  }
  async function close() {
    await page.locator('#drawer [data-action="drawer-close"]').first().click();
    await page.locator('#drawer:not([open])').waitFor({ state: 'attached' });
  }
  async function save(formId, status = 200) {
    const paidProduct = formId === 'commerce-paid-prices-form' && await page.locator('#commerce-paid-product').inputValue();
    await page.locator(`button[form="${formId}"][type="submit"]:visible, #${formId} button[type="submit"]:visible`).click();
    const response = page.waitForResponse(r => r.request().method() === 'PUT' && new URL(r.url()).pathname === '/api/local/settings');
    await page.locator('#confirm-dialog [data-action="confirm-accept"]').click();
    assert.equal((await response).status(), status);
    if (status === 200 && paidProduct)
      await page.getByText(paidProduct + ' 代付价格已保存', { exact: true }).waitFor();
    else if (status === 200) await page.locator('#drawer:not([open])').waitFor({ state: 'attached' });
    else await page.getByText('模拟设置保存失败', { exact: true }).waitFor();
  }
  await page.goto(origin + '/#/workspace/order/claude');
  await page.waitForFunction(() => document.querySelector('#commerce-saleAmount')?.value === '201');
  assert.equal(await page.locator('#main :is([data-action="commerce-price-settings"], [data-action="commerce-currency-settings"])').count(), 0);
  assert.deepEqual(await codes(paid), ['CNY', 'MYR']);
  assert.deepEqual(await codes(sale), ['CNY', 'MYR']);
  await page.locator('#commerce-email').fill('claude-draft@example.test');
  await page.locator('#commerce-paidAmount').fill('24.0001');
  await openCurrencies('Claude');
  await add('欧元 EUR');
  await currencyForm.getByRole('button', { name: '移除币种 马币 MYR', exact: true }).click();
  await close();
  await page.goto(origin + '/#/workspace/order/gpt');
  await page.waitForFunction(() => document.querySelector('#commerce-saleAmount')?.value === '101');
  assert.equal(await page.locator('#main :is([data-action="commerce-price-settings"], [data-action="commerce-currency-settings"])').count(), 0);
  assert.equal(await paid.inputValue(), 'PHP');
  assert.deepEqual(await codes(paid), ['PHP', 'CLP', 'USD', 'IDR', 'MYR', 'CNY']);
  await openCurrencies('GPT');
  assert.deepEqual(await currencies(), ['人民币 CNY', '菲律宾比索 PHP'], 'GPT 草稿不混入 Claude 币种');
  await add('英镑 GBP');
  await close();
  await page.goto(origin + '/#/workspace/order/claude');
  assert.equal(await page.locator('#commerce-email').inputValue(), 'claude-draft@example.test');
  await openCurrencies('Claude');
  assert.deepEqual(await currencies(), ['人民币 CNY', '欧元 EUR'], 'Claude 设置草稿与 GPT 隔离');
  await save('commerce-currencies-form');
  assert.deepEqual(settings.data.orderCurrenciesByProduct.GPT.map(row => row.code), ['CNY', 'PHP']);
  await page.goto(origin + '/#/workspace/order/claude');
  await page.waitForFunction(() => document.querySelector('#commerce-saleCurrency option[value="EUR"]'));
  assert.deepEqual(await codes(sale), ['CNY', 'EUR']);
  await openCurrencies('GPT');
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
  await page.goto(origin + '/#/workspace/order/gpt');
  await page.waitForFunction(() => document.querySelector('#commerce-saleCurrency option[value="GBP"]'));
  assert(!await sale.locator('option[value="EUR"]').count());

  await openPrices('Claude');
  const prices = page.locator('#drawer[open] #commerce-prices-form');
  await prices.waitFor();
  assert.deepEqual(await prices.locator('[data-price-product]').evaluateAll(nodes => [...new Set(nodes.map(node => node.dataset.priceProduct))]), ['Claude Pro', 'Claude Max']);
  await prices.locator('[data-price-product="Claude Pro"][data-price-currency="EUR"]').fill('49.9900');
  await prices.locator('[data-price-product="Claude Max"][data-price-plan="Max 5x"][data-price-currency="EUR"]').fill('99.1234');
  await save('commerce-prices-form');
  assert.equal(settings.data.orderPrices.GPT.Plus.CNY, '101');
  await page.goto(origin + '/#/workspace/order/claude');
  await sale.selectOption('EUR');
  assert.equal(await page.locator('#commerce-saleAmount').inputValue(), '49.9900');
  await page.locator('#commerce-product').selectOption('Claude Max');
  assert.equal(await sale.inputValue(), 'EUR');
  assert.equal(await page.locator('#commerce-saleAmount').inputValue(), '99.1234');
  await openPrices('GPT');
  await prices.waitFor();
  assert.deepEqual(await prices.locator('[data-price-product]').evaluateAll(nodes => [...new Set(nodes.map(node => node.dataset.priceProduct))]), ['GPT']);
  await prices.locator('[data-price-plan="Plus"][data-price-currency="CNY"]').fill('111.1111');
  await save('commerce-prices-form');
  assert.equal(settings.data.orderPrices['Claude Pro'].Pro.EUR, '49.9900');
  assert.equal(settings.data.orderPrices['Claude Max']['Max 5x'].EUR, '99.1234');

  await settingsTab('代付价格');
  const country = page.locator('#commerce-paid-country');
  const paidForm = page.locator('#commerce-paid-prices-form');
  const plus = paidForm.getByRole('textbox', { name: 'Plus 原币代付金额', exact: true });
  const pro = paidForm.getByRole('textbox', { name: 'Pro 100 原币代付金额', exact: true });
  const budget = paidForm.locator('[data-paid-budget]').first();
  const quote = page.locator('#commerce-paid-quote');
  await plus.fill('983');
  await pro.fill('1200');
  await budget.filter({ hasText: '¥ 122.88' }).waitFor();
  phpRate = '0.13';
  rateVersion++;
  await page.evaluate(version => window.IDLocalData.acceptChangeVersions({ 'finance-rates': String(version) }), rateVersion);
  await budget.filter({ hasText: '¥ 127.79' }).waitFor();
  assert.equal(await plus.inputValue(), '983');
  await save('commerce-paid-prices-form');
  assert.equal(settings.data.gptPaidPrices.Plus.PHP, '983');
  assert.equal(settings.data.orderPrices.GPT.Plus.CNY, '111.1111');
  await country.selectOption('CLP');
  await plus.fill('10000');
  await quote.getByText(/汇率已过期/).waitFor();
  assert.equal(await budget.textContent(), '—');
  await save('commerce-paid-prices-form');
  await country.selectOption('IDR');
  await quote.getByText(/暂无有效汇率/).waitFor();
  assert.equal(await plus.inputValue(), '');
  for (const width of [1440, 390, 320]) for (const dark of [false, true]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(dark => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; }, dark);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const countryBox = await country.boundingBox();
    assert(countryBox && countryBox.x >= 0 && countryBox.x + countryBox.width <= width);
    assert(await paidForm.getByRole('button', { name: '保存代付价格' }).isVisible());
  }
  await page.setViewportSize({ width: 1440, height: 1000 });

  const paidProduct = page.locator('#commerce-paid-product');
  await paidProduct.selectOption('Claude Pro');
  await country.selectOption('CNY');
  const claudePro = paidForm.getByRole('textbox', { name: 'Pro 原币代付金额', exact: true });
  await claudePro.fill('95.0010');
  await paidProduct.selectOption('Claude Max');
  await paidForm.getByRole('textbox', { name: 'Max 5x 原币代付金额', exact: true }).fill('405.1234');
  await paidProduct.selectOption('Claude Pro');
  assert.equal(await claudePro.inputValue(), '95.0010');
  await save('commerce-paid-prices-form');
  await paidProduct.selectOption('Claude Max');
  await page.getByRole('button', { name: '读取最新', exact: true }).click();
  await page.locator('#confirm-dialog [data-action="confirm-accept"]').click();
  const claudeMax = paidForm.getByRole('textbox', { name: 'Max 5x 原币代付金额', exact: true });
  await page.waitForFunction(() => document.querySelector('[aria-label="Max 5x 原币代付金额"]')?.value === '');
  await claudeMax.fill('405.1234');
  await save('commerce-paid-prices-form');
  assert.equal(settings.data.claudePaidPrices['Claude Pro'].Pro.CNY, '95.0010');
  assert.equal(settings.data.claudePaidPrices['Claude Max']['Max 5x'].CNY, '405.1234');
  assert.equal(settings.data.gptPaidPrices.Plus.PHP, '983');

  async function checkReference(kind, expected) {
    const id = 'commerce-' + kind + '-price-reference';
    const note = page.locator('#' + id);
    const trigger = page.locator(`summary[aria-controls="${id}"]`);
    assert(!(await note.isVisible()));
    await trigger.scrollIntoViewIfNeeded();
    const groups = page.locator('.order-financial-groups');
    const height = (await groups.boundingBox()).height;
    await trigger.press('Enter');
    await page.locator('#' + id + ':popover-open').waitFor();
    await note.locator('[aria-current="true"] dd').filter({ hasText: expected[0][1] }).waitFor();
    const rows = await note.locator('dl > div').evaluateAll(nodes =>
      nodes.map(node => [node.querySelector('dt').textContent, node.querySelector('dd').textContent]));
    assert.deepEqual(rows, expected);
    assert.doesNotMatch(await note.innerText(), /汇率|成本|折合|¥/u);
    assert.equal((await groups.boundingBox()).height, height);
    assert(await note.evaluate(node => {
      const box = node.getBoundingClientRect();
      return box.left >= 0 && box.right <= document.documentElement.clientWidth && box.top >= 0 && box.bottom <= innerHeight &&
        node.scrollWidth <= node.clientWidth + 1;
    }));
    await trigger.press('Escape');
    await note.waitFor({ state: 'hidden' });
  }

  const paidAmount = page.locator('#commerce-paidAmount'), plan = page.locator('#commerce-plan');
  await page.goto(origin + '/#/workspace/order/gpt');
  await page.waitForFunction(() => document.querySelector('#commerce-paidAmount')?.value === '983');
  assert.match(await page.locator('label[for="commerce-paidCurrency"]').textContent(), /国家／地区/);
  assert.equal(await paid.inputValue(), 'PHP');
  assert.equal(await page.getByText('折合人民币预算', { exact: true }).count(), 0);
  await checkReference('paid', [['菲律宾', '983 PHP'], ['智利', '10000 CLP']]);
  await checkReference('sale', [['人民币', '111.1111 CNY']]);
  await page.locator('[name="commerce-paidConfirmed"]').check();
  await plan.selectOption('Pro 100');
  assert.equal(await paidAmount.inputValue(), '1200');
  assert(!(await page.locator('[name="commerce-paidConfirmed"]').isChecked()));
  await paid.selectOption('CLP');
  assert.equal(await paidAmount.inputValue(), '');
  await checkReference('paid', [['智利', '未配置（CLP）'], ['菲律宾', '1200 PHP']]);
  await plan.selectOption('Plus');
  assert.equal(await paidAmount.inputValue(), '10000');
  await paidAmount.fill('9876.1234');
  await settingsTab('代付价格');
  await page.goto(origin + '/#/workspace/order/gpt');
  assert.equal(await paid.inputValue(), 'CLP');
  assert.equal(await paidAmount.inputValue(), '9876.1234');
  await page.locator('#commerce-payment').selectOption('苹果内购');
  assert.equal(await paid.inputValue(), 'USD');
  assert.equal(await paidAmount.inputValue(), '');
  await page.getByLabel('查看代付金额说明').click();
  await page.locator('#commerce-paid-price-reference:popover-open').getByText('苹果内购按实际美元金额填写。').waitFor();
  await page.getByLabel('查看代付金额说明').press('Escape');
  await page.locator('#commerce-payment').selectOption('银行卡');
  assert.equal(await paid.inputValue(), 'PHP');
  assert.equal(await paidAmount.inputValue(), '983');

  await page.goto(origin + '/#/workspace/order/claude');
  await page.locator('#commerce-product').selectOption('Claude Pro');
  await paid.selectOption('CNY');
  await sale.selectOption('EUR');
  await page.setViewportSize({ width: 390, height: 1000 });
  await checkReference('paid', [['中国', '95.0010 CNY']]);
  await checkReference('sale', [['欧元', '49.9900 EUR'], ['人民币', '201 CNY']]);
  await page.locator('#commerce-product').selectOption('Claude Max');
  await paid.selectOption('CNY');
  await checkReference('paid', [['中国', '405.1234 CNY']]);
  await checkReference('sale', [['欧元', '99.1234 EUR'], ['人民币', '301 CNY']]);
  await page.setViewportSize({ width: 1440, height: 1000 });

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
        const actions = [...group.querySelectorAll('.order-financial-heading summary')].map(node => node.getBoundingClientRect());
        return { top: rect.top, left: rect.left, right: rect.right, titleY: title.top + title.height / 2,
          actionsFit: actions.every(a => a.left >= title.right && a.right <= rect.right &&
            a.height >= (innerWidth <= 900 ? 44 : 28) && Math.abs(a.top + a.height / 2 - title.top - title.height / 2) <= 1) };
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
  await openCurrencies('Claude');
  await currencyForm.getByRole('button', { name: '移除币种 欧元 EUR', exact: true }).click();
  await save('commerce-currencies-form');
  await page.goto(origin + '/#/orders/pro');
  await page.locator('#commerce-search').fill('legacy-eur@example.test');
  await page.locator('[data-action="commerce-order-edit"][data-id="legacy-eur"]').click();
  assert.equal(await paid.inputValue(), 'EUR', '编辑原单在移除币种后仍保留原值');
  assert.match(await paid.locator('option:checked').textContent(), /已移出选项/);
  assert.equal(await page.locator('#commerce-paidAmount').inputValue(), '30.1234');
  assert.deepEqual(fixture.commerce.data.orders, originalOrders);
  assert.deepEqual(businessWrites, []);
  assert.deepEqual(errors, []);
  const employeeContext = await browser.newContext();
  await interceptDesign(employeeContext, { localFixtures: fixture, actor: { ...actor, role: 'employee' } });
  const employee = await employeeContext.newPage();
  await employee.goto(origin + '/#/settings/payment-countries');
  await employee.getByRole('heading', { name: '访问受限' }).waitFor();
  assert.equal(await employee.locator('a[href="#/settings/payment-countries"]').count(), 0);
  await employeeContext.close();
});

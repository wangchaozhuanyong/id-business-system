import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { interceptDesign, origin } from './helpers/offline-design.mjs';
import { validOrderCurrencyGroups, retainOrderSettings } from '../server/order-currency-settings.mjs';
import { validClaudePaidPrices, validGptPaidPrices, validOrderPrices, validPersonalPaidPrices } from '../server/order-policy.mjs';

test('GPT、Claude Pro、Claude Max、Gemini、Grok 的币种、代付和售价设置接通订单表单', { timeout: 90_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL,
    ignoreDefaultArgs: ['--hide-scrollbars'] });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 }, locale: 'zh-CN' });
  const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  const actor = { id: 'qa-admin', name: '合成管理员', role: 'admin' };
  const personalPricing = [
    { product: 'Gemini', plan: 'Google AI Plus', saleCode: 'EUR', saleName: '欧元', salePrice: '98.1234', stockPrice: '128.1200',
      paidCode: 'PHP', paidLabel: '菲律宾 · 菲律宾比索 PHP', paidPrice: '349.1000' },
    { product: 'Grok', plan: 'The X Subscription Premium', saleCode: 'GBP', saleName: '英镑', salePrice: '78.1234', stockPrice: '118.1200',
      paidCode: 'EGP', paidLabel: '埃及 · 埃及镑 EGP', paidPrice: '659.0001' }
  ];
  let settings = { version: 1, data: { ...fixture.settings.data,
    orderCurrenciesByProduct: {
      GPT: [{ code: 'CNY', name: '人民币' }, { code: 'PHP', name: '菲律宾比索' }],
      Claude: [{ code: 'CNY', name: '人民币' }, { code: 'MYR', name: '马币' }],
      Gemini: [{ code: 'CNY', name: '人民币' }], Grok: [{ code: 'CNY', name: '人民币' }]
    },
    orderPrices: { GPT: { Plus: { CNY: '101' } }, 'Claude Pro': { Pro: { CNY: '201' } }, 'Claude Max': { 'Max 5x': { CNY: '301' } } },
    gptPaidPrices: { 'Pro 500': { CNY: '80' } }
  } };
  const legacy = { ...fixture.commerce.data.orders.find(row => row.product === 'Claude Pro'),
    id: 'legacy-eur', email: 'legacy-eur@example.test', paidCurrency: 'EUR', saleCurrency: 'EUR',
    paidAmount: '30.1234', saleAmount: '60.1234', cancelled: false, version: 1 };
  fixture.commerce.data.orders.push(legacy);
  const baseOrder = fixture.commerce.data.orders.find(row => row.product === 'GPT');
  for (const { product, plan, saleCode, paidCode } of personalPricing) {
    const slug = product.toLowerCase();
    fixture.commerce.data.orders.push({ ...baseOrder, id: `pricing-${slug}`, email: `pricing-${slug}@example.test`,
      product, plan, businessType: '续费', source: '管理员手工', taskId: '', cancelled: false,
      billingChannel: 'web', billingCycle: 'month', loginMethod: product === 'Gemini' ? 'google' : 'email',
      entitlementStatus: 'pending', paidCurrency: paidCode, saleCurrency: saleCode, paidAmount: '80.0001', saleAmount: '90.0001',
      paidConfirmed: false, receiptConfirmed: false });
  }
  const originalOrders = structuredClone(fixture.commerce.data.orders);
  await interceptDesign(context, { localFixtures: fixture, actor, skipRechargeAssets: true });
  await context.route('**/api/local/auth/order-owners', route => route.fulfill({ json: { items: [actor] } }));
  await context.route('**/api/local/auth/display-names', route => route.fulfill({ json: { items: [actor] } }));
  let failSave = false, rateVersion = 1, phpRate = '0.125';
  const writes = [], businessWrites = [];
  await context.route('**/api/local/finance/collection?**', route => route.fulfill({ json: {
    version: rateVersion,
    now: '2026-11-09T13:00:00Z',
    rows: [
      { currency: 'PHP', rate: phpRate, status: 'valid', source: 'ExchangeRate-API', at: '2026-11-09T12:00:00Z', expiresAt: '2026-11-10T12:00:00Z' },
      { currency: 'CLP', rate: '0.008', status: 'expired', at: '2026-11-08T12:00:00Z', expiresAt: '2026-11-09T12:00:00Z' },
      { currency: 'EGP', rate: '0.16', status: 'valid', source: 'ExchangeRate-API', at: '2026-11-09T12:00:00Z', expiresAt: '2026-11-10T12:00:00Z' }
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
    if ('stockOrderPrices' in command.data) assert(validOrderPrices(command.data.stockOrderPrices));
    if ('gptPaidPrices' in command.data) assert(validGptPaidPrices(command.data.gptPaidPrices));
    if ('claudePaidPrices' in command.data) assert(validClaudePaidPrices(command.data.claudePaidPrices));
    if ('personalPaidPrices' in command.data) assert(validPersonalPaidPrices(command.data.personalPaidPrices));
    settings = { version: command.version + 1, data: retainOrderSettings(command.data, settings.data) };
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
  const orderForm = page.locator('#commerce-order-form:visible');
  const paid = orderForm.locator('#commerce-paidCurrency'), sale = orderForm.locator('#commerce-saleCurrency');
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
    const response = page.waitForResponse(r => r.request().method() === 'PUT' && new URL(r.url()).pathname === '/api/local/settings');
    await page.locator(`button[form="${formId}"][type="submit"]:visible, #${formId} button[type="submit"]:visible`).click();
    assert.equal((await response).status(), status);
    if (status === 200 && paidProduct)
      await page.getByText(paidProduct + ' 代付价格已保存', { exact: true }).waitFor();
    else if (status === 200) await page.locator('#drawer:not([open])').waitFor({ state: 'attached' });
    else await page.getByText('模拟设置保存失败', { exact: true }).waitFor();
  }
  async function choosePreset(kind, amount, code, scope = orderForm) {
    const label = kind === 'paid' ? '选择代付金额' : '选择售卖金额';
    await scope.getByRole('button', { name: label, exact: true }).click();
    await page.getByRole('menu', { name: label, exact: true })
      .getByRole('menuitem', { name: `使用预设 ${amount} ${code}`, exact: true }).click();
    assert.equal(await scope.locator(`#commerce-${kind}Amount`).inputValue(), amount);
  }
  await page.goto(origin + '/#/workspace/order/claude');
  await orderForm.locator('#commerce-plan').selectOption('Pro');
  await page.waitForFunction(() => document.querySelector('#commerce-saleAmount')?.value === '201');
  assert.equal(await page.locator('#main :is([data-action="commerce-price-settings"], [data-action="commerce-currency-settings"])').count(), 0);
  assert.deepEqual(await codes(paid), ['CNY', 'MYR']);
  assert.deepEqual(await codes(sale), ['CNY', 'MYR']);
  await orderForm.locator('#commerce-businessType').selectOption('成品交付');
  assert.equal(await orderForm.locator('#commerce-saleAmount').inputValue(), '', '成品号未定价时保持空值');
  await orderForm.locator('#commerce-businessType').selectOption('续费');
  assert.equal(await orderForm.locator('#commerce-saleAmount').inputValue(), '201');
  await orderForm.locator('#commerce-email').fill('claude-draft@example.test');
  await orderForm.locator('#commerce-paidAmount').fill('24.0001');
  await openCurrencies('Claude');
  await add('欧元 EUR');
  await currencyForm.getByRole('button', { name: '移除币种 马币 MYR', exact: true }).click();
  await close();
  await page.goto(origin + '/#/workspace/order/gpt');
  await page.waitForFunction(() => document.querySelector('#commerce-saleAmount')?.value === '101');
  assert.equal(await page.locator('#main :is([data-action="commerce-price-settings"], [data-action="commerce-currency-settings"])').count(), 0);
  assert.equal(await paid.inputValue(), 'PHP');
  assert.deepEqual(await codes(paid), ['PHP', 'CLP', 'USD', 'IDR', 'MYR', 'EGP', 'CNY']);
  assert.equal(await paid.locator('option[value="CNY"]').textContent(), '其他 · 人民币 CNY');
  await openCurrencies('GPT');
  assert.deepEqual(await currencies(), ['人民币 CNY', '菲律宾比索 PHP'], 'GPT 草稿不混入 Claude 币种');
  await add('英镑 GBP');
  await close();
  await page.goto(origin + '/#/workspace/order/claude');
  assert.equal(await orderForm.locator('#commerce-email').inputValue(), 'claude-draft@example.test');
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
  const renewalPrices = prices.locator('[data-price-panel="orderPrices"]');
  const stockPrices = prices.locator('[data-price-panel="stockOrderPrices"]');
  const priceCurrency = prices.locator('#commerce-price-currency');
  const priceGroup = prices.locator('[data-price-group]:visible');
  const priceTab = label => page.locator('#drawer[open]').getByRole('tab', { name: label, exact: true }).click();
  async function checkPriceGroup(code, title, plans) {
    assert.equal(await priceGroup.getAttribute('data-price-group'), code);
    assert.equal(await priceGroup.getByRole('heading').textContent(), title);
    assert.deepEqual(await priceGroup.locator('label').allTextContents(), plans);
    assert.deepEqual(await prices.locator('[data-price-currency]:visible').evaluateAll(nodes =>
      nodes.map(node => [node.dataset.priceCurrency, node.dataset.pricePlan])), plans.map(plan => [code, plan]));
  }
  await prices.waitFor();
  assert.deepEqual(await prices.locator('[data-price-product]').evaluateAll(nodes => [...new Set(nodes.map(node => node.dataset.priceProduct))]), ['Claude Pro', 'Claude Max']);
  assert.deepEqual(await codes(priceCurrency), ['CNY', 'EUR']);
  await checkPriceGroup('CNY', '人民币 CNY', ['Pro', 'Max 5x', 'Max 20x']);
  assert.equal(await renewalPrices.locator('[data-price-product="Claude Pro"][data-price-currency="CNY"]').inputValue(), '201');
  await priceCurrency.selectOption('EUR');
  await checkPriceGroup('EUR', '欧元 EUR', ['Pro', 'Max 5x', 'Max 20x']);
  await renewalPrices.locator('[data-price-product="Claude Pro"][data-price-currency="EUR"]').fill('49.9900');
  await renewalPrices.locator('[data-price-product="Claude Max"][data-price-plan="Max 5x"][data-price-currency="EUR"]').fill('99.1234');
  await priceTab('成品号售价');
  await checkPriceGroup('EUR', '欧元 EUR', ['Pro', 'Max 5x', 'Max 20x']);
  assert.equal(await stockPrices.locator('[data-price-product="Claude Pro"][data-price-currency="CNY"]').inputValue(), '');
  await stockPrices.locator('[data-price-product="Claude Pro"][data-price-currency="EUR"]').fill('129.5000');
  const stockMaxPrice = stockPrices.locator('[data-price-product="Claude Max"][data-price-plan="Max 5x"][data-price-currency="EUR"]');
  await stockMaxPrice.fill('199.9999');
  await close();
  await openPrices('Claude');
  await prices.waitFor();
  assert(await stockPrices.isVisible(), '重新打开保留成品号页签和草稿');
  assert.equal(await priceCurrency.inputValue(), 'EUR', '重新打开保留币种选择');
  assert.equal(await stockMaxPrice.inputValue(), '199.9999');
  const dismissNotice = page.getByRole('button', { name: '关闭提示', exact: true });
  if (await dismissNotice.isVisible()) await dismissNotice.click();
  const priceEvidence = new URL('../.runtime/stock-order-prices-20261110/', import.meta.url);
  await mkdir(priceEvidence, { recursive: true });
  for (const width of [1440, 1024, 901, 900, 768, 390]) for (const dark of [false, true]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(dark => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; }, dark);
    for (const label of ['续费售价', '成品号售价']) {
      await priceTab(label);
      const fieldsFit = await priceGroup.locator('.field').evaluateAll(fields => fields.every(field => {
        const label = field.querySelector('label').getBoundingClientRect();
        const input = field.querySelector('input').getBoundingClientRect();
        return label.left >= 0 && label.right <= input.left + 1 && label.top < input.bottom &&
          input.right <= innerWidth && input.width > 0;
      }));
      assert(fieldsFit, `售价标签和输入框在 ${width}px ${dark ? '深色' : '浅色'} 下保持左侧布局`);
      assert(await page.locator('#drawer').evaluate(node => node.scrollWidth <= node.clientWidth));
    }
    if ((width === 1440 && !dark) || (width === 390 && dark))
      await page.locator('#drawer').screenshot({ path: fileURLToPath(new URL(`stock-prices-${width}-${dark ? 'dark' : 'light'}.png`, priceEvidence)) });
  }
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.evaluate(() => { document.documentElement.dataset.theme = 'light'; });
  await stockMaxPrice.fill('-1');
  await priceTab('续费售价');
  await priceCurrency.selectOption('CNY');
  const beforeInvalidPrice = writes.length;
  await page.locator('button[form="commerce-prices-form"][type="submit"]').click();
  await stockPrices.getByText('请输入非负金额，最多四位小数', { exact: true }).waitFor();
  assert(await stockPrices.isVisible(), '隐藏页签中的错误会切换到对应页签');
  assert.equal(await priceCurrency.inputValue(), 'EUR', '隐藏币种中的错误会切换到对应币种');
  assert(await stockMaxPrice.evaluate(node => node === document.activeElement));
  assert.equal(writes.length, beforeInvalidPrice);
  await stockMaxPrice.fill('199.9999');
  failSave = true;
  await save('commerce-prices-form', 503);
  assert.equal(await stockMaxPrice.inputValue(), '199.9999');
  await save('commerce-prices-form');
  assert.equal(settings.data.orderPrices.GPT.Plus.CNY, '101');
  assert.equal(settings.data.stockOrderPrices['Claude Pro'].Pro.EUR, '129.5000');
  assert.equal(settings.data.stockOrderPrices['Claude Max']['Max 5x'].EUR, '199.9999');
  await page.goto(origin + '/#/workspace/order/claude');
  await orderForm.locator('#commerce-plan').selectOption('Pro');
  await sale.selectOption('EUR');
  assert.equal(await orderForm.locator('#commerce-saleAmount').inputValue(), '49.9900');
  assert.equal(await orderForm.locator('[name="commerce-receiptConfirmed"]').count(), 0);
  await orderForm.locator('#commerce-businessType').selectOption('成品交付');
  assert.equal(await orderForm.locator('#commerce-saleAmount').inputValue(), '129.5000');
  assert.match(await orderForm.locator('#commerce-sale-price-reference').textContent(), /成品号售价/);
  await orderForm.locator('#commerce-plan').selectOption('Max 5x');
  assert.equal(await orderForm.locator('#commerce-saleAmount').inputValue(), '199.9999');
  await orderForm.locator('#commerce-businessType').selectOption('续费');
  assert.equal(await sale.inputValue(), 'EUR');
  assert.equal(await orderForm.locator('#commerce-saleAmount').inputValue(), '99.1234');
  await openPrices('GPT');
  await prices.waitFor();
  assert.deepEqual(await prices.locator('[data-price-product]').evaluateAll(nodes => [...new Set(nodes.map(node => node.dataset.priceProduct))]), ['GPT']);
  await checkPriceGroup('CNY', '人民币 CNY', ['Plus', 'Pro 100', 'Pro 200', 'Pro 500']);
  await renewalPrices.locator('[data-price-plan="Plus"][data-price-currency="CNY"]').fill('111.1111');
  await priceCurrency.selectOption('PHP');
  await checkPriceGroup('PHP', '菲律宾比索 PHP', ['Plus', 'Pro 100', 'Pro 200', 'Pro 500']);
  await renewalPrices.locator('[data-price-plan="Plus"][data-price-currency="PHP"]').fill('998.1234');
  await priceCurrency.selectOption('CNY');
  assert.equal(await renewalPrices.locator('[data-price-plan="Plus"][data-price-currency="CNY"]').inputValue(), '111.1111');
  await priceTab('成品号售价');
  await stockPrices.locator('[data-price-plan="Plus"][data-price-currency="CNY"]').fill('211.1111');
  await save('commerce-prices-form');
  assert.equal(settings.data.orderPrices['Claude Pro'].Pro.EUR, '49.9900');
  assert.equal(settings.data.orderPrices['Claude Max']['Max 5x'].EUR, '99.1234');
  assert.equal(settings.data.stockOrderPrices['Claude Pro'].Pro.EUR, '129.5000');
  assert.equal(settings.data.stockOrderPrices['Claude Max']['Max 5x'].EUR, '199.9999');
  assert.equal(settings.data.orderPrices.GPT.Plus.PHP, '998.1234');
  await page.goto(origin + '/#/workspace/order/gpt');
  await orderForm.locator('#commerce-businessType').selectOption('成品交付');
  assert.equal(await orderForm.locator('#commerce-saleAmount').inputValue(), '211.1111');
  await orderForm.locator('#commerce-businessType').selectOption('续费');
  assert.equal(await orderForm.locator('#commerce-saleAmount').inputValue(), '111.1111');

  await settingsTab('代付价格');
  const country = page.locator('#commerce-paid-country');
  const paidForm = page.locator('#commerce-paid-prices-form');
  const plus = paidForm.getByRole('textbox', { name: 'Plus 原币代付金额', exact: true });
  const pro = paidForm.getByRole('textbox', { name: 'Pro 100 原币代付金额', exact: true });
  const budget = paidForm.locator('[data-paid-budget]').first();
  const quote = page.locator('#commerce-paid-quote');
  const paidPricesFit = () => paidForm.locator('.paid-price-fields').evaluate(grid => {
    const edge = grid.getBoundingClientRect();
    return document.documentElement.scrollWidth <= innerWidth && [...grid.querySelectorAll('.field')].every(field => {
      const label = field.querySelector('label').getBoundingClientRect();
      const input = field.querySelector('input').getBoundingClientRect();
      const budget = document.createRange();
      budget.selectNodeContents(field.querySelector('output'));
      return label.left >= edge.left && label.right <= input.left + 1 && input.right <= edge.right + 1 &&
        input.width > 0 && budget.getClientRects().length === 1 && budget.getBoundingClientRect().right <= edge.right + 1;
    });
  });
  assert.deepEqual(await codes(country), ['PHP', 'CLP', 'USD', 'IDR', 'MYR', 'EGP']);
  assert.equal(await country.locator('option[value="EGP"]').textContent(), '埃及 · 埃及镑 EGP');
  assert(await paidForm.getByRole('heading', { name: '菲律宾 · 菲律宾比索 PHP', exact: true }).isVisible());
  await plus.fill('983');
  await pro.fill('1200');
  await country.selectOption('EGP');
  assert(await paidForm.getByRole('heading', { name: '埃及 · 埃及镑 EGP', exact: true }).isVisible());
  assert.equal(await plus.inputValue(), '', '埃及的代付金额独立于菲律宾');
  await country.selectOption('PHP');
  assert.equal(await plus.inputValue(), '983', '切换国家后恢复菲律宾草稿');
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
  await country.selectOption('EGP');
  await quote.getByText(/每 1 EGP 折合 0.16 CNY/).waitFor();
  await paidForm.getByRole('textbox', { name: 'Pro 500 原币代付金额', exact: true }).fill('1250');
  await paidForm.locator('[data-paid-budget]').last().filter({ hasText: '¥ 200.00' }).waitFor();
  await save('commerce-paid-prices-form');
  assert.equal(settings.data.gptPaidPrices['Pro 500'].EGP, '1250');
  assert.equal(settings.data.gptPaidPrices['Pro 500'].CNY, '80');
  await country.selectOption('IDR');
  await quote.getByText(/暂无有效汇率/).waitFor();
  assert.equal(await plus.inputValue(), '');
  for (const width of [1440, 390, 320]) for (const dark of [false, true]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(dark => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; }, dark);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
    const countryBox = await country.boundingBox();
    assert(countryBox && countryBox.x >= 0 && countryBox.x + countryBox.width <= width);
    assert(await paidPricesFit(), `代付金额和预算在 ${width}px 下同时可见`);
    assert(await paidForm.getByRole('button', { name: '保存代付价格' }).isVisible());
  }
  await page.setViewportSize({ width: 1440, height: 1000 });

  const paidProduct = page.locator('#commerce-paid-product');
  await paidProduct.selectOption('Claude Pro');
  await country.selectOption('EGP');
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
  assert.equal(settings.data.claudePaidPrices['Claude Pro'].Pro.EGP, '95.0010');
  assert.equal(settings.data.claudePaidPrices['Claude Max']['Max 5x'].EGP, '405.1234');
  assert.equal(settings.data.gptPaidPrices.Plus.PHP, '983');

  for (const { product, plan: productPlan, saleCode, saleName, salePrice, stockPrice, paidCode, paidLabel, paidPrice } of personalPricing) {
    const slug = product.toLowerCase();
    await openCurrencies(product);
    assert.deepEqual(await currencies(), ['人民币 CNY']);
    await add(`${saleName} ${saleCode}`);
    await save('commerce-currencies-form');
    assert.deepEqual(settings.data.orderCurrenciesByProduct[product].map(row => row.code), ['CNY', saleCode]);
    await openPrices(product);
    await prices.waitFor();
    await priceCurrency.selectOption(saleCode);
    assert.equal(await priceGroup.getByRole('heading').textContent(), `${saleName} ${saleCode}`);
    assert(await prices.locator('[data-price-currency]:visible').evaluateAll((nodes, code) =>
      nodes.length > 0 && nodes.every(node => node.dataset.priceCurrency === code), saleCode));
    const priceField = `[data-price-plan="${productPlan}"][data-price-currency="${saleCode}"]`;
    await renewalPrices.locator(priceField).fill(salePrice);
    await priceTab('成品号售价');
    await stockPrices.locator(priceField).fill(stockPrice);
    await save('commerce-prices-form');
    assert.equal(settings.data.orderPrices[product][productPlan][saleCode], salePrice);
    assert.equal(settings.data.stockOrderPrices[product][productPlan][saleCode], stockPrice);

    await settingsTab('代付价格');
    await paidProduct.selectOption(product);
    await country.selectOption(paidCode);
    const priceInput = paidForm.getByRole('textbox', { name: `${productPlan} 原币代付金额`, exact: true });
    assert.equal(await priceInput.inputValue(), '');
    await priceInput.fill(paidPrice);
    assert(await paidForm.getByRole('heading', { name: paidLabel, exact: true }).isVisible());
    for (const width of [390, 320]) for (const dark of [false, true]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.evaluate(dark => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; }, dark);
      assert(await paidPricesFit(), `${product} 在 ${width}px ${dark ? '深色' : '浅色'} 下显示完整金额和预算`);
    }
    if (product === 'Gemini') {
      failSave = true;
      await save('commerce-paid-prices-form', 503);
      assert.equal(await priceInput.inputValue(), paidPrice);
    }
    await save('commerce-paid-prices-form');
    assert.equal(writes.at(-1).action, 'personal_paid_prices_save');
    assert.equal(settings.data.personalPaidPrices[product][productPlan][paidCode], paidPrice);
    await page.setViewportSize({ width: 1440, height: 1000 });

    await page.goto(origin + '/#/workspace/order/' + slug);
    const order = page.locator('#main #commerce-order-form[data-price-reference-status="ready"]');
    await order.waitFor();
    await order.locator('#commerce-plan').selectOption(productPlan);
    assert.deepEqual(await codes(sale), ['CNY', saleCode]);
    assert.equal(await paid.locator(`option[value="${paidCode}"]`).textContent(), paidLabel);
    await paid.selectOption(paidCode);
    await sale.selectOption(saleCode);
    await choosePreset('paid', paidPrice, paidCode, order);
    await choosePreset('sale', salePrice, saleCode, order);
    await order.locator('#commerce-businessType').selectOption('成品交付');
    await choosePreset('sale', stockPrice, saleCode, order);
    if (product === 'Gemini') {
      await order.locator('#commerce-payment').selectOption('苹果内购');
      assert.deepEqual(await codes(paid), ['USD']);
      await order.getByRole('button', { name: '选择代付金额', exact: true }).click();
      assert(await page.getByRole('menuitem', { name: '当前币种暂无预设金额' }).isDisabled());
      await page.keyboard.press('Escape');
    }

    await page.goto(origin + '/#/orders/' + slug);
    await page.locator(`[data-action="commerce-order-edit"][data-id="pricing-${slug}"]`).click();
    const editor = page.locator('#drawer[open] #commerce-order-form[data-price-reference-status="ready"]');
    await editor.waitFor();
    assert.equal(await editor.locator('#commerce-paidAmount').inputValue(), '80.0001');
    assert.equal(await editor.locator('#commerce-saleAmount').inputValue(), '90.0001');
    assert.equal(await editor.locator('#commerce-correctionReason').inputValue(), '修改错误');
    await choosePreset('paid', paidPrice, paidCode, editor);
    await choosePreset('sale', salePrice, saleCode, editor);
    await close();
  }
  assert.equal(settings.data.personalPaidPrices.Gemini['Google AI Plus'].PHP, '349.1000');
  assert.deepEqual(settings.data.orderCurrenciesByProduct.Gemini.map(row => row.code), ['CNY', 'EUR']);
  assert.deepEqual(settings.data.orderCurrenciesByProduct.Grok.map(row => row.code), ['CNY', 'GBP']);
  assert.equal(settings.data.claudePaidPrices['Claude Max']['Max 5x'].EGP, '405.1234');
  assert.equal(settings.data.gptPaidPrices.Plus.PHP, '983');

  async function checkReference(kind, expected) {
    const id = 'commerce-' + kind + '-price-reference';
    const note = orderForm.locator('#' + id);
    const trigger = orderForm.locator(`summary[aria-controls="${id}"]`);
    assert(!(await note.isVisible()));
    await trigger.scrollIntoViewIfNeeded();
    const groups = orderForm.locator('.order-financial-groups');
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

  const paidAmount = orderForm.locator('#commerce-paidAmount'), plan = orderForm.locator('#commerce-plan');
  await page.goto(origin + '/#/workspace/order/gpt');
  await page.waitForFunction(() => document.querySelector('#commerce-paidAmount')?.value === '983');
  assert.match(await orderForm.locator('label[for="commerce-paidCurrency"]').textContent(), /国家／地区/);
  assert.equal(await paid.inputValue(), 'PHP');
  assert.equal(await page.getByText('折合人民币预算', { exact: true }).count(), 0);
  await checkReference('paid', [['菲律宾', '983 PHP'], ['智利', '10000 CLP']]);
  await checkReference('sale', [['人民币', '111.1111 CNY'], ['菲律宾比索', '998.1234 PHP']]);
  assert.equal(await orderForm.locator('[name="commerce-paidConfirmed"]').count(), 0);
  await plan.selectOption('Pro 100');
  assert.equal(await paidAmount.inputValue(), '1200');
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
  await orderForm.locator('#commerce-payment').selectOption('苹果内购');
  assert.equal(await paid.inputValue(), 'USD');
  assert.equal(await paidAmount.inputValue(), '');
  await orderForm.getByLabel('查看代付金额说明').click();
  await orderForm.locator('#commerce-paid-price-reference:popover-open').getByText('苹果内购按实际美元金额填写。').waitFor();
  await orderForm.getByLabel('查看代付金额说明').press('Escape');
  await orderForm.locator('#commerce-payment').selectOption('银行卡');
  assert.equal(await paid.inputValue(), 'PHP');
  assert.equal(await paidAmount.inputValue(), '983');
  await plan.selectOption('Pro 500');
  await paid.selectOption('EGP');
  assert.equal(await paidAmount.inputValue(), '1250');

  await page.goto(origin + '/#/workspace/order/claude');
  await orderForm.locator('#commerce-plan').selectOption('Pro');
  await paid.selectOption('CNY');
  await sale.selectOption('EUR');
  await page.setViewportSize({ width: 390, height: 1000 });
  await checkReference('paid', [['人民币', '未配置（CNY）'], ['埃及', '95.0010 EGP']]);
  await checkReference('sale', [['欧元', '49.9900 EUR'], ['人民币', '201 CNY']]);
  await paid.selectOption('EGP');
  await choosePreset('paid', '95.0010', 'EGP');
  await orderForm.locator('#commerce-plan').selectOption('Max 5x');
  await paid.selectOption('CNY');
  await checkReference('paid', [['人民币', '未配置（CNY）'], ['埃及', '405.1234 EGP']]);
  await checkReference('sale', [['欧元', '99.1234 EUR'], ['人民币', '301 CNY']]);
  await paid.selectOption('EGP');
  await choosePreset('paid', '405.1234', 'EGP');
  await page.setViewportSize({ width: 1440, height: 1000 });

  const evidence = new URL('../.runtime/order-product-settings-20261108/', import.meta.url);
  const screenshots = process.env.ID_ORDER_SETTINGS_SCREENSHOTS === '1';
  if (screenshots) await mkdir(evidence, { recursive: true });
  for (const product of ['gpt', 'claude']) {
    await page.goto(origin + '/#/workspace/order/' + product);
    for (const width of [1920, 1440, 1024, 390, 320]) for (const dark of [false, true]) {
      await page.setViewportSize({ width, height: 1000 });
      await page.waitForFunction(() => innerWidth > 900 || document.querySelector('#sidebar').getBoundingClientRect().right <= 0);
      await page.evaluate(dark => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; }, dark);
      const geometry = await orderForm.locator('.order-financial-group').evaluateAll(groups => groups.map(group => {
        const rect = group.getBoundingClientRect(), title = group.querySelector('h3').getBoundingClientRect();
        const actions = [...group.querySelectorAll('.order-financial-heading summary')].map(node => node.getBoundingClientRect());
        return { top: rect.top, left: rect.left, right: rect.right, titleY: title.top + title.height / 2,
          actionsFit: actions.every(a => a.left >= title.right && a.right <= rect.right &&
            a.height >= (innerWidth <= 900 ? 44 : 28) && Math.abs(a.top + a.height / 2 - title.top - title.height / 2) <= 1) };
      }));
      assert(geometry.every(row => row.actionsFit && row.left >= 0 && row.right <= width), JSON.stringify({ product, width, dark, geometry }));
      for (const row of geometry)
        for (const peer of geometry.filter(peer => Math.abs(peer.top - row.top) <= 1))
          assert(Math.abs(row.titleY - peer.titleY) <= 1, '同排费用模块的实际标题文字居中模型一致');
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      if (screenshots && product === 'claude' && !dark && [1440, 390].includes(width)) {
        await orderForm.locator('.order-financial-groups').screenshot({ path: fileURLToPath(new URL(`claude-${width}-light.png`, evidence)) });
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
  assert.equal(await orderForm.locator('#commerce-paidAmount').inputValue(), '30.1234');
  assert.equal(await orderForm.locator('#commerce-saleAmount').inputValue(), '60.1234');
  const savedType = orderForm.locator('#commerce-businessType');
  assert.equal(await savedType.inputValue(), '续费');
  assert.equal(await savedType.isEditable(), false, '编辑原订单时保留业务类型');
  assert.equal(await orderForm.locator('#commerce-saleAmount').inputValue(), '60.1234', '编辑历史订单保留原售价');
  assert.deepEqual(fixture.commerce.data.orders, originalOrders);
  assert.deepEqual(businessWrites, []);
  assert.deepEqual(errors, []);
  const employeeContext = await browser.newContext();
  await interceptDesign(employeeContext, { localFixtures: fixture, actor: { ...actor, role: 'employee' }, skipRechargeAssets: true });
  const employee = await employeeContext.newPage();
  await employee.goto(origin + '/#/settings/payment-countries');
  await employee.getByRole('heading', { name: '访问受限' }).waitFor();
  assert.equal(await employee.locator('a[href="#/settings/payment-countries"]').count(), 0);
  await employeeContext.close();
});

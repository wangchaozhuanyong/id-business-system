import assert from 'node:assert/strict';
import { mkdir, readFile } from 'node:fs/promises';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { interceptDesign, origin, settle } from './helpers/offline-design.mjs';

test('订单金额预设、手填、更正原因和既有价格与订阅快捷操作', { timeout: 90_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 },
    locale: 'zh-CN', timezoneId: 'America/Los_Angeles' });
  const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  const actor = { id: 'qa-admin', name: '合成管理员', role: 'admin' };
  fixture.settings.data = { ...fixture.settings.data,
    gptPaidPrices: { Plus: { PHP: '983', EGP: '1999.1234' }, 'Pro 100': { EGP: '5900' } },
    claudePaidPrices: { 'Claude Pro': { Pro: { MYR: '88', USD: '20' } } },
    orderPrices: { GPT: { Plus: { CNY: '1320', USD: '190' } }, 'Claude Pro': { Pro: { CNY: '300' } } },
    stockOrderPrices: { GPT: { Plus: { CNY: '1680' } } }
  };
  const prior = { ...fixture.commerce.data.orders.find(row => row.product === 'GPT'),
    id: 'manual-shortcuts', email: 'manual-shortcuts@example.test', source: '管理员手工', taskId: '', version: 1, cancelled: false,
    start: '2026-11-01 10:00', expiry: '2026-12-01 10:00', paidCurrency: 'PHP', paidAmount: '975.1000',
    saleCurrency: 'CNY', saleAmount: '1200', paidConfirmed: false, receiptConfirmed: false, correctionReason: '上次更正的原因' };
  fixture.commerce.data.orders.push(prior, { ...prior, id: 'locked-shortcuts', email: 'locked-shortcuts@example.test', source: '线上代充', taskId: 'locked-task' });
  const { external } = await interceptDesign(context, { localFixtures: fixture, actor });
  let failSettings = false, holdSettings = false, releaseSettings;
  const writes = [];
  await context.route('**/api/local/**', async route => {
    if (!['GET', 'HEAD'].includes(route.request().method())) {
      writes.push(new URL(route.request().url()).pathname);
      return route.fulfill({ status: 500, json: { error: '本测试不允许写入' } });
    }
    return route.fallback();
  });
  await context.route('**/api/local/settings', async route => {
    if (route.request().method() !== 'GET') return route.fallback();
    if (holdSettings) { holdSettings = false; await new Promise(resolve => { releaseSettings = resolve; }); }
    if (failSettings) {
      failSettings = false;
      return route.fulfill({ status: 503, json: { error: '模拟价格读取失败' } });
    }
    return route.fulfill({ json: fixture.settings });
  });
  await context.route('**/api/local/auth/order-owners', route => route.fulfill({ json: { items: [actor] } }));
  await context.route('**/api/local/auth/display-names', route => route.fulfill({ json: { items: [actor] } }));
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  await page.clock.setFixedTime(new Date('2026-03-01T16:10:40Z'));
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const form = page.locator('#main #commerce-order-form');
  const panel = page.locator('#drawer[open] #commerce-order-price-reference-panel');
  const referenceButton = (kind, scope = form) => scope.locator(`[data-action="commerce-order-price-reference"][data-kind="${kind}"]`);
  const amountLabel = kind => kind === 'paid' ? '选择代付金额' : '选择售卖金额';
  const amountButton = (kind, scope = form) => scope.getByRole('button', { name: amountLabel(kind), exact: true });
  async function openAmount(kind, scope = form) {
    await amountButton(kind, scope).click();
    const menu = page.getByRole('menu', { name: amountLabel(kind), exact: true });
    await menu.waitFor();
    return menu;
  }
  async function openReference(kind, scope = form) {
    await referenceButton(kind, scope).click();
    await panel.waitFor();
    await panel.locator('.form-section').waitFor();
  }
  async function closeReference() {
    await page.getByRole('button', { name: '返回订单', exact: true }).click();
    await panel.waitFor({ state: 'hidden' });
  }
  const priceGroups = () => panel.locator('[data-price-group]').evaluateAll(groups => groups.map(group => [
    group.dataset.priceGroup,
    [...group.querySelectorAll('tbody tr')].map(row => [...row.cells].map(cell => cell.textContent))
  ]));
  await page.goto(origin + '/#/workspace/order/gpt');
  await page.waitForFunction(() => document.querySelector('#commerce-saleAmount')?.value === '1320');
  const paidAmount = form.locator('#commerce-paidAmount'), saleAmount = form.locator('#commerce-saleAmount');
  await paidAmount.fill('975.1234');
  let menu = await openAmount('paid');
  assert.equal(await menu.getByRole('menuitem', { name: /^使用预设/ }).count(), 1);
  await menu.getByRole('menuitem', { name: '使用预设 983 PHP', exact: true }).press('Enter');
  assert.equal(await paidAmount.inputValue(), '983');
  assert(!(await form.getByRole('checkbox', { name: '代付已确认' }).isChecked()));
  await form.locator('#commerce-paidCurrency').selectOption('CLP');
  menu = await openAmount('paid');
  assert(await menu.getByRole('menuitem', { name: '当前币种暂无预设金额', exact: true }).isDisabled());
  await menu.getByRole('menuitem', { name: '手动填写', exact: true }).click();
  assert(await paidAmount.evaluate(node => node === document.activeElement));
  await paidAmount.fill('10.0123');
  assert.equal(await paidAmount.inputValue(), '10.0123');
  await form.locator('#commerce-paidCurrency').selectOption('PHP');
  await form.locator('#commerce-saleCurrency').selectOption('USD');
  await saleAmount.fill('188.1234');
  menu = await openAmount('sale');
  await menu.getByRole('menuitem', { name: '使用预设 190 USD', exact: true }).click();
  assert.equal(await saleAmount.inputValue(), '190');
  assert(!(await form.getByRole('checkbox', { name: '实收已确认' }).isChecked()));
  await form.locator('#commerce-saleCurrency').selectOption('CNY');
  await form.locator('#commerce-paidAmount').fill('975.1234');
  await form.locator('#commerce-saleAmount').fill('1400');
  await form.locator('#commerce-notes').fill('查看价格时保留录单草稿');
  const draft = await form.evaluate(node => Object.fromEntries(new FormData(node)));
  await openReference('paid');
  assert.deepEqual(await priceGroups(), [
    ['PHP', [['Plus', '983']]],
    ['EGP', [['Plus', '1999.1234'], ['Pro 100', '5900']]]
  ]);
  assert.match(await panel.innerText(), /菲律宾.*PHP/s);
  assert.match(await panel.innerText(), /埃及.*EGP.*1999\.1234/s);
  assert.doesNotMatch(await panel.innerText(), /人民币|CNY|折合|汇率|预算/);
  assert.equal(await panel.locator('input, select, textarea, button[type="submit"]').count(), 0);
  await closeReference();
  assert.deepEqual(await form.evaluate(node => Object.fromEntries(new FormData(node))), draft);
  assert(await referenceButton('paid').evaluate(node => node === document.activeElement));
  await openReference('sale');
  assert.deepEqual(await priceGroups(), [['CNY', [['Plus', '1320']]], ['USD', [['Plus', '190']]]]);
  assert.match(await panel.innerText(), /续费售价.*1320/s);
  assert.doesNotMatch(await panel.innerText(), /1680/);
  await page.keyboard.press('Escape');
  await panel.waitFor({ state: 'hidden' });
  assert.equal(await form.locator('#commerce-saleAmount').inputValue(), '1400');
  await form.locator('#commerce-businessType').selectOption('成品交付');
  await openReference('sale');
  assert.match(await panel.innerText(), /成品号售价.*1680/s);
  assert.doesNotMatch(await panel.innerText(), /1320/);
  await closeReference();
  menu = await openAmount('sale');
  assert(await menu.getByRole('menuitem', { name: '使用预设 1680 CNY', exact: true }).isVisible());
  await page.keyboard.press('Escape');
  fixture.settings.data.stockOrderPrices.GPT.Plus.CNY = '1780';
  await openReference('sale');
  assert.match(await panel.innerText(), /1780/, '重开读取已保存的新价格');
  await closeReference();
  failSettings = true;
  await referenceButton('paid').click();
  await panel.getByText('价格读取失败，请重试。', { exact: true }).waitFor();
  await panel.getByRole('button', { name: '重试', exact: true }).click();
  await panel.locator('tbody tr').first().waitFor();
  await closeReference();

  await form.locator('#commerce-start').fill('2000-01-01T01:00');
  for (const [label, start, expiry] of [
    ['15分钟前', '2026-03-01T23:55', '2026-04-01T23:55'],
    ['1小时前', '2026-03-01T23:10', '2026-04-01T23:10'],
    ['2小时前', '2026-03-01T22:10', '2026-04-01T22:10']
  ]) {
    await form.getByRole('button', { name: label, exact: true }).click();
    assert.equal(await form.locator('#commerce-start').inputValue(), start, '按点击时刻倒推，并按北京时间显示');
    assert.equal(await form.locator('#commerce-expiry').inputValue(), expiry);
  }
  await page.clock.setFixedTime(new Date('2026-12-31T16:05:00Z'));
  await form.getByRole('button', { name: '15分钟前', exact: true }).click();
  assert.equal(await form.locator('#commerce-start').inputValue(), '2026-12-31T23:50', '再次点击以新时刻计算，正确跨年');
  assert.equal(await form.locator('#commerce-expiry').inputValue(), '2027-01-31T23:50');
  await page.clock.setFixedTime(new Date('2026-01-31T04:00:00Z'));
  await form.getByRole('button', { name: '2小时前', exact: true }).click();
  assert.equal(await form.locator('#commerce-start').inputValue(), '2026-01-31T10:00');
  assert.equal(await form.locator('#commerce-expiry').inputValue(), '2026-02-28T10:00', '沿用月末到期规则');
  await page.goto(origin + '/#/workspace/order/claude');
  await page.goto(origin + '/#/workspace/order/gpt');
  assert.equal(await form.locator('#commerce-start').inputValue(), '2026-01-31T10:00', '快捷时间保存在会话草稿');
  assert.equal(await form.locator('#commerce-notes').inputValue(), '查看价格时保留录单草稿');

  holdSettings = true;
  await referenceButton('paid').click();
  await panel.getByText('正在读取已设置的价格…', { exact: true }).waitFor();
  await closeReference();
  await page.goto(origin + '/#/workspace/order/claude');
  releaseSettings();
  await page.waitForFunction(() => document.querySelector('#commerce-product')?.value === 'Claude Pro');
  await form.and(page.locator('[data-price-reference-status="ready"]')).waitFor();
  await form.locator('#commerce-paidCurrency').selectOption('MYR');
  menu = await openAmount('paid');
  await menu.getByRole('menuitem', { name: '使用预设 88 MYR', exact: true }).click();
  assert.equal(await paidAmount.inputValue(), '88');
  await openReference('paid');
  assert.match(await panel.innerText(), /88/);
  assert.doesNotMatch(await panel.innerText(), /983|1999/);
  await closeReference();
  await form.locator('#commerce-businessType').selectOption('成品交付');
  await openReference('sale');
  assert.match(await panel.innerText(), /尚未配置成品号售价/);
  await closeReference();

  await page.goto(origin + '/#/orders/gpt');
  await page.locator('#commerce-search').fill('manual-shortcuts@example.test');
  await page.locator('[data-action="commerce-order-edit"][data-id="manual-shortcuts"]').click();
  const editor = page.locator('#drawer[open] #commerce-order-form');
  const editorPaid = editor.locator('#commerce-paidAmount'), editorSale = editor.locator('#commerce-saleAmount');
  const reason = editor.locator('#commerce-correctionReason');
  await editor.and(page.locator('[data-price-reference-status="ready"]')).waitFor();
  assert.equal(await editorPaid.inputValue(), '975.1000', '打开旧单先显示历史原金额');
  assert.equal(await editorSale.inputValue(), '1200');
  assert.equal(await reason.inputValue(), '修改错误', '新更正不沿用上一次的原因');
  await editor.locator('#commerce-paidCurrency').selectOption('EGP');
  assert.equal(await editorPaid.inputValue(), '975.1000');
  menu = await openAmount('paid', editor);
  await menu.getByRole('menuitem', { name: '使用预设 1999.1234 EGP', exact: true }).click();
  assert.equal(await editorPaid.inputValue(), '1999.1234');
  menu = await openAmount('sale', editor);
  await menu.getByRole('menuitem', { name: '使用预设 1320 CNY', exact: true }).click();
  assert.equal(await editorSale.inputValue(), '1320');
  menu = await openAmount('sale', editor);
  await page.keyboard.press('Escape');
  await menu.waitFor({ state: 'hidden' });
  assert(await editor.isVisible(), '关闭金额下拉时保留订单抽屉');
  assert(await amountButton('sale', editor).evaluate(node => node === document.activeElement));
  await editorSale.fill('1311.0123');
  await reason.fill('核对客户实际收款后修正');
  await editor.locator('#commerce-notes').fill('编辑旧单的未保存内容');
  const oldDraft = await editor.evaluate(node => Object.fromEntries(new FormData(node)));
  await openReference('sale', editor);
  await closeReference();
  await editor.waitFor();
  assert.deepEqual(await editor.evaluate(node => Object.fromEntries(new FormData(node))), oldDraft,
    '从价格抽屉返回旧单编辑，保留金额、版本和全部草稿');
  await page.getByRole('button', { name: '关闭抽屉', exact: true }).click();
  await editor.waitFor({ state: 'hidden' });
  await page.locator('#commerce-search').fill('locked-shortcuts@example.test');
  await page.locator('[data-action="commerce-order-edit"][data-id="locked-shortcuts"]').click();
  assert.equal(await editor.locator('[data-action="commerce-order-start-shortcut"]').count(), 0,
    '自动入单的只读订阅时间不能通过快捷操作修改');
  assert.equal(await editor.locator('#commerce-start').getAttribute('readonly'), '');
  assert.equal(await editorPaid.getAttribute('readonly'), '');
  assert.equal(await amountButton('paid', editor).count(), 0);
  assert(await amountButton('sale', editor).isVisible());
  await page.getByRole('button', { name: '关闭抽屉', exact: true }).click();

  const output = fileURLToPath(new URL('../.runtime/order-price-shortcuts-20261110/', import.meta.url));
  await mkdir(output, { recursive: true });
  for (const width of [1920, 1440, 1024, 901, 900, 768, 390, 320]) for (const dark of [false, true]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(dark => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; }, dark);
    for (const product of ['gpt', 'claude', ...(width === 390 ? ['gemini', 'grok'] : [])]) {
      await page.goto(origin + '/#/workspace/order/' + product);
      await form.waitFor();
      await settle(page);
      const geometry = await form.locator('.order-financial-heading').evaluateAll(nodes => nodes.map(node => {
        const title = node.querySelector('h3').getBoundingClientRect();
        const actions = node.querySelector('.order-financial-actions').getBoundingClientRect();
        const heading = node.getBoundingClientRect();
        return { title: { right: title.right, y: title.y },
          rightAligned: Math.abs(actions.right - heading.right) <= 1,
          separated: title.right <= actions.left - 7,
          contained: [...node.querySelectorAll('.button')].every(button => {
            const b = button.getBoundingClientRect();
            return b.left >= actions.left - 1 && b.right <= heading.right + 1 &&
              b.top >= heading.top - 1 && b.bottom <= heading.bottom + 1 && b.height >= (innerWidth <= 900 ? 44 : 36);
          }) };
      }));
      assert(geometry.every(row => row.rightAligned && row.separated && row.contained), JSON.stringify({ width, dark, product, geometry }));
      const amountGeometry = await form.locator('.order-amount-picker').evaluateAll(nodes => nodes.every(node => {
        const field = node.closest('.field').getBoundingClientRect();
        const label = node.closest('.field').querySelector('label').getBoundingClientRect();
        const input = node.querySelector('input').getBoundingClientRect();
        const button = node.querySelector('button').getBoundingClientRect();
        const minimum = innerWidth <= 900 ? 44 : 36;
        return label.right <= input.left && input.width >= 60 && input.right < button.left &&
          input.top === button.top && input.height === button.height && button.right <= field.right + 1 &&
          button.width >= minimum && button.height >= minimum;
      }));
      assert(amountGeometry, `${width} ${dark ? '深色' : '浅色'} ${product} 金额与下拉同排且可操作`);
      assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${width} ${product} 横向溢出`);
      if (product === 'gpt' && ((width === 1920 && !dark) || (width === 390 && dark))) {
        await form.locator('.order-financial-groups').screenshot({ path: output + `order-actions-${width}-${dark ? 'dark' : 'light'}.png` });
        await openReference('paid');
        await page.locator('#drawer').screenshot({ path: output + `paid-prices-${width}-${dark ? 'dark' : 'light'}.png` });
        await closeReference();
      }
    }
  }
  assert.deepEqual(writes, [], '查看、选择金额和设置时间均在订单草稿中操作');
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
});

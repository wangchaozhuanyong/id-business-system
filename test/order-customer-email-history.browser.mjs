import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

test('订单优先匹配客户历史邮箱，支持切换、手填和草稿，保留既有账号约束', { timeout: 60_000 }, async (t) => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  const contact = fixture.commerce.data.customers[0];
  fixture.commerce.data.customers = ['alpha', 'beta', 'empty'].map(id => ({ ...contact, id, name: `合成客户 ${id}` }));
  const seed = fixture.commerce.data.orders.find(row => row.product === 'GPT');
  const order = (id, customerId, email, product, start, extra = {}) => ({ ...seed,
    id, orderNo: `QA-${id}`, customerId, email, product, plan: product === 'GPT' ? 'Plus' : 'Pro',
    start, createdAt: start, accountId: '', accountSource: '客户自有', businessType: '续费',
    source: '管理员手工', taskId: '', cancelled: false, ...extra
  });
  fixture.commerce.data.orders = [
    order('older', 'alpha', 'older@example.test', 'GPT', '2026-09-01T12:00'),
    order('recent', 'alpha', 'recent@example.test', 'GPT', '2026-10-01T12:00'),
    order('duplicate', 'alpha', 'RECENT@example.test', 'GPT', '2026-08-01T12:00'),
    order('claude', 'alpha', 'claude@example.test', 'Claude Pro', '2026-11-01T12:00'),
    order('beta', 'beta', 'beta@example.test', 'GPT', '2026-10-02T12:00'),
    order('cancelled', 'alpha', 'cancelled@example.test', 'GPT', '2026-11-02T12:00', { cancelled: true }),
    order('unlinked', '', 'unlinked@example.test', 'GPT', '2026-11-03T12:00'),
    order('invalid', 'alpha', 'invalid', 'GPT', '2026-11-04T12:00'),
    order('auto', '', 'automatic@example.test', 'GPT', '2026-07-01T12:00', { source: '线上代充', taskId: 'synthetic-task' }),
    order('stock', 'alpha', 'delivered@example.test', 'GPT', '2026-06-01T12:00', { businessType: '成品交付', accountId: 'delivered-id' })
  ];
  await interceptDesign(context, { localFixtures: fixture });
  await context.route('**/api/local/order-cards', route => route.fulfill({ json: {
    items: [{ id: 'synthetic-card', last4: '7141', usageCount: 3, status: '正常', active: true }]
  } }));
  const writes = [];
  await context.route('**/api/local/commerce', route => {
    if (route.request().method() === 'GET') return route.fallback();
    writes.push(route.request().method());
    return route.fulfill({ status: 500, json: { message: '此测试只读' } });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const email = page.locator('#commerce-email');
  const trigger = page.locator('#commerce-emailHistory-picker');
  const popup = page.locator('#commerce-emailHistory-popover');
  const search = popup.getByRole('searchbox', { name: '搜索客户历史邮箱' });
  async function openHistory() {
    await trigger.click();
    await page.locator('#commerce-emailHistory-picker[aria-expanded="true"]').waitFor();
  }
  async function customer(id) {
    await page.locator('#commerce-customerId-picker').click();
    await page.locator('#commerce-customerId-popover input').fill(id);
    await page.locator(`#commerce-customerId-options [data-value="${id}"]`).click();
  }
  await page.goto(origin + '/#/workspace/order/gpt');
  await page.locator('#commerce-customerId option[value="alpha"]').waitFor({ state: 'attached' });
  await page.locator('#commerce-cardId-picker').click();
  await page.locator('#commerce-cardId-options [data-value="synthetic-card"]').click();
  assert.match(await page.locator('#commerce-cardId-picker').innerText(), /已用 3 次/);
  assert.equal(await page.locator('[data-commerce-pool-usage]').isVisible(), false, '次数只在银行卡选项显示，不再重复一行');
  assert.equal(await email.inputValue(), '', '未选择客户时不匹配任何产品的历史邮箱');
  await customer('alpha');
  assert.equal(await email.inputValue(), 'claude@example.test', '优先该客户最近使用邮箱，即使最近订单属于其他产品');
  assert.match(await page.locator('[data-commerce-field="email"] .field-title-help .title-description').textContent(), /所选客户最近使用/);
  await openHistory();
  await popup.getByRole('option').first().waitFor();
  assert.equal(await popup.getByRole('option').count(), 5, '去重并排除其他客户、撤单、无关联及无效邮箱');
  assert.deepEqual(await popup.getByRole('option').evaluateAll(nodes => nodes.map(node => node.dataset.value)),
    ['', 'claude@example.test', 'recent@example.test', 'older@example.test', 'delivered@example.test'],
    '历史列表按该客户使用时间倒序，不按产品分组优先');
  await search.fill('OLDER');
  await popup.locator('[data-value="older@example.test"]').click();
  assert.equal(await email.inputValue(), 'older@example.test');
  await openHistory();
  await popup.locator('[data-value="claude@example.test"]').waitFor();
  await search.press('Escape');
  await customer('beta');
  assert.equal(await email.inputValue(), 'beta@example.test', '切客户替换旧历史邮箱');
  await customer('empty');
  assert.equal(await email.inputValue(), '');
  assert.equal(await trigger.isEnabled(), false);
  await email.fill('new-account@example.test');
  await customer('alpha');
  assert.equal(await email.inputValue(), 'new-account@example.test', '手填新邮箱不被自动覆盖');
  await openHistory();
  await popup.locator('[data-value=""]').click();
  assert.equal(await email.inputValue(), '');
  assert(await email.evaluate(node => node === document.activeElement));
  await customer('alpha');
  assert.equal(await email.inputValue(), 'claude@example.test');
  await page.locator('#commerce-businessType').selectOption('成品交付');
  assert.equal(await email.inputValue(), '');
  assert.equal(await trigger.isVisible(), true);
  assert.equal(await email.isVisible(), false);
  assert.equal(await email.getAttribute('list'), null);
  assert.match(await page.locator('[data-commerce-field="email"] .field-title-help .title-description').textContent(), /可用|未使用/);
  await page.locator('#commerce-businessType').selectOption('续费');
  assert.equal(await email.inputValue(), 'claude@example.test');
  await email.fill('draft-new@example.test');
  const submitted = await page.locator('#commerce-order-form').evaluate(form => Object.fromEntries(new FormData(form)));
  assert.equal(submitted['commerce-email'], 'draft-new@example.test');
  assert.equal(Object.hasOwn(submitted, 'commerce-emailHistory'), false, '历史选择器不新增业务字段');
  await page.goto(origin + '/#/workspace/order/claude');
  await customer('alpha');
  assert.equal(await email.inputValue(), 'claude@example.test', '切换产品仍使用该客户最近邮箱');
  await page.goto(origin + '/#/workspace/order/gpt');
  assert.equal(await email.inputValue(), 'draft-new@example.test', '返回保留手填草稿');

  for (const width of [1440, 390, 320]) for (const dark of [false, true]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(dark => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; }, dark);
    await openHistory();
    await search.fill('recent');
    await popup.locator('[data-value="recent@example.test"]').waitFor();
    const geometry = await popup.evaluate(node => {
      const box = element => element.getBoundingClientRect().toJSON();
      return { popup: box(node), search: box(node.querySelector('input')), option: box(node.querySelector('[role="option"]')) };
    });
    assert(geometry.popup.x >= 0 && geometry.popup.right <= width && geometry.popup.top >= 0 && geometry.popup.bottom <= 900, JSON.stringify({width,dark,...geometry}));
    assert(geometry.search.bottom <= geometry.option.top);
    const row = await email.evaluate(node => {
      const a = node.getBoundingClientRect(), b = node.parentElement.querySelector('.commerce-picker-trigger').getBoundingClientRect();
      return { sameRow: Math.abs(a.top - b.top) < 1, inputWidth: a.width, total: document.documentElement.scrollWidth };
    });
    assert(row.sameRow && row.inputWidth > 80 && row.total <= width, `输入与历史按钮同排且不溢出：${JSON.stringify({width,dark,...row})}`);
    await search.press('Escape');
  }
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto(origin + '/#/orders/gpt');
  await page.locator('[data-action="commerce-order-edit"][data-id="older"]').click();
  assert.equal(await email.inputValue(), 'older@example.test', '编辑原单不改成最新邮箱');
  await customer('beta');
  assert.equal(await email.inputValue(), 'older@example.test', '更换原单客户仍保留原邮箱');
  await page.locator('#drawer [data-action="drawer-close"]').first().click();
  await page.locator('[data-action="commerce-order-edit"][data-id="auto"]').click();
  await customer('alpha');
  assert.equal(await email.inputValue(), 'automatic@example.test');
  assert.equal(await email.getAttribute('readonly'), '');
  assert.equal(await trigger.isVisible(), false);
  await page.locator('#drawer [data-action="drawer-close"]').first().click();
  await page.locator('[data-action="commerce-order-edit"][data-id="stock"]').click();
  assert.equal(await email.inputValue(), 'delivered@example.test');
  assert.equal(await email.getAttribute('readonly'), '');
  assert.equal(await trigger.isVisible(), false);
  assert.deepEqual(writes, []);
  assert.deepEqual(errors, []);
});

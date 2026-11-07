import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

test('成品账号下拉顶部搜索、模糊匹配、选择回填与草稿恢复', { timeout: 60_000 }, async t => {
  const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  const seed = fixture.inventory.data.accounts.find(row => row.type === 'gpt');
  fixture.inventory.data.accounts = Array.from({ length: 36 }, (_, index) => ({
    ...seed, id: `picker-${index}`, email: `stock-candidate-${index}@example.test`,
    emailType: 'google', inventoryState: 'available', usageLinks: [], used: false
  }));
  fixture.inventory.data.accounts.push({ ...seed, id: 'unavailable', email: 'unavailable@example.test', health: 'dead' });
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const { external } = await interceptDesign(context, { localFixtures: fixture });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/#/workspace/order/gpt');
  await page.locator('#commerce-businessType').selectOption('成品交付');
  const trigger = page.locator('#commerce-emailHistory-picker');
  const popup = page.locator('#commerce-emailHistory-popover');
  const search = popup.getByRole('searchbox', { name: '搜索可用账号' });
  await page.locator('#commerce-emailHistory option[value="stock-candidate-35@example.test"]').waitFor({ state: 'attached' });
  assert.equal(await page.locator('datalist').count(), 0);
  assert.equal(await page.locator('#commerce-email').isVisible(), false);
  for (const width of [1440, 1024, 901, 900, 768, 390]) for (const dark of [false, true]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(dark => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; }, dark);
    await trigger.click();
    await page.locator('#commerce-emailHistory-picker[aria-expanded="true"]').waitFor();
    await search.waitFor();
    await search.fill('CANDIDATE-35 EXAMPLE');
    const option = popup.getByRole('option');
    assert.equal(await option.count(), 1, '局部匹配、大小写与分词搜索可找到第 36 条');
    assert.match(await option.innerText(), /stock-candidate-35@example.test/);
    const geometry = await popup.evaluate(node => {
      const rect = node.getBoundingClientRect();
      return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom,
        searchBottom: node.querySelector('input').getBoundingClientRect().bottom,
        optionTop: node.querySelector('[role="option"]').getBoundingClientRect().top };
    });
    assert(geometry.searchBottom <= geometry.optionTop && geometry.left >= 0 && geometry.right <= width && geometry.top >= 0 && geometry.bottom <= 900, JSON.stringify({ width, dark, geometry }));
    await search.fill('unavailable');
    assert.equal(await popup.getByRole('option').count(), 0);
    assert.equal(await popup.getByRole('status').isVisible(), true);
    await search.fill('CANDIDATE-35 EXAMPLE');
    await search.press('ArrowDown');
    await page.keyboard.press('Enter');
    assert.equal(await page.locator('#commerce-email').inputValue(), 'stock-candidate-35@example.test');
    assert.equal(await page.locator('#commerce-accountId').inputValue(), 'picker-35');
    assert.match(await trigger.innerText(), /stock-candidate-35@example.test/);
    assert.equal(await trigger.evaluate(node => node === document.activeElement), true);
  }
  const submitted = await page.locator('#commerce-order-form').evaluate(form => Object.fromEntries(new FormData(form)));
  assert.equal(submitted['commerce-email'], 'stock-candidate-35@example.test');
  assert.equal(Object.hasOwn(submitted, 'commerce-emailHistory'), false);
  await page.goto(origin + '/#/workspace/order/claude');
  await page.goto(origin + '/#/workspace/order/gpt');
  assert.match(await trigger.innerText(), /stock-candidate-35@example.test/, '切页返回恢复选择');
  await page.locator('#commerce-businessType').selectOption('续费');
  assert.equal(await page.locator('#commerce-email').isVisible(), true);
  assert.deepEqual(errors, []);
  assert.deepEqual(external, []);
});

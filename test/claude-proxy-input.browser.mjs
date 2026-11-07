import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { chromium } from 'playwright';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

test('Claude 新增默认 SOCKS5，链接自动拆分并恢复草稿', { timeout: 30_000 }, async t => {
  const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  const browser = await chromium.launch();
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  await interceptDesign(context, { localFixtures: fixture });
  const page = await context.newPage();
  page.setDefaultTimeout(5000);
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/#/accounts/claude');
  const open = () => page.getByRole('button', { name: '新增账号', exact: true }).click();
  await open();
  const protocol = page.locator('#inventory-proxy-protocol');
  const link = page.locator('#inventory-proxy-url');
  const values = () => page.locator('#inventory-asset-form').evaluate(form =>
    ['host', 'port', 'user', 'pass'].map(name => form.querySelector(`#inventory-proxy-${name}`).value));
  assert.equal(await protocol.inputValue(), 'socks5');
  for (const width of [1440, 390]) for (const dark of [false, true]) {
    await page.setViewportSize({ width, height: 1000 });
    await page.evaluate(dark => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; }, dark);
    await link.fill('proxy.example.test:1088:demo:sample-value');
    assert.deepEqual(await values(), ['proxy.example.test', '1088', 'demo', 'sample-value']);
    await link.fill('https://demo:sample%40value@proxy.example.test:8443');
    assert.equal(await protocol.inputValue(), 'https');
    assert.deepEqual(await values(), ['proxy.example.test', '8443', 'demo', 'sample@value']);
    await link.fill('socks5://proxy.example.test:1080');
    assert.equal(await protocol.inputValue(), 'socks5');
    assert.deepEqual(await values(), ['proxy.example.test', '1080', '', '']);
    await link.fill('socks5://proxy.example.test:70000');
    assert(await page.locator('#inventory-proxy-url-error').innerText());
    assert.deepEqual(await values(), ['proxy.example.test', '1080', '', '']);
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  await link.fill('socks5://demo:sample@proxy.example.test:1089');
  await page.evaluate(() => window.IDDesignAPI.closeDrawer());
  await open();
  assert.deepEqual(await values(), ['proxy.example.test', '1089', 'demo', 'sample']);
  assert.equal(await protocol.inputValue(), 'socks5');
  assert.deepEqual(errors, []);
});

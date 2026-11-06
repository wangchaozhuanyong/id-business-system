import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { startCodexdaichongDemoSite } from '../modules/recharge/codexdaichong/demo-site.mjs';

test('embedded recharge retains ordinary drafts across reloads, isolates records and protects later edits', { timeout: 90_000 }, async t => {
  assert(process.env.ID_RECHARGE_QA_PLAYWRIGHT, '请指定已有 Playwright 模块入口');
  const playwright = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await (playwright.default || playwright).chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const host = await startCodexdaichongDemoSite(0);
  t.after(() => new Promise(resolve => { host.server.close(resolve); host.server.closeAllConnections(); }));
  const origin = new URL(host.url).origin;
  const page = await browser.newPage();
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(8000);
  // This test unlocks only the disposable demo UI. Every external request and every
  // real mutation is blocked; the save responses below are browser-local fixtures.
  await page.route('**/*', route => new URL(route.request().url()).origin === origin &&
    ['GET', 'HEAD'].includes(route.request().method()) ? route.continue() : route.abort());
  await page.route('**/integrations/codexdaichong/demo-only.js', route => route.fulfill({ contentType: 'text/javascript', body: '' }));
  const selector = '.recharge-integration__content iframe:not([hidden])';
  const frame = () => page.frameLocator(selector);
  const navigate = async hash => { await page.evaluate(hash => { location.hash = '#/' + hash; }, hash); };
  const config = async () => {
    await page.locator('[data-action="ops-integrated-view"][data-view="config"]').click();
    await frame().locator('#config.active').waitFor();
    await page.locator('.recharge-integration__view[aria-busy="false"]').waitFor();
  };
  await page.goto(origin + '/#/online-recharge/chatgpt');
  await frame().locator('#queryInput').waitFor();
  await config();
  await frame().locator('#max_concurrent_activations').fill('7');
  await frame().locator('#gpt_api_base_url').fill('https://draft.example.test/api');
  await frame().locator('#gpt_api_key').fill('fixture-not-a-real-key');
  await page.locator('[data-action="ops-integrated-view"][data-view="dashboard"]').click();
  const refreshed = page.waitForResponse(response => response.url().endsWith('/api/admin/data'));
  await config();
  await refreshed;
  await assertEventually(() => frame().locator('#max_concurrent_activations').inputValue(), '7');
  await navigate('customers/list');
  await page.locator('[data-recharge-module]').waitFor({ state: 'detached' });
  await navigate('online-recharge/chatgpt');
  await frame().locator('#config.active').waitFor();
  await assertEventually(() => frame().locator('#gpt_api_base_url').inputValue(), 'https://draft.example.test/api');
  assert.equal(await frame().locator('#gpt_api_key').inputValue(), '');
  const saved = await page.evaluate(() => window.IDRechargeDrafts.read('admin'));
  assert.equal(saved.max_concurrent_activations, '7');
  assert(!JSON.stringify(saved).includes('fixture-not-a-real-key'));

  // A failed save and a late successful response both preserve the appropriate draft.
  const api = '**/integrations/codexdaichong/api/admin/gpt-api';
  await page.route(api, route => route.request().method() === 'POST'
    ? route.fulfill({ status: 503, contentType: 'application/json', body: '{"success":false,"message":"fixture failure"}' })
    : route.continue());
  await frame().locator('button[onclick="saveGptApiConfig()"]').click();
  await frame().getByText('fixture failure', { exact: true }).waitFor();
  assert.equal(await frame().locator('#gpt_api_base_url').inputValue(), 'https://draft.example.test/api');
  await page.unroute(api);
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  await page.route(api, async route => {
    if (route.request().method() !== 'POST') return route.continue();
    started.resolve();
    await release.promise;
    await route.fulfill({ contentType: 'application/json', body: '{"success":true,"message":"fixture saved"}' });
  });
  await frame().locator('button[onclick="saveGptApiConfig()"]').click();
  await started.promise;
  await frame().locator('#gpt_api_base_url').fill('https://later.example.test/api');
  release.resolve();
  await frame().getByText('fixture saved', { exact: true }).waitFor();
  await assertEventually(() => frame().locator('#gpt_api_base_url').inputValue(), 'https://later.example.test/api');
  assert.equal(await page.evaluate(() => window.IDRechargeDrafts.read('admin').gpt_api_base_url), 'https://later.example.test/api');
  await frame().locator('button[onclick="saveGptApiConfig()"]').click();
  await assertEventually(() => page.evaluate(() => Object.hasOwn(window.IDRechargeDrafts.read('admin'), 'gpt_api_base_url')), false);

  // Address editors key drafts by record, including a separate new-address draft.
  await page.locator('[data-action="ops-integrated-view"][data-view="tax_addresses"]').click();
  await frame().locator('#tax_addresses.active').waitFor();
  const admin = await page.locator(selector).elementHandle();
  const content = await admin.contentFrame();
  await content.evaluate(() => showAddressForm());
  await frame().locator('#addr_city').fill('New draft city');
  await content.evaluate(() => { hideAddressForm(); showAddressForm({ id: 1, city: 'Original one' }); });
  assert.equal(await frame().locator('#addr_city').inputValue(), 'Original one');
  await frame().locator('#addr_city').fill('Edited one');
  await content.evaluate(() => { hideAddressForm(); showAddressForm({ id: 2, city: 'Original two' }); });
  assert.equal(await frame().locator('#addr_city').inputValue(), 'Original two');
  await content.evaluate(() => showAddressForm({ id: 1, city: 'Server one' }));
  assert.equal(await frame().locator('#addr_city').inputValue(), 'Edited one');
  await content.evaluate(() => showAddressForm());
  assert.equal(await frame().locator('#addr_city').inputValue(), 'New draft city');

  // Restoring a selector also restores the derived plan/region presentation.
  await page.locator('[data-action="ops-integrated-view"][data-view="checkout_debug"]').click();
  await frame().locator('#checkout_debug.active').waitFor();
  await frame().locator('#checkout_plan_type').selectOption('pro200');
  await frame().locator('#checkout_plan_name').fill('custom-plan-draft');
  await frame().locator('#checkout_region_selector').selectOption('MY');
  await navigate('customers/list');
  await page.locator('[data-recharge-module]').waitFor({ state: 'detached' });
  await navigate('online-recharge/chatgpt');
  await frame().locator('#checkout_debug.active').waitFor();
  await assertEventually(() => frame().locator('#checkout_plan_name').inputValue(), 'custom-plan-draft');
  assert.equal(await frame().locator('#checkout_plan_type').inputValue(), 'pro200');
  assert.equal(await frame().locator('#checkout_region_selector').inputValue(), 'MY');
  assert.match(await frame().locator('#checkout_region_hint').textContent(), /马来西亚/);

  // The BitBrowser iframe keeps the editable window/configuration text, never its secrets.
  await navigate('recharge/start');
  const bit = () => page.frameLocator('.recharge-integration__frame--bit-local');
  await bit().locator('#bit-window-name').fill('Draft browser window');
  await bit().locator('#bit-connection-name').fill('Draft connection');
  await bit().locator('#bit-local-token').fill('fixture-local-secret');
  await navigate('customers/list');
  await page.locator('[data-recharge-module]').waitFor({ state: 'detached' });
  await navigate('recharge/start');
  await assertEventually(() => bit().locator('#bit-window-name').inputValue(), 'Draft browser window');
  assert.equal(await bit().locator('#bit-connection-name').inputValue(), 'Draft connection');
  assert.equal(await bit().locator('#bit-local-token').inputValue(), '');
  assert(!JSON.stringify(await page.evaluate(() => window.IDRechargeDrafts.read('bit-local'))).includes('fixture-local-secret'));
  assert.deepEqual(errors, []);
});

async function assertEventually(read, expected) {
  const until = Date.now() + 5000;
  let actual;
  do {
    actual = await read();
    if (actual === expected) return;
    await new Promise(resolve => setTimeout(resolve, 40));
  } while (Date.now() < until);
  assert.equal(actual, expected);
}

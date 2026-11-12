import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

test('embedded recharge retains ordinary drafts across reloads, isolates records and protects later edits', { timeout: 90_000 }, async t => {
  assert(process.env.ID_RECHARGE_QA_PLAYWRIGHT, '请指定已有 Playwright 模块入口');
  const playwright = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await (playwright.default || playwright).chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const page = await browser.newPage();
  const traffic = await interceptDesign(page.context(), { localFixtures: {} });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  page.setDefaultTimeout(8000);
  await page.route('**/*', route =>
    ['GET', 'HEAD'].includes(route.request().method()) ? route.fallback() : route.abort());
  let savedOrbitcard = { live_management: false, orbitcard_base_url: 'https://cards.example.test' };
  let failSave = true;
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  t.after(() => release.resolve());
  await page.route('**/integrations/codexdaichong/api/admin/orbitcard/config', async route => {
    if (route.request().method() === 'GET') return route.fulfill({ json: { success: true, config: savedOrbitcard } });
    if (failSave) return route.fulfill({ status: 503, json: { success: false, message: 'fixture failure' } });
    const { live_management, orbitcard_base_url } = route.request().postDataJSON();
    assert.equal(live_management, true);
    started.resolve();
    await release.promise;
    savedOrbitcard = { live_management, orbitcard_base_url };
    await route.fulfill({ json: { success: true, message: 'fixture saved' } });
  });
  const selector = '#main > [data-page-region]:not([hidden]) .recharge-integration__content iframe:not([hidden])';
  const frame = () => page.frameLocator(selector);
  const navigate = async hash => { await page.evaluate(hash => { location.hash = '#/' + hash; }, hash); };
  const config = async () => {
    await page.locator('[data-action="ops-integrated-view"][data-view="config"]').click();
    await frame().locator('#config.active').waitFor();
    await page.locator('#main > [data-page-region]:not([hidden]) .recharge-integration__view[aria-busy="false"]').waitFor();
  };
  await page.goto(origin + '/#/online-recharge/chatgpt');
  await frame().locator('#queryInput').waitFor();
  await config();
  await frame().locator('#max_concurrent_activations').fill('7');
  assert.equal(await frame().locator('#gpt_api_enabled').count(), 0);
  await frame().locator('#orbitcard_base_url').fill('https://draft.example.test/api');
  await frame().locator('#orbitcard_live_management').check();
  await frame().locator('#orbitcard_api_key').fill('fixture-not-a-real-key');
  await page.locator('[data-action="ops-integrated-view"][data-view="dashboard"]').click();
  await config();
  await assertEventually(() => frame().locator('#max_concurrent_activations').inputValue(), '7');
  const refreshed = page.waitForResponse(response => new URL(response.url()).pathname.endsWith('/admin'));
  await page.locator('[data-action="ops-integrated-refresh"]').click();
  await refreshed;
  await frame().locator('#config.active').waitFor();
  await assertEventually(() => frame().locator('#max_concurrent_activations').inputValue(), '7');
  await navigate('customers/list');
  await page.locator('#main > [data-page-region]:not([hidden]) [data-recharge-module]').waitFor({ state: 'detached' });
  await navigate('online-recharge/chatgpt');
  await frame().locator('#config.active').waitFor();
  await assertEventually(() => frame().locator('#orbitcard_base_url').inputValue(), 'https://draft.example.test/api');
  assert.equal(await frame().locator('#orbitcard_live_management').isChecked(), true);
  assert.equal(await frame().locator('#orbitcard_api_key').inputValue(), '');
  const saved = await page.evaluate(() => window.IDRechargeDrafts.read('admin'));
  assert.equal(saved.max_concurrent_activations, '7');
  assert(!JSON.stringify(saved).includes('fixture-not-a-real-key'));

  // A failed save and a late successful response both preserve the appropriate draft.
  await frame().locator('#orbitcard_config_save').click();
  await frame().getByText('fixture failure', { exact: true }).waitFor();
  assert.equal(await frame().locator('#orbitcard_base_url').inputValue(), 'https://draft.example.test/api');
  failSave = false;
  await frame().locator('#orbitcard_config_save').click();
  await started.promise;
  await frame().locator('#orbitcard_base_url').fill('https://later.example.test/api');
  release.resolve();
  await frame().getByText('fixture saved', { exact: true }).waitFor();
  await assertEventually(() => frame().locator('#orbitcard_base_url').inputValue(), 'https://later.example.test/api');
  assert.equal(await page.evaluate(() => window.IDRechargeDrafts.read('admin').orbitcard_base_url), 'https://later.example.test/api');
  await frame().locator('#orbitcard_config_save').click();
  await assertEventually(() => page.evaluate(() => Object.hasOwn(window.IDRechargeDrafts.read('admin'), 'orbitcard_base_url')), false);

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
  await frame().locator('#checkout_plan_type').selectOption('pro100');
  await frame().locator('#checkout_plan_name').fill('custom-plan-draft');
  assert(await frame().locator('#checkout_region_selector').isDisabled());
  await assertEventually(() => frame().locator('#checkout_region_selector').inputValue(), 'EG');
  await navigate('customers/list');
  await page.locator('#main > [data-page-region]:not([hidden]) [data-recharge-module]').waitFor({ state: 'detached' });
  await navigate('online-recharge/chatgpt');
  await frame().locator('#checkout_debug.active').waitFor();
  await assertEventually(() => frame().locator('#checkout_plan_name').inputValue(), 'custom-plan-draft');
  assert.equal(await frame().locator('#checkout_plan_type').inputValue(), 'pro100');
  await assertEventually(() => frame().locator('#checkout_region_selector').inputValue(), 'EG');
  assert.match(await frame().locator('#checkout_region_hint').textContent(), /埃及/);

  // The BitBrowser iframe keeps connection drafts and clears the authorization and its email.
  await navigate('recharge/start');
  const bit = () => page.frameLocator('.recharge-integration__frame--bit-local');
  const windowEmail = 'draft-window@example.test';
  await bit().locator('#bit-authorization-json').fill(JSON.stringify({
    sessionToken: 'synthetic-session', user: { id: 'user-fixture', email: windowEmail },
    account: { id: 'account-fixture' }
  }));
  await assertEventually(() => bit().locator('#bit-window-name').inputValue(), windowEmail);
  await bit().locator('#bit-connection-name').fill('Draft connection');
  await bit().locator('#bit-local-token').fill('fixture-local-secret');
  await navigate('customers/list');
  await page.locator('#main > [data-page-region]:not([hidden]) [data-recharge-module]').waitFor({ state: 'detached' });
  await navigate('recharge/start');
  await assertEventually(() => bit().locator('#bit-connection-name').inputValue(), 'Draft connection');
  assert.equal(await bit().locator('#bit-window-name').inputValue(), '');
  assert.equal(await bit().locator('#bit-local-token').inputValue(), '');
  const bitDraft = JSON.stringify(await page.evaluate(() => window.IDRechargeDrafts.read('bit-local')));
  assert(!bitDraft.includes(windowEmail));
  assert(!bitDraft.includes('fixture-local-secret'));
  assert.deepEqual(traffic.external, []);
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

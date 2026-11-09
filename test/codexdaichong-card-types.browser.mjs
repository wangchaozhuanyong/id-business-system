import assert from 'node:assert/strict';
import test from 'node:test';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin, settle } from './helpers/offline-design.mjs';

test('card pool renders host card types safely and retries without reloading card data', { timeout: 35_000 }, async (t) => {
  assert(process.env.ID_RECHARGE_QA_PLAYWRIGHT, '请指定已有 Playwright 模块入口');
  const module = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const { chromium } = module.default || module;
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1280, height: 850 } });
  const { external } = await interceptDesign(context);
  const prefix = '/integrations/codexdaichong';
  const first = Promise.withResolvers();
  const release = Promise.withResolvers();
  let reads = 0;
  let cardReads = 0;
  let types = { version: 1, items: [{ id: 'type-a', name: '<img src=x onerror=alert(1)>测试', active: true }], assignments: { 'recharge:1': 'type-a' } };
  let failing = false;
  await context.route(origin + prefix + '/api/admin/cards', (route) => {
    cardReads++;
    return route.fulfill({ json: { cards: [{ id: 1, last4: '0007' }, { id: 2, last4: '0007' }] } });
  });
  await context.route(origin + '/api/local/card-types', async (route) => {
    assert.equal(route.request().method(), 'GET');
    assert.equal(new URL(route.request().url()).search, '');
    if (++reads === 1) {
      first.resolve();
      await release.promise;
    }
    return failing ? route.fulfill({ status: 503, json: { error: 'synthetic' } }) : route.fulfill({ json: types });
  });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  const pageErrors = [];
  page.on('pageerror', (error) => pageErrors.push(error.message));
  await page.goto(origin + prefix + '/admin?view=cards');
  await first.promise;
  const cards = page.locator('#cards.active .card-pool-table');
  const typed = cards.locator('[data-recharge-card-type="recharge:1"]');
  const untyped = cards.locator('[data-recharge-card-type="recharge:2"]');
  await cards.getByRole('columnheader', { name: '银行卡类型', exact: true }).waitFor();
  await typed.getByText('加载中…', { exact: true }).waitFor();
  release.resolve();
  await typed.getByText(types.items[0].name, { exact: true }).waitFor();
  await untyped.getByText('未设置', { exact: true }).waitFor();
  assert.equal(await typed.locator('img').count(), 0);
  assert.equal(await cards.locator('thead th').count(), 11);
  assert.equal(await cards.locator('tbody tr').first().locator('td').count(), 11);

  failing = true;
  await page.evaluate(() => loadCardPoolList());
  await page.getByText('银行卡类型刷新失败，已保留上次结果。', { exact: true }).waitFor();
  await typed.getByText(types.items[0].name, { exact: true }).waitFor();
  const previousCardReads = cardReads;
  failing = false;
  types = { version: 2, items: [{ id: 'type-a', name: '已同步的新名称', active: true }], assignments: { 'recharge:1': 'type-a' } };
  await page.getByRole('button', { name: '重试读取类型' }).click();
  await typed.getByText('已同步的新名称', { exact: true }).waitFor();
  assert.equal(cardReads, previousCardReads);
  await page.getByRole('button', { name: '重试读取类型' }).waitFor({ state: 'hidden' });

  await page.setViewportSize({ width: 390, height: 844 });
  await page.evaluate(() => { document.documentElement.dataset.idTheme = 'dark'; });
  await settle(page);
  await typed.getByText('已同步的新名称', { exact: true }).waitFor();
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth + 1), true);

  const parentUrl = origin + '/card-types-notification-fixture';
  await context.route(parentUrl, (route) => route.fulfill({
    contentType: 'text/html',
    body: '<iframe title="银行卡池" src="' + prefix + '/admin?view=cards"></iframe>'
  }));
  const host = await context.newPage();
  host.on('pageerror', (error) => pageErrors.push(error.message));
  await host.goto(parentUrl);
  const frame = host.frameLocator('iframe');
  const embeddedType = frame.locator('[data-recharge-card-type="recharge:1"]');
  await embeddedType.getByText('已同步的新名称', { exact: true }).waitFor();
  const post = (message) => host.evaluate((detail) => {
    document.querySelector('iframe').contentWindow.postMessage({
      source: 'id-recharge-shell', ...detail
    }, location.origin);
  }, message);
  await post({ type: 'visibility', visible: true });
  const before = { reads, cardReads };
  types = { version: 3, items: [{ id: 'type-a', name: '通知同步的类型', active: true }], assignments: { 'recharge:1': 'type-a' } };
  await frame.locator('body').evaluate(() => {
    const data = { source: 'id-recharge-shell', type: 'data-change', scopes: ['card-types'] };
    window.dispatchEvent(new MessageEvent('message', { source: window, origin: location.origin, data }));
    window.dispatchEvent(new MessageEvent('message', { source: window.parent, origin: 'https://other.invalid', data }));
  });
  await post({ type: 'data-change', scopes: ['settings'] });
  await post({ type: 'visibility', visible: false });
  await post({ type: 'data-change', scopes: ['card-types'] });
  await settle(host);
  assert.equal(reads, before.reads, 'wrong sender, origin, scope and hidden notifications do not fetch');
  await post({ type: 'visibility', visible: true });
  await post({ type: 'data-change', scopes: ['card-types'] });
  await embeddedType.getByText('通知同步的类型', { exact: true }).waitFor();
  assert.equal(reads, before.reads + 1);
  assert.equal(cardReads, before.cardReads, 'notification refreshes types without reading the upstream card list');
  assert.equal(host.url(), parentUrl);
  assert.deepEqual(external, []);
  assert.deepEqual(pageErrors, []);
});

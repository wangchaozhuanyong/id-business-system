import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

test('版本通知更新相关列表，保留筛选、分页和草稿；心跳与相同版本不重读', { timeout: 60_000 }, async t => {
  const { chromium } = await import(pathToFileURL(process.env.ID_RECHARGE_QA_PLAYWRIGHT).href);
  const browser = await chromium.launch({ channel: process.env.ID_RECHARGE_QA_BROWSER_CHANNEL });
  t.after(() => browser.close());
  const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  fixture.commerce.data.customers.forEach((row, index) => { row.name = `stream 客户 ${index}`; });
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await interceptDesign(context, { localFixtures: fixture, changeEvents: true });
  await context.addInitScript(versions => {
    const original = window.fetch.bind(window);
    window.changeVersions = versions;
    window.streamConnections = 0;
    window.bootIdentity = crypto.randomUUID();
    const frame = (type, versions) => `event: ${type}\r\ndata: ${JSON.stringify({ schema: 1, versions })}\r\n\r\n`;
    window.emitRevision = (versions, type = 'change') => {
      Object.assign(window.changeVersions, versions);
      if (window.changeController) {
        const bytes = new TextEncoder().encode(frame(type, versions));
        // Split CRLF across chunks to exercise real streaming boundaries.
        window.changeController.enqueue(bytes.slice(0, bytes.length - 1));
        window.changeController.enqueue(bytes.slice(-1));
      }
    };
    window.emitHeartbeat = () => window.changeController.enqueue(new TextEncoder().encode(': heartbeat\r\n\r\n'));
    window.fetch = (input, options) => {
      if (new URL(String(input), location.href).pathname !== '/api/local/change-events') return original(input, options);
      window.streamConnections++;
      return Promise.resolve(new Response(new ReadableStream({ start(controller) {
        window.changeController = controller;
        controller.enqueue(new TextEncoder().encode(frame('snapshot', window.changeVersions)));
        options.signal.addEventListener('abort', () => {
          try { controller.error(new DOMException('aborted', 'AbortError')); } catch {}
        }, { once: true });
      } }), { headers: { 'content-type': 'text/event-stream; charset=utf-8' } }));
    };
  }, { inventory: String(fixture.inventory.version), commerce: String(fixture.commerce.version) });
  const reads = { inventory: 0, commerce: 0 }, writes = [], errors = [];
  await context.route('**/api/local/**', route => {
    const request = route.request(), resource = new URL(request.url()).pathname.split('/').at(-1);
    if (!['GET', 'HEAD'].includes(request.method())) {
      writes.push(resource);
      return route.fulfill({ status: 503, json: { error: '禁止业务写入' } });
    }
    if (resource in reads) {
      reads[resource]++;
      return route.fulfill({ json: fixture[resource] });
    }
    return route.fallback();
  });
  const page = await context.newPage();
  page.setDefaultTimeout(6000);
  page.on('pageerror', error => errors.push(error.message));
  const settle = () => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const go = async route => {
    await page.evaluate(route => window.IDDesignAPI.go(route), route);
    await page.locator(`#main[data-layout-route="${route}"]`).waitFor();
  };
  const emit = versions => page.evaluate(versions => window.emitRevision(versions), versions);
  const idle = () => page.waitForFunction(() => {
    const state = window.IDChangeSync?.status();
    return state?.connected && state.snapshots > 0 && !state.refreshing && !state.pending;
  });
  await page.goto(origin + '/#/accounts/gpt');
  await page.locator('#main [data-action="inventory-more"]').first().waitFor();
  await page.waitForFunction(() => window.IDDesignAPI.modules.commerce.listOrders().length > 0);
  await idle();
  const boot = await page.evaluate(() => window.bootIdentity);
  const baseline = { ...reads };
  const seed = fixture.inventory.data.accounts.find(row => row.type === 'gpt');
  fixture.inventory.data.accounts.unshift({ ...seed, id: 'stream-added-account', email: 'stream-added@example.test' });
  fixture.inventory.version++;
  await emit({ inventory: String(fixture.inventory.version) });
  await page.locator('tr[data-row-id="stream-added-account"]').waitFor();
  await idle();
  assert.equal(reads.inventory, baseline.inventory + 1);
  assert.equal(reads.commerce, baseline.commerce, '库存变化不重读订单');
  const stableReads = { ...reads };
  await page.evaluate(version => {
    window.emitHeartbeat(); window.emitHeartbeat();
    window.emitRevision({ inventory: version }); window.emitRevision({ inventory: version });
  }, String(fixture.inventory.version));
  await settle();
  assert.deepEqual(reads, stableReads);

  await go('customers/list');
  await page.locator('#commerce-search').fill('stream');
  await page.locator('#main .pagination button[data-page="2"]:not([aria-label])').click();
  const customer = fixture.commerce.data.customers[0];
  fixture.commerce.data.customers.push({ ...customer, id: 'stream-new-customer', name: 'stream 新客户' });
  fixture.commerce.version++;
  await emit({ commerce: String(fixture.commerce.version) });
  await page.waitForFunction(() => window.IDDesignAPI.modules.commerce.getCustomers().some(row => row.id === 'stream-new-customer'));
  await idle();
  assert.equal(await page.locator('#commerce-search').inputValue(), 'stream');
  assert.equal(await page.evaluate(() => window.IDDesignAPI.state.page), 2);

  await go('workspace/order/gpt');
  await page.locator('#commerce-email').fill('unsaved-stream-draft@example.test');
  const beforeDraft = reads.commerce;
  fixture.commerce.data.customers.push({ ...customer, id: 'stream-during-edit', name: 'stream 编辑期间新客户' });
  fixture.commerce.version++;
  await emit({ commerce: String(fixture.commerce.version) });
  await page.waitForFunction(() => window.IDChangeSync.status().pending > 0);
  await settle();
  assert.equal(reads.commerce, beforeDraft, '编辑期间暂缓更新，避免覆盖输入');
  assert.equal(await page.locator('#commerce-email').inputValue(), 'unsaved-stream-draft@example.test');
  await go('orders/gpt');
  await page.waitForFunction(() => window.IDDesignAPI.modules.commerce.getCustomers().some(row => row.id === 'stream-during-edit'));
  await idle();
  await go('workspace/order/gpt');
  assert.equal(await page.locator('#commerce-email').inputValue(), 'unsaved-stream-draft@example.test');
  await go('customers/list');

  const beforeReconnect = { ...reads };
  fixture.inventory.data.accounts.unshift({ ...seed, id: 'stream-reconnected-account', email: 'reconnected@example.test' });
  fixture.inventory.version++;
  await page.evaluate(version => {
    window.changeController.close(); window.changeController = null;
    window.changeVersions.inventory = version;
  }, String(fixture.inventory.version));
  await page.waitForFunction(() => window.streamConnections === 2);
  await page.waitForFunction(() => window.IDDesignAPI.modules.inventory.getAsset('stream-reconnected-account'));
  await idle();
  assert.equal(reads.inventory, beforeReconnect.inventory + 1);
  assert.equal(reads.commerce, beforeReconnect.commerce);
  assert.equal(await page.evaluate(() => window.bootIdentity), boot, '不刷新整个网页');
  for (const width of [390, 320]) for (const dark of [false, true]) {
    await page.setViewportSize({ width, height: 900 });
    await page.evaluate(dark => { document.documentElement.dataset.theme = dark ? 'dark' : 'light'; }, dark);
    await go('accounts/gpt');
    assert(await page.locator('tr[data-row-id="stream-reconnected-account"]').isVisible());
    const id = `stream-mobile-${width}-${dark}`;
    fixture.inventory.data.accounts.unshift({ ...seed, id, email: `${id}@example.test` });
    fixture.inventory.version++;
    await emit({ inventory: String(fixture.inventory.version) });
    await page.locator(`tr[data-row-id="${id}"]`).waitFor();
    await idle();
    assert(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
  }
  assert.deepEqual(writes, []);
  assert.deepEqual(errors, []);
  await page.evaluate(() => window.IDChangeSync.stop());
});

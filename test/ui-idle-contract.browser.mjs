import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { chromium } from 'playwright';
import { interceptDesign, origin, root } from './helpers/offline-design.mjs';

test('every registered navigation route stays idle without data changes', { timeout: 120_000 }, async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const intercepted = await interceptDesign(context, { localFixtures: fixture, actor: { id: 'contract-admin', name: '合成管理员', role: 'super' } });
  const page = await context.newPage(), requests = [], errors = [], results = [], inFlight = new Set();
  page.setDefaultTimeout(6000);
  page.on('pageerror', e => errors.push(e.message));
  page.on('request', request => {
    const url = new URL(request.url());
    if (url.origin === origin && url.pathname !== '/api/local/change-events') inFlight.add(request);
    if (url.pathname.startsWith('/api/local/') && url.pathname !== '/api/local/change-events') requests.push(url.pathname + url.search);
  });
  page.on('requestfinished', request => inFlight.delete(request));
  page.on('requestfailed', request => inFlight.delete(request));
  const settleReads = async () => {
    let quiet = 0;
    for (let i = 0; i < 300 && quiet < 3; i++) {
      await new Promise(resolve => setTimeout(resolve, 10));
      quiet = inFlight.size ? 0 : quiet + 1;
    }
    assert.equal(inFlight.size, 0, 'isolated responses must settle');
  };
  await page.goto(origin + '/#/customers/list');
  await page.locator('#commerce-search').waitFor();
  await page.clock.install();
  const routes = await page.evaluate(() => [...new Set(window.IDDesignAPI.navigation.flatMap(group => group[2].map(item => item[1])))]);
  for (const route of routes) {
    await page.evaluate(route => window.IDDesignAPI.go(route), route);
    await page.waitForFunction(route => document.querySelector('#main').dataset.layoutRoute === route, route);
    await page.clock.runFor(350);
    const integration = page.locator('#main > [data-page-region]:not([hidden]) .recharge-integration__view');
    if (await integration.count()) await page.locator('#main > [data-page-region]:not([hidden]) .recharge-integration__view[aria-busy="false"]').waitFor();
    // Finish iframe code and its initial dependent reads before measuring idle.
    await settleReads();
    const before = requests.length;
    await page.clock.fastForward(120_000);
    await settleReads();
    const idleReads = requests.slice(before);
    results.push({ route, idleReads });
    assert.deepEqual(idleReads, [], `${route}: no interval-driven local business reads`);
    const automatic = await page.locator('#main > [data-page-region]:not([hidden]) input[data-auto-search]').evaluateAll(nodes => nodes.map(n => n.id));
    assert(automatic.every(Boolean), `${route}: automatic search requires a stable identifier`);
  }
  const output = process.env.ID_LAYOUT_QA_OUTPUT || join(root, '.runtime/ui-contract');
  await mkdir(output, { recursive: true });
  await writeFile(join(output, 'idle-routes.json'), JSON.stringify({ routeCount: routes.length, results, errors }, null, 2));
  assert.deepEqual(errors, []);
  assert.deepEqual(intercepted.external, []);
  assert.deepEqual(intercepted.unavailable, []);
});

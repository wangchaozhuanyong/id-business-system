import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { chromium } from 'playwright';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

test('shared automatic search debounces, respects IME and preserves view ownership', async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  const fixture = JSON.parse(await readFile(new URL('../docs/audits/2026-11-06-design-review/visual-fixtures.json', import.meta.url)));
  fixture['tools/mailbox-pool'] = { version: 1, items: [
    { id: 'search-mail', email: 'search@example.test', provider: 'google', active: true }
  ] };
  const requests = await interceptDesign(context, { localFixtures: fixture, actor: { id: 'search-admin', name: '合成管理员', role: 'admin' } });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', e => errors.push(e.message));
  await page.goto(origin + '/#/customers/list');
  const search = () => page.locator('#main > [data-page-region]:not([hidden]) #commerce-search');
  await search().waitFor();
  await page.clock.install({ time: new Date('2026-11-12T00:00:00Z') });
  await page.clock.pauseAt(new Date('2026-11-12T00:00:01Z'));
  await page.evaluate(() => {
    window.searchCommits = [];
    document.addEventListener('input', e => {
      if (e.target.hasAttribute('data-auto-search')) window.searchCommits.push({ id: e.target.id, value: e.target.value });
    });
  });
  const commits = () => page.evaluate(() => window.searchCommits);
  const query = () => page.evaluate(() => window.IDDesignAPI.state.query);
  await search().fill('alpha');
  await page.clock.runFor(100);
  await search().fill('alphabet');
  await page.clock.runFor(299);
  assert.equal(await query(), '', 'raw typing must not replace the applied result yet');
  await page.clock.runFor(1);
  assert.equal(await query(), 'alphabet');
  assert.equal((await commits()).length, 1, 'a burst produces one search');
  await search().fill('immediate'); await search().press('Enter');
  assert.equal(await query(), 'immediate');
  await page.clock.runFor(400);
  assert.equal((await commits()).length, 2, 'Enter cancels the pending timer');
  await search().fill(''); assert.equal(await query(), '');
  await search().fill('focus-check');
  await page.locator('#nav-toggle').focus();
  await page.clock.runFor(300);
  assert.equal(await page.evaluate(() => document.activeElement.id), 'nav-toggle', 'delayed search cannot steal another control\'s focus');
  await search().fill('');

  await search().focus();
  await search().evaluate(node => {
    window.composingSearch = node;
    node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
    node.value = 'zhong';
    node.dispatchEvent(new InputEvent('input', { bubbles: true, isComposing: true }));
    window.IDDesignAPI.render();
  });
  await page.clock.runFor(600);
  assert.equal(await query(), '');
  assert(await page.evaluate(() => window.composingSearch.isConnected), 'background render keeps the IME node');
  await search().evaluate(node => {
    node.value = '中文资料';
    node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
    node.dispatchEvent(new InputEvent('input', { bubbles: true }));
  });
  await page.clock.runFor(300); assert.equal(await query(), '中文资料');

  await search().fill('unfinished');
  await page.evaluate(() => window.IDDesignAPI.render());
  assert.equal(await search().inputValue(), 'unfinished', 'unrelated renders preserve the raw query');
  assert.equal(await query(), '中文资料', 'unrelated renders keep the applied filter');
  await page.evaluate(() => window.IDDesignAPI.go('orders/gpt'));
  const countBefore = (await commits()).length;
  await page.clock.runFor(700);
  assert.equal(await query(), '', 'the departed list cannot change the destination filter');
  assert.equal((await commits()).length, countBefore);
  await page.evaluate(() => window.IDDesignAPI.go('customers/list'));
  assert.equal(await search().inputValue(), 'unfinished');
  await page.clock.runFor(1); assert.equal(await query(), 'unfinished');

  await search().fill('cleared-on-identity-boundary');
  await page.evaluate(() => { window.IDDesignAPI.clearPageRegions(); window.IDDesignAPI.render(); });
  await page.clock.runFor(700);
  assert.equal(await query(), 'unfinished', 'identity cleanup cancels pending input');
  assert.notEqual(await search().inputValue(), 'cleared-on-identity-boundary');
  await page.evaluate(() => window.IDDesignAPI.go('plugins/mailboxes'));
  await page.locator('.mailbox-account').waitFor();
  await page.locator('#ops-mailbox-pool-search').fill('unapplied-missing-mail');
  await page.evaluate(() => window.IDDesignAPI.modules.operations.refreshLiveReads(['tools/mailbox-pool']));
  assert.equal(await page.locator('.mailbox-account').count(), 1, 'push refresh retains the applied query during typing');
  await page.clock.runFor(300);
  assert.equal(await page.locator('.mailbox-account').count(), 0);
  assert.deepEqual(errors, []); assert.deepEqual(requests.external, []); assert.deepEqual(requests.unavailable, []);
});

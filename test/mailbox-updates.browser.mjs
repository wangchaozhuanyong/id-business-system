import assert from 'node:assert/strict';
import test from 'node:test';
import { chromium } from 'playwright';
import { interceptDesign, origin } from './helpers/offline-design.mjs';

async function prepare(browser, width, relay = false) {
  const context = await browser.newContext({ viewport: { width, height: 900 } });
  const requests = await interceptDesign(context, { localFixtures: {},
    actor: { id: 'mail-update-fixture', name: '合成管理员', role: 'admin' } });
  await context.addInitScript(({ relay }) => {
    const fetchOriginal = window.fetch.bind(window);
    window.mailReads = 0; window.mailStreams = []; window.mailHeld = [];
    window.mailState = { success: true, primaryEmail: 'f***@example.test', targetType: 'PRIMARY',
      codeExpiresAt: '2027-01-01T00:00:00Z', supportsUpdates: true, updatesSource: relay ? 'relay' : 'managed', items: [
        { subject: '合成邮件一', receivedAt: '2026-11-12T01:00:00Z', body: '合成正文一', extractedCode: '123456' }
      ] };
    window.emitMail = (event, data) => {
      const stream = window.mailStreams.findLast(value => !value.closed);
      const bytes = new TextEncoder().encode(event === 'heartbeat' ? ': heartbeat\r\n\r\n'
        : `event: ${event}\r\ndata: ${JSON.stringify(data)}\r\n\r\n`);
      stream.controller.enqueue(bytes.slice(0, -1)); stream.controller.enqueue(bytes.slice(-1));
    };
    window.fetch = (url, options) => {
      if (String(url) !== (relay ? '/api/local/apple-relay/public-query' : '/api/local/tools/mailbox-query')) return fetchOriginal(url, options);
      if (options.headers.Accept === 'text/event-stream') {
        const stream = { closed: false };
        window.mailStreams.push(stream);
        return Promise.resolve(new Response(new ReadableStream({ start(controller) {
          stream.controller = controller;
          const heartbeat = setInterval(() => {
            if (!window.silentMail && !stream.closed)
              controller.enqueue(new TextEncoder().encode(': heartbeat\n\n'));
          }, 20_000);
          options.signal.addEventListener('abort', () => {
            stream.closed = true;
            clearInterval(heartbeat);
            try { controller.error(new DOMException('aborted', 'AbortError')); } catch {}
          }, { once: true });
          controller.enqueue(new TextEncoder().encode('event: ready\ndata: {"version":0}\n\n'));
        }, cancel() { stream.closed = true; } }), { headers: { 'content-type': 'text/event-stream' } }));
      }
      window.mailReads++;
      const payload = structuredClone(window.mailState);
      if (window.holdMail) return new Promise(resolve => window.mailHeld.push(() => resolve(Response.json(payload))));
      return Promise.resolve(Response.json(payload));
    };
  }, { relay });
  const page = await context.newPage(), errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto(origin + '/#/plugins/mailboxes');
  await page.getByRole('button', { name: '邮箱查询', exact: true }).click();
  const form = page.locator('#drawer #ops-managed-mail-query');
  await form.locator('#ops-managed-query-code').fill(relay ? 'BUY-AAAA-BBBB' : 'MBX-' + 'F'.repeat(32));
  await form.getByRole('button', { name: '查询邮件', exact: true }).click();
  await form.getByText('合成邮件一', { exact: true }).waitFor();
  return { context, page, form, errors, requests };
}

test('mail notifications are idle without reads, preserve content, coalesce bursts and stop on hidden/closed views', async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  for (const relay of [false, true]) for (const width of [1440, 390]) await t.test(`${relay ? 'relay' : 'managed'} ${width}px`, async () => {
    const { context, page, form, errors, requests } = await prepare(browser, width, relay);
    try {
      await page.clock.install({ time: new Date('2026-11-12T02:00:00Z') });
      await page.clock.pauseAt(new Date('2026-11-12T02:00:01Z'));
      await page.evaluate(() => { window.originalMailNode = document.querySelector('#ops-managed-query-results details'); });
      await form.locator('[data-mail-auto-refresh]').check();
      await page.waitForFunction(() => window.mailReads === 2 && !document.querySelector('#ops-managed-mail-query [type=submit]').disabled);
      assert.equal(await page.evaluate(() => window.originalMailNode === document.querySelector('#ops-managed-query-results details')), true);
      assert.match(await form.locator('[data-mail-refresh]').innerText(), /新邮件自动更新/);
      await page.clock.runFor(120_000);
      assert.equal(await page.evaluate(() => window.mailReads), 2);
      await page.evaluate(() => { window.emitMail('heartbeat'); window.emitMail('changed', { version: 0 }); });
      assert.equal(await page.evaluate(() => window.mailReads), 2);
      await page.evaluate(() => {
        window.mailState.items.unshift({ subject: '合成新邮件', body: '新内容', receivedAt: '2026-11-12T02:02:00Z' });
        window.emitMail('changed', { version: 1 }); window.emitMail('changed', { version: 1 });
      });
      await form.getByText('合成新邮件', { exact: true }).waitFor();
      assert.equal(await page.evaluate(() => window.mailReads), 3);
      assert.equal(await form.locator('details').filter({ has: page.getByText('合成邮件一', { exact: true }) }).getAttribute('open'), '');
      assert.equal(await form.locator('details').filter({ has: page.getByText('合成新邮件', { exact: true }) }).getAttribute('open'), null);
      await page.evaluate(() => { window.holdMail = true; window.emitMail('changed', { version: 2 }); });
      await page.waitForFunction(() => window.mailHeld.length === 1);
      await page.evaluate(() => {
        window.mailState.items[0].body = '最后一次变更';
        window.emitMail('changed', { version: 3 }); window.emitMail('changed', { version: 4 });
      });
      await page.evaluate(() => { window.holdMail = false; window.mailHeld.shift()(); });
      await page.waitForFunction(() => window.mailReads === 5 && !document.querySelector('#ops-managed-mail-query [type=submit]').disabled);
      assert.match(await form.locator('#ops-managed-query-results').textContent(), /最后一次变更/);
      await page.evaluate(() => {
        window.mailHidden = true;
        Object.defineProperty(document, 'hidden', { configurable: true, get: () => window.mailHidden });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.waitForFunction(() => window.mailStreams.every(stream => stream.closed));
      await page.clock.runFor(120_000);
      assert.equal(await page.evaluate(() => window.mailReads), 5);
      await page.evaluate(() => { window.mailHidden = false; document.dispatchEvent(new Event('visibilitychange')); });
      await page.waitForFunction(() => window.mailReads === 6 && window.mailStreams.length === 2);
      await page.waitForFunction(() => !document.querySelector('#ops-managed-mail-query [type=submit]').disabled);
      await page.evaluate(() => { window.originalMailNode = document.querySelector('#ops-managed-query-results details'); });
      await page.evaluate(() => window.emitMail('changed', { version: 1 }));
      await page.waitForFunction(() => window.mailReads === 7 && !document.querySelector('#ops-managed-mail-query [type=submit]').disabled);
      assert.equal(await page.evaluate(() => window.originalMailNode === document.querySelector('#ops-managed-query-results details')), true);
      await page.evaluate(() => document.querySelector('#drawer').close());
      await page.clock.runFor(20);
      await page.waitForFunction(() => window.mailStreams.every(stream => stream.closed));
      await page.clock.runFor(120_000);
      assert.equal(await page.evaluate(() => window.mailReads), 7);
      assert.deepEqual(errors, []); assert.deepEqual(requests.external, []);
    } finally { await context.close(); }
  });
});

test('a silently stalled mailbox stream reconnects without idle mail polling', async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const { context, page, form, errors } = await prepare(browser, 390, true);
  try {
    await page.clock.install({ time: new Date('2026-11-12T02:00:00Z') });
    await page.clock.pauseAt(new Date('2026-11-12T02:00:01Z'));
    await form.locator('[data-mail-auto-refresh]').check();
    await page.waitForFunction(() => window.mailReads === 2);
    await page.evaluate(() => { window.silentMail = true; });
    await page.clock.runFor(61_000);
    assert.equal(await page.evaluate(() => window.mailStreams.length), 2);
    assert.equal(await page.evaluate(() => window.mailStreams[0].closed), true);
    assert.equal(await page.evaluate(() => window.mailReads), 3, 'reconnection reconciles once');
    await page.evaluate(() => { window.silentMail = false; });
    await page.clock.runFor(120_000);
    assert.equal(await page.evaluate(() => window.mailReads), 3, 'healthy heartbeats never query mail');
    assert.equal(await page.evaluate(() => window.mailStreams.length), 2);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('mail connection timeouts cannot reset the bounded retry budget', async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const { context, page, form } = await prepare(browser, 1440);
  try {
    await page.clock.install({ time: new Date('2026-11-12T02:00:00Z') });
    await page.clock.pauseAt(new Date('2026-11-12T02:00:01Z'));
    await page.evaluate(() => {
      const original = window.fetch;
      window.timedOutStreams = 0;
      window.fetch = (url, options) => {
        if (options?.headers?.Accept !== 'text/event-stream') return original(url, options);
        window.timedOutStreams++;
        return new Promise((_resolve, reject) => options.signal.addEventListener('abort',
          () => reject(new DOMException('synthetic timeout', 'AbortError')), { once: true }));
      };
    });
    await form.locator('[data-mail-auto-refresh]').check();
    await page.clock.runFor(240_000);
    assert.equal(await page.evaluate(() => window.timedOutStreams), 4);
    assert.equal(await form.locator('[data-mail-auto-refresh]').isChecked(), false);
    assert.equal(await page.evaluate(() => window.mailReads), 1);
    assert.match(await form.locator('#ops-managed-query-results').textContent(), /合成邮件一/);
  } finally { await context.close(); }
});

test('mail identity changes reject late reads and authorization errors do not auto-retry', async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const { context, page, form, errors } = await prepare(browser, 1440);
  try {
    await form.locator('[data-mail-auto-refresh]').check();
    await page.waitForFunction(() => window.mailReads === 2 && !document.querySelector('#ops-managed-mail-query [type=submit]').disabled);
    await page.evaluate(() => { window.holdMail = true; window.emitMail('changed', { version: 1 }); });
    await page.waitForFunction(() => window.mailHeld.length === 1);
    await form.locator('#ops-managed-query-code').fill('MBX-' + 'G'.repeat(32));
    await page.evaluate(() => { window.holdMail = false; window.mailHeld.shift()(); });
    assert.equal(await form.locator('#ops-managed-query-results').textContent(), '');
    assert.equal(await form.locator('[data-mail-auto-refresh]').isChecked(), false);
    await page.waitForFunction(() => window.mailStreams.every(stream => stream.closed));
    await form.getByRole('button', { name: '查询邮件', exact: true }).click();
    await form.getByText('合成邮件一', { exact: true }).waitFor();
    await form.locator('[data-mail-auto-refresh]').check();
    await page.waitForFunction(() => window.mailStreams.length === 2 && !document.querySelector('#ops-managed-mail-query [type=submit]').disabled);
    await page.evaluate(() => window.emitMail('stopped', { reason: 'authorization' }));
    await page.waitForFunction(() => !document.querySelector('[data-mail-auto-refresh]').checked);
    assert.match(await form.locator('#ops-managed-query-progress').textContent(), /授权已变化/);
    await form.locator('[data-mail-auto-refresh]').check();
    await page.waitForFunction(() => window.mailStreams.length === 3);
    await page.evaluate(() => window.IDLocalData.queries.clear());
    await page.waitForFunction(() => window.mailStreams.every(stream => stream.closed));
    assert.equal(await form.locator('[data-mail-auto-refresh]').isChecked(), false);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

test('failed mail streams have bounded reconnects and never become timed mail queries', async t => {
  const browser = await chromium.launch(); t.after(() => browser.close());
  const { context, page, form, errors } = await prepare(browser, 1440);
  try {
    await page.clock.install({ time: new Date('2026-11-12T02:00:00Z') });
    await page.clock.pauseAt(new Date('2026-11-12T02:00:01Z'));
    await page.evaluate(() => {
      const original = window.fetch;
      window.failedStreams = 0;
      window.fetch = (url, options) => {
        if (options?.headers?.Accept === 'text/event-stream') {
          window.failedStreams++;
          return Promise.reject(new TypeError('synthetic disconnect'));
        }
        return original(url, options);
      };
    });
    await form.locator('[data-mail-auto-refresh]').check();
    for (const delay of [1000, 3000, 10_000]) await page.clock.runFor(delay);
    assert.equal(await page.evaluate(() => window.failedStreams), 4);
    assert.equal(await form.locator('[data-mail-auto-refresh]').isChecked(), false);
    await page.clock.runFor(120_000);
    assert.equal(await page.evaluate(() => window.failedStreams), 4);
    assert.equal(await page.evaluate(() => window.mailReads), 1);
    assert.match(await form.locator('#ops-managed-query-results').textContent(), /合成邮件一/);
    assert.deepEqual(errors, []);
  } finally { await context.close(); }
});

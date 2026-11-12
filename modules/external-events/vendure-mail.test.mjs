import assert from 'node:assert/strict';
import test from 'node:test';
import { consumeVendureMail } from './vendure-mail.mjs';
const frame = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

test('existing Vendure protocol reconciles once, ignores heartbeats and deduplicates identities, not cursor order', async () => {
  let reads = 0, request;
  const cursors = [];
  const a = 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa', b = 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb';
  const payload = frame('ready', { version: 1, cursor: '20', reconcile: true }) + ': heartbeat\n\n' +
    frame('mail', { eventId: a, cursor: '22' }) + frame('mail', { eventId: a, cursor: '22' }) +
    frame('mail', { eventId: b, cursor: '21' }) + frame('reconcile', {}) + frame('access-denied', {});
  await assert.rejects(consumeVendureMail({ shopUrl: 'http://127.0.0.1:3000/shop-api', queryCode: 'BUY-TEST-CODE',
    onChange: async () => { reads++; }, onCursor: async cursor => cursors.push(cursor),
    fetchImpl: async (url, options) => { request = { url: String(url), options };
      return new Response(payload, { headers: { 'Content-Type': 'text/event-stream' } }); }
  }), /mail_event_stream_unavailable/);
  assert.equal(request.url, 'http://127.0.0.1:3000/storefront-realtime/mail-events');
  assert.equal(request.options.redirect, 'error');
  assert.deepEqual(JSON.parse(request.options.body), { queryCode: 'BUY-TEST-CODE' });
  assert.equal(reads, 4); assert.deepEqual(cursors, ['20', '22', '21']);
});

test('a failed refresh does not acknowledge a cursor or reveal service content', async () => {
  const cursors = [];
  await assert.rejects(consumeVendureMail({ shopUrl: 'http://127.0.0.1/shop-api', queryCode: 'BUY-TEST-CODE',
    onChange: async () => { throw new Error('private upstream content'); }, onCursor: async value => cursors.push(value),
    fetchImpl: async () => new Response(frame('ready', { version: 1, cursor: '5', reconcile: true }),
      { headers: { 'Content-Type': 'text/event-stream' } })
  }), error => error.message === 'mail_event_stream_unavailable');
  assert.deepEqual(cursors, []);
});

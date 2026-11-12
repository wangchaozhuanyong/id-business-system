import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { Readable } from 'node:stream';
import test from 'node:test';
import { watchMailboxImap } from '../server/tools/mailbox-idle.mjs';
import { createManagedMailboxQuery, managedMailboxQueryRoute } from '../server/tools/mailbox-pool.mjs';
import { createMicrosoftMailbox } from '../server/tools/mailbox-microsoft.mjs';

const tick = () => new Promise(resolve => setImmediate(resolve));
const item = { id: 'synthetic-mailbox', provider: 'google', email: 'fixture@example.test',
  appPassword: 'synthetic-only', expiresAt: '2027-01-01T00:00:00Z', revision: 1 };
const code = 'MBX-' + 'F'.repeat(32), origin = 'https://mailbox.example.test';

class Socket extends EventEmitter {
  writes = [];
  setEncoding(value) { assert.equal(value, 'utf8'); }
  write(value) { this.writes.push(value); }
  destroy() { this.destroyed = true; this.emit('close'); }
  receive(line) { this.emit('data', line + '\r\n'); }
  ok(status = 'OK') { this.receive(this.writes.at(-1).split(' ')[0] + ' ' + status + ' complete'); }
}
function protocol(provider = 'google') {
  const socket = new Socket(), scheduled = new Set(), events = [], errors = [];
  const controller = new AbortController();
  const ready = watchMailboxImap({ ...item, provider, accessToken: 'synthetic-token' }, {
    signal: controller.signal, onChange: () => events.push('change'), onError: error => errors.push(error.code),
    connectTls(options) { assert.equal(options.port, 993); assert.equal(options.rejectUnauthorized, true);
      assert.equal(options.host, options.servername); return socket; },
    schedule(fn, delay) { const timer = { fn, delay }; scheduled.add(timer); return timer; },
    cancel(timer) { scheduled.delete(timer); }
  });
  function select() {
    socket.receive('* OK welcome');
    if (provider === 'microsoft') socket.receive('+');
    socket.receive('U1 OK authenticated');
    socket.receive('* CAPABILITY IMAP4rev1 IDLE'); socket.ok();
    socket.receive('* 2 EXISTS'); socket.receive('* OK [UIDNEXT 9] next');
    socket.receive('* OK [UIDVALIDITY 1] valid'); socket.ok();
    socket.receive('+ idling');
  }
  return { socket, scheduled, events, errors, controller, ready, select };
}

test('IMAP IDLE uses read-only selection, real changes, and keepalive without fetching mail', async () => {
  const p = protocol(); p.select();
  const handle = await p.ready;
  assert.match(p.socket.writes[2], /EXAMINE INBOX/);
  assert.equal(p.events.length, 0);
  p.socket.receive('* 2 EXISTS');
  p.socket.receive('* 1 FETCH (FLAGS (\\Seen))');
  assert.equal(p.events.length, 0);
  p.socket.emit('data', '* 3 EX'); p.socket.emit('data', 'ISTS\r\n');
  assert.equal(p.events.length, 1);
  p.socket.receive('* 3 EXISTS'); assert.equal(p.events.length, 1);
  p.socket.receive('* 2 EXPUNGE'); assert.equal(p.events.length, 2);
  p.socket.receive('* 2 EXISTS'); assert.equal(p.events.length, 2);
  p.scheduled.values().next().value.fn();
  assert.equal(p.socket.writes.at(-1), 'DONE\r\n');
  p.socket.receive('U4 OK idle ended');
  assert.match(p.socket.writes.at(-1), /IDLE/);
  p.socket.receive('+ idling again');
  assert.equal(p.events.length, 2);
  assert.equal(p.socket.writes.some(value => /\b(FETCH|SEARCH|STORE|SELECT|NOOP)\b/.test(value)), false);
  handle.close(); assert.equal(p.socket.destroyed, true); assert.equal(p.scheduled.size, 0);
  assert.deepEqual(p.errors, []);
});

test('IDLE capabilities, rejected authorization, malformed traffic and cancellation fail closed', async () => {
  const unsupported = protocol();
  unsupported.socket.receive('* OK welcome'); unsupported.socket.ok();
  unsupported.socket.receive('* CAPABILITY IMAP4rev1'); unsupported.socket.ok();
  await assert.rejects(unsupported.ready, { code: 'IDLE_UNSUPPORTED' });
  const rejected = protocol(); rejected.socket.receive('* OK welcome'); rejected.socket.ok('NO');
  await assert.rejects(rejected.ready, { code: 'AUTH_REJECTED' });
  const cancelled = protocol(); cancelled.controller.abort();
  await assert.rejects(cancelled.ready, { code: 'ABORTED' });
  const broken = protocol(); broken.select(); await broken.ready;
  broken.socket.emit('data', 'x'.repeat(65537));
  assert.deepEqual(broken.errors, ['UNAVAILABLE']); assert.equal(broken.socket.destroyed, true);
  const timed = protocol(); timed.scheduled.values().next().value.fn();
  await assert.rejects(timed.ready, { code: 'UNAVAILABLE' });
});

test('Microsoft uses existing XOAUTH2 scope and never places bearer material in a URL', async () => {
  const p = protocol('microsoft'); p.select();
  const handle = await p.ready;
  assert.equal(p.socket.writes[0], 'U1 AUTHENTICATE XOAUTH2\r\n');
  assert.match(Buffer.from(p.socket.writes[1].trim(), 'base64').toString(), /^user=fixture@example.test\x01auth=Bearer synthetic-token/);
  handle.close();
});

class Reply extends EventEmitter {
  chunks = [];
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  write(value) { this.chunks.push(value); return !this.slow; }
  end(value) { if (value) this.chunks.push(value); this.ended = true; }
  text() { return this.chunks.join(''); }
}
function request(queryCode = code, headers = {}) {
  return Object.assign(Readable.from([Buffer.from(JSON.stringify({ queryCode }))]), {
    method: 'POST', url: managedMailboxQueryRoute,
    headers: { host: 'mailbox.example.test', origin, 'content-type': 'application/json', accept: 'text/event-stream', ...headers }
  });
}
function server({ pending = false } = {}) {
  let current = { ...item }, opens = 0, reads = 0, closed = 0, watchOptions, resolveReady, rejectReady;
  const subscribers = new Set();
  const watch = {
    close() { closed++; }
  };
  const handler = createManagedMailboxQuery({ publicOrigin: origin, clock: () => Date.parse('2026-11-12T00:00:00Z'),
    store: {
      findManagedMailbox: value => value === code ? current : null,
      subscribeChanges(listener) { subscribers.add(listener); return () => subscribers.delete(listener); }
    },
    readMailbox: async () => { reads++; return []; },
    watchMailbox: async (_item, options) => {
      opens++; watchOptions = options;
      if (!pending) return watch;
      return new Promise((resolve, reject) => {
        resolveReady = () => resolve(watch); rejectReady = reject;
        options.signal.addEventListener('abort', () => reject(Object.assign(new Error('cancelled'), { code: 'ABORTED' })));
      });
    }
  });
  return { handler, subscribers, notify: () => watchOptions.onChange(), fail: () => watchOptions.onError({ code: 'UNAVAILABLE' }),
    counts: () => ({ opens, reads, closed }), authorize(value) { current = value; for (const cb of [...subscribers]) cb(); },
    resolve: () => resolveReady(), reject: error => rejectReady(error), signal: () => watchOptions.signal };
}

test('viewers share one listener; no mail reads until data events; disconnect releases the last listener', async () => {
  const s = server(), a = new Reply(), b = new Reply();
  try {
    await Promise.all([s.handler(request(), a), s.handler(request(), b)]);
    assert.equal(a.status, 200); assert.match(a.headers['Content-Type'], /text\/event-stream/);
    assert.equal(a.headers['Cache-Control'], 'private, no-store');
    assert.deepEqual(s.counts(), { opens: 1, reads: 0, closed: 0 });
    assert.match(a.text(), /event: ready/);
    s.notify(); assert.match(a.text(), /event: changed\ndata: {"version":1}/);
    assert.match(b.text(), /event: changed/);
    assert.equal(a.text().includes(item.email), false); assert.equal(a.text().includes(code), false);
    a.emit('close'); assert.equal(s.signal().aborted, false);
    b.emit('close'); assert.equal(s.signal().aborted, true);
    assert.equal(s.subscribers.size, 0); assert.equal(s.counts().closed, 1);
  } finally { s.handler.close(); }
});

test('invalid codes and cross-origin requests cannot start a subscription', async () => {
  const s = server();
  for (const [req, status] of [[request('bad'), 404], [request(code, { origin: 'https://other.example.test' }), 403]]) {
    const reply = new Reply(); await s.handler(req, reply); assert.equal(reply.status, status);
    assert.doesNotMatch(reply.text(), /fixture@example/);
  }
  assert.equal(s.counts().opens, 0); s.handler.close();
});

test('revoked codes stop both ready and still-connecting listeners, without returning old updates', async () => {
  for (const pending of [false, true]) {
    const s = server({ pending }), reply = new Reply();
    const handled = s.handler(request(), reply);
    await tick();
    if (!pending) await handled;
    s.authorize(null);
    await handled;
    assert.equal(reply.ended, true); assert.equal(s.signal().aborted, true);
    assert.equal(s.subscribers.size, 0);
    if (pending) assert.equal(reply.status, 404);
    else assert.match(reply.text(), /"reason":"authorization"/);
    const before = reply.text(); s.notify(); assert.equal(reply.text(), before);
    s.handler.close();
  }
});

test('provider errors and slow viewers close cleanly; OAuth token rotation alone does not loop', async () => {
  const s = server(), reply = new Reply();
  await s.handler(request(), reply);
  s.authorize({ ...item, revision: 2, refreshToken: 'rotated-synthetic' });
  assert.equal(reply.ended, undefined);
  reply.slow = true; s.notify();
  assert.equal(reply.ended, true); assert.equal(s.signal().aborted, true);
  s.handler.close();
  const failed = server(), next = new Reply(); await failed.handler(request(), next);
  failed.fail(); assert.equal(next.ended, true); assert.match(next.text(), /"reason":"connection"/);
  failed.handler.close();
});

test('different mailbox viewers never receive one another’s notifications or a rebound code', async () => {
  const otherCode = 'MBX-' + 'G'.repeat(32), watches = new Map(), listeners = new Set();
  const records = new Map([[code, item], [otherCode, { ...item, id: 'other', email: 'other@example.test' }]]);
  const handler = createManagedMailboxQuery({ publicOrigin: origin, clock: () => Date.parse('2026-11-12'),
    store: { findManagedMailbox: value => records.get(value),
      subscribeChanges(listener) { listeners.add(listener); return () => listeners.delete(listener); } },
    watchMailbox: async (mail, options) => { watches.set(mail.id, options); return { close() {} }; }
  });
  const first = new Reply(), second = new Reply();
  try {
    await handler(request(), first); await handler(request(otherCode), second);
    watches.get(item.id).onChange();
    assert.match(first.text(), /event: changed/); assert.doesNotMatch(second.text(), /event: changed/);
    records.set(code, records.get(otherCode));
    for (const listener of [...listeners]) listener();
    assert.match(first.text(), /"reason":"authorization"/); assert.equal(first.ended, true);
    assert.equal(second.ended, undefined);
    watches.get('other').onChange(); assert.match(second.text(), /event: changed/);
  } finally { handler.close(); }
});

test('unsupported providers fail visibly and release the slot for a later connection', async () => {
  const s = server({ pending: true }), reply = new Reply();
  const initial = s.handler(request(), reply); await tick();
  s.reject(Object.assign(new Error('Unsupported'), { code: 'IDLE_UNSUPPORTED' }));
  await initial;
  assert.equal(reply.status, 409); assert.match(reply.text(), /立即刷新/);
  assert.equal(s.subscribers.size, 0);
  const next = new Reply(), retried = s.handler(request(), next); await tick(); s.resolve(); await retried;
  assert.equal(next.status, 200); assert.equal(s.counts().opens, 2); s.handler.close();
});

test('Microsoft watch reuses token exchange and rotates only after a successful connection', async () => {
  let rotated = 0, optionsPassed;
  const mailbox = createMicrosoftMailbox({ publicOrigin: origin,
    config: { clientId: '00000000-0000-0000-0000-000000000001', clientSecret: 'synthetic-only',
      redirectUri: origin + '/api/local/tools/mailbox-microsoft/callback' },
    store: { rotateMicrosoftRefreshToken() { rotated++; } },
    fetchImpl: async (_url, options) => {
      assert.equal(options.body.get('grant_type'), 'refresh_token');
      return Response.json({ access_token: 'synthetic-access', refresh_token: 'synthetic-rotated' });
    },
    watchImap: async (mail, options) => { assert.equal(mail.accessToken, 'synthetic-access'); optionsPassed = options; return { close() {} }; }
  });
  const controller = new AbortController();
  await mailbox.watchMailbox({ ...item, provider: 'microsoft', refreshToken: 'synthetic-old' }, { signal: controller.signal });
  assert.equal(rotated, 1); assert.equal(optionsPassed.signal, controller.signal);
  controller.abort();
  await assert.rejects(mailbox.watchMailbox({ ...item, provider: 'microsoft' }, { signal: controller.signal }), { code: 'ABORTED' });
  assert.equal(rotated, 1);
});

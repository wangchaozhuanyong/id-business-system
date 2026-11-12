import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { createRelayMailUpdates } from '../server/apple-relay/mail-updates.mjs';

class Response extends EventEmitter {
  frames = []; headers = {}; writableEnded = false;
  writeHead(status, headers) { this.status = status; this.headers = headers; }
  write(frame) { this.frames.push(frame); return !this.blocked; }
  end(body) { this.body = body; this.writableEnded = true; }
}
const turn = () => new Promise(resolve => setImmediate(resolve));
function fixture(t) {
  const upstream = [], listeners = new Set();
  let valid = true, authorizations = 0;
  const manager = createRelayMailUpdates({ shopUrl: 'http://127.0.0.1:44570/shop-api',
    authorize: async () => { authorizations++; return { id: 'synthetic-binding', expiresAt: null }; },
    identity: target => target.id,
    validLocal: async () => valid,
    subscribeChanges(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    consume: options => { upstream.push(options); return new Promise((resolve, reject) =>
      options.signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })); }
  });
  t.after(() => manager.close());
  return { manager, upstream, listeners, get authorizations() { return authorizations; },
    revoke() { valid = false; for (const listener of listeners) listener(); },
    async connect(code = 'BUY-AAAA-BBBB') {
      const response = new Response();
      await manager.handle(new EventEmitter(), response, code);
      return response;
    }
  };
}

test('relay shares a stream, emits opaque revisions only, and has no idle mail reads', async t => {
  const f = fixture(t), first = await f.connect(), second = await f.connect();
  assert.equal(f.upstream.length, 1);
  await f.upstream[0].onChange();
  assert.equal(first.status, 200); assert.match(first.frames[0], /^event: ready/);
  assert.equal(second.frames.length, 1);
  await turn(); assert.equal(first.frames.length, 1); assert.equal(f.authorizations, 2);
  await f.upstream[0].onChange();
  assert.match(first.frames[1], /event: changed\ndata: {"version":2}/);
  assert.doesNotMatch(first.frames.join(''), /BUY|synthetic-binding|44570/);
  first.emit('close'); assert.equal(f.upstream[0].signal.aborted, false);
  second.emit('close'); assert.equal(f.upstream[0].signal.aborted, true);
  assert.equal(f.listeners.size, 0);
});

test('local revocation ends existing relay clients before any later notification', async t => {
  const f = fixture(t), response = await f.connect();
  await f.upstream[0].onChange();
  f.revoke(); await turn();
  assert.equal(response.writableEnded, true);
  assert.match(response.frames.at(-1), /"reason":"authorization"/);
  assert.equal(f.upstream[0].signal.aborted, true);
  const count = response.frames.length;
  await f.upstream[0].onChange(); assert.equal(response.frames.length, count);
});

test('relay bounds sources and closes slow clients without retaining subscriptions', async t => {
  const f = fixture(t);
  for (let index = 0; index < 6; index++) await f.connect('BUY-AAAA-BBB' + index);
  await assert.rejects(f.connect('BUY-AAAA-CCCC'), { status: 503 });
  const slow = await f.connect('BUY-AAAA-BBB0'); slow.blocked = true;
  await f.upstream[0].onChange();
  assert.equal(slow.writableEnded, true);
  f.manager.close(); assert.equal(f.listeners.size, 0);
  assert(f.upstream.every(source => source.signal.aborted));
});

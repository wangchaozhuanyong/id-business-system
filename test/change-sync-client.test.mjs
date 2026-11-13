import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import test from 'node:test';

const source = await readFile(new URL('../frontend/change-sync.js', import.meta.url), 'utf8');
const settle = () => new Promise(resolve => setImmediate(resolve));
function fixture({ form = false } = {}) {
  let listener, current = '1', observed = '1', reads = 0, fail = false, writes = false;
  const timers = new Map(), events = new Map(), notices = [];
  const otherVersions = new Map(), acknowledged = [];
  const data = { writesPending: () => writes,
    pendingChangeVersions: scopes => Object.fromEntries(scopes.flatMap(scope => scope === 'commerce'
      ? current !== observed ? [[scope, current]] : []
      : otherVersions.has(scope) ? [[scope, otherVersions.get(scope)]] : [])),
    subscribeChanges: callback => { listener = callback; return () => {}; },
    acknowledgeChanges: versions => acknowledged.push(...Object.entries(versions)), clearChangeTracking: () => {} };
  const api = { state: { route: form ? 'workspace/order/gpt' : 'orders/gpt' },
    modules: { commerce: { refreshCommerce: async () => { reads++; observed = current; return true; } } },
    notify: message => notices.push(message) };
  const window = { IDLocalData: data, IDDesignAPI: api,
    IDDesignModules: [{ onDataChanges: async () => !fail }],
    addEventListener: (type, fn) => events.set(type, fn) };
  const document = { hidden: false, addEventListener: (type, fn) => events.set(type, fn), querySelectorAll: () => [],
    querySelector: selector => selector.includes('id-local-data-events') ? { content: 'enabled' } :
      form && selector.includes('#main form[novalidate]') ? {} : null };
  runInNewContext(source, { window, document, queueMicrotask,
    setTimeout: (fn, ms) => { const id = Symbol(); timers.set(id, { fn, ms }); return id; },
    clearTimeout: id => timers.delete(id) });
  return { api: window.IDChangeSync, design: api, modules: window.IDDesignModules, timers, notices, acknowledged,
    reads: () => reads, fail: value => { fail = value; }, writes: value => { writes = value; },
    emit: version => { current = version; listener(['commerce']); },
    emitBehind: () => listener(['commerce'], { behind: true }),
    emitScope: (scope, version) => { otherVersions.set(scope, version); listener([scope]); },
    event: type => events.get(type)?.(),
    tick: async () => { const [id, timer] = timers.entries().next().value; timers.delete(id); timer.fn(); await settle(); } };
}
test('idle pages never poll; a new revision updates beside an untouched editor', async () => {
  const f = fixture({ form: true });
  f.api.resume(); await settle();
  assert.equal(f.reads(), 0); assert.equal(f.timers.size, 0);
  f.emit('2'); await settle();
  assert.equal(f.reads(), 1); assert.equal(f.api.status().pending, 0);
  f.emit('2'); await settle();
  assert.equal(f.reads(), 1); assert.equal(f.timers.size, 0);
});
test('a failed dependent view retries even after its base read consumed the version', async () => {
  const f = fixture(); f.fail(true); f.emit('2'); await settle();
  assert.equal(f.reads(), 1); assert.equal(f.timers.size, 1);
  f.fail(false); await f.tick();
  assert.equal(f.reads(), 2); assert.equal(f.api.status().pending, 0);
  assert.equal(f.timers.size, 0); assert.equal(f.api.status().refreshFailures, 0);
});
test('recovery is bounded; an explicit retry resumes pending work without a new revision', async () => {
  const f = fixture(); f.fail(true); f.emit('2'); await settle();
  for (let i = 0; i < 3; i++) await f.tick();
  assert.equal(f.reads(), 4); assert.equal(f.timers.size, 0);
  f.api.resume(); await settle(); assert.equal(f.reads(), 4);
  f.fail(false); f.api.retry(); await settle();
  assert.equal(f.reads(), 5); assert.equal(f.api.status().pending, 0);
});
test('writes defer reads until idle; stopping cancels recovery', async () => {
  const f = fixture(); f.writes(true); f.emit('2'); await settle();
  assert.equal(f.reads(), 0);
  f.writes(false); f.fail(true); f.event('id-data-write-idle'); await settle();
  assert.equal(f.timers.size, 1);
  f.api.stop(); assert.equal(f.timers.size, 0);
});
test('a newer revision arriving during the last failed attempt receives its own recovery', async () => {
  const f = fixture();
  f.modules.push({ onDataChanges: async () => { if (f.reads() === 4) f.emit('3'); } });
  f.fail(true); f.emit('2'); await settle();
  for (let i = 0; i < 3; i++) await f.tick();
  assert.equal(f.reads(), 5);
  assert.equal(f.timers.size, 1);
  f.fail(false); await f.tick();
  assert.equal(f.reads(), 6);
  assert.equal(f.api.status().pending, 0);
});
test('a render exception retains the pending update instead of acknowledging success', async () => {
  const f = fixture();
  f.design.state.route = 'mailboxes/google';
  f.design.render = () => { throw new Error('synthetic render failure'); };
  f.emit('2'); await settle();
  assert.equal(f.api.status().refreshFailures, 1);
  assert.equal(f.api.status().pending, 1);
  f.design.render = () => {};
  await f.tick();
  assert.equal(f.api.status().refreshFailures, 0);
  assert.equal(f.api.status().pending, 0);
});

test('inventory updates while a commerce read is stalled and a failed scope keeps its own retry', async () => {
  const f = fixture(), held = Promise.withResolvers(), inventory = [];
  f.design.modules.commerce.refreshCommerce = () => held.promise;
  f.design.modules.inventory = { refreshLocalInventory: async () => { inventory.push('refreshed'); return true; } };
  f.emit('2'); await settle();
  f.emitScope('inventory', '2'); await settle();
  assert.deepEqual(inventory, ['refreshed']);
  assert.deepEqual(f.acknowledged, [['inventory', '2']]);
  assert.equal(f.api.status().pending, 1);
  held.resolve(false);
  await settle();
  assert.equal(f.api.status().refreshFailures, 1);
  f.emitScope('inventory', '3'); await settle();
  assert.deepEqual(inventory, ['refreshed', 'refreshed']);
  assert.deepEqual(f.acknowledged, [['inventory', '2'], ['inventory', '3']]);
  assert.equal(f.timers.size, 1);
  f.api.stop();
});

test('a successful response still retries if it predates the announced version', async () => {
  const f = fixture();
  const refresh = f.design.modules.commerce.refreshCommerce;
  f.design.modules.commerce.refreshCommerce = async () => {
    f.emitBehind();
    return true;
  };
  f.emit('2'); await settle();
  assert.equal(f.api.status().pending, 1);
  assert.equal(f.timers.size, 1);
  assert.deepEqual(f.acknowledged, []);
  f.design.modules.commerce.refreshCommerce = refresh;
  await f.tick();
  assert.equal(f.api.status().pending, 0);
  assert.deepEqual(f.acknowledged, [['commerce', '2']]);
});

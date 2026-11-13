import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, writeFile, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { createDataChangeStream, changedVersions, dataSourceIdentity } from '../server/change-sync.mjs';

class Response extends EventEmitter {
  chunks = []; writableLength = 0; destroyed = false;
  writeHead(status, headers) { this.status = status; this.headers = headers; return this; }
  write(value) { this.chunks.push(value); this.emit('chunk', value); return true; }
  end() { this.destroyed = true; this.emit('close'); }
}
const tick = () => new Promise(resolve => setImmediate(resolve));

test('stream sends only changed revisions; unchanged signals and heartbeats do not refresh data', async t => {
  let versions = { inventory: '1', commerce: '2' }, notify;
  const feed = createDataChangeStream({
    source: 'fixture-source',
    getVersions: () => versions, getActor: () => ({ id: 'fixture' }),
    subscribe: listener => { notify = listener; return () => { notify = undefined; }; }, heartbeatMs: 10
  });
  t.after(() => feed.close());
  const response = new Response();
  feed.handle({ method: 'GET' }, response, { id: 'fixture' });
  assert.equal(response.status, 200);
  assert.equal(response.headers['X-Accel-Buffering'], 'no');
  assert(response.chunks[0].includes('"source":"fixture-source"'));
  notify(); notify();
  await delay(25);
  assert.equal(response.chunks.filter(chunk => chunk.includes('data:')).length, 1);
  assert(response.chunks.some(chunk => chunk === ': heartbeat\n\n'));
  versions = { ...versions, inventory: '2' };
  notify(); notify();
  await tick();
  const changed = response.chunks.filter(chunk => chunk.startsWith('event: change'));
  assert.equal(changed.length, 1);
  assert(changed[0].includes('"inventory":"2"'));
  assert(!changed[0].includes('commerce'));
  assert(!changed[0].includes('source'));
  assert.deepEqual(changedVersions({ inventory: '1' }, { inventory: '1' }), {});
});

test('the data source stays stable across writes and changes after a restored file replaces it', async t => {
  const runtime = new URL('../.runtime/', import.meta.url);
  await mkdir(runtime, { recursive: true });
  const directory = await mkdtemp(new URL('data-source-', runtime));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'state.fixture'), replacement = join(directory, 'restored.fixture');
  await writeFile(file, 'synthetic state 1');
  const before = await dataSourceIdentity(file);
  await writeFile(file, 'synthetic state 2');
  assert.equal(await dataSourceIdentity(file), before);
  await writeFile(replacement, 'synthetic state 1');
  await rename(replacement, file);
  assert.notEqual(await dataSourceIdentity(file), before);
});

test('stream closes revoked identities and does not turn temporary failures into login revocation', t => {
  let actor = { id: 'fixture' }, notify;
  const feed = createDataChangeStream({ getVersions: () => ({ inventory: '1' }), getActor: () => actor,
    subscribe: listener => { notify = listener; return () => {}; } });
  t.after(() => feed.close());
  const response = new Response();
  feed.handle({ method: 'GET' }, response, actor);
  actor = null;
  notify();
  return tick().then(() => {
    assert.equal(response.destroyed, true);
    assert(response.chunks.some(chunk => chunk.startsWith('event: auth-expired')));
  });
});

test('file changes reconcile another writer without polling or starting a website/database', async t => {
  const runtime = new URL('../.runtime/', import.meta.url);
  await mkdir(runtime, { recursive: true });
  const directory = await mkdtemp(new URL('change-feed-', runtime));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, 'revision.json');
  await writeFile(file, '1');
  let version = '1';
  const feed = createDataChangeStream({ getVersions: () => ({ inventory: version }),
    getActor: () => ({ id: 'fixture' }), subscribe: () => () => {}, watchPaths: [file] });
  t.after(() => feed.close());
  const response = new Response();
  feed.handle({ method: 'GET' }, response, { id: 'fixture' });
  const received = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('file notification not received')), 2000);
    response.on('chunk', chunk => { if (chunk.startsWith('event: change')) { clearTimeout(timer); resolve(chunk); } });
  });
  version = '2';
  await writeFile(file, '2');
  assert((await received).includes('"inventory":"2"'));
});

test('temporary metadata read failures close only the stream, without revoking login', async t => {
  let fail = false, notify;
  const feed = createDataChangeStream({ getVersions: () => {
    if (fail) throw new Error('synthetic temporary read failure');
    return { inventory: '1' };
  }, getActor: () => ({ id: 'fixture' }), subscribe: callback => { notify = callback; return () => {}; } });
  t.after(() => feed.close());
  const response = new Response();
  feed.handle({ method: 'GET' }, response, { id: 'fixture' });
  fail = true;
  notify();
  await tick();
  assert(response.destroyed);
  assert(!response.chunks.some(chunk => chunk.includes('auth-expired')));
});

// Requires an explicitly permitted isolated database environment. Not run on
// this workstation without an explicit exception to AGENTS.md. The three cases
// below were explicitly authorized and run on 2026-11-12.
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import test from 'node:test';
import { createLocalBusinessStore } from '../server/local-business.mjs';
import { describeWriteOperation } from '../server/write-operation.mjs';

const actor = { id: 'test-admin', name: '隔离测试管理员', role: 'admin' };
const empty = () => ({ customers: [], tenants: [], orders: [], operating: [], rentBatches: [], logs: [] });
async function database(t) {
  const root = new URL('../.runtime/', import.meta.url);
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(new URL('write-protocol-', root));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, 'isolated.sqlite');
}
test('a receipt survives restart and rejects a changed-body replay', async t => {
  const path = await database(t);
  let store = createLocalBusinessStore(path);
  t.after(() => store.close());
  const entries = [{ domain: 'commerce', version: 0, data: empty(), action: '新增资料' }];
  const operation = describeWriteOperation('isolated-operation-0001', actor, entries);
  store.saveBatch(structuredClone(entries), { actor, operation });
  const count = store.audit().length;
  store.close(); store = createLocalBusinessStore(path);
  assert.equal(store.saveBatch(structuredClone(entries), { actor, operation })[0].version, 1);
  assert.equal(store.audit().length, count);
  assert.throws(() => store.replayWrite({ ...operation, fingerprint: 'different' }), { status: 409 });
  const failed = describeWriteOperation('isolated-operation-0002', actor, entries);
  assert.throws(() => store.saveBatch(structuredClone(entries), { actor, operation: failed }), { status: 409 });
  assert.equal(store.replayWrite(failed), null, 'a rolled-back write must not leave a success receipt');
});

const storeUrl = new URL('../server/local-business.mjs', import.meta.url).href;
const operationUrl = new URL('../server/write-operation.mjs', import.meta.url).href;
const workerSource = `
  const workerData = await new Promise(resolve => process.once('message', resolve));
  try {
    const { createLocalBusinessStore } = await import(workerData.storeUrl);
    const { describeWriteOperation } = await import(workerData.operationUrl);
    const store = createLocalBusinessStore(workerData.path);
    try {
      const snapshot = store.load('commerce');
      const before = structuredClone(snapshot.data.customers.find(row => row.id === workerData.id));
      const after = { ...before, name: workerData.name, version: before.version + 1 };
      const log = { id: 'log-' + workerData.name, entityId: before.id, type: '修改资料' };
      snapshot.data.customers[snapshot.data.customers.findIndex(row => row.id === before.id)] = after;
      snapshot.data.logs.unshift(log);
      const entries = [{ domain: 'commerce', version: snapshot.version, data: snapshot.data, action: '修改资料',
        recordChange: { list: 'customers', before, after, log } }];
      const operation = describeWriteOperation('isolated-' + workerData.name, workerData.actor, entries);
      const start = new Promise(resolve => process.once('message', resolve));
      process.send({ ready: true });
      await start;
      let response;
      try { store.saveBatch(entries, { actor: workerData.actor, operation }); response = { status: 200 }; }
      catch (error) { response = { status: error.status || 500, error: error.message }; }
      await new Promise(resolve => process.send(response, resolve));
    } finally { store.close(); }
  } finally { process.disconnect(); }
`;
for (const same of [false, true]) test(`independent database writers: ${same ? 'same contact conflicts' : 'different contacts both persist'}`,
  { timeout: 20_000 }, async t => {
    const path = await database(t), store = createLocalBusinessStore(path);
    t.after(() => store.close());
    const data = empty();
    data.customers = ['a', 'b'].map(id => ({ id, name: id, version: 1, phone: id }));
    store.saveBatch([{ domain: 'commerce', version: 0, data, action: '新增资料' }], { actor });
    const workers = [], ready = [], results = [];
    for (let index = 0; index < 2; index++) {
      const worker = spawn(process.execPath, ['--input-type=module', '-e', workerSource],
        { stdio: ['ignore', 'ignore', 'pipe', 'ipc'] });
      workers.push(worker);
      t.after(() => { if (worker.exitCode === null) worker.kill(); });
      // Drain diagnostics without recording fixture data or environment values.
      worker.stderr.resume();
      ready.push(new Promise((resolve, reject) => { worker.on('message', value => { if (value.ready) resolve(); }); worker.on('error', reject); }));
      results.push(new Promise((resolve, reject) => { worker.on('message', value => { if (value.status) resolve(value); }); worker.on('error', reject); }));
      worker.send({ storeUrl, operationUrl, path, actor,
        id: same || index === 0 ? 'a' : 'b', name: 'writer-number-' + index });
    }
    await Promise.all(ready);
    for (const worker of workers) worker.send({ start: true });
    const responses = await Promise.all(results);
    assert.deepEqual(responses.map(row => row.status).sort(), same ? [200, 409] : [200, 200], JSON.stringify(responses));
    const saved = store.load('commerce');
    assert.equal(saved.data.logs.length, same ? 1 : 2);
    if (!same) assert.deepEqual(saved.data.customers.map(row => row.name), ['writer-number-0', 'writer-number-1']);
  });

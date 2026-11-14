import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createRechargeEvents } from '../server/recharge-events.mjs';
import { createRechargeOrderSync } from '../server/recharge-order-sync.mjs';

const turn = () => new Promise(resolve => setImmediate(resolve));
const event = { version: 1, receipt: 'a'.repeat(64), jobs: ['synthetic-job'], scopes: ['task_logs'], reconcile: false };
function runtime(t) {
  const children = [], calls = [], scheduled = [], readerStates = [], listeners = new Set();
  const revisions = { settings: 1, inventory: 1 };
  let reject = false;
  const runtime = createRechargeEvents({
    config: { host: '127.0.0.1', password: 'synthetic-only', pythonPath: '/synthetic/vendor', checkpointPath: '/synthetic/checkpoint' },
    store: { changeVersions: () => revisions, notifyChanges() {}, subscribeChanges(fn) { listeners.add(fn); return () => listeners.delete(fn); } },
    orderSync: { eventBoundary: () => 1000, pendingJobs: () => ['pending'], async runCommitted(command) {
      calls.push(command); if (reject) throw new Error('synthetic readback failure');
    } },
    activity: { collect: async () => {}, unavailable() {} },
    onReaderStatus: state => readerStates.push(state),
    schedule(fn, delay) { const timer = { fn, delay }; scheduled.push(timer); return timer; }, cancel() {},
    spawnProcess(executable, args, options) {
      assert.equal(executable, 'python3'); assert(args.includes('--config-fd'));
      assert.equal(JSON.stringify(options).includes('synthetic-only'), false);
      const child = new EventEmitter();
      child.stdin = new PassThrough(); child.stdout = new PassThrough(); child.stderr = new PassThrough();
      child.stdio = [child.stdin, child.stdout, child.stderr, new PassThrough()];
      child.kill = () => { child.killed = true; };
      children.push(child); return child;
    }
  });
  t.after(() => runtime.close()); runtime.start();
  return { runtime, children, calls, scheduled, readerStates, listeners, reject() { reject = true; },
    notify() { revisions.settings++; for (const listener of listeners) listener(); } };
}

test('runtime is idle without events, acknowledges applied work, and reacts to local ownership changes', async t => {
  const f = runtime(t), child = f.children[0];
  await turn(); assert.equal(f.calls.length, 0);
  const configuration = JSON.parse(child.stdio[3].read().toString());
  assert.equal(configuration.sinceEpochSeconds, 1000);
  child.stdout.write(JSON.stringify(event) + '\n'); await turn();
  assert.deepEqual(f.calls[0].jobKeys, event.jobs);
  assert.equal(child.stdin.read().toString(), event.receipt + '\n');
  f.notify(); await turn(); assert.deepEqual(f.calls[1].jobKeys, ['pending']);
  await turn(); assert.equal(f.calls.length, 2); assert.equal(f.scheduled.length, 0);
  f.runtime.close(); assert.equal(child.killed, true); assert.equal(f.listeners.size, 0);
});

test('failed readback never ACKs; fatal schema errors stop without a restart loop', async t => {
  const f = runtime(t), child = f.children[0]; f.reject();
  child.stdout.write(JSON.stringify(event) + '\n'); await turn();
  assert.equal(child.stdin.read(), null); assert.equal(child.killed, true);
  assert.equal(f.scheduled.length, 1); assert.equal(f.scheduled[0].delay, 1000);
  assert.deepEqual(f.readerStates, ['reconnecting']);
  f.scheduled[0].fn();
  const next = f.children[1]; next.stderr.write('recharge_event_subscriber_review_required\n'); next.emit('close', 2);
  assert.equal(f.scheduled.length, 1);
  assert.deepEqual(f.readerStates, ['reconnecting', 'review']);
});

test('committed billing changes publish a revision only for recharge reconciliation', async t => {
  const f = runtime(t), child = f.children[0];
  const billing = { ...event, jobs: [], scopes: ['billing_records'], reconcile: true };
  child.stdout.write(JSON.stringify(billing) + '\n');
  await turn();
  assert.deepEqual(f.runtime.versions(), { 'recharge-billing': billing.receipt });
});

test('committed card changes also invalidate reconciliation card classifications', async t => {
  const f = runtime(t), child = f.children[0];
  const cards = { ...event, jobs: [], scopes: ['card_assets'], reconcile: true };
  child.stdout.write(JSON.stringify(cards) + '\n');
  await turn();
  assert.deepEqual(f.runtime.versions(), {
    'tenant-cards': cards.receipt, 'card-types': cards.receipt, 'recharge-billing': cards.receipt
  });
});

test('startup alone does not confirm the connection; native heartbeats do not import orders', async t => {
  const f = runtime(t), child = f.children[0];
  child.stderr.write('recharge_event_subscriber_ready\n');
  await turn();
  assert.deepEqual(f.readerStates, []);
  assert.deepEqual(f.calls.map(call => call.jobKeys), [['pending']]);
  child.stderr.write('recharge_event_subscriber_heartbeat\n');
  await turn();
  assert.deepEqual(f.readerStates, ['connected']);
  assert.equal(f.calls.length, 1);
});

test('a removed source task stays visible for review and does not block all later source commits', async () => {
  let saved;
  const sync = createRechargeOrderSync({ store: {
    featureDocument: domain => ({ version: 1, data: domain === 'order-sync' ? { since: 1000, rows: [] } : {} }),
    load: () => ({ data: {} }), applyRechargeOrder({ row }) { saved = row; return row; }
  }, client: { get: async () => { throw Object.assign(new Error('not found'), { upstreamStatus: 404 }); } } });
  await sync.runCommitted({ apply: true, jobKeys: ['removed-job'] });
  assert.deepEqual(saved.needs, ['原代充任务已移除，请人工核对']);
  assert.equal(saved.orderNo, undefined);
});

test('committed running tasks avoid billing scans; failed terminal evidence remains durable and retries', async () => {
  let data = { since: 1000, rows: [] }, reads = 0, status = 'running';
  const store = {
    featureDocument(domain) { return { version: 1, data: domain === 'order-sync' ? data : {} }; },
    load: () => ({ data: {} }),
    rememberRechargeSessions(keys) { for (const jobKey of keys) if (!data.rows.some(row => row.jobKey === jobKey)) data.rows.push({ jobKey }); },
    applyRechargeOrder({ row }) { data.rows = [...data.rows.filter(old => old.jobKey !== row.jobKey), row]; return row; }
  };
  const sync = createRechargeOrderSync({ store, client: {
    async get(path) {
      if (path.startsWith('/api/admin/task-logs/')) return { task: { jobKey: 'synthetic-job', status } };
      reads++; throw new Error('synthetic source unavailable');
    }, async listCodes() { reads++; throw new Error('synthetic source unavailable'); }
  } });
  await sync.runCommitted({ apply: true, jobKeys: ['synthetic-job'] });
  assert.equal(reads, 0); assert.equal(data.rows.length, 0);
  status = 'success';
  await assert.rejects(sync.runCommitted({ apply: true, jobKeys: ['synthetic-job'] }), /committed_readback_unavailable/);
  assert.deepEqual(sync.pendingJobs(), ['synthetic-job']); assert.equal(reads, 3);
});

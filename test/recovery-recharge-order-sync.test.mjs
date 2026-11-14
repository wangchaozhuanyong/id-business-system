import assert from 'node:assert/strict';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createLocalBusinessStore } from '../server/local-business.mjs';
import { createRechargeOrderSync } from '../server/recharge-order-sync.mjs';
import { createSnapshot, restoreSnapshot } from '../server/backup/local-sqlite.mjs';
import { consumeCommittedJobs } from '../modules/external-events/committed-jobs.mjs';

// Synthetic successful native task; no executor, network, payment or notification.
const root = fileURLToPath(new URL('..', import.meta.url));
const since = Date.parse('2026-11-10T00:00:00Z');
const completed = since + 60_000;
const job = 'synthetic-restored-success';
const event = { version: 1, receipt: 'a'.repeat(64), jobs: [job], scopes: ['task_logs'], reconcile: true };

function upstream() {
  const reads = [];
  let available = true;
  return {
    reads,
    fail() { available = false; },
    resume() { available = true; },
    client: {
      async listCodes() { return [{ code: 'SYNTHETIC-RESTORE-CODE', plan_type: 'plus' }]; },
      async get(path) {
        reads.push(path);
        if (!available) throw new Error('synthetic read interruption');
        if (path === '/api/admin/task-logs/' + job) return {
          task: { jobKey: job, status: 'success', createdAt: new Date(since + 1000).toISOString(),
            cdk: 'SYNTHETIC-RESTORE-CODE', cardLast4: '4242' },
          runtimeEntries: [{ jobKey: job, source: 'task', ts: completed,
            text: '任务结束 status=success progress=100' }]
        };
        if (path === '/api/admin/cards') return { cards: [{ id: 91, last4: '4242',
          card_number: '4242424242424242', usage_count: 1, last_used_at: new Date(completed).toISOString() }] };
        if (path.startsWith('/api/admin/billing?')) return { total: 1, records: [{
          cdk_code: 'SYNTHETIC-RESTORE-CODE', status: 'success', plan_type: 'plus',
          email: 'recovery-fixture@example.test', stripe_session_id: 'synthetic-stripe-session',
          card_last4: '4242', card_number: '4242424242424242',
          payment_time: new Date(completed).toISOString(), amount: '999', currency: 'PHP'
        }] };
        throw new Error('Unexpected recovery request: ' + path);
      }
    }
  };
}

async function deliver(sync, acknowledge = async () => {}) {
  await consumeCommittedJobs([event], {
    run: command => sync.runCommitted(command), pendingJobs: () => sync.pendingJobs(),
    changed: async () => {}, acknowledge
  });
}

async function fixture(t, imported) {
  const base = join(root, 'backups');
  await mkdir(base, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(join(base, '.recharge-recovery-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const source = join(directory, 'synthetic.sqlite');
  const original = createLocalBusinessStore(source);
  const remote = upstream();
  try {
    original.saveBatch([{ domain: 'commerce', version: 0, action: '合成恢复资料', data: {
      customers: [{ id: 'synthetic-existing-customer', name: '合成客户' }],
      orders: [], tenants: [], operating: [], rentBatches: [], logs: []
    } }]);
    original.saveFeatureDocument('order-sync', 0, { since, rows: [] });
    if (imported) await deliver(createRechargeOrderSync({ store: original, client: remote.client,
      clock: () => completed + 1000 }));
  } finally { original.close(); }
  await createSnapshot({ source, output: join(directory, 'snapshot') });
  await restoreSnapshot({ input: join(directory, 'snapshot'), key: source + '.key',
    output: join(directory, 'restored'), exercise: true });
  const recovered = createLocalBusinessStore(join(directory, 'restored/local-business.sqlite'));
  t.after(() => recovered.close());
  const sync = createRechargeOrderSync({ store: recovered, client: remote.client,
    // Recovery can occur much later; retain the original admission boundary.
    clock: () => completed + 40 * 24 * 60 * 60_000 });
  assert.equal(sync.eventBoundary(), since / 1000);
  return { recovered, sync, remote };
}

for (const imported of [false, true]) test(
  `恢复${imported ? '已入单' : '尚未入单'}快照后重放成功任务，仅保留一单且不把预估账单当实扣`, async t => {
    const { recovered, sync, remote } = await fixture(t, imported);
    let acknowledgements = 0;
    for (let index = 0; index < 3; index++) await deliver(sync, async () => { acknowledgements++; });
    const orders = recovered.load('commerce').data.orders;
    assert.equal(orders.length, 1);
    assert.equal(orders[0].taskId, job);
    assert.equal(orders[0].entitlementStatus, 'active');
    assert.equal(orders[0].paidConfirmed, false);
    assert.equal(orders[0].paidAmount, '');
    assert.equal(orders[0].receiptConfirmed, false);
    assert.equal(orders[0].financialEvidence.length, 0);
    assert.equal(acknowledgements, 3);
    const rows = recovered.featureDocument('order-sync').data.rows;
    assert.equal(rows.length, 1);
    assert.equal(rows[0].orderNo, orders[0].orderNo);
    assert.ok(rows[0].needs.includes('实扣金额待核对'));
    assert.ok(remote.reads.every(path => /^\/api\/admin\/(task-logs\/|cards$|billing\?)/.test(path)));
  });

test('恢复回读失败不确认断点；确认丢失后的重放不重复创建订单', async t => {
  const { recovered, sync, remote } = await fixture(t, false);
  let acknowledgements = 0;
  remote.fail();
  await assert.rejects(deliver(sync, async () => { acknowledgements++; }), /committed_event_not_applied/);
  assert.equal(acknowledgements, 0);
  assert.equal(recovered.load('commerce').data?.orders?.length || 0, 0);
  remote.resume();
  await assert.rejects(deliver(sync, async () => { throw new Error('synthetic lost ACK'); }), /lost ACK/);
  const orderId = recovered.load('commerce').data.orders[0].id;
  await deliver(sync, async () => { acknowledgements++; });
  assert.equal(acknowledgements, 1);
  assert.deepEqual(recovered.load('commerce').data.orders.map(row => row.id), [orderId]);
});

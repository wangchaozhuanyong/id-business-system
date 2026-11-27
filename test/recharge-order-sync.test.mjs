import assert from 'node:assert/strict';
import test from 'node:test';
import { createLocalBusinessStore } from '../server/local-business.mjs';
import { createOrderRechargeClient } from '../server/order-recharge-client.mjs';
import { buildRechargeOrder, createRechargeOrderSync, rechargeOrderEvidence } from '../server/recharge-order-sync.mjs';
import { rechargeSessions, usedRechargeCode } from './recharge-order-fixtures.mjs';
import { checkAppleOrder, deriveCardIssueFee, nextOrderNo, redactClaudeProOrderMaterials } from '../server/order-policy.mjs';
import { rechargeAdmissionConflict, rechargeAdmissionPending } from '../server/recharge-order-admission.mjs';
import { subscriptionForOrder } from '../server/subscription-management.mjs';

const createdAt = '2026-10-31T15:30:00.000Z';
const completedAt = '2026-10-31T15:45:00.000Z';
const now = Date.parse('2026-10-31T16:00:00.000Z');
const session = { jobKey: 'task-a', status: 'success', progress: 100, cdk: 'example-code', createdAt, cardLast4: '2345' };
const ownerData = { requests: [{ id: 'batch-a', status: 'issued', applicantId: 'employee-a', codes: ['EXAMPLE-CODE'] }] };

test('browser reconciliation uses the terminal timestamp but does not promote an estimated billing amount', () => {
  const context = {
    now, ownerData,
    bills: [{
      cdk_code: session.cdk, email: 'account@example.test', status: 'success', plan_type: 'pro200',
      amount: '100', currency: 'PHP', payment_time: completedAt, stripe_session_id: 'synthetic-payment',
      card_last4: '2345', card_number: '4000000000002345'
    }],
    cards: [{ id: 1, last4: '2345', card_number: '4000000000002345' }],
    runtimeEntries: [{
      source: 'task', text: '任务结束 status=success progress=100 message=开通成功',
      jobKey: session.jobKey, ts: Date.parse(completedAt)
    }]
  };
  const evidence = rechargeOrderEvidence(session, context);
  assert.equal(evidence.expiry, '2026-11-30T23:45');
  assert.equal(evidence.cardId, 'recharge:1');
  assert.equal(evidence.employeeId, 'employee-a');
  assert.equal(evidence.paidAmount, '');
  assert.equal(rechargeOrderEvidence({ ...session, status: 'failed' }, context), null);
  assert.equal(rechargeOrderEvidence(session, { ...context, runtimeEntries: [] }).start, '');
  assert.equal(rechargeOrderEvidence(session, { ...context, bills: [...context.bills, ...context.bills] }).email, '');
  const order = buildRechargeOrder(evidence, { orderPrices: { GPT: { 'Pro 200': { CNY: '300' } } } }, now);
  assert.equal(order.saleAmount, '300');
  assert.equal(order.receiptConfirmed, false);
  assert.equal(order.paidConfirmed, false);
  assert.equal(order.proCardNumber, '4000000000002345');
  assert.equal(order.rechargeCode, 'example-code');
  assert.doesNotMatch(JSON.stringify(redactClaudeProOrderMaterials(order, { role: 'employee' })), /4000000000002345/);
});

test('only a matching terminal provider receipt supplies the actual amount', () => {
  const open = { ...session, gptApiOrderId: 'provider-a', gptApiRaw: JSON.stringify({
    orderId: 'provider-a', status: 'succeeded', targetEmail: 'account@example.test',
    planCode: 'pro100', completedAt, payment: { amount: '124.31', currency: 'PHP' }
  }) };
  const evidence = rechargeOrderEvidence(open, { now, ownerData });
  assert.equal(evidence.paidAmount, '124.31');
  assert.equal(evidence.paidCurrency, 'PHP');
  assert.equal(evidence.plan, 'Pro 100');
  assert.equal(buildRechargeOrder(evidence, {}, now).paidConfirmed, true);
  const linkedCard = rechargeOrderEvidence(open, { now, orbitCards: [{ cardId: 71, recharges: [{
    jobKey: 'task-a', orderId: 'provider-a', cardLast4: '2345', status: 'success',
    planType: 'pro100', useNumber: 2
  }] }] });
  assert.equal(linkedCard.cardId, 'orbitcard:71');
  assert.equal(linkedCard.firstUse, false);
  assert.equal(rechargeOrderEvidence({ ...open, gptApiOrderId: 'provider-other' }, { now }).paidAmount, '');
  const legacy = { ...session, gptApiOrderId: '30', gptApiRaw: JSON.stringify({
    id: 30, status: 'success', recharge_account: 'account@example.test', plan: 'plus',
    amount: '70.12', currency: 'PHP', settled_at: '2026-10-31 15:45:00'
  }) };
  const legacyEvidence = rechargeOrderEvidence(legacy, { now });
  assert.equal(legacyEvidence.paidAmount, '70.12');
  assert.equal(legacyEvidence.start, '');
  assert.equal(legacyEvidence.plan, 'Plus');
});

test('preview writes nothing and confirmed synchronization only reads the selected task', async () => {
  let checkpoint = { version: 0, data: null };
  const applied = [];
  const store = {
    featureDocument: (domain) => domain === 'order-sync' ? checkpoint : { version: 1, data: ownerData },
    saveFeatureDocument(_domain, version, data) {
      checkpoint = { version: version + 1, data };
      return checkpoint;
    },
    load: () => ({ version: 0, data: null }),
    applyRechargeOrder({ row, order }) {
      applied.push({ row, order });
      return { ...row, orderNo: 'OD-LOCAL-0001' };
    }
  };
  const other = { ...session, jobKey: 'task-b', cdk: 'other-code' };
  const open = { ...session, gptApiOrderId: 'provider-a', gptApiRaw: JSON.stringify({
    orderId: 'provider-a', status: 'succeeded', targetEmail: 'account@example.test',
    planCode: 'plus', completedAt, payment: { amount: '123', currency: 'PHP' }
  }) };
  const paths = [];
  const client = {
    listCodes: async () => [usedRechargeCode(session), usedRechargeCode(other)],
    async get(path) {
      paths.push(path);
      if (path.includes('/sessions')) return rechargeSessions(path.includes('&search=')
        ? [path.endsWith(other.cdk) ? other : session] : [session, other]);
      if (path.includes('/cards')) return { cards: [] };
      if (path.includes('/billing')) return { total: 0, records: [] };
      return { task: path.endsWith(other.jobKey) ? { ...open, ...other } : open };
    }
  };
  let clock = Date.parse('2026-10-31T15:00:00.000Z');
  const sync = createRechargeOrderSync({ store, client, clock: () => clock });
  clock = now;
  assert.equal((await sync.run()).rows.length, 2);
  assert.equal(checkpoint.version, 0);
  assert.equal(applied.length, 0);
  paths.length = 0;
  assert.equal((await sync.run({ apply: true, jobKeys: ['task-a'] })).rows[0].orderNo, 'OD-LOCAL-0001');
  assert.equal(applied.length, 1);
  assert.equal(applied[0].order.createdById, 'employee-a');
  assert.equal(paths.includes('/api/admin/task-logs/task-b'), false);
  assert.equal(checkpoint.data.since, Date.parse('2026-10-31T15:00:00.000Z'));
});

test('accounting transport reads stock and rejects checkout and CDK creation routes', async () => {
  const attempts = [];
  const client = createOrderRechargeClient({ upstreamUrl: 'http://127.0.0.1:4349', secret: 'x'.repeat(40) },
    async (url, options) => {
      attempts.push([url.pathname, options.method]);
      return Response.json(url.pathname.endsWith('/stock') ? { items: [] } : []);
    });
  await assert.rejects(client.get('/api/run-process'), /不支持/);
  await assert.rejects(client.get('https://example.test/api/admin/cards'), /不支持/);
  await assert.rejects(client.get('/api/admin/orbitcard/usage?refresh=1'), /不支持/);
  await assert.rejects(client.get('/api/admin/cdks/generate'), /不支持/);
  await assert.rejects(client.get('/api/admin/cdks/import'), /不支持/);
  await client.listCodes();
  assert.deepEqual(await client.listCodeStock(), []);
  assert.deepEqual(attempts, [['/api/admin/cdks', 'GET'], ['/api/admin/cdks/returns/stock', 'GET']]);
});

test('后台已核实充值码，账单与卡池不可用时保留成功并等待补资料', async () => {
  const start = Date.parse('2026-10-31T15:00:00.000Z');
  let time = now, restored = false;
  const records = new Map(), writes = [];
  const store = {
    featureDocument: () => ({ version: 1, data: { since: start, rows: [...records.values()] } }),
    rememberRechargeSessions(ids) {
      for (const jobKey of ids) if (!records.has(jobKey)) records.set(jobKey, { jobKey });
      return { since: start, rows: [...records.values()] };
    },
    load: () => ({ data: {} }),
    applyRechargeOrder(input) {
      writes.push(input);
      const row = { ...input.row, orderNo: 'OD-LOCAL-0001' };
      records.set(row.jobKey, row);
      return row;
    }
  };
  const client = {
    async listCodes() { return [usedRechargeCode(session)]; },
    async get(path) {
      if (path.includes('&search=')) return rechargeSessions([session]);
      if (path.startsWith('/api/admin/sessions')) return { total: 3, items: [
        { job_key: 'task-a', status: 'success' }, { job_key: 'task-b', status: 'failed' },
        { job_key: 'task-c', status: 'running' }
      ] };
      if (path === '/api/admin/task-logs/task-a') return {
        task: restored ? { ...session, gptApiOrderId: 'provider-a', gptApiRaw: JSON.stringify({
          orderId: 'provider-a', status: 'succeeded', targetEmail: 'account@example.test', planCode: 'plus',
          completedAt, payment: { amount: '123', currency: 'PHP' }
        }) } : session
      };
      if (!restored) throw new Error('模拟辅助资料不可用');
      return { records: [], total: 0, cards: [] };
    }
  };
  const sync = createRechargeOrderSync({ store, client, background: true, clock: () => time });
  await sync.run({ apply: true });
  assert.deepEqual([...records.keys()], ['task-a']);
  assert.equal(writes.length, 1);
  assert.equal(writes[0].order.entitlementStatus, 'active');
  assert.equal(writes[0].order.paidConfirmed, false);
  assert.equal(writes[0].order.receiptConfirmed, false);
  assert.equal(writes[0].order.email, '');
  restored = true;
  await sync.run({ apply: true });
  assert.equal(writes.length, 1);
  time += 15 * 60_000;
  const retry = await sync.run({ apply: true });
  assert.equal(retry.rows[0].orderNo, 'OD-LOCAL-0001');
  assert.equal(writes[1].order.taskId, writes[0].order.taskId);
  assert.equal(writes[1].order.entitlementStatus, 'active');
  assert.equal(writes[1].order.email, 'account@example.test');
  assert.equal(writes[1].order.paidAmount, '123');
});

test('实际回读失败只计一次，未重读的技术待办既不累加也不恢复', async t => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const since = Date.parse('2026-10-31T15:00:00.000Z');
  const tasks = Array.from({ length: 7 }, (_, index) => 'retry-' + index);
  const fixtures = tasks.map(jobKey => ({ ...session, jobKey, cdk: 'code-' + jobKey }));
  store.saveFeatureDocument('order-sync', 0, { since, rows: tasks.map(jobKey => ({
    jobKey, checkedAt: now, needs: ['本次回读未确认，可重试']
  })) });
  const reads = [], states = [];
  let unavailable = true;
  const client = {
    listCodes: async () => fixtures.map(task => usedRechargeCode(task)),
    async get(path) {
      if (path.includes('&search=')) return rechargeSessions(fixtures.filter(task => path.endsWith(task.cdk)));
      if (path.startsWith('/api/admin/sessions')) return { total: 0, items: [] };
      if (path.startsWith('/api/admin/billing')) return { total: 0, records: [] };
      if (path === '/api/admin/cards') return { cards: [] };
      assert(path.startsWith('/api/admin/task-logs/'));
      const jobKey = path.split('/').at(-1);
      reads.push(jobKey);
      if (unavailable) throw new Error('fixture task read unavailable');
      return { task: fixtures.find(task => task.jobKey === jobKey), runtimeEntries: [{
        source: 'task', jobKey, ts: Date.parse(completedAt), text: '任务结束 status=success progress=100'
      }] };
    }
  };
  const sync = createRechargeOrderSync({ store, client, background: true, clock: () => now,
    publicOrigin: 'http://fixture.local', onStatus: ok => states.push(ok) });
  await assert.rejects(sync.runCommitted({ apply: true, jobKeys: tasks.slice(-2) }), /committed_readback_unavailable/);
  assert.deepEqual(reads.splice(0), tasks.slice(-2));
  assert.deepEqual(states, [false]);
  unavailable = false;
  await sync.run({ apply: true });
  assert.deepEqual(reads, []);
  assert.deepEqual(states, [false]);
  const call = async (actor, origin = 'http://fixture.local', body = { mode: 'retry' }) => {
    const response = { writeHead(status) { this.status = status; }, end(raw) { this.body = JSON.parse(raw); } };
    await sync.handle({ method: 'POST', headers: { origin }, async *[Symbol.asyncIterator]() { yield JSON.stringify(body); } },
      response, actor);
    return response;
  };
  const admin = { id: 'test-admin', role: 'admin' };
  assert.equal((await call({ id: 'test-employee', role: 'employee' })).status, 403);
  assert.equal((await call(admin, 'http://external.local')).status, 403);
  assert.equal((await call(admin, undefined, { mode: 'retry', jobKeys: ['other'] })).status, 400);
  assert.deepEqual(reads, []);
  const first = await call(admin);
  assert.equal(first.status, 200);
  assert.equal(first.body.rows.filter(row => row.orderNo).length, 6);
  assert.equal(first.body.pending, 1);
  assert.deepEqual(reads, tasks.slice(0, 6));
  assert.deepEqual(states, [false]);
  const second = await call(admin);
  assert.equal(second.body.pending, 0);
  assert.deepEqual(reads, tasks);
  assert.deepEqual(states, [false, true]);
  assert.equal(store.load('commerce').data.orders.length, 7);
});

test('业务待核对保留初次记录时间并可重试，空批次不能确认恢复', async t => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const firstPendingAt = now - 60 * 60_000;
  store.saveFeatureDocument('order-sync', 0, { since: Date.parse(createdAt) - 1000, rows: [
    { jobKey: session.jobKey, checkedAt: firstPendingAt, needs: [rechargeAdmissionConflict] },
    { jobKey: 'excluded-task', excluded: true, checkedAt: firstPendingAt, needs: [] }
  ] });
  store.rememberRechargeSessions(['not-yet-checked'], 100, firstPendingAt - 1000);
  const states = [];
  let clock = now;
  const sync = createRechargeOrderSync({ store, clock: () => clock, onStatus: ok => states.push(ok), client: {
    async get(path) {
      if (path.startsWith('/api/admin/sessions')) throw new Error('fixture session list unavailable');
      assert.equal(path, '/api/admin/task-logs/' + session.jobKey);
      return { task: session };
    },
    listCodes: async () => []
  } });

  await assert.rejects(sync.run({ apply: true }), /fixture session list unavailable/);
  assert.deepEqual(await sync.runCommitted({ apply: true, jobKeys: ['excluded-task'] }), { rows: [], more: false });
  assert.deepEqual(states, [false]);

  for (let attempt = 0; attempt < 3; attempt++) {
    clock += 60_000;
    const result = await sync.runCommitted({ apply: true, jobKeys: [session.jobKey] });
    assert.deepEqual(result, { rows: [{ jobKey: session.jobKey, needs: [rechargeAdmissionPending], orderNo: '' }], more: false });
  }
  assert.deepEqual(states, [false, true, true, true]);
  assert.deepEqual(sync.pendingJobs().sort(), [session.jobKey, 'not-yet-checked'].sort());
  assert.deepEqual(sync.healthView(), { pending: 2, oldestPendingAt: firstPendingAt - 1000, lastImportedAt: null,
    technicalPending: 0, lastTechnicalFailureAt: null, reviewPending: 1, oldestReviewAt: firstPendingAt });
  assert.equal(store.load('commerce').data, null);
});

test('只有原任务接口的 404 转人工核对，证据接口的 404 仍需要重试', async t => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  store.saveFeatureDocument('order-sync', 0, { since: Date.parse(createdAt) - 1000, rows: [] });
  const missing = Object.assign(new Error('fixture upstream 404'), { upstreamStatus: 404 });
  const states = [];
  let missingTask = false;
  const sync = createRechargeOrderSync({ store, clock: () => now, onStatus: ok => states.push(ok), client: {
    async get() {
      if (missingTask) throw missing;
      return { task: session };
    },
    async listCodes() { throw missing; }
  } });
  const retry = () => sync.runCommitted({ apply: true, jobKeys: [session.jobKey] });
  await assert.rejects(retry(), /committed_readback_unavailable/);
  assert.equal(sync.healthView().technicalPending, 1);
  assert.equal(sync.healthView().lastTechnicalFailureAt, now);
  missingTask = true;
  const { rows } = await retry();
  assert.deepEqual(rows[0].needs, ['原代充任务已移除，请人工核对']);
  assert.deepEqual(states, [false, true]);
  assert.equal(sync.healthView().technicalPending, 0);
  assert.equal(sync.healthView().reviewPending, 1);
});

test('Apple renewals enforce original binding and first-use card fees use actual history', () => {
  const inventory = { mailboxes: [
    { type: 'apple', id: 'apple-1', status: '正常' }, { type: 'apple', id: 'apple-2', status: '正常' }
  ] };
  const ledger = { wallets: [
    { id: 'apple-1', currency: 'USD', balance: '18' }, { id: 'apple-2', currency: 'USD', balance: '75' }
  ], movements: [] };
  const order = {
    id: 'new', payment: '苹果内购', product: 'GPT', plan: 'Plus', businessType: '续费',
    appleIdId: 'apple-1', paidAmount: '10', email: 'same@example.test', paidConfirmed: true
  };
  const prior = { ...order, id: 'old', start: '2026-10-01T10:00' };
  assert.equal(checkAppleOrder(order, null, [prior], ledger, inventory, [order, prior]), undefined);
  assert.match(checkAppleOrder({ ...order, appleIdId: 'apple-2' }, null, [prior], ledger, inventory, [order, prior]), /原订阅/);
  assert.match(checkAppleOrder({ ...order, businessType: '成品交付' }, null, [], ledger, inventory, [order]), /区间/);
  const cardOrder = { ...order, payment: '银行卡', cardId: 'recharge:1', costSettings: { cardIssueUsd: '0.5' } };
  assert.equal(deriveCardIssueFee(cardOrder, null, [], { usageCount: 0 }).applied, true);
  const claude = { ...cardOrder, product: 'Claude Pro', cardTypeId: 'card-type-vccwc999' };
  assert.equal(deriveCardIssueFee(claude, null, [], { usageCount: 0 }).applied, true);
  assert.equal(deriveCardIssueFee({ ...claude, cardTypeId: 'card-type-real' }, null, [], { usageCount: 0 }), undefined);
  const payment = { kind: 'payment', cardId: cardOrder.cardId };
  assert.equal(deriveCardIssueFee(cardOrder, null, [{ id: 'old', financialEvidence: [payment] }], { usageCount: 0 }).applied, false);
  assert.equal(deriveCardIssueFee(cardOrder, null, [], { usageCount: 2 }).pending, true);
  assert.equal(nextOrderNo([{ orderNo: 'OD-LOCAL-0042' }]), 'OD-LOCAL-0043');
});

test('collection, table-write and quote failures affect only auxiliary synchronization, never native recharge', async t => {
  for (const point of ['checkpoint', 'read', 'write', 'quote']) await t.test(point, async () => {
    const privateDiagnostic = 'synthetic-private-storage-or-provider-diagnostic';
    const privateValues = [privateDiagnostic, 'synthetic-authorization', 'synthetic-cvc', '4000000000002345'];
    const task = { ...session, gptApiOrderId: 'provider-a', gptApiRaw: JSON.stringify({
      orderId: 'provider-a', status: 'succeeded', targetEmail: 'account@example.test', planCode: 'plus',
      completedAt, payment: { amount: '123', currency: 'PHP' }, accessToken: privateValues[1], cvc: privateValues[2]
    }) };
    const originalTask = structuredClone(task);
    const attempts = [];
    const writes = [];
    let fail = true;
    let checkpoint = { version: 1, data: point === 'checkpoint' ? null : {
      since: Date.parse('2026-10-31T15:00:00.000Z'), rows: []
    } };
    const store = {
      featureDocument: name => name === 'order-sync' ? checkpoint : { data: ownerData },
      saveFeatureDocument(_name, version, data) {
        if (fail && point === 'checkpoint') throw new Error(privateDiagnostic);
        checkpoint = { version: version + 1, data };
        return checkpoint;
      },
      load: () => ({ data: {} }),
      applyRechargeOrder({ row, order }) {
        if (fail && point === 'write') throw new Error(privateDiagnostic);
        writes.push({ row, order });
        return { ...row, ...(order && { orderNo: 'OD-LOCAL-0001' }) };
      }
    };
    const client = createOrderRechargeClient({ upstreamUrl: 'http://127.0.0.1:31993', secret: 'x'.repeat(40) },
      async (url, options) => {
        attempts.push({ path: url.pathname, method: options.method });
        assert.equal(options.method, 'GET');
        if (url.pathname === '/api/admin/cdks') return Response.json([usedRechargeCode(task)]);
        if (url.pathname === '/api/admin/sessions') return Response.json(rechargeSessions([task]));
        if (url.pathname === '/api/admin/cards') return Response.json({ cards: [{
          id: 1, last4: '2345', card_number: privateValues[3], cvc: privateValues[2], session: privateValues[1]
        }] });
        if (url.pathname === '/api/admin/billing') return Response.json({ total: 0, records: [] });
        if (url.pathname === '/api/admin/orbitcard/usage') return Response.json({ cards: [] });
        assert.equal(url.pathname, '/api/admin/task-logs/task-a');
        if (fail && point === 'read') throw new Error(privateDiagnostic);
        return Response.json({ task, runtimeEntries: [] });
      });
    const sync = createRechargeOrderSync({ store, client, clock: () => now, publicOrigin: 'http://fixture.local',
      quoteService: { enabled: true, async snapshotFor() { if (fail && point === 'quote') throw new Error(privateDiagnostic); } }
    });
    const request = {
      method: 'POST', headers: { origin: 'http://fixture.local' },
      async *[Symbol.asyncIterator]() { yield JSON.stringify({ mode: 'apply', jobKeys: ['task-a'] }); }
    };
    const response = {
      writeHead(status) { this.status = status; },
      end(raw) { this.body = JSON.parse(raw); }
    };
    await sync.handle(request, response, { role: 'admin' });
    assert.equal(response.status, ['checkpoint', 'write'].includes(point) ? 503 : 200);
    if (point === 'read') {
      assert.deepEqual(response.body.rows, [{ jobKey: 'task-a', needs: ['本次回读未确认，可重试'], orderNo: '' }]);
      assert.equal(writes.some(write => write.order), false);
    }
    if (point === 'quote') assert.equal(writes.filter(write => write.order).length, 1);
    assert.deepEqual(task, originalTask);
    for (const value of privateValues) {
      assert.equal(JSON.stringify(response.body).includes(value), false);
      assert.equal(JSON.stringify(writes).includes(value), false);
    }
    assert(attempts.every(attempt => attempt.method === 'GET' && !/run-process|checkout|cancel|retry/.test(attempt.path)));
    fail = false;
    await sync.run({ jobKeys: ['task-a'] });
    assert.deepEqual(task, originalTask);
    assert(attempts.every(attempt => attempt.method === 'GET'));
  });
});

test('a paid-looking payload on a failed, running or unknown task never creates a successful order', () => {
  const raw = JSON.stringify({ orderId: 'provider-a', status: 'succeeded', targetEmail: 'account@example.test',
    planCode: 'plus', completedAt, payment: { amount: '123', currency: 'PHP' } });
  for (const status of ['failed', 'running', 'manual', 'awaiting_review']) {
    const task = { ...session, status, gptApiOrderId: 'provider-a', gptApiRaw: raw };
    const original = structuredClone(task);
    assert.equal(rechargeOrderEvidence(task, { now }), null);
    assert.deepEqual(task, original);
  }
});

test('the collection transport cannot call payment, cancellation or card mutation endpoints even as GET', async () => {
  const attempts = [];
  const client = createOrderRechargeClient({ upstreamUrl: 'http://127.0.0.1:31993', secret: 'x'.repeat(40) },
    async (...args) => { attempts.push(args); throw new Error('network must never be used'); });
  for (const path of ['/api/run-process', '/api/admin/checkout/generate', '/api/admin/cancel-renewal',
    '/api/admin/cards/1', '/api/admin/orbitcard/sync', '/api/admin/orbitcard/usage?refresh=1'])
    await assert.rejects(client.get(path), /不支持/);
  assert.equal(attempts.length, 0);
});

test('自动充值调试数据（无充值码）严禁入单，只有充值码成功任务才入单', async () => {
  const debugTaskWithoutCdk = { jobKey: 'debug-task-1', status: 'success', createdAt, cardLast4: '2345' };
  const debugEvidence1 = rechargeOrderEvidence(debugTaskWithoutCdk, { now });
  assert.equal(debugEvidence1.code, '');
  assert.equal(debugEvidence1.codeRenewal, false);
  assert.ok(debugEvidence1.needs.includes('充值码待核对'));

  const debugTaskEmptyCdk = { jobKey: 'debug-task-2', status: 'success', cdk: '   ', createdAt, cardLast4: '2345' };
  const debugEvidence2 = rechargeOrderEvidence(debugTaskEmptyCdk, { now });
  assert.equal(debugEvidence2.code, '');
  assert.equal(debugEvidence2.codeRenewal, false);
  assert.ok(debugEvidence2.needs.includes('充值码待核对'));

  const normalTask = { jobKey: 'real-cdk-task', status: 'success', cdk: 'VALID-CDK-CODE', createdAt, cardLast4: '2345' };
  const evidence = rechargeOrderEvidence(normalTask, {
    now,
    bills: [{
      cdk_code: 'VALID-CDK-CODE', email: 'user@example.test', status: 'success', plan_type: 'plus',
      payment_time: completedAt, stripe_session_id: 'session-real', card_last4: '2345'
    }],
    runtimeEntries: [{ source: 'task', text: '任务结束 status=success progress=100', jobKey: 'real-cdk-task', ts: Date.parse(completedAt) }]
  });
  assert.ok(evidence);
  assert.equal(evidence.code, 'VALID-CDK-CODE');
  assert.equal(evidence.rechargeCode, 'VALID-CDK-CODE');
  const order = buildRechargeOrder(evidence, {}, now);
  assert.equal(order.rechargeCode, 'VALID-CDK-CODE');
  assert.equal(order.email, 'user@example.test');
});

test('实时提交、后台补扫和管理员重读共用成功码准入，迟到回执仅入单一次', async t => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const since = Date.parse(createdAt) - 1000;
  store.saveFeatureDocument('order-sync', 0, { since, rows: [] });
  const tasks = [
    { ...session, jobKey: 'debug-marker', cdk: '[checkout-debug]' },
    { ...session, jobKey: 'debug-blank', cdk: '' },
    { ...session, jobKey: 'internal-product', cdk: 'ADMIN_PRODUCT_GEN:1' },
    { ...session, jobKey: 'manual-review', cdk: 'review-code', status: 'manual' },
    { ...session, jobKey: 'incomplete', cdk: 'incomplete-code', progress: 99 },
    { ...session, jobKey: 'duplicate-1', cdk: 'duplicate-code' },
    { ...session, jobKey: 'duplicate-2', cdk: 'duplicate-code' },
    { ...session, jobKey: 'wrong-job', cdk: 'wrong-job-code' },
    { ...session, jobKey: 'unknown-code', cdk: 'unknown-code' },
    session
  ];
  let poolReady = false, clock = now;
  const taskReads = [];
  const client = {
    async listCodes() {
      return [tasks[4], tasks[6]].map(task => usedRechargeCode(task)).concat([
        { ...usedRechargeCode(tasks[7]), session_job_key: 'different-job' },
        { ...usedRechargeCode(session), status: poolReady ? 'used' : 'processing' }
      ]);
    },
    async get(path) {
      if (path.includes('/task-logs/')) {
        const task = tasks.find(row => path.endsWith('/' + row.jobKey));
        taskReads.push(task.jobKey);
        return { task, runtimeEntries: [{ jobKey: task.jobKey, source: 'task',
          ts: Date.parse(completedAt), text: '任务结束 status=success progress=100' }] };
      }
      if (path.includes('/sessions?')) {
        const code = new URL(path, 'http://fixture.local').searchParams.get('search');
        return rechargeSessions(code ? tasks.filter(task => task.cdk === code) : tasks);
      }
      if (path.includes('/cards')) return { cards: [] };
      return { total: 1, records: [{ status: 'success', cdk_code: session.cdk, plan_type: 'plus',
        stripe_session_id: 'verified-fixture', email: 'recharge@example.test', payment_time: completedAt, card_last4: '2345' }] };
    }
  };
  const sync = createRechargeOrderSync({ store, client, background: true, clock: () => clock, publicOrigin: 'http://fixture.local' });
  for (const batch of [tasks.slice(0, 6), tasks.slice(6)])
    await sync.runCommitted({ apply: true, jobKeys: batch.map(task => task.jobKey) });
  assert.equal(store.load('commerce').data, null);
  const pending = Object.fromEntries(store.featureDocument('order-sync').data.rows.map(row => [row.jobKey, row]));
  for (const task of tasks.slice(0, 3)) assert.equal(pending[task.jobKey].excluded, true);
  assert.equal(pending['manual-review'], undefined);
  for (const task of [tasks[4], tasks[7], tasks[8], session])
    assert.deepEqual(pending[task.jobKey].needs, [rechargeAdmissionPending]);
  for (const task of tasks.slice(5, 7)) assert.deepEqual(pending[task.jobKey].needs, [rechargeAdmissionConflict]);
  poolReady = true;
  clock += 15 * 60_000;
  await sync.run({ apply: true });
  const response = { writeHead(status) { this.status = status; }, end(value) { this.body = JSON.parse(value); } };
  await sync.handle({ method: 'POST', headers: { origin: 'http://fixture.local' },
    async *[Symbol.asyncIterator]() { yield JSON.stringify({ mode: 'retry' }); }
  }, response, { role: 'admin' });
  assert.equal(response.status, 200);
  await sync.runCommitted({ apply: true, jobKeys: [session.jobKey, 'debug-marker'] });
  const commerce = store.load('commerce');
  assert.equal(commerce.data.orders.length, 1);
  const [order] = commerce.data.orders;
  assert.equal(order.taskId, session.jobKey);
  assert.equal(order.email, 'recharge@example.test');
  assert.equal(order.receiptConfirmed, false);
  assert.ok(subscriptionForOrder({ commerce, inventory: { data: null } }, order.id, now));
  assert.equal(taskReads.filter(key => key === 'debug-marker').length, 1);
});

test('订单写入事务拒绝伪造或冲突的充值码关联', t => {
  const store = createLocalBusinessStore(':memory:');
  t.after(() => store.close());
  const first = buildRechargeOrder({ jobKey: session.jobKey, rechargeCode: session.cdk }, {}, now);
  const entry = { since: now, row: { jobKey: session.jobKey, needs: [] }, order: first };
  assert.throws(() => store.applyRechargeOrder(entry), /缺少已核实/);
  assert.ok(store.applyRechargeOrder({ ...entry, admission: usedRechargeCode(session) }).orderNo);
  const duplicate = { ...session, jobKey: 'another-task', cdk: session.cdk.toUpperCase() };
  const result = store.applyRechargeOrder({ ...entry, row: { jobKey: duplicate.jobKey, needs: [] },
    admission: usedRechargeCode(duplicate),
    order: { ...first, taskId: duplicate.jobKey, rechargeCode: duplicate.cdk } });
  assert.deepEqual(result.needs, [rechargeAdmissionConflict]);
  assert.equal(result.orderNo, undefined);
  assert.equal(store.load('commerce').data.orders.length, 1);
});

import assert from 'node:assert/strict';
import test from 'node:test';
import { buildEmployeeStatistics, createEmployeeStatisticsHandler, employeeStatisticsRoute } from '../server/employee-statistics.mjs';
import { rechargeCodeItemId } from '../server/recharge-code-returns.mjs';

const now = Date.parse('2026-11-09T04:00:00Z');
const query = { date: '2026-11-09', kind: 'all', page: 1, pageSize: 10 };
const earlier = '2026-11-08 10:00';
const today = '2026-11-09 09:00';
const employee = { id: 'operator-a', name: '甲员工' };
const code = index => 'KC-' + String(index).padStart(28, 'A');

function sources() {
  return {
    employees: [employee, { id: 'operator-b', name: '乙员工' }],
    commerce: {
      orders: [
        { id: 'manual', orderNo: 'ORDER-1', createdById: employee.id, ownerId: 'operator-b',
          createdAt: '2026-11-08T16:00:00.000Z', cancelled: true },
        { id: 'last-day', createdById: employee.id, createdAt: '2026-11-08T15:59:59.999Z' },
        { id: 'draft', createdById: employee.id, createdAt: today, draft: true },
        { id: 'synced', orderNo: 'ORDER-2', source: '线上代充', taskId: 'job-2',
          createdById: employee.id, createdAt: today, rechargeCompletedAt: '2026-11-09T01:01:00Z' }
      ],
      customers: [{ id: 'customer', createdById: employee.id, createdAt: today },
        { id: 'unattributed-customer', createdAt: today }, { id: 'old', createdById: employee.id, updatedAt: today }]
    },
    inventory: {
      mailboxes: [{ id: 'mail-a', createdById: employee.id, createdAt: today, email: 'alice@example.test', password: 'fixture-password',
        claimId: 'claim-mail-a', claimBatchId: 'batch-mail' }],
      accounts: [{ id: 'account-a', createdById: employee.id, createdAt: today, email: 'bob@example.test' }],
      batches: [
        { id: 'batch-mail', kind: 'mail', actorId: 'former', actorName: '历史领用人', time: earlier,
          items: [{ id: 'claim-mail-a', assetId: 'mail-a', status: 'pending', claimedAt: earlier }] },
        { id: 'batch-account', kind: 'account', actorId: employee.id, time: today,
          items: [{ id: 'used-a', assetId: 'account-a', status: 'used', usedAt: today, orderId: 'manual' },
            { id: 'returned-a', assetId: 'account-old', status: 'abnormal', returnedAt: today, claimedAt: earlier }] }
      ]
    },
    requests: [
      { id: 'code-batch', status: 'issued', plan: 'plus', applicantId: employee.id, issuedAt: '2026-11-08T02:00:00Z',
        codes: [1, 2, 3, 4, 5, 6, 7].map(code),
        returns: [
          { itemId: rechargeCodeItemId('code-batch', code(3)), state: 'returned', returnedAt: '2026-11-09T01:05:00Z' },
          { itemId: rechargeCodeItemId('code-batch', code(4)), state: 'pending', startedAt: '2026-11-09T00:00:00Z' }
        ] },
      { id: 'issued-today', status: 'issued', plan: 'plus', applicantId: employee.id, createdAt: earlier,
        issuedAt: '2026-11-09T01:00:00Z', codes: [code(8), code(8)] },
      { id: 'requested', status: 'issuing', applicantId: employee.id, createdAt: today, codes: [code(9)] }
    ],
    nativeCodes: [
      { code: code(1), status: 'unused', shipped: false }, { code: code(2), status: 'used',
        used_at: '2026-11-9 09:00:00', session_job_key: 'job-2' },
      { code: code(5), status: 'unused', shipped: true }, { code: code(6), status: 'processing' },
      { code: code(8), status: 'used', used_at: '2026-11-9 10:00:00' }
    ].map(row => ({ ...row, type: '自助', plan_type: 'plus' }))
  };
}

test('按北京时间和实际操作人统计，未结资产跨日继续归原领用人', () => {
  const snapshot = buildEmployeeStatistics(sources(), query, now);
  const people = new Map(snapshot.items.map(row => [row.id, row]));
  assert.deepEqual(people.get(employee.id).counts, {
    orders: 1, cancelledOrders: 1, syncedOrders: 1, customers: 1, undated: 2,
    submittedMail: 1, submittedAccounts: 1, extractedAccounts: 1, used: 2, returned: 2,
    unusedCodes: 1, overdue: 1, returningCodes: 1, deliveredCodes: 1, processingCodes: 1,
    review: 1, issuedCodes: 1, pendingCodeRequests: 1
  });
  assert.equal(people.get(employee.id).unverifiedCodes, 1);
  assert.equal(people.get(employee.id).useTimeUnverified, 1);
  assert.deepEqual(people.get('operator-b').counts, {});
  assert.deepEqual(people.get('former').counts, { openMail: 1, overdue: 1 });
  assert.equal(people.get('former').name, '历史领用人');
  assert.equal(people.get('unattributed').counts.customers, 1);
  const yesterday = buildEmployeeStatistics(sources(), { ...query, date: '2026-11-08' }, now);
  assert.equal(yesterday.items.find(row => row.id === 'former').counts.extractedMail, 1);
  assert.equal(yesterday.items.find(row => row.id === employee.id).counts.issuedCodes, 7);
});

test('上游不可读时保留确认发放和作废回执，未用数量留待核对', () => {
  const data = { ...sources(), nativeCodes: null };
  const snapshot = buildEmployeeStatistics(data, { ...query, kind: 'code' }, now);
  assert.equal(snapshot.codeSourceAvailable, false);
  const row = snapshot.items.find(row => row.id === employee.id);
  assert.equal(row.counts.issuedCodes, 1);
  assert.equal(row.counts.returned, 1);
  assert.equal(row.counts.unusedCodes, undefined);
  assert.equal(row.unverifiedCodes, 6);
  assert.equal(row.counts.review, 6);
  assert.equal(row.counts.returningCodes, 1);
});

test('明细按员工和指标分页，接口输出脱敏字段', () => {
  const data = sources();
  const original = data.inventory.mailboxes[0];
  data.inventory.mailboxes.push(...Array.from({ length: 12 }, (_, index) => ({
    ...original, id: 'mail-' + index
  })));
  const { items, total, page } = buildEmployeeStatistics(data, {
    ...query, kind: 'mail', metric: 'submittedMail', employee: employee.id, page: 9
  }, now);
  assert.equal(total, 13);
  assert.equal(page, 2);
  assert.equal(items.length, 3);
  assert(items.every(row => row.subject === 'a***@example.test'));
  assert(!JSON.stringify(items).includes(original.password));
  assert(!JSON.stringify(items).includes(original.email));
  const codeDetails = buildEmployeeStatistics(data, {
    ...query, kind: 'code', metric: 'unusedCodes', employee: employee.id
  }, now);
  assert.equal(codeDetails.total, 1);
  assert.equal(codeDetails.items[0].batch, 'PO000001');
  assert.equal(codeDetails.items[0].reference, 'PO000001-01');
  assert.equal(codeDetails.items[0].id, rechargeCodeItemId('code-batch', code(1)));
  assert(!JSON.stringify(codeDetails).includes(code(1)));
});

test('统计入口仅管理员可读，校验日期、权限及筛选后才读取来源', async () => {
  const data = sources();
  let reads = 0;
  const handler = createEmployeeStatisticsHandler({
    clock: () => now,
    readEmployees: () => data.employees,
    store: {
      load(domain) { reads++; return { data: data[domain] }; },
      featureDocument() { return { data: { requests: data.requests } }; }
    },
    client: { listCodes() { throw new Error('synthetic unavailable'); } },
    publicOrigin: 'https://employee-statistics.test'
  });
  async function request(actor, suffix = '', options = {}) {
    const received = {};
    await handler({ method: 'GET', url: employeeStatisticsRoute + suffix, headers: {}, ...options }, {
      writeHead(status, headers) { Object.assign(received, { status, headers }); },
      setHeader() {},
      end(body) { received.body = JSON.parse(body); }
    }, actor);
    return received;
  }
  const admin = { ...employee, role: 'admin' };
  assert.equal((await request(null)).status, 401);
  assert.equal((await request({ ...employee, role: 'employee' })).status, 403);
  assert.equal((await request(admin, '', { method: 'POST' })).status, 405);
  assert.equal((await request(admin, '', { headers: { origin: 'https://unrelated.test' } })).status, 403);
  assert.equal((await request(admin, '?date=2026-02-30')).status, 400);
  assert.equal((await request(admin, '?date=2026-11-10')).status, 400);
  assert.equal((await request(admin, '?metric=unusedCodes')).status, 400);
  assert.equal(reads, 0);
  const received = await request(admin);
  assert.equal(received.status, 200);
  assert.equal(received.headers['Cache-Control'], 'private, no-store');
  assert.equal(received.body.date, '2026-11-09');
  assert.equal(received.body.codeSourceAvailable, false);
  assert.equal(reads, 2);
});

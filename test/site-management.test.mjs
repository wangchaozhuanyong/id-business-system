import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { PassThrough } from 'node:stream';
import test from 'node:test';
import { createSiteManagement, siteBackupView, siteDataIssues } from '../server/site-management.mjs';
import { createSiteObservations, measuredActivity } from '../server/site-observations.mjs';

const origin = 'https://id.example.test';
const path = '/api/local/site-management';
const at = Date.parse('2026-11-13T04:30:00Z');
const revision = 'f'.repeat(40);
const admin = { id: 'fixture-admin', role: 'admin' }, employee = { id: 'fixture-employee', role: 'employee' };
const minute = 60_000;

function requestCapture() {
  const response = new EventEmitter();
  const headers = {};
  response.setHeader = (key, value) => { headers[key] = value; };
  return { response, headers };
}

test('keeps page and server measurements separate and never stores raw fields', async () => {
  const data = await createSiteObservations({ version: revision, clock: () => at });
  assert.equal(measuredActivity('/api/local/commerce', 'GET'), undefined);
  assert.equal(measuredActivity('/api/local/commerce', 'GET', 'order-list'), 'order-list');
  assert.equal(measuredActivity('/api/local/batch', 'PUT', 'order-save'), 'order-save');
  assert.equal(measuredActivity('/api/local/renewals', 'POST', 'order-save'), 'order-save');
  assert.equal(measuredActivity('/api/local/renewals', 'POST'), undefined);
  assert.equal(measuredActivity('/api/local/private', 'PUT', 'order-save'), undefined);
  for (let i = 0; i < 21; i++) {
    const { response, headers } = requestCapture();
    data.request(response, 'order-list', employee.id);
    response.statusCode = 200;
    response.emit('finish');
    const sample = { id: headers['X-ID-Diagnostic'], activity: 'order-list', result: 'ok', elapsed: i === 20 ? 3500 : 650 };
    assert.equal(data.sample(sample, 'someone-else'), false);
    assert.equal(data.sample(sample, employee.id), true);
    assert.equal(data.sample(sample, employee.id), false);
  }
  const bad = requestCapture();
  data.request(bad.response, 'order-save', employee.id);
  bad.response.statusCode = 503;
  bad.response.emit('finish');
  const id = bad.headers['X-ID-Diagnostic'];
  assert.equal(data.sample({ id, activity: 'order-save', result: 'failed', elapsed: 111, data: 'private form' }, employee.id), false);
  assert.equal(data.sample({ id, activity: 'order-save', result: 'failed', elapsed: 111 }, employee.id), true);
  assert.equal(data.sample({ id: randomUUID(), activity: 'login', result: 'ok', elapsed: 1 }), false);
  const login = requestCapture();
  data.request(login.response, 'login');
  login.response.statusCode = 401;
  login.response.emit('finish');
  assert.equal(data.sample({ id: login.headers['X-ID-Diagnostic'], activity: 'login', result: 'blocked', elapsed: 111 }), true);
  const report = data.performanceView(24);
  assert.equal(report.groups.browser.p95, 750);
  assert.ok(report.groups.server.p95 < report.groups.browser.p95);
  assert.equal(report.groups.browser.failed, 1);
  assert.equal(report.groups.browser.blocked, 1);
  assert.equal(report.groups.browser.activities.find(row => row.activity === 'order-save').p95, null);
  assert.equal(report.groups.browser.trend.at(-1).total, 23);
  assert.equal(data.performanceView(168).groups.browser.trend.length, 7);
  assert.deepEqual(data.diagnostic(id), { id, at, activity: 'order-save', result: 'failed', channel: 'server', version: revision });
  assert.deepEqual(data.resourceView().latest, null);
  const previous = data.resourceVersionOf();
  await data.collect(37);
  assert.equal(data.resourceView().trend.at(-1).disk, 37);
  assert.notEqual(data.resourceVersionOf(), previous);
});

test('identifies duplicate upstream orders and broken links without flagging blank optional values', () => {
  const orders = [
    { id: 'order-a', orderNo: 'OD-LOCAL-0001', taskId: 'private-origin', source: '线上代充', product: 'GPT',
      createdAt: '2026-11-13 11:00', customerId: 'missing-a', accountId: 'missing-b', accountSource: '库存', notes: 'private' },
    { id: 'order-b', orderNo: 'OD-LOCAL-0002', taskId: 'private-origin', source: '线上代充', product: 'GPT',
      createdAt: '2026-11-13 10:00', tenantId: 'missing-c' },
    { id: 'order-c', orderNo: 'OD-LOCAL-0003', product: 'GPT', accountId: '', tenantId: '', customerId: '' },
    { id: 'order-d', draft: true, customerId: 'draft-only' }
  ];
  const sync = { rows: [{ jobKey: 'no-order', orderNo: 'OD-LOCAL-0008', checkedAt: at },
    { jobKey: 'not-imported', needs: ['待处理'] }] };
  const result = siteDataIssues({ orders }, { accounts: [] }, sync);
  assert.equal(result.total, 6);
  assert.equal(result.items.filter(row => row.type === 'duplicate').length, 2);
  assert.equal(result.items[0].orderNo, 'OD-LOCAL-0008');
  assert.ok(result.items.every(row => !['order-c', 'order-d'].includes(row.orderId)));
  assert.ok(!JSON.stringify(result).includes('private-origin'));
  assert.equal(siteDataIssues({ orders }, null, sync, { kind: 'inventory' }).total, 0);
  assert.equal(siteDataIssues({ orders }, null, sync).coverage.inventory, false);
});

test('latest verified backup and a separate passed restore are displayed independently', () => {
  const capture = at - 12 * minute;
  const report = { at: at - minute, drive: { at: at - minute, verifiedAt: at - 10 * minute,
    failures: 0, integrityFailure: false }, mysql: { capturedAt: capture, verifiedAt: at - 11 * minute },
    mysqlTimerActive: true, mysqlAttemptFailed: false };
  const restore = { version: 1, database: 'recharge', result: 'passed', isolated: true, capturedAt: capture,
    finishedAt: at - 2 * minute, durationMs: 11_000, checkedRecords: 3 };
  let { databases } = siteBackupView(report, { recharge: restore }, at);
  assert.equal(databases[0].state, 'verified');
  assert.equal(databases[0].capturedAt, null);
  assert.equal(databases[0].exercise, null);
  assert.equal(databases[1].exercise.durationMs, 11_000);
  databases = siteBackupView({ ...report, at: at - 4 * minute, drive: { ...report.drive, capturedAt: capture } },
    { recharge: { ...restore, isolated: false } }, at).databases;
  assert.equal(databases[0].state, 'unknown');
  assert.equal(databases[0].capturedAt, capture);
  assert.equal(databases[1].exercise, null);
});

async function reply(handle, { url = path, body, method = 'GET', actor, id, headers = {} }) {
  const req = new PassThrough();
  Object.assign(req, { url, method, headers: { host: new URL(origin).host, origin, 'sec-fetch-site': 'same-origin',
    'content-type': 'application/json', 'x-id-operation': id, ...headers } });
  req.end(body === undefined ? undefined : JSON.stringify(body));
  let code, headersOut, value;
  await handle(req, { writeHead(status, values) { code = status; headersOut = values; return this; },
    end(body) { value = body; } }, actor);
  return { code, headers: headersOut, value };
}

test('protects administrative data and exports the filtered redacted snapshot with an audit receipt', async () => {
  const receipts = new Map();
  const handler = createSiteManagement({ store: {
    load: () => ({ data: { customers: [
      { id: 'customer-a', name: '张三', active: true, phone: '9012345678', notes: 'private', createdAt: '2026-11-12T16:02:00Z' },
      { id: 'customer-b', name: '李四', active: false, createdAt: '2026-11-13T16:00:00Z' }
    ] } }),
    recordSiteExport(actor, operation, label) {
      assert.equal(actor.id, admin.id);
      receipts.set(operation.domain, label);
    }
  }, observations: { diagnostic: () => null }, origin, official: true,
  release: { version: revision, updatedAt: at - 4000 }, clock: () => at });
  assert.equal((await reply(handler, { url: path + '?view=information' })).code, 401);
  assert.equal((await reply(handler, { url: path + '?view=information', actor: employee })).code, 403);
  const info = await reply(handler, { url: path + '?view=information', actor: admin });
  assert.deepEqual(JSON.parse(info.value), { official: true, domain: 'id.example.test',
    timeZone: '北京时间（UTC+8）', version: revision, updatedAt: at - 4000 });
  const exp = { url: path + '/export', method: 'POST', body: { collection: 'customers', start: '2026-11-13',
    end: '2026-11-13', status: 'active' }, id: randomUUID() };
  assert.equal((await reply(handler, { ...exp, actor: employee })).code, 403);
  assert.equal((await reply(handler, { ...exp, actor: admin, headers: { origin: 'https://other.test' } })).code, 403);
  assert.equal((await reply(handler, { ...exp, actor: admin, body: { ...exp.body, end: '2026-11-31' } })).code, 400);
  const file = await reply(handler, { ...exp, actor: admin });
  assert.equal(file.code, 200);
  assert.equal(file.headers['X-ID-Export-Count'], '1');
  assert.match(file.value, /customer-a.*张＊＊.*2026-11-13/);
  assert.doesNotMatch(file.value, /三|customer-b|9012345678|private/);
  assert.match([...receipts.values()][0], /2026-11-13 至 2026-11-13.*使用中.*1 条/);
});

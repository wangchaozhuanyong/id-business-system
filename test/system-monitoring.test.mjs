import assert from 'node:assert/strict';
import { Readable, Writable } from 'node:stream';
import { once } from 'node:events';
import httpModule from 'node:http';
import { syncBuiltinESMExports } from 'node:module';
import test from 'node:test';
import { createSystemMonitoring } from '../server/system-monitoring.mjs';
import { createLegacyRechargeNotifications, projectRechargeMonitoring } from '../server/monitoring-recharge.mjs';
import { createMonitoringSources } from '../server/monitoring-sources.mjs';
import { createMonitoringHandler, createMonitoringReadiness, createProbeReportHandler, signMonitoringReport } from '../server/monitoring-route.mjs';
import { monitorPath, monitorReportPath, readyPath, sendTelegram } from '../server/monitoring-policy.mjs';
import { advanceSiteProbe, runSiteProbeCycle } from '../server/monitoring-site-probe.mjs';
import { createCodexdaichongGateway, CODEXDAICHONG_PREFIX } from '../modules/recharge/codexdaichong/gateway.mjs';

const origin = 'https://monitoring.example.test';
const token = '123456:' + 'fixture-token-material-for-unit-tests';
const ops = '-100999001', security = '999002', group = '-100999003';
const supervisor = { id: 'fixture-super', name: '合成管理员', role: 'super' };
const admin = { ...supervisor, role: 'admin' };
const now = Date.parse('2026-11-10T02:00:00Z');
const minute = 60_000;
const probeSecret = 'synthetic-monitor-probe-key-for-tests';
const fixtureError = (status, message) => Object.assign(new Error(message), { status });

function fixture(t, options = {}) {
  let at = now;
  const documents = new Map(), audit = [], sent = [];
  const store = {
    featureDocument: key => structuredClone(documents.get(key) || { version: 0, data: null }),
    saveFeatureDocument(key, version, data, metadata) {
      if (version !== (documents.get(key)?.version ?? 0)) throw fixtureError(409, 'fixture conflict');
      if (metadata) audit.push(structuredClone(metadata));
      documents.set(key, structuredClone({ version: version + 1, data }));
      return store.featureDocument(key);
    }
  };
  const monitor = createSystemMonitoring({ store, origin, clock: () => at, native: options.native,
    async send(input) {
      sent.push(input);
      return options.send ? options.send(input, sent.length) : { status: 'accepted', messageId: sent.length };
    }
  });
  t.after(() => monitor.close());
  return { monitor, store, audit, sent, tick(ms = minute) { at += ms; return at; }, clock: () => at };
}

async function enable(f, channels = { operations: ops, security }) {
  const { monitor, tick } = f;
  monitor.save(0, { enabled: false, token, channels, rules: {} }, supervisor);
  for (const target of Object.keys(channels)) {
    monitor.queueTest(monitor.configView().version, target, supervisor);
    assert.equal(await monitor.dispatch(), true);
    tick(1000);
  }
  monitor.save(monitor.configView().version, { enabled: true, channels: {}, rules: { channel_change: false } }, supervisor);
}

test('requires a test receipt for the current binding, keeps secrets write-only, and checks config version', async t => {
  const f = fixture(t);
  const { monitor, audit, tick } = f;
  monitor.save(0, { enabled: false, token, channels: { operations: ops }, rules: {} }, supervisor);
  const configuration = { enabled: true, channels: {}, rules: {} };
  assert.throws(() => monitor.save(0, configuration, supervisor), { status: 409 });
  assert.throws(() => monitor.save(1, configuration, supervisor), { status: 422 });
  assert.throws(() => monitor.save(1, { ...configuration, enabled: false, channels: { rechargeGroup: ops } }, supervisor),
    { status: 422 });
  monitor.queueTest(1, 'operations', supervisor);
  assert.equal(monitor.configView().channels.operations.verified, false);
  assert.equal(await monitor.dispatch(), true);
  assert.equal(monitor.configView().channels.operations.verified, true);
  monitor.save(1, configuration, supervisor);
  assert.equal(monitor.configView().enabled, true);
  assert.equal(monitor.view({ tab: 'deliveries' }).items[0].messageId, 1);
  const safe = JSON.stringify([monitor.configView(), monitor.view(), monitor.view({ tab: 'deliveries' }), audit]);
  for (const value of [token, ops]) assert.equal(safe.includes(value), false);
  tick();
  monitor.save(2, { enabled: false, channels: { operations: '-100999004' }, rules: {} }, supervisor);
  assert.equal(monitor.configView().channels.operations.verified, false);
  assert.throws(() => monitor.save(3, configuration, supervisor), { status: 422 });
});

test('opens a sustained incident once, coalesces counts, and separates acceptance, acknowledgement and recovery', async t => {
  const f = fixture(t);
  await enable(f);
  const { monitor, sent, tick, audit } = f;
  const sample = (status, count) => monitor.observe([{ code: 'recharge_runtime', status, count }]);
  sample('bad', 1); tick(); sample('bad', 2);
  assert.equal(monitor.view().items.some(row => row.label === '代充执行器不可用'), false);
  tick(); sample('bad', 3);
  const opened = monitor.view().items.find(row => row.label === '代充执行器不可用');
  assert.equal(opened.accepted, false);
  assert.equal(await monitor.dispatch(), true);
  tick(); sample('bad', 4);
  const updated = monitor.view().items.find(row => row.id === opened.id);
  assert.equal(updated.count, 4);
  assert.equal(updated.accepted, true);
  monitor.acknowledge(opened.id, admin);
  monitor.acknowledge(opened.id, admin);
  assert.equal(audit.filter(row => row.action === 'monitor_acknowledge').length, 1);
  assert.equal(monitor.activeCount(), 1);
  tick(); sample('unknown');
  assert.equal(monitor.view({ status: 'resolved' }).total, 0);
  tick(); sample('ok'); tick(); sample('ok');
  assert.equal(monitor.view({ status: 'resolved' }).items[0].id, opened.id);
  assert.equal(monitor.activeCount(), 0);
  assert.equal(await monitor.dispatch(), true);
  assert.equal(sent.filter(row => row.text.includes(opened.id)).length, 2);
  assert.match(sent.at(-1).text, /已恢复/);
});

test('respects Telegram retry-after, records ambiguous outcomes, and avoids replay or a stale target', async t => {
  const f = fixture(t, { send(input, count) {
    if (count === 2) return { status: 'retry', delay: 10_000 };
    if (count === 3) return { status: 'unknown', reason: 'unconfirmed' };
    return { status: 'accepted', messageId: count };
  } });
  await enable(f, { operations: ops });
  const { monitor, sent, tick } = f;
  monitor.observe([{ code: 'backup', status: 'bad' }]);
  assert.equal(await monitor.dispatch(), true);
  tick(9999); assert.equal(await monitor.dispatch(), false);
  tick(1); assert.equal(await monitor.dispatch(), true);
  tick(minute); assert.equal(await monitor.dispatch(), false);
  assert.equal(sent.length, 3);
  assert.equal(monitor.view({ tab: 'deliveries', status: 'unknown' }).items[0].attempts, 2);
  monitor.observe([{ code: 'sheets', status: 'bad' }]);
  monitor.save(monitor.configView().version, { enabled: false, channels: { operations: '-100999004' }, rules: {} }, supervisor);
  assert.equal(await monitor.dispatch(), false);
  assert.equal(monitor.view({ tab: 'deliveries', status: 'cancelled' }).total, 1);
});

test('legacy handoff stages the same event switches and destinations and reconciles an ambiguous write', async t => {
  const telegram = { bot_token: 'masked…', admin_chat_id: security, group_chat_id: group,
    notify_admin: true, notify_group: true, on_success: true, on_failure: false, on_card_pool_empty: true };
  let idle = false, writes = 0;
  const native = createLegacyRechargeNotifications({
    async readLegacyNotificationSettings() {
      return { telegram: { ...telegram }, config: { maintenance_mode: idle }, runtime: { active_activation_jobs: 0 },
        stats: { running: 0 } };
    },
    async disableLegacyBusinessNotifications(snapshot) {
      writes++;
      assert.equal(snapshot.adminChat, security);
      assert.equal(snapshot.groupChat, group);
      assert.equal(snapshot.notifyAdmin, true);
      assert.equal(snapshot.notifyGroup, true);
      assert.equal(JSON.stringify(snapshot).includes('masked'), false);
      Object.assign(telegram, { on_success: false, on_failure: false, on_card_pool_empty: false });
      throw new Error('simulated lost response after apply');
    }
  });
  const f = fixture(t, { native });
  const { monitor, tick, sent } = f;
  monitor.save(0, { enabled: false, token, channels: {}, rules: {} }, supervisor);
  await monitor.importLegacy(1, supervisor);
  assert.equal(monitor.legacyLocked(), false);
  monitor.queueTest(2, 'rechargeAdmin', supervisor);
  assert.equal(await monitor.dispatch(), true);
  tick(1000);
  monitor.queueTest(2, 'rechargeGroup', supervisor);
  assert.equal(await monitor.dispatch(), true);
  tick(1000);
  monitor.save(2, { enabled: true, channels: {}, rules: {} }, supervisor);
  monitor.observe([{ code: 'recharge_success', status: 'bad', scope: 'pre-cutover' }]);
  assert.equal(sent.length, 2);
  await assert.rejects(monitor.takeOver(3, supervisor), { status: 409 });
  assert.equal(writes, 0);
  idle = true;
  await assert.rejects(monitor.takeOver(3, supervisor), { status: 503 });
  assert.equal(monitor.legacyLocked(), true);
  assert.equal(monitor.configView().legacy.phase, 'switching');
  await monitor.takeOver(4, supervisor);
  assert.equal(writes, 1);
  assert.equal(monitor.configView().legacy.phase, 'managed');
  assert.deepEqual(telegram, { bot_token: 'masked…', admin_chat_id: security, group_chat_id: group,
    notify_admin: true, notify_group: true, on_success: false, on_failure: false, on_card_pool_empty: false });
  tick();
  monitor.observe([{ code: 'recharge_success', status: 'bad', scope: 'id-task-confirmed' },
    { code: 'recharge_failure', status: 'bad', scope: 'id-task-declined' }]);
  await monitor.dispatch(); tick(1000); await monitor.dispatch();
  assert.deepEqual(new Set(sent.slice(2).map(row => row.chatId)), new Set([security, group]));
  assert(sent.slice(2).every(row => row.text.includes('确认成功') && !row.text.includes('id-task-confirmed')));
});

test('moving a single destination preserves verified bindings for the other channels', async t => {
  const f = fixture(t);
  await enable(f);
  const { monitor } = f;
  monitor.save(monitor.configView().version, { enabled: true, channels: { security: '999103' }, rules: {} }, supervisor);
  const { channels, enabled } = monitor.configView();
  assert.equal(enabled, true);
  assert.equal(channels.security.verified, false);
  assert.equal(channels.operations.verified, true);
});

test('gateway locks the legacy sender after handoff and observes only confirmed resource refusals', async t => {
  let requests = 0;
  let responseStatus = 409;
  let body = { success: false, code: 'recharge_route_unavailable', execution_started: false, message: '合成线路拒绝' };
  const transport = t.mock.method(httpModule, 'request', (_, callback) => {
    requests++;
    const request = new Writable({ write(chunk, encoding, done) { done(); } });
    request.setTimeout = () => {};
    queueMicrotask(() => callback(Object.assign(Readable.from([Buffer.from(JSON.stringify(body))]),
      { statusCode: responseStatus, headers: { 'content-type': 'application/json' } })));
    return request;
  });
  syncBuiltinESMExports();
  t.after(() => { transport.mock.restore(); syncBuiltinESMExports(); });
  const outcomes = [];
  const gateway = createCodexdaichongGateway({ upstreamUrl: 'http://127.0.0.1:32002', publicOrigin: origin,
    secret: probeSecret, legacyNotificationLocked: () => true, onRechargeOutcome: value => outcomes.push(value),
    getUnifiedPrincipal: () => ({ id: 'fixture-user', email: 'fixture@example.test', admin: true, sensitive: true }) });
  async function invoke(path) {
    const request = Object.assign(Readable.from([Buffer.from('{}')]),
      { url: CODEXDAICHONG_PREFIX + path, method: 'POST', headers: { origin }, socket: {} });
    let status;
    const response = new Writable({ write(chunk, encoding, done) { done(); } });
    response.writeHead = value => { status = value; return response; };
    const finished = once(response, 'finish');
    await gateway.handle(request, response);
    await finished;
    return status;
  }
  assert.equal(await invoke('/api/admin/telegram/test'), 409);
  assert.equal(requests, 0);
  assert.equal(await invoke('/api/run-process'), 409);
  body = { success: false, message: '任意错误中的卡池文案' };
  responseStatus = 503;
  assert.equal(await invoke('/api/run-process'), 503);
  body.message = '银行卡池暂无可用卡片，请先在后台「银行卡池」导入银行卡后再试';
  assert.equal(await invoke('/api/run-process'), 503);
  assert.deepEqual(outcomes, ['recharge_route', 'recharge_cards']);
});

test('projects only pinned recharge evidence and does not backfill the pre-cutover success cohort', () => {
  const raw = { token: 'synthetic-private', phone: '00000000000', cdk: 'synthetic-redeem' };
  const rows = [
    { ...raw, jobKey: 'old-success', time: '2026/11/10 09:48:00', status: 'success' },
    { ...raw, jobKey: 'new-success', time: '2026/11/10 09:59:00', status: 'success' },
    { ...raw, jobKey: 'review-job', time: '2026/11/10 09:58:00', status: 'manual',
      message: '付款结果待核实，已转人工确认，请勿重复充值，请联系客服处理。' },
    { ...raw, jobKey: 'generic-manual', time: '2026/11/10 09:57:00', status: 'manual',
      message: '已转人工确认，请联系客服处理后再试' }
  ];
  const result = projectRechargeMonitoring(rows, now, now - 10 * minute);
  assert.deepEqual(result.samples.filter(row => row.code === 'recharge_success').map(row => row.scope), ['new-success']);
  assert.deepEqual(result.samples.filter(row => row.code === 'recharge_review' && row.status === 'bad')
    .map(row => row.scope), ['review-job']);
  assert.equal(result.samples.some(row => row.code === 'recharge_failure'), false);
  assert.equal(JSON.stringify(result).includes('synthetic'), false);
});

async function http(handler, { url = monitorPath, method = 'GET', body, headers = {}, actor = supervisor } = {}) {
  const source = body === undefined ? [] : [Buffer.from(typeof body === 'string' ? body : JSON.stringify(body))];
  const request = Object.assign(Readable.from(source), { url, method, headers: { host: 'monitoring.example.test', ...headers } });
  const result = {};
  await handler(request, {
    writeHead(status, responseHeaders) { Object.assign(result, { status, headers: responseHeaders }); return this; },
    end(body) { if (body !== undefined) result.body = body; return this; }
  }, actor);
  return result;
}

test('monitor APIs enforce roles, same-origin writes, and explicit verified evidence', async t => {
  const { monitor } = fixture(t);
  const handler = createMonitoringHandler({ monitor, publicOrigin: origin });
  const config = monitorPath + '?tab=config';
  assert.equal((await http(handler, { url: config, actor: null })).status, 401);
  assert.equal((await http(handler, { url: config, actor: admin })).status, 403);
  assert.equal((await http(handler, { actor: { ...admin, role: 'employee' } })).status, 403);
  const initial = await http(handler, { actor: admin });
  assert.equal(initial.status, 200);
  assert.equal(JSON.parse(initial.body).pageSize, 20);
  assert.equal(JSON.parse((await http(handler, { url: monitorPath + '?tab=incidents&page=2&pageSize=10', actor: admin })).body).pageSize, 10);
  assert.equal(JSON.parse((await http(handler, { url: monitorPath + '?tab=deliveries&pageSize=50' })).body).pageSize, 50);
  assert.equal((await http(handler, { url: monitorPath + '?pageSize=100' })).status, 400);
  assert.equal((await http(handler, { url: monitorPath + '?pageSize=10&pageSize=20' })).status, 400);
  const body = { action: 'verified', code: 'payment_duplicate', reference: '12345678-1234-1234-1234-123456789abc' };
  const headers = { origin, 'content-type': 'application/json' };
  assert.equal((await http(handler, { method: 'POST', body, headers: { ...headers, origin: 'https://unrelated.test' } })).status, 403);
  assert.equal((await http(handler, { method: 'POST', body, headers, actor: admin })).status, 403);
  assert.equal(JSON.parse((await http(handler, { method: 'POST', body, headers })).body).recorded, true);
  assert.equal(JSON.parse((await http(handler, { method: 'POST', body, headers })).body).recorded, false);
  assert.equal(monitor.view().items[0].priority, 'P0');
});

test('standalone readiness and HMAC probe receipt require observed evidence and preserve the external acceptance', async t => {
  const { monitor, tick, clock } = fixture(t);
  const ready = createMonitoringReadiness({ check: () => clock() > now, clock });
  assert.equal((await http(ready, { url: readyPath })).status, 503);
  tick(5000);
  assert.equal((await http(ready, { url: readyPath })).body, 'id-business-ready\n');
  assert.equal((await http(ready, { url: readyPath + '?extra=1' })).status, 404);
  const handler = createProbeReportHandler({ monitor, secret: probeSecret, clock });
  const probeId = '12345678-1234-1234-1234-123456789def';
  const report = JSON.stringify({ at: clock(), status: 'ok', certificateDays: 3,
    incident: { id: probeId, at: now - minute, recoveredAt: now, accepted: true } });
  const headers = { 'content-type': 'application/json', 'x-id-probe-signature': signMonitoringReport(probeSecret, report) };
  assert.equal((await http(handler, { url: monitorReportPath, method: 'POST', body: report + ' ', headers })).status, 403);
  assert.equal((await http(handler, { url: monitorReportPath, method: 'POST', body: report, headers })).status, 204);
  assert.equal((await http(handler, { url: monitorReportPath, method: 'POST', body: report, headers })).status, 204);
  const { items } = monitor.view({ status: 'resolved' });
  assert.equal(items.length, 1);
  assert.equal(items[0].id, probeId);
  assert.equal(items[0].accepted, true);
  assert.equal(items[0].external, true);
  assert.equal(monitor.view({ tab: 'deliveries' }).total, 0);
});

test('off-site probe can notify during host outage and reports a single recovery after two valid checks', async () => {
  let at = now;
  let state;
  const sent = [], reports = [];
  for (const status of ['bad', 'bad', 'bad', 'bad', 'ok', 'ok', 'ok']) {
    at += minute;
    state = await runSiteProbeCycle({ origin, token, chatId: ops, secret: probeSecret, previous: state,
      clock: () => at, persist: async () => {}, check: async () => ({ status, certificateDays: null }),
      send: async input => { sent.push(input.text); return { status: 'accepted' }; },
      fetchImpl: async (_, input) => {
        assert.equal(input.headers['X-ID-Probe-Signature'], signMonitoringReport(probeSecret, input.body));
        if (status === 'bad') throw new Error('fixture down');
        reports.push(JSON.parse(input.body));
        return new Response(null, { status: 204 });
      }
    });
  }
  assert.equal(sent.length, 2);
  assert.match(sent[0], /紧急/);
  assert.match(sent[1], /已恢复/);
  assert.equal(reports[1].incident.accepted, true);
  assert.equal(reports[2].incident, undefined);
  assert.equal(advanceSiteProbe({ status: 'bad', streak: 2, at: now }, { status: 'bad' }, now + 5 * minute).incident, undefined);
});

test('probe keeps an outage with an unacknowledged report across a subsequent outage', () => {
  const first = { at: now - 6 * minute, recoveredAt: now - 3 * minute,
    opened: { status: 'accepted' }, recovered: { status: 'accepted' } };
  const next = advanceSiteProbe({ status: 'bad', streak: 2, at: now - minute, incident: first },
    { status: 'bad' }, now);
  assert.equal(next.incident.at, now);
  assert.deepEqual(next.backlog, [first]);
});
test('collects verified sources and treats missing reports or disabled jobs as distinct states', async t => {
  const f = fixture(t);
  const { monitor, clock, tick } = f;
  const sources = createMonitoringSources({ monitor, databasePath: '/fixture/local-business.sqlite', clock,
    workerReceiptDirectory: '/fixture/monitoring-receipts',
    externalProbe: true, runtimeProbe: async () => ({ ready: true }),
    rechargeClient: { async get() { return { tasks: [] }; } },
    readDisk: async () => ({ blocks: 100, bavail: 5 }),
    readReceipt: async (directory, name) => {
      assert.equal(directory, '/fixture/monitoring-receipts');
      return name === 'backup' ? { at: clock(), failures: 0, integrityFailure: true } : null;
    }
  });
  t.after(() => sources.close());
  for (let index = 0; index < 5; index++) sources.recordAuth({ kind: 'rejected', accountKey: 'synthetic-account-hash' });
  for (let index = 0; index < 50; index++) sources.recordHttp('/api/local/inventory', index < 5 ? 503 : 200, supervisor);
  await sources.tick();
  tick(); await sources.tick();
  const { items, checks } = monitor.view();
  for (const label of ['异常登录尝试', '业务 SQLite 备份异常', '业务磁盘可用空间不足', '业务接口错误率过高'])
    assert(items.some(row => row.label === label), label);
  assert.equal(checks.find(row => row.label === 'Google 表格同步连续失败').status, 'unknown');
  assert.equal(checks.find(row => row.label === '代充订单同步连续失败').status, 'disabled');
  assert.equal(JSON.stringify(monitor.view()).includes('synthetic-account-hash'), false);
});

test('backup and Sheets monitoring reserve their own mount and skip business data when unconfigured', async t => {
  const { monitor, clock } = fixture(t);
  let receiptReads = 0;
  const sources = createMonitoringSources({ monitor, databasePath: '/fixture/state/local-business.sqlite', clock,
    readDisk: async () => ({ blocks: 100, bavail: 50 }), readReceipt: async () => { receiptReads++; } });
  t.after(() => sources.close());
  await sources.tick();
  const checks = monitor.view().checks;
  assert.equal(receiptReads, 0);
  assert.equal(checks.find(row => row.code === 'backup').status, 'disabled');
  assert.equal(checks.find(row => row.label === 'Google 表格同步连续失败').status, 'disabled');
  assert.match(checks.find(row => row.code === 'backup').detail, /尚未接入/);
  assert.match(checks.find(row => row.code === 'public_site').detail, /站外探针尚未接通/);
  assert.match(checks.find(row => row.code === 'api_errors').detail, /样本不足/);
});

test('two backup checks use the verified capture time, report failure and recover independently', async t => {
  const { monitor, store, clock, tick, sent } = fixture(t);
  monitor.save(0, { enabled: false, channels: {}, rules: { backup: false } }, supervisor);
  const saved = store.featureDocument('system-monitoring-config');
  delete saved.data.rules.recharge_backup;
  store.saveFeatureDocument('system-monitoring-config', saved.version, saved.data);
  assert.equal(monitor.configView().rules.find(row => row.code === 'recharge_backup').enabled, true);
  assert.equal(monitor.configView().rules.find(row => row.code === 'backup').enabled, false);

  const clean = () => ({
    at: clock(),
    drive: { at: clock(), verifiedAt: now, failures: 0, integrityFailure: false },
    mysql: { capturedAt: clock() - 10 * minute, verifiedAt: clock() },
    mysqlTimerActive: true, mysqlAttemptFailed: false
  });
  let report = clean();
  const sources = createMonitoringSources({ monitor, databasePath: '/fixture/state/local-business.sqlite', clock,
    backupReceiptDirectory: '/fixture/backup-monitoring', readDisk: async () => ({ blocks: 100, bavail: 60 }),
    readBackupReceipt: async (directory) => {
      assert.equal(directory, '/fixture/backup-monitoring');
      return report;
    } });
  t.after(() => sources.close());
  const read = code => monitor.view().checks.find(row => row.code === code);
  await sources.tick();
  assert.equal(read('backup').status, 'ok');
  assert.equal(read('recharge_backup').status, 'ok');
  tick();
  report = clean();
  report.mysql.capturedAt -= 26 * minute;
  await sources.tick();
  assert.equal(read('backup').status, 'ok');
  assert.equal(read('recharge_backup').status, 'bad');
  assert.match(read('recharge_backup').detail, /超过 35 分钟/);

  tick();
  report = { ...clean(), mysqlAttemptFailed: true };
  await sources.tick();
  assert.match(read('recharge_backup').detail, /任务失败/);
  for (let n = 0; n < 2; n++) {
    tick();
    report = clean();
    await sources.tick();
  }
  assert.equal(read('recharge_backup').status, 'ok');
  tick(4 * minute);
  await sources.tick();
  assert.match(read('backup').detail, /采集回执缺失或已超时/);
  assert.equal(read('recharge_backup').status, 'bad');
  assert.equal(sent.length, 0);
});

test('check evidence exposes fixed reasons and freshness without carrying arbitrary source text', t => {
  const f = fixture(t);
  f.monitor.observe([{ code: 'disk_space', status: 'ok', count: 62, reason: 'private-upstream-error' }]);
  const read = () => f.monitor.view().checks.find(row => row.code === 'disk_space');
  assert.equal(read().title, '业务磁盘');
  assert.equal(read().measurement, '磁盘可用比例：62%');
  assert.equal(read().at, now);
  assert.equal(JSON.stringify(f.monitor.view()).includes('private-upstream-error'), false);
  f.tick(6 * minute);
  assert.equal(read().status, 'unknown');
  assert.match(read().detail, /超过 5 分钟/);
  assert.equal(read().measurement, '');
});

test('notification overview separates disabled, missing recipients and ready channels without exposing destinations', async t => {
  const f = fixture(t);
  assert.equal(f.monitor.view().notifications.status, 'disabled');
  assert.equal(f.monitor.view().notifications.configured, 0);
  await enable(f);
  const partial = f.monitor.view().notifications;
  assert.equal(partial.status, 'partial');
  assert.deepEqual(partial.missingChannels, ['代充管理员']);
  f.monitor.save(f.monitor.configView().version, { enabled: true, channels: { rechargeAdmin: '999005' }, rules: {} }, supervisor);
  f.monitor.queueTest(f.monitor.configView().version, 'rechargeAdmin', supervisor);
  f.tick(); await f.monitor.dispatch();
  assert.equal(f.monitor.view().notifications.status, 'ready');
  assert.equal(f.monitor.view().notifications.verified, 3);
  const response = JSON.stringify(f.monitor.view());
  for (const secret of [token, ops, security, '999005']) assert.equal(response.includes(secret), false);
});

test('incidents distinguish absent, pending, ambiguous and accepted delivery evidence', async t => {
  const absent = fixture(t);
  absent.monitor.observe([{ code: 'exchange_rates', status: 'bad' }]);
  assert.equal(absent.monitor.view().items[0].deliveryStatus, 'no_record');
  const delivered = fixture(t);
  await enable(delivered);
  delivered.monitor.observe([{ code: 'exchange_rates', status: 'bad' }]);
  assert.equal(delivered.monitor.view().items[0].deliveryStatus, 'queued');
  delivered.tick(); await delivered.monitor.dispatch();
  assert.equal(delivered.monitor.view().items[0].deliveryStatus, 'accepted');
  const ambiguous = fixture(t, { send: (input, count) => count <= 2
    ? { status: 'accepted', messageId: count } : { status: 'unknown' } });
  await enable(ambiguous);
  ambiguous.monitor.observe([{ code: 'exchange_rates', status: 'bad' }]);
  ambiguous.tick(); await ambiguous.monitor.dispatch();
  assert.equal(ambiguous.monitor.view().items[0].deliveryStatus, 'unknown');
});

test('unresolved incidents sort ahead of restored records and acknowledged filters remain exclusive', t => {
  const { monitor, tick } = fixture(t);
  monitor.observe([{ code: 'exchange_rates', status: 'bad' }]);
  const old = monitor.view().items[0];
  monitor.acknowledge(old.id, admin);
  tick(); monitor.observe([{ code: 'exchange_rates', status: 'ok' }]);
  tick(); monitor.observe([{ code: 'exchange_rates', status: 'ok' }]);
  tick(); monitor.observe([{ code: 'security_confirmed', scope: 'evidence-1', status: 'bad' }]);
  assert.equal(monitor.view({ pageSize: 1 }).items[0].label, '已核实安全事件');
  assert.equal(monitor.view({ page: 2, pageSize: 1 }).items[0].id, old.id);
  assert.equal(monitor.view({ status: 'acknowledged' }).total, 0);
  assert.equal(monitor.view({ status: 'resolved' }).total, 1);
});

test('a truncated recharge batch cannot establish a healthy failure rate', () => {
  const rows = Array.from({ length: 200 }, (_, index) => ({ jobKey: 'job-' + index,
    time: '2026/11/10 09:59:00', status: 'success' }));
  const sample = () => projectRechargeMonitoring(rows, now).samples.find(row => row.code === 'recharge_burst');
  assert.equal(sample().status, 'unknown');
  assert.equal(sample().reason, 'tasks_incomplete');
  for (let index = 0; index < 5; index++) rows[index].status = 'failed';
  assert.equal(sample().status, 'bad');
});

test('invalid task receipts preserve the independently observed runtime status', async t => {
  const f = fixture(t);
  const sources = createMonitoringSources({ monitor: f.monitor, clock: f.clock, databasePath: '/fixture/data.sqlite',
    runtimeProbe: async () => ({ ready: true }), rechargeClient: { get: async () => ({ tasks: null }) },
    readDisk: async () => ({ blocks: 100, bavail: 50 }) });
  t.after(() => sources.close());
  await sources.tick();
  const checks = f.monitor.view().checks;
  assert.equal(checks.find(row => row.code === 'recharge_runtime').status, 'ok');
  assert.match(checks.find(row => row.code === 'recharge_review').detail, /无法读取有效/);
});

test('Telegram transport distinguishes acceptance, explicit rate limits, and an incomplete response', async () => {
  const attempt = fetchImpl => sendTelegram({ token, chatId: ops, text: '脱敏测试', fetchImpl });
  assert.deepEqual(await attempt(async (url, options) => {
    assert.equal(new URL(url).origin, 'https://api.telegram.org');
    assert.equal(options.redirect, 'error');
    assert.equal(JSON.parse(options.body).protect_content, true);
    return Response.json({ ok: true, result: { message_id: 123, chat: { id: Number(ops) } } });
  }), { status: 'accepted', messageId: 123 });
  assert.deepEqual(await attempt(async () => Response.json({ ok: false, parameters: { retry_after: 7 } }, { status: 429 })),
    { status: 'retry', delay: 7000 });
  assert.deepEqual(await attempt(async () => Response.json({ ok: true, result: { message_id: 1, chat: { id: 11 } } })),
    { status: 'unknown', reason: 'unconfirmed' });
});


test('monitor queries filter all records before pagination and use displayed timestamps', async t => {
  const f = fixture(t);
  const { monitor, tick } = f;
  // More than one page of independent one-shot events; these are in-memory fixtures.
  for (let i = 0; i < 25; i++) monitor.observe([{ code: 'security_confirmed', scope: 'old-' + i, status: 'bad' }]);
  tick(8 * 86400_000);
  monitor.observe([{ code: 'payment_duplicate', scope: 'new-payment', status: 'bad' }]);
  monitor.observe([{ code: 'recharge_route', scope: 'new-route', status: 'bad' }]);
  const selected = monitor.view({ q: '重复扣款', priority: 'P0', days: 7, page: 9, pageSize: 10 });
  assert.equal(selected.total, 1);
  assert.equal(selected.page, 1);
  assert.equal(selected.items[0].label, '已核实重复扣款');
  assert.equal(monitor.view({ priority: 'P1', days: 1 }).total, 1);
  assert.equal(monitor.view({ q: '安全', days: 7 }).total, 0);
  assert.equal(monitor.view({ q: selected.items[0].id.toUpperCase() }).total, 1);
  assert.equal(monitor.view({ q: '安全', page: 3, pageSize: 10 }).items.length, 5);
  assert.equal(monitor.view({ q: '不存在' }).total, 0);

  monitor.save(0, { enabled: false, token, channels: { operations: ops }, rules: {} }, supervisor);
  monitor.queueTest(1, 'operations', supervisor);
  tick(2 * 86400_000);
  assert.equal(monitor.view({ tab: 'deliveries', q: '渠道测试', days: 1 }).total, 0);
  await monitor.dispatch();
  const sent = monitor.view({ tab: 'deliveries', q: '运维', status: 'accepted', days: 1 });
  assert.equal(sent.total, 1, 'time filter follows the completion time displayed in the table');
  assert.equal(monitor.view({ tab: 'deliveries', q: '安全' }).total, 0);
  assert.equal(monitor.view({ tab: 'deliveries', q: ops }).total, 0, 'private recipient ID is not a searchable field');
});

test('monitor query validation rejects ambiguous, excessive and unknown filters', async t => {
  const { monitor } = fixture(t);
  const handler = createMonitoringHandler({ monitor, publicOrigin: origin });
  for (const query of ['q=' + 'x'.repeat(101), 'q=a&q=b', 'days=-1', 'days=2', 'priority=P3',
    'q=%00', 'tab=deliveries&priority=P0', 'surprise=true'])
    assert.equal((await http(handler, { url: monitorPath + '?' + query })).status, 400, query);
  assert.equal((await http(handler, { url: monitorPath + '?q=%E6%94%AF%E4%BB%98&days=7&priority=P0', actor: admin })).status, 200);
});

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { createNativeRechargeRouting, DEFAULT_PLAN_ROUTES, parseExitTrace,
  validatePlanRoutes, migrateRechargeRouting } from './native-routing.mjs';

function fixture({ rows = [], countries = ['PH'], onProbe, failures = [] } = {}) {
  let version = 1;
  let plans = { ...DEFAULT_PLAN_ROUTES };
  const audit = [];
  const checks = new Map();
  const labelAudit = [];
  const calls = [];
  const warnings = [];
  const fail = name => { if (failures.includes(name)) throw new Error('private database credentials'); };
  let substitutions = 0;
  const store = {
    async runQuery(sql, values) {
      if (sql.startsWith('SELECT version')) { fail('policy'); return [{ version, plans_json: plans, audit_json: audit }]; }
      if (sql.includes('FROM id_recharge_proxy_checks')) { fail('history-read'); return [...checks.values()]; }
      if (sql.includes('FROM proxy_assets p LEFT JOIN id_recharge_proxy_country_labels')) {
        if (sql.includes('WHERE p.id')) { fail('proxy-read'); return rows.filter(row => row.id === values[0]); }
        fail('pool-read');
        return rows;
      }
      throw new Error('Unexpected query: ' + sql);
    },
    async runExecute(sql, values) {
      if (sql.startsWith('INSERT INTO id_recharge_proxy_checks')) {
        fail('history-write');
        const [proxy_id, config_hash, country_code, exit_ip, check_status, check_source, latency_ms] = values;
        checks.set(proxy_id, { proxy_id, config_hash, country_code, exit_ip, check_status,
          check_source, latency_ms, checked_ms: Date.now() });
        return { affectedRows: 1 };
      }
      if (sql.startsWith('UPDATE id_recharge_route_config')) {
        if (values[2] !== version) return { affectedRows: 0 };
        plans = JSON.parse(values[0]); audit.push(JSON.parse(values[1])); version++;
        return { affectedRows: 1 };
      }
      assert.match(sql, /^UPDATE proxy_assets SET usage_count/);
      fail('usage-write');
      calls.push(['usage', values[0]]);
      return { affectedRows: 1 };
    },
    async updateProxyAssetCheck(id, value) { fail('status-write'); calls.push(['check', id, value.ok]); },
    async withTransaction(operation) {
      const draft = structuredClone(rows);
      const events = [];
      const result = await operation({
        async query(sql, [value]) {
          assert.match(sql, /FOR UPDATE$/);
          return [draft.filter(row => sql.includes('WHERE p.id') ? row.id === value :
            createHash('sha256').update(row.proxy_url).digest('hex') === value)];
        },
        async execute(sql, values) {
          if (sql.startsWith('INSERT INTO proxy_assets')) {
            const id = Math.max(0, ...draft.map(row => row.id)) + 1;
            draft.push({ id, proxy_url: values[0], is_active: 1 });
            return [{ insertId: id }];
          }
          assert.match(sql, /^INSERT INTO id_recharge_proxy_country_labels/);
          fail('label-write');
          const [id, countryCode, event] = values;
          draft.find(row => row.id === id).label_country_code = countryCode;
          events.push(JSON.parse(event));
          return [{ affectedRows: 1 }];
        }
      });
      rows.splice(0, rows.length, ...draft);
      labelAudit.push(...events);
      return result;
    }
  };
  const routing = createNativeRechargeRouting({ store, chooseOrder: rows => rows,
    onWarning(message) { warnings.push(message); fail('warning'); },
    substituteSession(raw) { substitutions++; return raw.replace('{session}', 'synthetic-sticky-' + substitutions); },
    async probe(proxy) {
      calls.push(['probe', proxy]);
      await onProbe?.({ rows, routing });
      const countryCode = countries.length > 1 ? countries.shift() : countries[0];
      if (countryCode === 'error') throw new Error('socks5://private-user:private-password@private-host');
      return { ip: '8.8.8.8', countryCode, latencyMs: 12, source: 'Cloudflare trace' };
    }
  });
  const request = async (method, path, body) => {
    const response = { statusCode: 200 };
    await routing.handleAdmin({ method, path, body, admin: { email: 'operator@example.test' } }, {
      status(code) { response.statusCode = code; return this; },
      json(payload) { response.payload = payload; }
    });
    return response;
  };
  return { routing, calls, rows, checks, warnings, labelAudit, request, substitutions: () => substitutions };
}
const proxy = (id, enabled = 1, label = null) => ({ id, is_active: enabled, label_country_code: label,
  proxy_url: 'socks5://synthetic-{session}:synthetic-secret@proxy.example.test:' + (1000 + id) });

test('trace accepts public IPv4/IPv6 and rejects ambiguous, private and oversized responses', () => {
  assert.equal(parseExitTrace('ip=8.8.8.8\nloc=PH\n').countryCode, 'PH');
  assert.equal(parseExitTrace('ip=2606:4700:4700::1111\r\nloc=EG\r\n').countryCode, 'EG');
  for (const trace of ['ip=127.0.0.1\nloc=PH', 'ip=10.1.2.3\nloc=PH', 'ip=192.0.2.1\nloc=PH',
    'ip=2001:db8::1\nloc=PH', 'ip=ff02::1\nloc=PH', 'ip=8.8.8.8\nloc=XX', 'ip=8.8.8.8\nloc=PH\nloc=EG',
    'ip=8.8.8.8\nip=1.1.1.1\nloc=PH', 'x'.repeat(16385)]) assert.throws(() => parseExitTrace(trace));
});
test('four canonical plans are mandatory and default countries match the authorization', () => {
  assert.deepEqual(validatePlanRoutes(DEFAULT_PLAN_ROUTES), { plus: 'PH', pro100: 'EG', pro200: 'PH', pro500: 'EG' });
  for (const value of [{}, { ...DEFAULT_PLAN_ROUTES, plus: 'ZZ' }, { ...DEFAULT_PLAN_ROUTES, pro_5x: 'EG' }])
    assert.throws(() => validatePlanRoutes(value));
});
test('only an entirely empty pool can use a verified matching direct exit', async () => {
  const f = fixture();
  const route = await f.routing.resolve('plus');
  assert.equal(route.proxy, ''); assert.equal(route.region, 'PH'); assert.equal(route.currency, 'PHP');
  await f.routing.revalidate(route);
  assert.deepEqual(f.calls, [['probe', ''], ['probe', '']]);
  await assert.rejects(fixture({ countries: ['JP'] }).routing.resolve('plus'), /服务器直连出口为 JP/);
  const disabled = fixture({ rows: [proxy(1, 0)] });
  await assert.rejects(disabled.routing.resolve('plus'), /没有启用/);
  assert.equal(disabled.calls.length, 0);
});
test('country mismatch and failed proxies never fall back to direct or expose credentials', async () => {
  const f = fixture({ rows: [proxy(1), proxy(2)], countries: ['JP', 'error'] });
  await assert.rejects(f.routing.resolve('plus'), error => {
    assert.match(error.message, /未找到已核验/);
    assert.doesNotMatch(error.message, /private-|synthetic-secret/); return true;
  });
  assert.ok(f.calls.filter(call => call[0] === 'probe').every(call => call[1]));
  assert.ok(!f.calls.some(call => call[0] === 'usage'));
  assert.ok(!JSON.stringify(await f.routing.view()).includes('synthetic-secret'));
});
test('the live check tries matching labels first and only then unmarked proxies', async () => {
  const rows = [proxy(1), proxy(2, 1, 'MX'), proxy(3, 1, 'PH'), proxy(4, 0, 'PH')];
  const tagged = fixture({ rows });
  assert.equal((await tagged.routing.resolve('plus')).proxyId, 3);
  assert.equal(tagged.substitutions(), 1);
  const fallback = fixture({ rows, countries: ['MX', 'PH'] });
  assert.equal((await fallback.routing.resolve('plus')).proxyId, 1);
  assert.deepEqual(fallback.calls.filter(([type]) => type === 'probe').map(([, url]) => url.split(':').at(-1)),
    ['1003', '1001']);
  const view = await fallback.routing.view();
  assert.deepEqual(view.proxyCountries.slice(0, 2).map(({ code }) => code), ['PH', 'EG']);
  assert.ok(view.proxyCountries.some(({ code, name }) => code === 'MX' && name === '墨西哥'));
  assert.equal(view.proxyLabels.find(label => label.proxyId === 3).countryCode, 'PH');
  assert.equal(view.checks.find(check => check.proxyId === 3).countryCode, 'MX');
  assert.equal(view.proxyLabels.find(label => label.proxyId === 1).countryCode, null);
  const wrongLabel = fixture({ rows: [proxy(1, 1, 'MX')], countries: ['PH'] });
  await assert.rejects(wrongLabel.routing.resolve('plus'), /未找到已核验/);
  assert.equal(wrongLabel.substitutions(), 0);
});
test('country edits during either live probe block the selected route', async () => {
  for (const during of [1, 2]) {
    let probes = 0;
    const f = fixture({ rows: [proxy(1, 1, 'PH')], onProbe: ({ rows }) => {
      if (++probes === during) rows[0].label_country_code = 'MX';
    } });
    if (during === 1) {
      await assert.rejects(f.routing.resolve('plus'), /国家标注在检测期间发生变化/);
      assert.ok(!f.calls.some(([type]) => type === 'usage'));
    } else {
      const route = await f.routing.resolve('plus');
      let launched = false;
      await assert.rejects(f.routing.verifiedStart(route, () => { launched = true; })({}), /国家标注已变更/);
      assert.equal(launched, false);
    }
  }
});
test('batch import requires a country and atomically adds or labels existing proxies', async () => {
  const legacy = proxy(1);
  const other = proxy(2, 1, 'EG');
  const f = fixture({ rows: [legacy, other] });
  const raw = 'gate.example.test:8080:synthetic-user:synthetic-password';
  for (const countryCode of [undefined, 'ZZ', '']) {
    assert.equal((await f.request('POST', '/proxies', { proxies: [raw], countryCode })).statusCode, 400);
  }
  const rejected = await f.request('POST', '/proxies', { proxies: [raw, other.proxy_url], countryCode: 'PH' });
  assert.equal(rejected.statusCode, 409);
  assert.deepEqual(f.rows, [legacy, other]);
  assert.deepEqual(f.labelAudit, []);
  const batch = { proxies: [raw, legacy.proxy_url, raw], countryCode: 'PH' };
  const imported = (await f.request('POST', '/proxies', batch)).payload;
  assert.equal(imported.success, true);
  assert.deepEqual([imported.added, imported.labeled, imported.skipped], [1, 1, 0]);
  assert.deepEqual(f.rows.map(row => row.label_country_code), ['PH', 'EG', 'PH']);
  assert.ok(f.labelAudit.every(event => event.actor === 'operator@example.test' && event.previousCountryCode === null));
  assert.doesNotMatch(JSON.stringify(f.labelAudit), /synthetic-user|synthetic-password|gate\.example/);
  const retried = (await f.request('POST', '/proxies', batch)).payload;
  assert.deepEqual([retried.added, retried.labeled, retried.skipped], [0, 0, 2]);
  assert.equal(f.labelAudit.length, 2);
  const failed = fixture({ failures: ['label-write'] });
  const unavailable = await failed.request('POST', '/proxies', batch);
  assert.equal(unavailable.statusCode, 503);
  assert.doesNotMatch(JSON.stringify(unavailable), /private|synthetic/);
  assert.deepEqual(failed.rows, []);
});
test('editing an existing label detects stale edits and never writes exit observations', async () => {
  const f = fixture({ rows: [proxy(1)] });
  const edit = (id, countryCode, expectedCountryCode) =>
    f.request('PUT', '/proxies/' + id + '/country', { countryCode, expectedCountryCode });
  assert.equal((await edit(99, 'PH', null)).statusCode, 404);
  assert.equal((await edit(1, 'ZZ', null)).statusCode, 400);
  assert.equal((await edit(1, 'PH', undefined)).statusCode, 400);
  assert.deepEqual((await edit(1, 'PH', null)).payload, { success: true, proxyId: 1, countryCode: 'PH' });
  assert.equal((await edit(1, 'MX', null)).statusCode, 409);
  assert.equal((await edit(1, 'MX', 'PH')).statusCode, 200);
  assert.equal((await edit(1, 'MX', 'PH')).statusCode, 200);
  assert.deepEqual(f.labelAudit.map(event => [event.previousCountryCode, event.countryCode]), [[null, 'PH'], ['PH', 'MX']]);
  assert.equal(f.checks.size, 0);
});
test('selected sticky proxy is resolved once and exactly reused immediately before the worker starts', async () => {
  const f = fixture({ rows: [proxy(1)], countries: ['EG'] });
  const route = await f.routing.resolve('pro100');
  let worker;
  await f.routing.verifiedStart(route, async env => { worker = env; })({ PROXY: route.proxy });
  assert.equal(f.substitutions(), 1);
  assert.equal(route.region, 'EG'); assert.equal(route.currency, 'EGP');
  assert.equal(worker.PROXY, route.proxy);
  assert.deepEqual(f.calls.filter(call => call[0] === 'probe').map(call => call[1]), [route.proxy, route.proxy]);
  assert.doesNotMatch(f.routing.describe(route), /synthetic-secret|proxy\.example/);
});
test('changed or disabled proxy and drifting country block child launch', async () => {
  for (const mutation of [row => row.is_active = 0, row => row.proxy_url += '-changed']) {
    const f = fixture({ rows: [proxy(1)] }); const route = await f.routing.resolve('plus');
    mutation(f.rows[0]); let ran = false;
    await assert.rejects(f.routing.verifiedStart(route, () => { ran = true; })({}), /变更或停用/);
    assert.equal(ran, false);
  }
  const f = fixture({ rows: [proxy(1)], countries: ['PH', 'JP'] });
  const route = await f.routing.resolve('plus');
  await assert.rejects(f.routing.revalidate(route), /出口国家发生变化/);
});
test('policy updates use optimistic version checks, preserve audit and freeze accepted jobs', async () => {
  const f = fixture({ rows: [proxy(1)] }); const route = await f.routing.resolve('plus');
  await f.routing.savePolicy({ version: 1, plans: { ...DEFAULT_PLAN_ROUTES, plus: 'EG' } }, 'fixture@example.test');
  await assert.rejects(f.routing.savePolicy({ version: 1, plans: DEFAULT_PLAN_ROUTES }, 'other'), /已被更新/);
  const view = await f.routing.view();
  assert.equal(view.version, 2); assert.equal(view.auditCount, 1); assert.equal(view.billingAddressCountry, 'US');
  assert.equal(route.region, 'PH'); await f.routing.revalidate(route);
  await assert.rejects(f.routing.resolve('pro_5x'), /尚未配置/);
});
test('configuration races during selection fail before a route is accepted', async () => {
  let changed = false;
  const f = fixture({ rows: [proxy(1)], onProbe: async ({ routing }) => {
    if (!changed) { changed = true; await routing.savePolicy({ version: 1, plans: DEFAULT_PLAN_ROUTES }, 'fixture'); }
  } });
  await assert.rejects(f.routing.resolve('plus'), /配置已更新/);
  assert.ok(!f.calls.some(call => call[0] === 'usage'));
});
test('auxiliary storage and warning failures never block a verified route or mark it unhealthy', async () => {
  for (const failures of [['history-read'], ['history-write'], ['status-write'], ['usage-write'],
    ['history-read', 'history-write', 'status-write', 'usage-write', 'warning']]) {
    const f = fixture({ rows: [proxy(1)], failures });
    const route = await f.routing.resolve('plus');
    let started = false;
    await f.routing.verifiedStart(route, () => { started = true; })({ PROXY: route.proxy });
    assert.equal(started, true);
    assert.equal(f.calls.filter(call => call[0] === 'probe').length, 2);
    assert.ok(!f.calls.some(call => call[0] === 'check' && call[2] === false));
    assert.ok(f.warnings.length > 0);
    assert.doesNotMatch(JSON.stringify(f.warnings), /private|credentials|synthetic-secret/);
  }
});
test('required policy and pool reads still fail closed without probing or direct fallback', async () => {
  for (const failure of ['policy', 'pool-read', 'proxy-read']) {
    const f = fixture({ rows: [proxy(1)], failures: [failure] });
    await assert.rejects(f.routing.resolve('plus'), error => error.code === 'route_storage_unavailable');
    assert.ok(!f.calls.some(call => call[0] === 'probe' && !call[1]));
    assert.ok(!f.calls.some(call => call[0] === 'usage'));
  }
});
test('a failed live probe remains a failure even when failure records cannot be saved', async () => {
  const f = fixture({ rows: [proxy(1)], countries: ['error'], failures: ['history-write', 'status-write'] });
  await assert.rejects(f.routing.resolve('plus'), error => {
    assert.match(error.message, /未找到已核验/);
    assert.doesNotMatch(error.message, /private|credentials|synthetic-secret/); return true;
  });
  assert.ok(!f.calls.some(call => call[0] === 'usage'));
});
test('each new native outer attempt selects a fresh sticky route in the accepted task country', async () => {
  const f = fixture({ rows: [proxy(1), proxy(2)] });
  const first = await f.routing.resolve('plus');
  await f.routing.savePolicy({ version: 1, plans: { ...DEFAULT_PLAN_ROUTES, plus: 'EG' } }, 'fixture');
  f.rows[0].is_active = 0;
  const second = await f.routing.nextAttempt(first);
  assert.equal(second.region, 'PH'); assert.equal(second.currency, 'PHP');
  assert.equal(second.configVersion, first.configVersion);
  assert.equal(second.proxyId, 2); assert.notEqual(second.proxy, first.proxy);
  assert.equal(f.substitutions(), 2);
  let ran = false;
  await f.routing.verifiedStart(second, () => { ran = true; })({ PROXY: second.proxy });
  assert.equal(ran, true);
  assert.deepEqual(f.calls.filter(call => call[0] === 'probe').map(call => call[1]),
    [first.proxy, second.proxy, second.proxy]);
});
test('migration is additive and idempotent without touching upstream payment tables', async () => {
  const sql = [];
  await migrateRechargeRouting({ async query(statement) { sql.push(statement); } });
  assert.equal(sql.length, 4);
  assert.match(sql[0], /^CREATE TABLE IF NOT EXISTS id_recharge_route_config/);
  assert.match(sql[1], /^CREATE TABLE IF NOT EXISTS id_recharge_proxy_checks/);
  assert.match(sql[2], /^CREATE TABLE IF NOT EXISTS id_recharge_proxy_country_labels/);
  assert.match(sql[2], /FOREIGN KEY \(proxy_id\) REFERENCES proxy_assets \(id\) ON DELETE CASCADE/);
  assert.match(sql[3], /^INSERT IGNORE INTO id_recharge_route_config/);
  assert.ok(sql.every(statement => !/^(?:DROP|ALTER|DELETE|TRUNCATE)\b/.test(statement)));
});

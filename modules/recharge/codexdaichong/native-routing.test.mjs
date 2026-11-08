import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createNativeRechargeRouting, DEFAULT_PLAN_ROUTES, parseExitTrace,
  validatePlanRoutes, migrateRechargeRouting } from './native-routing.mjs';

function fixture({ rows = [], countries = ['PH'], onProbe, failures = [] } = {}) {
  let version = 1;
  let plans = { ...DEFAULT_PLAN_ROUTES };
  const audit = [];
  const checks = new Map();
  const calls = [];
  const warnings = [];
  const fail = name => { if (failures.includes(name)) throw new Error('private database credentials'); };
  let substitutions = 0;
  const store = {
    async runQuery(sql, values) {
      if (sql.startsWith('SELECT version')) { fail('policy'); return [{ version, plans_json: plans, audit_json: audit }]; }
      if (sql.includes('FROM id_recharge_proxy_checks')) { fail('history-read'); return [...checks.values()]; }
      if (sql.includes('FROM proxy_assets WHERE id')) { fail('proxy-read'); return rows.filter(row => row.id === values[0]); }
      if (sql.includes('FROM proxy_assets ORDER BY')) { fail('pool-read'); return rows; }
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
    async updateProxyAssetCheck(id, value) { fail('status-write'); calls.push(['check', id, value.ok]); }
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
  return { routing, calls, rows, checks, warnings, substitutions: () => substitutions };
}
const proxy = (id, enabled = 1) => ({ id, is_active: enabled,
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
  assert.equal(sql.length, 3);
  assert.match(sql[0], /^CREATE TABLE IF NOT EXISTS id_recharge_route_config/);
  assert.match(sql[1], /^CREATE TABLE IF NOT EXISTS id_recharge_proxy_checks/);
  assert.match(sql[2], /^INSERT IGNORE INTO id_recharge_route_config/);
  assert.ok(sql.every(statement => !/\b(?:DROP|ALTER|DELETE|TRUNCATE)\b/.test(statement)));
});

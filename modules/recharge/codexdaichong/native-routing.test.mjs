import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createNativeRechargeRouting, DEFAULT_PLAN_ROUTES, parseExitTrace,
  validatePlanRoutes, migrateRechargeRouting, manualProxyDialOptions } from './native-routing.mjs';
import { normalizeRechargeProxyInput } from './proxy-input.mjs';

function fixture({ rows = [], countries = ['PH'], onProbe, onVerify, onUsage, onPolicy, onObservation,
  measure, now, failures = [], types = [] } = {}) {
  let version = 1;
  let plans = { ...DEFAULT_PLAN_ROUTES };
  const audit = [];
  const checks = new Map();
  const labelAudit = [];
  const calls = [];
  const warnings = [];
  const starts = [];
  let proxyTypes = new Map(types);
  const fail = name => { if (failures.includes(name)) throw new Error('private database credentials'); };
  let substitutions = 0;
  const store = {
    async runQuery(sql, values) {
      if (sql.startsWith('SELECT version')) {
        fail('policy');
        await onPolicy?.();
        return [{ version, plans_json: plans, audit_json: audit }];
      }
      if (sql.includes('FROM id_recharge_proxy_checks')) { fail('history-read'); return [...checks.values()]; }
      if (sql.startsWith('SELECT p.id, c.config_value')) {
        fail('type-read');
        return rows.filter(row => proxyTypes.has(row.id)).map(row => ({ id: row.id, proxy_type: proxyTypes.get(row.id) }));
      }
      if (sql.includes('FROM proxy_assets p LEFT JOIN id_recharge_proxy_country_labels')) {
        if (sql.includes('WHERE p.id')) {
          fail('proxy-read');
          if (sql.includes('LEFT JOIN app_config c ON')) {
            await onVerify?.();
            return rows.filter(row => row.id === values[1]).map(row => ({ ...row, proxy_type: proxyTypes.get(row.id) }));
          }
          return rows.filter(row => row.id === values[0]);
        }
        fail('pool-read');
        return rows;
      }
      throw new Error('Unexpected query: ' + sql);
    },
    async runExecute(sql, values) {
      if (sql.startsWith('INSERT INTO id_recharge_proxy_checks')) {
        fail('history-write');
        const [proxy_id, config_hash, country_code, exit_ip, check_status, check_source, checked_ms, latency_ms] = values;
        await onObservation?.({ proxyId: proxy_id, status: check_status });
        checks.set(proxy_id, { proxy_id, config_hash, country_code, exit_ip, check_status,
          check_source, latency_ms, checked_ms });
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
      await onUsage?.();
      return { affectedRows: 1 };
    },
    async updateProxyAssetCheck(id, value) { fail('status-write'); calls.push(['check', id, value.ok]); },
    async withTransaction(operation) {
      const draft = structuredClone(rows);
      const draftTypes = new Map(proxyTypes);
      const events = [];
      const result = await operation({
        async query(sql, [value]) {
          if (sql.startsWith('SELECT config_value FROM app_config')) {
            const current = draftTypes.get(Number(value.split(':').at(-1)));
            return [current ? [{ config_value: current }] : []];
          }
          assert.match(sql, /FOR UPDATE$/);
          return [draft.filter(row => /WHERE (?:p\.)?id =/.test(sql) ? row.id === value :
            createHash('sha256').update(row.proxy_url).digest('hex') === value)];
        },
        async execute(sql, values) {
          if (sql.startsWith('INSERT INTO proxy_assets')) {
            const id = Math.max(0, ...draft.map(row => row.id)) + 1;
            draft.push({ id, proxy_url: values[0], is_active: 1 });
            return [{ insertId: id }];
          }
          if (sql.startsWith('INSERT INTO app_config')) {
            fail('type-write');
            const [key, type] = values;
            assert.match(key, /^id_recharge_proxy_type:[1-9]\d*$/);
            draftTypes.set(Number(key.split(':').at(-1)), type);
            return [{ affectedRows: 1 }];
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
      proxyTypes = draftTypes;
      labelAudit.push(...events);
      return result;
    }
  };
  const routing = createNativeRechargeRouting({ store, now, chooseOrder: rows => rows,
    onWarning(message) { warnings.push(message); fail('warning'); },
    onStart(message) { starts.push(message); fail('start-log'); },
    substituteSession(raw) {
      return raw.replace(/\{session\}/gi, () => 'synthetic-sticky-' + ++substitutions);
    },
    async probe(proxy, timeout) {
      calls.push(['probe', proxy]);
      await onProbe?.({ rows, routing });
      if (measure) return measure(proxy, timeout);
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
  return { routing, calls, rows, checks, warnings, starts, labelAudit, request, substitutions: () => substitutions };
}
const proxy = (id, enabled = 1, label = null) => ({ id, is_active: enabled, label_country_code: label,
  proxy_url: 'socks5://synthetic-{session}:synthetic-secret@proxy.example.test:' + (1000 + id) });

test('trace accepts public IPv4/IPv6 and rejects ambiguous, private and oversized responses', () => {
  assert.equal(parseExitTrace('ip=8.8.8.8\nloc=PH\n').countryCode, 'PH');
  assert.equal(parseExitTrace('ip=2606:4700:4700::1111\r\nloc=EG\r\n').countryCode, 'EG');
  for (const trace of ['ip=127.0.0.1\nloc=PH', 'ip=10.1.2.3\nloc=PH', 'ip=192.0.2.1\nloc=PH',
    'ip=2001:db8::1\nloc=PH', 'ip=ff02::1\nloc=PH', 'ip=2606:4700::1111%eth0\nloc=PH',
    'ip=8.8.8.8\nloc=XX', 'ip=8.8.8.8\nloc=PH\nloc=EG',
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
test('proxy types apply to the entire new batch and survive relabeling without changing route selection', async () => {
  const legacy = proxy(1, 1, 'PH');
  const f = fixture({ rows: [legacy] });
  const proxies = [proxy(2).proxy_url, proxy(3).proxy_url, legacy.proxy_url];
  const batch = { proxies, countryCode: 'PH', proxyType: 'dedicated_static_residential' };
  const invalid = await f.request('POST', '/proxies', { ...batch, proxyType: 'socks5' });
  assert.equal(invalid.statusCode, 400);
  assert.deepEqual(f.rows, [legacy]);
  const imported = (await f.request('POST', '/proxies', batch)).payload;
  assert.deepEqual([imported.added, imported.skipped, imported.proxyType], [2, 1, batch.proxyType]);
  const expected = [2, 3].map(proxyId => ({ proxyId, proxyType: batch.proxyType }));
  assert.deepEqual((await f.routing.view()).proxyTypes, expected);
  const repeated = (await f.request('POST', '/proxies', { ...batch, proxyType: 'mobile' })).payload;
  assert.equal(repeated.skipped, 3);
  assert.deepEqual((await f.routing.view()).proxyTypes, expected);
  assert.equal((await f.routing.resolve('plus')).proxyId, 1);

  const edit = (id, proxyType, expectedProxyType) => f.request('PUT', '/proxies/' + id + '/type', { proxyType, expectedProxyType });
  assert.equal((await edit(99, 'mobile', null)).statusCode, 404);
  assert.equal((await edit(1, 'mobile', undefined)).statusCode, 400);
  assert.deepEqual((await edit(1, 'mobile', null)).payload, { success: true, proxyId: 1, proxyType: 'mobile' });
  assert.equal((await edit(1, 'static_residential', null)).statusCode, 409);
  assert.equal((await edit(1, 'mobile', null)).statusCode, 200);
  await f.request('PUT', '/proxies/1/country', { countryCode: 'EG', expectedCountryCode: 'PH' });
  assert.deepEqual((await f.routing.view()).proxyTypes, [{ proxyId: 1, proxyType: 'mobile' }, ...expected]);

  const failed = fixture({ failures: ['type-write'] });
  assert.equal((await failed.request('POST', '/proxies', batch)).statusCode, 503);
  assert.deepEqual(failed.rows, []);
  assert.deepEqual(failed.labelAudit, []);
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

for (const [plan, countryCode] of [['plus', 'PH'], ['pro100', 'EG']]) {
  test(`${countryCode} chooses the lowest current latency, including when the first response is slower`, async () => {
    const first = proxy(1, 1, countryCode), second = proxy(2, 1, countryCode);
    second.proxy_url = second.proxy_url.replace('synthetic-{session}', 'synthetic-static');
    const rows = [first, second, proxy(3, 1, countryCode), proxy(4, 1, countryCode)];
    const completed = [];
    let releaseSlowResponse;
    const waitForSecondProbe = new Promise(resolve => { releaseSlowResponse = resolve; });
    let initialSecondProbe = true;
    const f = fixture({ rows, types: [[1, 'mobile'], [2, 'static_residential']], async measure(url) {
      const id = Number(new URL(url).port) - 1000;
      if (id === 3) return { ip: '1.1.1.1', countryCode: 'JP', latencyMs: 1 };
      if (id === 4) throw new Error('synthetic timeout');
      if (id === 1) {
        completed.push(1);
        releaseSlowResponse();
        return { ip: '8.8.8.8', countryCode, latencyMs: 100 };
      }
      if (initialSecondProbe) {
        initialSecondProbe = false;
        await waitForSecondProbe;
        completed.push(2);
      }
      return { ip: '8.8.4.4', countryCode, latencyMs: 10 };
    } });
    const route = await f.routing.resolve(plan);
    assert.deepEqual(completed, [1, 2]);
    assert.equal(route.proxyId, 2);
    assert.equal(route.ip, '8.8.4.4');
    assert.equal(route.latencyMs, 10);
    assert.deepEqual(f.calls.filter(([kind]) => kind === 'usage'), []);
    const env = { PROXY: first.proxy_url, PAYMENT_REGION_OVERRIDE: countryCode };
    const handedOff = await f.routing.verifiedStart(route, workerEnv => workerEnv)(env);
    assert.deepEqual(handedOff, { ...env, PROXY: second.proxy_url });
    assert.equal(env.PROXY, first.proxy_url);
    assert.deepEqual(f.calls.filter(([kind]) => kind === 'usage'), [['usage', 2]]);
  });
}

test('a same-country IP change uses the measured backup session without starting the former winner', async () => {
  const counts = new Map();
  const f = fixture({ rows: [proxy(1), proxy(2)], types: [[1, 'dynamic_residential'], [2, 'mobile']], measure(url) {
    const id = Number(new URL(url).port) - 1000;
    const attempts = (counts.get(url) ?? 0) + 1;
    counts.set(url, attempts);
    const ip = id === 1 ? (attempts === 1 ? '8.8.8.8' : '1.1.1.1') : '8.8.4.4';
    return { ip, countryCode: 'PH', latencyMs: id };
  } });
  const primary = await f.routing.resolve('plus');
  const [primaryProbe, backupProbe] = f.calls.filter(([kind]) => kind === 'probe').map(([, url]) => url);
  assert.equal(primary.proxy, primaryProbe);
  const launched = [];
  await f.routing.verifiedStart(primary, env => { launched.push(env.PROXY); })({ PROXY: primary.proxy });
  assert.deepEqual(launched, [backupProbe]);
  assert.deepEqual([...counts], [[primaryProbe, 2], [backupProbe, 2]]);
  assert.equal(f.substitutions(), 2);
  assert.deepEqual(f.calls.filter(([kind]) => kind === 'usage'), [['usage', 2]]);
  assert.doesNotMatch(JSON.stringify(f.warnings), /synthetic-secret|proxy\.example|8\.8/);
  const routeRef = f.routing.describe(primary).split(' route_ref=')[1];
  assert.match(routeRef, /^[a-f0-9-]{36}$/);
  assert.deepEqual(f.starts, [
    '代理线路已交接 route_ref=' + routeRef + ' network=proxy#2 country=PH checked_exit=***.***.4.4'
  ]);
  assert.doesNotMatch(f.starts[0], /synthetic-secret|proxy\.example|8\.8\.4\.4/);
});

test('same-country drift without a measured backup never launches or generates a replacement session', async () => {
  let probes = 0;
  const f = fixture({ rows: [proxy(1)], measure() {
    return { ip: ++probes === 1 ? '8.8.8.8' : '8.8.4.4', countryCode: 'PH', latencyMs: 10 };
  } });
  const route = await f.routing.resolve('plus');
  await assert.rejects(f.routing.verifiedStart(route, () => assert.fail('must not launch'))({}),
    /出口 IP 与测速结果不一致/);
  assert.equal(f.substitutions(), 1);
  assert.ok(!f.calls.some(([kind]) => kind === 'usage'));
});

test('typed rotating gateways require a session template for automatic routing but remain manually testable', async () => {
  const rotating = proxy(1, 1, 'PH');
  rotating.proxy_url = rotating.proxy_url.replace('synthetic-{session}', 'synthetic-rotating');
  const f = fixture({ rows: [rotating, proxy(2, 1, 'PH')], types: [[1, 'mobile'], [2, 'dynamic_residential']] });
  const route = await f.routing.resolve('plus');
  assert.equal(route.proxyId, 2);
  assert.equal(f.calls.filter(([kind]) => kind === 'probe').length, 1);
  assert.equal((await f.routing.checkProxy(1)).countryCode, 'PH');
  await f.routing.checkProxy(2);
  await f.routing.checkProxy(2);
  const probes = f.calls.filter(([kind]) => kind === 'probe').map(([, url]) => url);
  assert.equal(probes[1], rotating.proxy_url);
  assert.equal(new Set([probes[0], ...probes.slice(2)]).size, 3);
});

test('an accepted static proxy cannot start once marked rotating without a session template', async () => {
  const row = proxy(1, 1, 'PH');
  row.proxy_url = row.proxy_url.replace('{session}', 'fixed');
  const f = fixture({ rows: [row], types: [[1, 'static_residential']] });
  const route = await f.routing.resolve('plus');
  const edit = await f.request('PUT', '/proxies/1/type', { proxyType: 'mobile', expectedProxyType: 'static_residential' });
  assert.equal(edit.statusCode, 200);
  await assert.rejects(f.routing.verifiedStart(route, () => assert.fail('must not launch'))({}), /会话占位符/);
  assert.equal(f.calls.filter(([kind]) => kind === 'probe').length, 1);
  assert.deepEqual(f.starts, []);
});

test('startup spends its remaining budget on the probe and will not launch after slow metadata reads', async () => {
  let time = 0;
  let delaying = false;
  const budgets = [];
  const f = fixture({ rows: [proxy(1)], now: () => time,
    onVerify() { if (delaying) time += 11000; },
    measure(_url, timeout) {
      budgets.push(timeout);
      return { ip: '8.8.8.8', countryCode: 'PH', latencyMs: 10 };
    }
  });
  const route = await f.routing.resolve('plus');
  delaying = true;
  await assert.rejects(f.routing.verifiedStart(route, () => assert.fail('must not launch'))({}), /核验超时/);
  assert.deepEqual(budgets, [20000, 9000]);
  assert.deepEqual(f.starts, []);
});

test('route selection times out even while a required policy read remains pending', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] });
  const pending = new Promise(() => {});
  const f = fixture({ rows: [proxy(1)], onPolicy: () => pending });
  const rejected = assert.rejects(f.routing.resolve('plus'), /套餐选路超时/);
  t.mock.timers.tick(20000);
  await rejected;
  assert.deepEqual(f.calls, []);
});

test('a slow observation write does not delay selection and the verified handoff', async () => {
  let releaseWrite;
  let writeBegan;
  const pendingWrite = new Promise(resolve => { releaseWrite = resolve; });
  const startedWrite = new Promise(resolve => { writeBegan = resolve; });
  let pendingWrites = 0;
  const f = fixture({ rows: Array.from({ length: 12 }, (_, index) => proxy(index + 1)), async onObservation() {
    pendingWrites++;
    writeBegan();
    await pendingWrite;
  } });
  let launched = false;
  const result = f.routing.resolve('plus')
    .then(route => f.routing.verifiedStart(route, () => { launched = true; })({}));
  await startedWrite;
  await setImmediate();
  const launchedWhileWritePending = launched;
  const concurrentWrites = pendingWrites;
  releaseWrite();
  await result;
  assert.equal(launchedWhileWritePending, true);
  assert.equal(concurrentWrites, 1);
});

test('a delayed initial observation cannot overwrite the result of startup verification', async () => {
  let releaseWrite;
  let writeBegan;
  const pendingWrite = new Promise(resolve => { releaseWrite = resolve; });
  const startedWrite = new Promise(resolve => { writeBegan = resolve; });
  const written = [];
  let now = 1000;
  const f = fixture({ rows: [proxy(1)], now: () => now, countries: ['PH', 'error'], async onObservation({ status }) {
    written.push(status);
    if (status === 'verified') { writeBegan(); await pendingWrite; }
  } });
  const route = await f.routing.resolve('plus');
  await startedWrite;
  now = 2000;
  await assert.rejects(f.routing.verifiedStart(route, () => assert.fail('must not launch'))({}), /检测失败/);
  releaseWrite();
  await setImmediate();
  assert.deepEqual(written, ['verified', 'failed']);
  assert.equal(f.checks.get(1).check_status, 'failed');
  assert.equal(f.checks.get(1).checked_ms, 2000);
});

test('asynchronous usage accounting does not delay the verified handoff', async () => {
  let releaseUsage;
  let usageBegan;
  const pendingUsage = new Promise(resolve => { releaseUsage = resolve; });
  const startedUsage = new Promise(resolve => { usageBegan = resolve; });
  const f = fixture({ rows: [proxy(1)], async onUsage() { usageBegan(); await pendingUsage; } });
  const route = await f.routing.resolve('plus');
  let launched = false;
  const result = f.routing.verifiedStart(route, () => { launched = true; })({});
  await startedUsage;
  const launchedWhileWritePending = launched;
  releaseUsage();
  await result;
  assert.equal(launchedWhileWritePending, true);
});

test('startup compares IPv6 addresses independently of their text representation', async () => {
  const ips = ['2606:4700:4700::1111', '2606:4700:4700:0:0:0:0:1111'];
  const f = fixture({ rows: [proxy(1)], measure: () => ({ ip: ips.shift(), countryCode: 'PH', latencyMs: 10 }) });
  const route = await f.routing.resolve('plus');
  const workerProxy = await f.routing.verifiedStart(route, env => env.PROXY)({});
  assert.equal(workerProxy, route.proxy);
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
test('auxiliary storage and logging failures never block a verified route or mark it unhealthy', async () => {
  for (const failures of [['history-read'], ['history-write'], ['status-write'], ['usage-write'],
    ['history-read', 'history-write', 'status-write', 'usage-write', 'warning', 'start-log']]) {
    const f = fixture({ rows: [proxy(1)], failures });
    const route = await f.routing.resolve('plus');
    let started = false;
    await f.routing.verifiedStart(route, () => { started = true; })({ PROXY: route.proxy });
    if (failures.includes('history-read')) await f.routing.view();
    await setImmediate();
    assert.equal(started, true);
    assert.equal(f.calls.filter(call => call[0] === 'probe').length, 2);
    assert.ok(!f.calls.some(call => call[0] === 'check' && call[2] === false));
    assert.ok(f.warnings.length > 0);
    assert.doesNotMatch(JSON.stringify(f.warnings), /private|credentials|synthetic-secret/);
  }
});
test('required policy and pool reads still fail closed without probing or direct fallback', async () => {
  for (const failure of ['policy', 'pool-read', 'type-read', 'proxy-read']) {
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
  assert.equal(f.substitutions(), 3);
  let ran = false;
  await f.routing.verifiedStart(second, () => { ran = true; })({ PROXY: second.proxy });
  assert.equal(ran, true);
  const [initialWinner, initialBackup, ...nextProbes] = f.calls.filter(call => call[0] === 'probe').map(call => call[1]);
  assert.equal(initialWinner, first.proxy);
  assert.notEqual(initialBackup, second.proxy);
  assert.deepEqual(nextProbes, [second.proxy, second.proxy]);
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

const manualProxy = (id, label, enabled = 1) => ({ ...proxy(id, enabled, label),
  proxy_url: 'http://fixture-{session}:example@proxy.example.test:' + (9000 + id) });

test('manual selection ranks HTTP and SOCKS5 together, reuses the fastest session and never probes direct', async () => {
  const f = fixture({ rows: [manualProxy(1, 'PH'), manualProxy(2, 'PH'), manualProxy(3, 'EG'),
    proxy(4, 1, 'PH'), manualProxy(5, null), manualProxy(6, 'PH', 0)],
    measure: url => ({ ip: '1.1.1.1', countryCode: 'PH', latencyMs: url.startsWith('socks5h://') ? 4 : 40 }) });
  const options = await f.routing.manualOptions('plus');
  assert.deepEqual(options.choices.map(row => row.id), ['1', '2', '4']);
  assert.doesNotMatch(JSON.stringify(options), /example@|proxy\.example|fixture-/);
  const result = await f.routing.manualProbe('plus', 'auto');
  assert.equal(result.proxyId, 4);
  assert.equal(result.proxy, f.calls.find(row => row[1].endsWith(':1004'))[1]);
  assert.equal(new URL(result.proxy).protocol, 'socks5h:');
  assert.deepEqual(f.calls.map(call => call[0]), ['probe', 'probe', 'probe']);
  await f.routing.validateManual(result);
  assert.equal(f.substitutions(), 3);
  const empty = fixture();
  await assert.rejects(empty.routing.manualProbe('plus', 'auto'), /没有符合测速条件的线路/);
  assert.equal(empty.calls.length, 0);
});

test('manual routes accept all pool protocols and retain the source protocol and measured URL', async () => {
  const host = 'gateway.example.test';
  const schemes = ['http', 'https', 'socks', 'socks4', 'socks5', 'socks5h'];
  const expected = [`http://${host}:80`, `https://${host}:443`, `socks5h://${host}:1080`,
    `socks4://${host}:1080`, `socks5h://${host}:1080`, `socks5h://${host}:1080`];
  const pool = normalizeRechargeProxyInput(schemes.map(scheme => scheme.toUpperCase() + '://' + host));
  const rows = pool.proxies.map((proxy_url, i) => ({ ...manualProxy(i + 1, 'PH'), proxy_url }));
  const f = fixture({ rows, measure: url => ({
    ip: '8.8.8.8', countryCode: 'PH', latencyMs: url.startsWith('https://') ? 3 : 25
  }) });
  const { choices } = await f.routing.manualOptions('plus');
  assert.deepEqual(choices.map(choice => choice.protocol), schemes);
  assert.doesNotMatch(JSON.stringify(choices), /gateway|:\/\//);
  const fastest = await f.routing.manualProbe('plus', 'auto');
  assert.equal(fastest.protocol, 'https');
  assert.equal(fastest.proxy, expected[1]);
  assert.deepEqual(f.calls.map(call => call[1]).sort(), [...expected].sort());
  for (const [i, choice] of choices.entries()) {
    const route = await f.routing.manualProbe('plus', choice.id);
    assert.equal(route.protocol, schemes[i]);
    assert.equal(route.proxy, expected[i]);
    assert.equal(f.calls.at(-1)[1], route.proxy);
  }
});

test('manual HTTPS preserves TLS, nondefault ports and the exact measured provider session', async () => {
  const row = { ...manualProxy(1, 'PH'), proxy_url: 'https://qa-{session}:p%40ss@gateway.example.test:8443' };
  const f = fixture({ rows: [row], types: [[1, 'mobile']] });
  const route = await f.routing.manualProbe('plus', '1');
  assert.match(route.proxy, /^https:\/\/qa-synthetic-sticky-1:p%40ss@gateway\.example\.test:8443$/);
  assert.equal(f.calls[0][1], route.proxy);
  await f.routing.validateManual(route);
  assert.equal(f.substitutions(), 1);
});

test('manual HTTP and SOCKS dials pin validated public DNS without changing the proxy hostname', async () => {
  const url = 'https://synthetic:password@gateway.example.test:9443';
  const addresses = [{ address: '2001:4860::42', family: 6 }, { address: '8.8.4.4', family: 4 }];
  let calls = 0;
  const dial = await manualProxyDialOptions(url, { resolve: async (host, options) => {
    assert.equal(host, 'gateway.example.test.');
    assert.deepEqual(options, { all: true });
    calls++;
    return addresses;
  } });
  assert.equal(dial.lookup, dial.socketOptions.lookup);
  // HTTP/TLS and the SOCKS client both receive the same dial filter, while
  // the TLS implementation can read the original identity from the URL.
  for (const lookup of [dial.lookup, dial.socketOptions.lookup]) {
    lookup('gateway.example.test', { all: true }, (error, result) => {
      assert.ifError(error);
      assert.deepEqual(result, [addresses[1]]);
    });
    lookup('gateway.example.test', {}, (error, address, family) => {
      assert.ifError(error);
      assert.equal(address, '8.8.4.4');
      assert.equal(family, 4);
    });
    lookup('other.example.test', {}, error => assert.match(error.message, /主机不匹配/));
  }
  assert.equal(calls, 1);
});

test('manual DNS fails closed for a private answer, mixed answer set or private literal', async () => {
  const url = 'socks5h://gateway.example.test:1080';
  for (const [address, family] of [['127.0.0.1', 4], ['169.254.169.254', 4], ['192.0.0.9', 4],
    ['::1', 6], ['2002::1', 6], ['::ffff:192.168.0.1', 6], ['3fff::1', 6]]) {
    await assert.rejects(manualProxyDialOptions(url, { resolve: async () =>
      [{ address: '1.1.1.1', family: 4 }, { address, family }] }), /DNS 含不可用地址/);
  }
  await assert.rejects(manualProxyDialOptions('http://10.0.0.1:8080', { resolve: assert.fail }),
    /DNS 含不可用地址/);
  await assert.rejects(manualProxyDialOptions(url, { timeout: 5, resolve: () => new Promise(() => {}) }), /DNS 查询超时/);
});

test('SOCKS4 preserves the user ID and excludes an unusable configured password or unsupported protocol', async () => {
  const row = { ...manualProxy(1, 'PH'), proxy_url: 'socks4://qa-{session}@gateway.example.test:80' };
  const f = fixture({ rows: [row], types: [[1, 'mobile']] });
  const route = await f.routing.manualProbe('plus', 'auto');
  assert.equal(route.protocol, 'socks4');
  assert.equal(route.proxy, 'socks4://qa-synthetic-sticky-1@gateway.example.test:80');
  assert.equal(f.calls[0][1], route.proxy);
  assert.equal(f.substitutions(), 1);
  for (const url of ['socks4://qa:fixture-password@gateway.example.test', 'future://gateway.example.test:9000']) {
    const excluded = fixture({ rows: [{ ...row, proxy_url: url }] });
    assert.deepEqual((await excluded.routing.manualOptions('plus')).choices, []);
    await assert.rejects(excluded.routing.manualProbe('plus', 'auto'), /代理协议、认证方式/);
    assert.equal(excluded.calls.length, 0);
  }
});

test('manual SOCKS5 uses remote DNS and RFC 1929 byte lengths for both credentials', async () => {
  const makeRow = value => ({ ...manualProxy(1, 'PH'), proxy_url: value });
  const authority = '@gateway.example.test:80';
  for (const scheme of ['socks', 'socks5', 'socks5h']) {
    const username = 'é'.repeat(127) + ':';
    const password = '界'.repeat(85);
    const credentials = encodeURIComponent(username) + ':' + encodeURIComponent(password);
    const raw = scheme + '://' + credentials + authority;
    const f = fixture({ rows: [makeRow(raw)] });
    const result = await f.routing.manualProbe('plus', '1');
    assert.equal(result.proxy, 'socks5h://' + credentials + authority);
    assert.equal(f.calls[0][1], result.proxy);
    const unauth = fixture({ rows: [makeRow(scheme + '://gateway.example.test:1080')] });
    assert.equal((await unauth.routing.manualProbe('plus', '1')).proxy, 'socks5h://gateway.example.test:1080');
  }
  for (const value of ['socks5://gateway.example.test:0', 'socks5://:@gateway.example.test:1080',
    'socks5://user:@gateway.example.test:1080', 'socks5://:password@gateway.example.test:1080',
    'socks5://user:%00@gateway.example.test:1080', 'socks5://user:%zz@gateway.example.test:1080',
    'socks5://' + encodeURIComponent('é'.repeat(128)) + ':x' + authority,
    'socks5://u:' + 'a'.repeat(256) + authority, 'https://bad%3Aname:password@gateway.example.test',
    'socks5h://127.0.0.1:1080']) {
    const f = fixture({ rows: [makeRow(value)] });
    assert.equal((await f.routing.manualOptions('plus')).choices.length, 0);
    await assert.rejects(f.routing.manualProbe('plus', '1'), /所选线路测速未通过/);
    assert.equal(f.calls.length, 0);
  }
});

test('six enabled typed Philippine SOCKS entries yield only the reusable session for manual launch', async () => {
  const rows = Array.from({ length: 6 }, (_, index) => {
    const row = proxy(index + 1, 1, 'PH');
    if (index !== 3) row.proxy_url = row.proxy_url.replace('{session}', 'fixed');
    return row;
  });
  const types = rows.map(row => [row.id, row.id % 2 ? 'mobile' : 'dynamic_residential']);
  const f = fixture({ rows, types });
  assert.deepEqual((await f.routing.manualOptions('plus')).choices.map(choice => choice.id), ['4']);
  await assert.rejects(f.routing.manualProbe('plus', '2'), /所选线路测速未通过/);
  assert.equal(f.calls.length, 0);
  const selected = await f.routing.manualProbe('plus', 'auto');
  assert.equal(selected.proxyId, 4);
  assert.equal(f.substitutions(), 1);
  assert.equal(f.calls[0][1], selected.proxy);
  assert.equal(new URL(selected.proxy).protocol, 'socks5h:');
  await f.routing.validateManual(selected);
  assert.equal(f.substitutions(), 1);
});

test('manual choice measures only requested row; mismatched country has no measured fallback', async () => {
  const rows = [manualProxy(1, 'PH'), manualProxy(2, 'PH')];
  const f = fixture({ rows, countries: ['EG', 'PH'] });
  await assert.rejects(f.routing.manualProbe('plus', '1'), /所选线路测速未通过/);
  assert.equal(f.calls.length, 1);
  assert(f.calls[0][1].endsWith(':9001'));
  const result = await f.routing.manualProbe('plus', '1');
  assert.equal(result.proxyId, 1);
  assert(f.calls.every(call => call[1].endsWith(':9001')));
});

test('manual auto considers unmarked candidates only after named country candidates fail', async () => {
  const f = fixture({ rows: [manualProxy(1, 'PH'), manualProxy(2, null)], countries: ['EG', 'PH'] });
  const route = await f.routing.manualProbe('plus', 'auto');
  assert.equal(route.proxyId, 2);
  assert.equal(f.calls.filter(c => c[0] === 'probe').length, 2);
  assert.equal((await f.routing.manualOptions('plus')).choices.length, 1);
  await f.routing.checkProxy(2); // An independent existing observation makes its IP available as a hint.
  assert.deepEqual((await f.routing.manualOptions('plus')).choices[1], {
    id: '2', name: '线路 #2', countryCode: 'PH', protocol: 'http', referenceIp: '8.8.8.8'
  });
});

test('manual ticket configuration recheck catches plan, provider credential, type, country or enable changes', async () => {
  for (const field of ['country', 'url', 'type', 'enabled', 'policy']) {
    const f = fixture({ rows: [manualProxy(1, 'PH')], types: [[1, 'mobile']] });
    const selected = await f.routing.manualProbe('plus', 'auto');
    if (field === 'country') f.rows[0].label_country_code = 'EG';
    if (field === 'url') f.rows[0].proxy_url += '/';
    if (field === 'type') assert.equal((await f.request('PUT', '/proxies/1/type', {
      expectedProxyType: 'mobile', proxyType: 'dynamic_residential' })).statusCode, 200);
    if (field === 'enabled') f.rows[0].is_active = 0;
    if (field === 'policy') await f.routing.savePolicy({ version: 1, plans: { ...DEFAULT_PLAN_ROUTES, plus: 'EG' } }, 'fixture');
    await assert.rejects(f.routing.validateManual(selected), /已变更/);
  }
});

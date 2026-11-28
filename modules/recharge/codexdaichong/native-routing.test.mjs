import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { setImmediate } from 'node:timers/promises';
import { createNativeRechargeRouting, DEFAULT_PLAN_ROUTES, parseExitTrace,
  validatePlanRoutes, migrateRechargeRouting } from './native-routing.mjs';

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

import { createHash, randomInt } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { isIP } from 'node:net';
import { join } from 'node:path';

export const ROUTE_REGIONS = Object.freeze({
  PH: { label: '菲律宾', currency: 'PHP' },
  EG: { label: '埃及', currency: 'EGP' },
  MY: { label: '马来西亚', currency: 'MYR' },
  SG: { label: '新加坡', currency: 'SGD' },
  US: { label: '美国', currency: 'USD' }
});
export const DEFAULT_PLAN_ROUTES = Object.freeze({ plus: 'PH', pro100: 'EG', pro200: 'PH', pro500: 'EG' });
const planKeys = Object.keys(DEFAULT_PLAN_ROUTES);
const fingerprint = value => createHash('sha256').update(value).digest('hex');
const directHash = fingerprint('id-recharge-direct-network-v1');
const traceEndpoint = 'https://www.cloudflare.com/cdn-cgi/trace';

export class RechargeRouteError extends Error {
  constructor(message, code = 'recharge_route_unavailable') {
    super(message);
    this.code = code;
    this.publicMessage = '当前套餐的充值线路暂不可用，请联系客服处理。';
  }
}

export function validatePlanRoutes(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      Object.keys(value).length !== planKeys.length ||
      !planKeys.every(plan => Object.hasOwn(value, plan) && typeof value[plan] === 'string' && Object.hasOwn(ROUTE_REGIONS, value[plan])))
    throw new RechargeRouteError('请为四种套餐分别选择有效支付地区', 'invalid_route_config');
  return Object.fromEntries(planKeys.map(plan => [plan, value[plan]]));
}

function publicIp(value) {
  const kind = isIP(value);
  if (kind === 4) {
    const [a, b, c] = value.split('.').map(Number);
    return a !== 0 && a !== 10 && a !== 127 && a < 224 &&
      !(a === 169 && b === 254) && !(a === 172 && b >= 16 && b <= 31) &&
      !(a === 192 && (b === 168 || (b === 0 && [0, 2].includes(c)))) && !(a === 100 && b >= 64 && b <= 127) &&
      !(a === 198 && ([18, 19].includes(b) || (b === 51 && c === 100))) && !(a === 203 && b === 0 && c === 113);
  }
  return kind === 6 && /^[23][0-9a-f]{0,3}:/i.test(value) && !/^2001:db8/i.test(value);
}

export function parseExitTrace(body) {
  if (typeof body !== 'string' || Buffer.byteLength(body) > 16384)
    throw new RechargeRouteError('出口检测返回无效资料');
  const ips = [...body.matchAll(/^ip=([^\r\n]+)$/gm)].map(match => match[1].trim());
  const countries = [...body.matchAll(/^loc=([A-Z]{2})\r?$/gm)].map(match => match[1]);
  if (ips.length !== 1 || countries.length !== 1 || !publicIp(ips[0]) || countries[0] === 'XX')
    throw new RechargeRouteError('无法核实公网出口及国家');
  return { ip: ips[0], countryCode: countries[0], source: 'Cloudflare trace' };
}

/** Fixed public destination only. Proxy authentication is never sent as destination data. */
export function createExitProbe(engineDir) {
  const require = createRequire(join(engineDir, 'package.json'));
  const axios = require('axios');
  const { ProxyAgent } = require('proxy-agent');
  return async (proxy, timeoutMs = 10000) => {
    const started = Date.now();
    const agent = proxy ? new ProxyAgent({ getProxyForUrl: () => proxy }) : undefined;
    try {
      const result = await axios.get(traceEndpoint, {
        ...(agent ? { httpAgent: agent, httpsAgent: agent } : {}),
        proxy: false, timeout: Math.max(1, Math.min(10000, timeoutMs)),
        maxRedirects: 0, maxContentLength: 16384, maxBodyLength: 16384,
        responseType: 'text', transformResponse: [value => value],
        headers: { Accept: 'text/plain' }, validateStatus: status => status === 200
      });
      return { ...parseExitTrace(result.data), latencyMs: Date.now() - started };
    } catch {
      // Axios errors can contain proxy credentials. Only emit a fixed diagnostic.
      throw new RechargeRouteError('出口国家检测失败，请检查线路后重试');
    } finally { agent?.destroy(); }
  };
}

export async function migrateRechargeRouting(connection) {
  const migration = await readFile(new URL('./routing-migration.sql', import.meta.url), 'utf8');
  for (const sql of migration.split(/;\s*(?:\n|$)/).map(value => value.trim()).filter(Boolean))
    await connection.query(sql);
  await connection.query(`INSERT IGNORE INTO id_recharge_route_config
    (singleton_id, version, plans_json, audit_json) VALUES (1, 1, ?, ?)`, [
    JSON.stringify(DEFAULT_PLAN_ROUTES),
    JSON.stringify([{ version: 1, actor: 'migration', at: new Date().toISOString(), plans: DEFAULT_PLAN_ROUTES }])
  ]);
}

const json = value => typeof value === 'string' ? JSON.parse(value) : value;
const safeId = value => Number.isSafeInteger(Number(value)) && Number(value) > 0;
const shuffle = rows => {
  const result = [...rows];
  for (let i = result.length - 1; i > 0; i--) {
    const j = randomInt(i + 1); [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
};

/** Only resolves the startup environment. It never starts, cancels or retries payment. */
export function createNativeRechargeRouting({ store, engineDir, probe, substituteSession, now = Date.now,
  chooseOrder = shuffle, onWarning = message => console.warn('[Recharge routing] ' + message) }) {
  const exitProbe = probe ?? createExitProbe(engineDir);
  const substitute = substituteSession ?? createRequire(join(engineDir, 'package.json'))('./proxy-pool').substituteProxySession;
  const query = async (sql, values = []) => {
    try { return await store.runQuery(sql, values); }
    catch { throw new RechargeRouteError('套餐选路资料尚未就绪，请检查路由迁移', 'route_storage_unavailable'); }
  };
  const execute = async (sql, values = []) => {
    try { return await store.runExecute(sql, values); }
    catch { throw new RechargeRouteError('无法保存选路资料，请稍后核对', 'route_storage_unavailable'); }
  };
  // Observation and usage records are auxiliary. Their errors must never turn a
  // successful live probe into a failed route or expose a database/proxy error.
  const auxiliary = async (message, operation) => {
    try { return await operation(); }
    catch {
      try { onWarning(message)?.catch?.(() => {}); } catch { /* Logging is auxiliary too. */ }
    }
  };
  async function policy() {
    const [row] = await query('SELECT version, plans_json, audit_json FROM id_recharge_route_config WHERE singleton_id = 1');
    if (!row || !Number.isSafeInteger(Number(row.version)) || Number(row.version) < 1)
      throw new RechargeRouteError('套餐选路配置未初始化', 'route_storage_unavailable');
    return { version: Number(row.version), plans: validatePlanRoutes(json(row.plans_json)), audit: json(row.audit_json) };
  }
  async function observations() {
    return await auxiliary('检测历史读取失败，本次以实时出口检测为准', async () => {
      const rows = await query(`SELECT proxy_id, config_hash, country_code, exit_ip, check_status,
        check_source, UNIX_TIMESTAMP(checked_at)*1000 AS checked_ms, latency_ms FROM id_recharge_proxy_checks`);
      return rows.map(row => ({ proxyId: Number(row.proxy_id), configHash: row.config_hash,
        countryCode: row.country_code, ip: row.exit_ip, status: row.check_status,
        source: row.check_source, checkedAt: new Date(Number(row.checked_ms)).toISOString(),
        latencyMs: row.latency_ms == null ? null : Number(row.latency_ms) }));
    }) ?? [];
  }
  async function saveCheck(id, hash, result, status = 'verified') {
    await execute(`INSERT INTO id_recharge_proxy_checks
      (proxy_id, config_hash, country_code, exit_ip, check_status, check_source, checked_at, latency_ms)
      VALUES (?, ?, ?, ?, ?, ?, UTC_TIMESTAMP(3), ?)
      ON DUPLICATE KEY UPDATE config_hash=VALUES(config_hash), country_code=VALUES(country_code),
      exit_ip=VALUES(exit_ip), check_status=VALUES(check_status), check_source=VALUES(check_source),
      checked_at=VALUES(checked_at), latency_ms=VALUES(latency_ms)`,
    [id, hash, result?.countryCode ?? '', result?.ip ?? '', status, 'Cloudflare trace', result?.latencyMs ?? null]);
  }
  async function inspectExit(id, raw, resolved, timeout) {
    const hash = id ? fingerprint(raw.trim()) : directHash;
    let result;
    try {
      result = await exitProbe(resolved, timeout);
      if (!publicIp(result?.ip ?? '') || !/^[A-Z]{2}$/.test(result?.countryCode ?? '') || result.countryCode === 'XX')
        throw new RechargeRouteError('检测服务没有提供可核实的国家');
    } catch {
      await auxiliary('出口检测失败记录保存失败', () => saveCheck(id, hash, null, 'failed'));
      if (id) await auxiliary('代理检测状态保存失败', () =>
        store.updateProxyAssetCheck(id, { ok: false, error: '出口国家检测失败' }));
      throw new RechargeRouteError('出口国家检测失败，请检查线路后重试');
    }
    await auxiliary('出口检测成功，检测记录保存失败', () => saveCheck(id, hash, result));
    if (id) await auxiliary('出口检测成功，代理检测状态保存失败', () =>
      store.updateProxyAssetCheck(id, { ok: true, ip: result.ip, latencyMs: result.latencyMs }));
    return { ...result, checkedAt: new Date(now()).toISOString(), configHash: hash };
  }
  async function proxies() {
    return query('SELECT id, proxy_url, is_active FROM proxy_assets ORDER BY sort_order ASC, id ASC');
  }
  async function currentProxy(id) {
    const rows = await query('SELECT id, proxy_url, is_active FROM proxy_assets WHERE id = ?', [id]);
    return rows[0];
  }
  async function checkProxy(id) {
    if (!safeId(id)) throw new RechargeRouteError('代理编号无效', 'invalid_proxy');
    const row = await currentProxy(Number(id));
    if (!row) throw new RechargeRouteError('代理不存在', 'invalid_proxy');
    const resolved = substitute(String(row.proxy_url));
    const result = await inspectExit(Number(id), String(row.proxy_url), resolved, 10000);
    return { ok: true, ...result, configHash: undefined };
  }
  async function resolve(planType) {
    const config = await policy();
    const country = Object.hasOwn(config.plans, planType) ? config.plans[planType] : '';
    if (!country) throw new RechargeRouteError('该套餐尚未配置支付地区', 'plan_route_missing');
    const base = { planType, region: country, currency: ROUTE_REGIONS[country].currency, configVersion: config.version };
    return selectRoute(base, true);
  }
  // Re-enter only at the upstream outer-attempt proxy selection point. The
  // accepted task's country stays fixed; every new attempt gets a fresh route.
  async function nextAttempt(route) {
    return selectRoute({ planType: route.planType, region: route.region,
      currency: route.currency, configVersion: route.configVersion }, false);
  }
  async function selectRoute(base, requireCurrentPolicy) {
    const country = base.region;
    const rows = await proxies();
    const policyChanged = async () => requireCurrentPolicy && (await policy()).version !== base.configVersion;
    if (!rows.length) {
      const result = await inspectExit(0, '', '', 10000);
      if (result.countryCode !== country)
        throw new RechargeRouteError(`代理池为空；服务器直连出口为 ${result.countryCode}，套餐要求 ${country}`);
      if ((await proxies()).length || await policyChanged())
        throw new RechargeRouteError('选路配置在检测期间发生变化，请重新提交');
      return Object.freeze({ ...base, ...result, proxyId: 0, proxy: '' });
    }
    const active = rows.filter(row => Number(row.is_active) === 1);
    if (!active.length) throw new RechargeRouteError('代理池存在条目，但没有启用的代理；未改为直连');
    const checked = await observations();
    const knownMatching = new Set(checked.filter(row => row.status === 'verified' && row.countryCode === country)
      .map(row => row.proxyId));
    const candidates = [...chooseOrder(active.filter(row => knownMatching.has(Number(row.id)))),
      ...chooseOrder(active.filter(row => !knownMatching.has(Number(row.id))))];
    const deadline = now() + 20000;
    for (const row of candidates) {
      if (now() >= deadline) break;
      const raw = String(row.proxy_url);
      const resolved = substitute(raw);
      let result;
      try { result = await inspectExit(Number(row.id), raw, resolved, deadline - now()); }
      catch { continue; }
      if (result.countryCode !== country) continue;
      const latest = await currentProxy(Number(row.id));
      if (!latest || Number(latest.is_active) !== 1 || fingerprint(String(latest.proxy_url).trim()) !== result.configHash)
        throw new RechargeRouteError('代理在检测期间发生变化，请重新提交');
      if (await policyChanged())
        throw new RechargeRouteError('套餐地区配置已更新，请重新提交');
      await auxiliary('代理使用次数保存失败', () =>
        execute('UPDATE proxy_assets SET usage_count = usage_count + 1 WHERE id = ?', [Number(row.id)]));
      return Object.freeze({ ...base, ...result, proxyId: Number(row.id), proxy: resolved });
    }
    throw new RechargeRouteError(`未找到已核验的 ${ROUTE_REGIONS[country].label}（${country}）可用出口，任务未启动`);
  }
  async function revalidate(route) {
    let raw = '';
    if (route.proxyId) {
      const row = await currentProxy(route.proxyId);
      if (!row || Number(row.is_active) !== 1 || fingerprint(String(row.proxy_url).trim()) !== route.configHash)
        throw new RechargeRouteError('已选代理已变更或停用，未启动充值');
      raw = String(row.proxy_url);
    } else if ((await proxies()).length) {
      throw new RechargeRouteError('代理池状态已变化，请重新选择执行线路');
    }
    const result = await inspectExit(route.proxyId, raw, route.proxy, 10000);
    if (result.countryCode !== route.region) throw new RechargeRouteError('启动前出口国家发生变化，未启动充值');
  }
  async function savePolicy(body, actor) {
    if (!body || Object.keys(body).some(key => !['version', 'plans'].includes(key)) ||
        !Number.isSafeInteger(body.version) || body.version < 1 || body.version >= Number.MAX_SAFE_INTEGER)
      throw new RechargeRouteError('套餐地区配置版本无效', 'invalid_route_config');
    const plans = validatePlanRoutes(body.plans);
    const event = { version: body.version + 1, actor: String(actor || 'admin').slice(0, 254),
      at: new Date(now()).toISOString(), plans };
    const result = await execute(`UPDATE id_recharge_route_config SET plans_json = ?,
      audit_json = JSON_ARRAY_APPEND(audit_json, '$', CAST(? AS JSON)), version = version + 1
      WHERE singleton_id = 1 AND version = ?`, [JSON.stringify(plans), JSON.stringify(event), body.version]);
    if (Number(result.affectedRows) !== 1)
      throw new RechargeRouteError('配置已被更新，请刷新后重试', 'route_version_conflict');
    return policy();
  }
  async function checkViews() {
    const [rows, checked] = await Promise.all([proxies(), observations()]);
    return checked.filter(check => check.proxyId === 0 || rows.some(row => Number(row.id) === check.proxyId &&
      fingerprint(String(row.proxy_url).trim()) === check.configHash))
      .map(({ configHash, ...value }) => value);
  }
  async function view() {
    const config = await policy();
    return { ...config, audit: config.audit.slice(-10), auditCount: config.audit.length,
      regions: ROUTE_REGIONS, checks: await checkViews(), localFallback: 'empty_pool_only', billingAddressCountry: 'US' };
  }
  async function checkLocal() {
    const result = await inspectExit(0, '', '', 10000);
    return { ok: true, ...result, configHash: undefined };
  }
  async function handleAdmin(req, res) {
    try {
      const path = req.path.replace(/\/+$/, '') || '/';
      if (req.method === 'GET' && path === '/') return res.json({ success: true, ...await view() });
      if (req.method === 'PUT' && path === '/') {
        await savePolicy(req.body, req.admin?.email);
        return res.json({ success: true, ...await view() });
      }
      if (req.method === 'POST' && path === '/check-local') {
        if (Object.keys(req.body || {}).length) throw new RechargeRouteError('不支持的检测参数', 'invalid_probe');
        return res.json({ success: true, ...await checkLocal() });
      }
      const match = /^\/proxies\/([1-9]\d*)\/check$/.exec(path);
      if (req.method === 'POST' && match) {
        if (Object.keys(req.body || {}).length) throw new RechargeRouteError('不支持的检测参数', 'invalid_probe');
        return res.json({ success: true, ...await checkProxy(Number(match[1])) });
      }
      return res.status(404).json({ success: false, message: '接口不存在' });
    } catch (error) {
      const status = error.code === 'route_version_conflict' ? 409 : error.code?.startsWith('invalid_') ? 400 : 503;
      return res.status(status).json({ success: false, code: error.code || 'route_storage_unavailable',
        message: error instanceof RechargeRouteError ? error.message : '选路资料未就绪，请检查运行配置' });
    }
  }
  return {
    resolve, nextAttempt, revalidate, checkProxy,
    view, savePolicy, checkLocal, handleAdmin,
    verifiedStart(route, run) { return async env => { await revalidate(route); return run(env); }; },
    describe(route) { return `套餐选路 plan=${route.planType} region=${route.region} currency=${route.currency} network=${route.proxyId ? 'proxy#' + route.proxyId : 'direct'} country=${route.countryCode}`; }
  };
}

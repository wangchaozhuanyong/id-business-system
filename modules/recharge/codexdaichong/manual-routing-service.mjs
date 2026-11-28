import { randomBytes } from 'node:crypto';
import { isProxyType } from '../bitbrowser/proxy-types.mjs';
import { DEFAULT_PLAN_ROUTES, ROUTE_REGIONS, RechargeRouteError } from './native-routing.mjs';
import { ManualRouteError, manualRoutingDigest, manualRoutingPrefix } from './manual-routing-client.mjs';

const ticketLifetimeMs = 120_000;
const actionPath = new RegExp('^' + manualRoutingPrefix + '(options|probe|consume|validate)\\?digest=([a-f0-9]{64})$');
const bindingFields = ['planType', 'region', 'configVersion', 'proxyId', 'proxyType', 'labelCountryCode', 'configHash'];

function readBinding(command) {
  const binding = command?.routeBinding;
  if (!binding || typeof binding !== 'object' || Object.keys(command).length !== 1 ||
      Object.keys(binding).length !== bindingFields.length || !bindingFields.every(field => Object.hasOwn(binding, field)) ||
      typeof binding.planType !== 'string' || !Object.hasOwn(DEFAULT_PLAN_ROUTES, binding.planType) ||
      typeof binding.region !== 'string' || !Object.hasOwn(ROUTE_REGIONS, binding.region) ||
      !Number.isSafeInteger(binding.configVersion) || binding.configVersion < 1 ||
      !Number.isSafeInteger(binding.proxyId) || binding.proxyId < 1 ||
      !(binding.proxyType === null || isProxyType(binding.proxyType)) ||
      !(binding.labelCountryCode === null || binding.labelCountryCode === binding.region) ||
      typeof binding.configHash !== 'string' || !/^[0-9a-f]{64}$/.test(binding.configHash))
    throw new ManualRouteError(400, '窗口的线路绑定资料无效');
  return binding;
}

function requireInput(command, action) {
  const fields = action === 'options' ? ['plan'] :
    ['email', 'plan', action === 'probe' ? 'proxyId' : 'ticket'];
  if (!command || Array.isArray(command) || typeof command !== 'object' ||
      Object.keys(command).length !== fields.length || fields.some(field =>
        !Object.hasOwn(command, field) || typeof command[field] !== 'string') ||
      !(action === 'options' && !command.plan) && !Object.hasOwn(DEFAULT_PLAN_ROUTES, command.plan))
    throw new ManualRouteError(400, '请核对账号、套餐与执行线路');
  if (action === 'options') return;
  const email = command.email.trim().toLowerCase();
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ||
      (action === 'probe' && command.proxyId !== 'auto' && !/^[1-9]\d{0,15}$/.test(command.proxyId)) ||
      (action === 'consume' && !/^[a-f0-9]{64}$/.test(command.ticket)))
    throw new ManualRouteError(400, '请核对账号、套餐与执行线路');
  return email;
}

export function createManualRouteTickets(routing, { now = Date.now } = {}) {
  // At most the latest measurement for each operator can be used. Replace it
  // before awaiting I/O so a slower earlier probe cannot resurrect stale credentials.
  const latest = new Map();
  function forget(owner, entry) {
    if (latest.get(owner) !== entry) return;
    latest.delete(owner);
    clearTimeout(entry?.expiry);
  }
  const stale = () => new ManualRouteError(409, '该测速结果已失效，请重新测速');
  return async (owner, action, command) => {
    if (action === 'validate') {
      await routing.validateManual(readBinding(command));
      return { ok: true };
    }
    const email = requireInput(command, action);
    if (action === 'options') return routing.manualOptions(command.plan);
    if (action === 'probe') {
      const previous = latest.get(owner);
      if (previous) forget(owner, previous);
      const entry = { email, plan: command.plan };
      latest.set(owner, entry);
      try {
        const route = await routing.manualProbe(command.plan, command.proxyId);
        if (latest.get(owner) !== entry) throw stale();
        entry.route = route;
        entry.ticket = randomBytes(32).toString('hex');
        entry.expiresAt = now() + ticketLifetimeMs;
        entry.expiry = setTimeout(() => forget(owner, entry), ticketLifetimeMs).unref();
        return { ticket: entry.ticket, expiresAt: entry.expiresAt, ip: route.ip, countryCode: route.region, latencyMs: route.latencyMs,
          name: '线路 #' + route.proxyId, protocol: route.protocol };
      } catch (error) { forget(owner, entry); throw error; }
    }
    const entry = latest.get(owner);
    if (!entry || entry.claimed || entry.email !== email || entry.plan !== command.plan || entry.ticket !== command.ticket)
      throw stale();
    // Claim synchronously. Even overlapping consume requests can hand the
    // measured connection to at most one browser launch.
    entry.claimed = true;
    try {
      if (entry.expiresAt <= now()) throw stale();
      await routing.validateManual(entry.route);
      if (latest.get(owner) !== entry || entry.expiresAt <= now()) throw stale();
      const routeBinding = Object.fromEntries(bindingFields.map(field => [field, entry.route[field]]));
      return { proxyUrl: entry.route.proxy, expectedCountry: entry.route.region, expectedIp: entry.route.ip, routeBinding };
    } finally { forget(owner, entry); }
  };
}

export async function handleManualRouting(req, res, actor, tickets) {
  const send = (status, payload) => {
    res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(payload));
  };
  try {
    const match = actionPath.exec(req.url);
    if (!match || req.method !== 'POST') throw new ManualRouteError(404, '接口不存在');
    if (!actor.admin || !/^manual-routing:[a-f0-9]{64}$/.test(actor.id))
      throw new ManualRouteError(403, '仅供手动充值工作台调用');
    if (!tickets) throw new ManualRouteError(503, '手动充值线路服务暂不可用');
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || ''))
      throw new ManualRouteError(400, '请求格式无效');
    const chunks = [];
    let size = 0;
    for await (const chunk of req.iterator({ destroyOnReturn: false })) {
      size += chunk.length;
      if (size > 4096) { req.resume(); throw new ManualRouteError(400, '请求资料过大'); }
      chunks.push(chunk);
    }
    const body = Buffer.concat(chunks);
    if (manualRoutingDigest(body) !== match[2]) throw new ManualRouteError(403, '线路请求校验失败');
    let command;
    try { command = JSON.parse(body); } catch { throw new ManualRouteError(400, '请求格式无效'); }
    const result = await tickets(actor.id, match[1], command);
    send(200, { success: true, result });
  } catch (error) {
    let status = 503, message = '线路服务暂不可用，请稍后重试';
    if (error instanceof ManualRouteError) { status = error.status; message = error.message; }
    if (error instanceof RechargeRouteError) {
      status = error.code === 'route_version_conflict' ? 409 :
        error.code === 'recharge_route_unavailable' ? 422 : error.code.startsWith('invalid_') ? 400 : 503;
      message = error.message;
    }
    send(status, { success: false, error: message });
  }
}

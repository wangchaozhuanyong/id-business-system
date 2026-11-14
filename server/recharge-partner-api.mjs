import { createHash, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { createSourceLimit } from './login-security.mjs';
import { unassignedRechargeStock } from './recharge-code-requests.mjs';
import { numberedRechargeRequests } from './recharge-code-numbers.mjs';
import {
  rechargePartnerIdPattern, rechargeRequestIdPattern, storefrontRechargeCode, storefrontRechargePlan
} from '../modules/recharge/vendure/admission.mjs';

export const partnerAdminRoute = '/api/local/recharge-partners';
export const partnerApiPrefix = '/api/recharge/v1';
export const partnerAuthorizationPage = '/recharge/authorize';
export const partnerAuthorizationRoute = partnerAuthorizationPage + '/request';
const keyPattern = /^(rp_[a-f0-9]{24})\.([A-Za-z0-9_-]{43})$/;
const codePattern = /^RA-[A-F0-9]{32}$/;
const operationPattern = /^[A-Za-z0-9._-]{1,120}$/;
const ticketPattern = /^[A-Za-z0-9_-]{43}$/;
const plans = new Map([['plus', 'Plus'], ['pro_5x', 'Pro 100'], ['pro_20x', 'Pro 200']]);
const currentPlans = new Set(['plus', 'pro100', 'pro200']);
const taskStates = new Set(['queued', 'running', 'succeeded', 'failed', 'awaiting_review']);
const stages = new Set(['started', 'processing', 'payment_details', 'paying', 'paid', 'subscription_check']);
const ticketLifetime = 15 * 60_000;
const minute = 60_000;
const systemActor = { id: 'partner-recharge', name: '合作方充值' };

const secret = () => randomBytes(32).toString('base64url');
const digest = (value) => createHash('sha256').update(value).digest('hex');
const time = (now) => new Date(now).toISOString();
const normalizeCode = (value) => typeof value === 'string' ? value.trim().toUpperCase() : '';
const equalHash = (hash, value) => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash) &&
  timingSafeEqual(Buffer.from(hash, 'hex'), Buffer.from(digest(value), 'hex'));

class RequestError extends Error {
  constructor(status, code, message) {
    super(message || code);
    this.status = status;
    this.code = code;
  }
}

const unavailable = () => new RequestError(503, 'temporarily_unavailable', '充值服务暂不可用，请稍后查询');
const notFound = () => new RequestError(404, 'not_found', '未找到可用的兑换码或充值请求');
const invalid = () => new RequestError(400, 'invalid_request', '请求资料无效');
const conflict = (message) => new RequestError(409, 'conflict', message);

function json(res, status, body) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req, fields, maximum = 4096) {
  if (!/^application\/json(?:\s*;|$)/i.test(req.headers['content-type'] || '')) throw invalid();
  if (Number(req.headers['content-length']) > maximum)
    throw new RequestError(413, 'request_too_large', '提交的资料过长');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > maximum) {
      req.resume();
      throw new RequestError(413, 'request_too_large', '提交的资料过长');
    }
    chunks.push(chunk);
  }
  let input;
  try { input = JSON.parse(Buffer.concat(chunks)); } catch { throw invalid(); }
  if (!input || Array.isArray(input) || typeof input !== 'object' ||
      Object.keys(input).some(key => !fields.includes(key))) throw invalid();
  return input;
}

function publicPartner({ id, name, createdAt, disabledAt }) {
  return { id, name, createdAt, disabledAt };
}

function publicBatch({ id, batchNo, partnerId, plan, createdAt, codes }) {
  return { id, batchNo, partnerId, plan, createdAt, codes: codes.map(row => row.code) };
}

function taskView(row, task, now) {
  const fallback = row.state === 'open' && row.expiresAt <= now ? 'expired'
    : row.state === 'open' ? 'awaiting_authorization' : 'awaiting_review';
  const source = task && taskStates.has(task.status) && task.plan === row.plan &&
    Number.isFinite(Date.parse(task.updatedAt)) ? task : undefined;
  const status = source?.status || fallback;
  return {
    id: row.id, plan: row.plan, status,
    stage: status === 'running' ? (stages.has(source.stage) ? source.stage : 'processing') : status,
    updatedAt: source ? time(Math.max(Date.parse(source.updatedAt), Date.parse(row.updatedAt) + 1))
      : status === 'expired' ? time(row.expiresAt) : row.updatedAt,
    expiresAt: time(row.expiresAt)
  };
}

function validAccountSession(source, now) {
  if (typeof source !== 'string' || source.length > 256_000) return false;
  try {
    const data = JSON.parse(source);
    const token = data?.accessToken ?? data?.access_token;
    return Boolean(data?.user?.id && typeof data.user.email === 'string' &&
      data.user.email.includes('@') && typeof token === 'string' &&
      token.length >= 20 && token.length <= 24_000 &&
      (typeof data.expires !== 'string' || !(Date.parse(data.expires) <= now)));
  } catch {
    return false;
  }
}

export function createRechargePartnerHandlers({
  store, transport, gateway, origin, readSource, authorizeAdmin, clock = Date.now
}) {
  const readPartners = () => store.featureDocument('recharge-partners');
  const readRequests = () => store.featureDocument('recharge-partner-requests');
  const pendingBatches = new Map();
  const partnerFor = (id) => readPartners().data?.partners?.find(row => row.id === id && !row.disabledAt);
  const ownedCode = (partnerId, value) => {
    const code = normalizeCode(value);
    if (!codePattern.test(code)) throw notFound();
    for (const batch of readPartners().data?.batches ?? []) {
      if (batch.partnerId !== partnerId) continue;
      const entry = batch.codes.find(row => row.code === code);
      if (entry) return { ...entry, plan: storefrontRechargePlan(batch.plan) };
    }
    throw notFound();
  };
  const handleErrors = (run) => async (req, res, arg) => {
    try {
      await run(req, res, arg);
    } catch (error) {
      if (res.headersSent || res.destroyed) return;
      const failure = error instanceof RequestError ? error : error?.status === 409
        ? conflict('资料已更新，请刷新后重试') : unavailable();
      if (failure.status === 429) res.setHeader('Retry-After', '60');
      json(res, failure.status, { code: failure.code, error: failure.message });
    }
  };
  const limit = (maximum) => createSourceLimit({ maximum, windowMs: minute, clock });
  const sourceLimit = limit(180);
  const partnerLimit = limit(240);
  const requestLimit = limit(18);
  function throttle(check, key) {
    if (!check(key)) throw new RequestError(429, 'rate_limited', '请求过于频繁，请稍后重试');
  }
  async function queue(action, input) {
    if (!gateway) throw unavailable();
    return gateway(action, input);
  }
  function requestTask(row, clientIp) {
    if (row.state === 'open') return null;
    return queue('task', { partnerId: row.partnerId, requestId: row.id, clientIp });
  }
  async function lookup(code, partnerId, clientIp) {
    const status = await queue('query', { code: code.nativeCode, partnerId, clientIp });
    if (status && (status.plan !== code.plan || !['available', 'reserved', 'used', 'disabled'].includes(status.status)))
      throw unavailable();
    return status || { status: 'disabled', plan: code.plan };
  }
  const saveRequests = (snapshot, requests) =>
    store.saveFeatureDocument('recharge-partner-requests', snapshot.version, { requests });

  function operationId(value) {
    if (typeof value !== 'string' || !operationPattern.test(value)) throw invalid();
    return value;
  }
  function requestView(row, task, includeAuthorization = false) {
    return { ...taskView(row, task, clock()), ...(includeAuthorization && { authorizationUrl:
      origin + partnerAuthorizationPage + '#' + row.id + '.' + store.rechargePartnerTicket(row.id) }) };
  }
  const admin = handleErrors(async (req, res, actor) => {
    if (!actor?.id || actor.active !== true || actor.role !== 'super')
      throw new RequestError(actor ? 403 : 401, 'forbidden', '请使用超级管理员账号');
    const initial = readPartners();
    const partners = initial.data?.partners ?? [];
    const batches = initial.data?.batches ?? [];
    if (req.method === 'GET') {
      const input = new URL(req.url, origin).searchParams.get('page');
      const pages = Math.max(1, Math.ceil(batches.length / 20));
      const page = Math.min(pages, input && /^[1-9]\d{0,6}$/.test(input) ? Number(input) : 1);
      const end = batches.length - (page - 1) * 20;
      return json(res, 200, {
        version: initial.version, apiOrigin: origin, apiBase: origin + partnerApiPrefix,
        partners: partners.map(publicPartner), batches: batches.slice(Math.max(0, end - 20), end).reverse().map(publicBatch),
        page, pages
      });
    }
    if (req.method !== 'POST' || req.headers.origin !== origin ||
        (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin'))
      throw new RequestError(403, 'forbidden', '请在 ID 后台操作');
    if (!authorizeAdmin(req))
      throw new RequestError(403, 'SECURITY_CONFIRMATION_REQUIRED', '请先完成安全确认，再继续这项操作');
    const body = await readBody(req, ['action', 'operationId', 'name', 'partnerId', 'plan', 'count']);
    const operation = operationId(body.operationId);
    if (body.action === 'create') {
      const name = typeof body.name === 'string' ? body.name.trim() : '';
      if (!name || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) throw invalid();
      const existing = partners.find(row => row.operation === operation && row.createdBy === actor.id);
      if (existing) {
        if (existing.name !== name) throw conflict('提交编号已用于其他资料');
        return json(res, 200, { partner: publicPartner(existing) });
      }
      if (partners.some(row => row.name === name && !row.disabledAt)) throw conflict('已有同名合作方');
      const id = 'rp_' + randomBytes(12).toString('hex');
      const apiKey = id + '.' + secret();
      const partner = { id, name, keyHash: digest(apiKey), operation, createdBy: actor.id, createdAt: time(clock()) };
      store.saveFeatureDocument('recharge-partners', initial.version, { ...initial.data, partners: [...partners, partner] },
        { action: 'recharge_partner_create', actor, targetId: id });
      return json(res, 201, { partner: publicPartner(partner), apiKey });
    }
    if (typeof body.partnerId !== 'string' || !rechargePartnerIdPattern.test(body.partnerId)) throw invalid();
    const partner = partners.find(row => row.id === body.partnerId);
    if (!partner) throw notFound();
    if (body.action === 'disable') {
      if (!partner.disabledAt) {
        partner.disabledAt = time(clock());
        store.saveFeatureDocument('recharge-partners', initial.version, { ...initial.data, partners },
          { action: 'recharge_partner_disable', actor, targetId: partner.id });
      }
      return json(res, 200, { partner: publicPartner(partner) });
    }
    if (body.action !== 'issue' || !currentPlans.has(body.plan) || !Number.isSafeInteger(body.count) ||
        body.count < 1 || body.count > 100) throw invalid();
    const existing = batches.find(row => row.operation === operation && row.createdBy === actor.id);
    if (existing) {
      if (existing.partnerId !== partner.id || existing.plan !== body.plan || existing.codes.length !== body.count)
        throw conflict('提交编号已用于其他发码资料');
      return json(res, 200, { batch: publicBatch(existing) });
    }
    if (partner.disabledAt) throw conflict('该合作方凭证已停用');
    const inventory = store.featureDocument('recharge-codes');
    const clientIp = readSource(req);
    if (!clientIp) throw unavailable();
    const stock = await transport.listCodeStock();
    if (!Array.isArray(stock) || !stock.every(row => row && typeof row.code === 'string' &&
        storefrontRechargeCode(row.code) === row.code) || new Set(stock.map(row => row.code)).size !== stock.length)
      throw unavailable();
    const candidates = unassignedRechargeStock(stock, inventory.data?.requests ?? [], inventory.data?.partnerReservedCodes)
      .filter(item => item.plan === body.plan).slice(0, 4000).map(item => item.code);
    if (candidates.length < body.count) throw conflict('该套餐可用库存不足');
    const id = randomUUID();
    const createdAt = time(clock());
    // The queue holds these native codes against submits while this callback commits
    // both the issuer's reservation and the partner batch in the same transaction.
    pendingBatches.set(id, { candidates: new Set(candidates), count: body.count, commit(selected) {
      const codes = selected.map(nativeCode => ({ code: 'RA-' + randomBytes(16).toString('hex').toUpperCase(), nativeCode }));
      const batch = numberedRechargeRequests([...batches, { id, codes, plan: body.plan, partnerId: partner.id,
        operation, createdBy: actor.id, createdAt }]).at(-1);
      store.saveRechargePartnerBatch(initial.version, inventory.version, batch, actor);
    } });
    try {
      const result = await queue('issue', { partnerId: partner.id, requestId: id, clientIp, codes: candidates, count: body.count });
      if (result === false) throw conflict('有兑换码已被占用，请重试发码');
    } finally {
      pendingBatches.delete(id);
    }
    const batch = readPartners().data?.batches?.find(row => row.id === id);
    if (!batch) throw unavailable();
    return json(res, 201, { batch: publicBatch(batch) });
  });

  const api = handleErrors(async (req, res, route) => {
    const clientIp = readSource(req);
    if (!clientIp || req.headers.origin || req.headers.cookie) throw new RequestError(403, 'forbidden');
    throttle(sourceLimit, clientIp);
    const match = /^Bearer (\S+)$/i.exec(req.headers.authorization || '');
    const apiKey = match?.[1];
    const partner = apiKey && partnerFor(keyPattern.exec(apiKey)?.[1]);
    if (!partner || !equalHash(partner.keyHash, apiKey)) throw new RequestError(401, 'invalid_api_key');
    const partnerId = partner.id;
    throttle(partnerLimit, partnerId);
    if (route === '/config' && req.method === 'GET') {
      const config = await queue('config', { partnerId, clientIp });
      return json(res, 200, { maintenance: config.maintenance !== false });
    }
    const requestId = route.startsWith('/redemptions/') ? route.slice('/redemptions/'.length) : '';
    if (rechargeRequestIdPattern.test(requestId) && req.method === 'GET') {
      const row = readRequests().data?.requests?.find(row => row.id === requestId && row.partnerId === partnerId);
      if (!row) throw notFound();
      return json(res, 200, requestView(row, await requestTask(row, clientIp)));
    }
    if (req.method !== 'POST' || !['/codes/verify', '/codes/query', '/redemptions'].includes(route)) throw notFound();
    const body = await readBody(req, ['code']);
    const code = ownedCode(partnerId, body.code);
    if (route === '/codes/verify') {
      const config = await queue('config', { partnerId, clientIp });
      if (config.maintenance !== false) throw unavailable();
    }
    const operation = route === '/redemptions' ? operationId(req.headers['idempotency-key']) : undefined;
    const matchesOperation = row => row.partnerId === partnerId &&
      (row.operation === operation || row.operations?.includes(operation));
    const existing = operation && readRequests().data?.requests?.find(matchesOperation);
    if (existing) {
      if (existing.code !== code.code) throw conflict('请求编号已用于其他兑换码');
      const canAuthorize = existing.state === 'open' && existing.expiresAt > clock();
      return json(res, 200, requestView(existing, await requestTask(existing, clientIp), canAuthorize));
    }
    const inventoryStatus = await lookup(code, partnerId, clientIp);
    if (route !== '/redemptions') {
      const latest = readRequests().data?.requests?.findLast(row => row.partnerId === partnerId && row.code === code.code);
      const task = latest && route === '/codes/query' ? await requestTask(latest, clientIp) : null;
      const retry = inventoryStatus.reason === 'verified_retry_available' &&
        (latest?.state !== 'claimed' || latest.afterFailedTask !== inventoryStatus.task?.id);
      const waiting = !retry && latest?.state === 'claimed' && inventoryStatus.status === 'available';
      return json(res, 200, { plan: code.plan, status: waiting ? 'reserved' : inventoryStatus.status,
        ...(waiting && { reason: 'manual_review_required' }),
        ...(retry && { reason: 'verified_retry_available' }),
        ...(inventoryStatus.reason === 'manual_review_required' && { reason: inventoryStatus.reason }),
        ...(route === '/codes/query' && { task: latest ? requestView(latest, task) : null }) });
    }
    const config = await queue('config', { partnerId, clientIp });
    if (config.maintenance !== false) throw unavailable();
    const snapshot = readRequests();
    const requests = snapshot.data?.requests ?? [];
    const concurrent = requests.find(matchesOperation);
    const now = clock();
    if (concurrent) {
      if (concurrent.code !== code.code) throw conflict('请求编号已用于其他兑换码');
      const canAuthorize = concurrent.state === 'open' && concurrent.expiresAt > now;
      return json(res, 200, requestView(concurrent, await requestTask(concurrent, clientIp), canAuthorize));
    }
    const latest = requests.findLast(row => row.partnerId === partnerId && row.code === code.code);
    if (!partnerFor(partnerId)) throw new RequestError(401, 'invalid_api_key');
    if (latest?.state === 'open' && latest.expiresAt > now) {
      const updated = { ...latest, operations: [...(latest.operations ?? [latest.operation]), operation] };
      if (updated.operations.length > 25) throw conflict('已有待授权请求，请使用原请求编号');
      saveRequests(snapshot, requests.map(row => row.id === latest.id ? updated : row));
      return json(res, 200, requestView(updated, null, true));
    }
    const retry = inventoryStatus.reason === 'verified_retry_available' && inventoryStatus.task?.status === 'failed' &&
      latest?.afterFailedTask !== inventoryStatus.task.id;
    if (inventoryStatus.status !== 'available' || (latest && latest.state !== 'open' && !retry))
      throw conflict('兑换码暂不可创建新请求');
    // These reads and the compare-and-swap are synchronous. No disabled partner can create
    // a request while awaiting a gateway reply.
    const row = { id: randomUUID(), partnerId, code: code.code, plan: code.plan, operation,
      state: 'open', updatedAt: time(now), expiresAt: now + ticketLifetime,
      ...(retry && { afterFailedTask: inventoryStatus.task.id }) };
    saveRequests(snapshot, [...requests, row]);
    return json(res, 201, requestView(row, null, true));
  });

  const authorization = handleErrors(async (req, res) => {
    const clientIp = readSource(req);
    if (!clientIp || req.method !== 'POST' || req.headers.origin !== origin ||
        (req.headers['sec-fetch-site'] && req.headers['sec-fetch-site'] !== 'same-origin'))
      throw new RequestError(403, 'forbidden', '请在 ID 授权页面操作');
    throttle(sourceLimit, clientIp);
    const { id, ticket, session } = await readBody(req, ['id', 'ticket', 'session'], 1_600_000);
    if (typeof id !== 'string' || typeof ticket !== 'string' ||
        !rechargeRequestIdPattern.test(id) || !ticketPattern.test(ticket)) throw notFound();
    throttle(requestLimit, id);
    const snapshot = readRequests();
    const requests = snapshot.data?.requests ?? [];
    const row = requests.find(row => row.id === id);
    if (!row || !timingSafeEqual(Buffer.from(store.rechargePartnerTicket(row.id)), Buffer.from(ticket))) throw notFound();
    const partner = partnerFor(row.partnerId);
    const now = clock();
    if (row.expiresAt <= now) throw new RequestError(410, 'expired', row.state === 'open'
      ? '此授权已过期，请回原网站重新发起' : '此授权链接已过期，请回原网站查询进度');
    if (row.state !== 'open')
      return json(res, 200, { ...requestView(row, await requestTask(row, clientIp)), partner: partner?.name });
    if (!partner)
      throw new RequestError(410, 'expired', '此授权已失效，请向原网站发起新的请求');
    if (session === undefined) return json(res, 200, { ...requestView(row), partner: partner.name });
    if (!validAccountSession(session, now))
      throw new RequestError(422, 'invalid_account_session', '请重新获取目标账号的完整授权资料');
    const code = ownedCode(row.partnerId, row.code);
    const [current, stillOpen] = await Promise.all([
      lookup(code, row.partnerId, clientIp), queue('config', { partnerId: row.partnerId, clientIp })
    ]);
    const latestSnapshot = readRequests();
    const latestRequests = latestSnapshot.data?.requests ?? [];
    const currentRow = latestRequests.find(entry => entry.id === row.id);
    if (!currentRow) throw notFound();
    if (currentRow.state !== 'open')
      return json(res, 200, { ...requestView(currentRow, await requestTask(currentRow, clientIp)), partner: partner.name });
    if (row.expiresAt <= clock() || !partnerFor(row.partnerId))
      throw new RequestError(410, 'expired', '此授权已失效，请向原网站查询');
    if (stillOpen.maintenance !== false) throw unavailable();
    if (current.status !== 'available' ||
        (row.afterFailedTask && (current.reason !== 'verified_retry_available' || current.task?.id !== row.afterFailedTask)))
      throw conflict('兑换码或原任务的状态已变化，请联系原网站查询');
    const claimed = { ...currentRow, state: 'claimed',
      updatedAt: time(Math.max(clock(), Date.parse(currentRow.updatedAt) + 1)) };
    saveRequests(latestSnapshot, latestRequests.map(entry => entry.id === row.id ? claimed : entry));
    let task;
    try {
      task = await queue('submit', { partnerId: row.partnerId, code: code.nativeCode, clientIp,
        requestId: row.id, session, afterFailedTask: row.afterFailedTask });
    } catch {
      // The queue may have committed. Only reads can recover an ambiguous submit.
    }
    if (task?.rejected === true) {
      const pending = readRequests();
      const pendingRows = pending.data?.requests ?? [];
      const current = pendingRows.find(entry => entry.id === row.id);
      if (current?.state === 'claimed') {
        const released = { ...current, state: 'open', updatedAt: time(Math.max(clock(), Date.parse(current.updatedAt) + 1)) };
        saveRequests(pending, pendingRows.map(entry => entry.id === row.id ? released : entry));
      }
      throw new RequestError(422, 'not_accepted', '本次未受理。请刷新后再次核对兑换码状态。');
    }
    return json(res, 200, { ...requestView(claimed, task), partner: partner.name });
  });

  async function lookupAdmission(code, clientIp, partnerId) {
    const allowed = () => {
      const data = readPartners().data;
      const batch = data?.batches?.find(batch => batch.codes.some(entry => entry.nativeCode === code));
      const partner = !partnerId || data?.partners?.some(row => row.id === partnerId && !row.disabledAt);
      return partner && (partnerId ? batch?.partnerId === partnerId : !batch);
    };
    if (!allowed()) return null;
    const admission = await transport.verifyStorefrontCode(code, clientIp);
    return allowed() ? admission : null;
  }

  function issueBatch(id, codes) {
    const pending = pendingBatches.get(id);
    if (!pending || !Array.isArray(codes) || codes.length !== pending.count || new Set(codes).size !== codes.length ||
        !codes.every(code => pending.candidates.has(code))) return 409;
    try {
      pending.commit(codes);
      return 200;
    } catch (error) {
      if (error?.status === 409) return 409;
      throw error;
    }
  }

  return { admin, api, authorization, lookupAdmission, issueBatch };
}

import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';
import { moyaoRechargeChannel, rechargeManualReviewReason, storefrontRechargeCode } from './admission.mjs';

export const vendureRechargePrefix = '/api/id-business-v2/online-recharge/integrations/vendure';
export const rechargeWorkerPrefix = '/integrations/recharge-worker';
// Match the pinned engine's canonical and readable legacy plan types.
const plans = new Set(['plus', 'pro100', 'pro200', 'pro500', 'pro_5x', 'pro_20x']);
const vendureFields = new Map([
  ['config', []],
  ['verify', ['code']],
  ['query', ['code']],
  ['submit', ['code', 'session']],
  ['task', ['id', 'taskToken']]
]);
const progressLabels = new Map([
  ['queued', '等待执行'],
  ['started', '已开始执行'],
  ['processing', '处理中'],
  ['payment_details', '填写支付资料'],
  ['paying', '正在付款'],
  ['paid', '付款成功'],
  ['subscription_check', '确认订阅'],
  ['succeeded', '开通成功'],
  ['failed', '执行失败，请联系客服处理。'],
  ['awaiting_review', '结果待核实，请勿重复充值，请联系客服处理。']
]);
const workerProgressStages = new Set(['started', 'processing', 'payment_details', 'paying', 'paid', 'subscription_check']);
const workerFields = new Map([
  ['claim', []],
  ['progress', ['id', 'leaseToken', 'stage', 'upstreamJobId']],
  ['result', ['id', 'leaseToken', 'outcome', 'evidenceId', 'upstreamJobId']]
]);
const upstreamJobPattern = /^[A-Za-z0-9_-]{1,128}$/;
const workerOutcomes = new Map([
  ['confirmed_success', 'succeeded'],
  ['confirmed_failure', 'failed'],
  ['unknown', 'awaiting_review']
]);
const legacyTaskStates = new Set(['succeeded', 'failed', 'awaiting_review']);
const legacyCodeStates = new Set(['used', 'reserved']);
const hexFingerprint = /^[a-f0-9]{64}$/;
const signatureWindowMs = 30_000;
const queuedLifetimeMs = 10 * 60_000;
const leaseLifetimeMs = 5 * 60_000;
const token = () => randomBytes(32).toString('base64url');

function secureEqual(expected, value) {
  if (typeof value !== 'string' || Buffer.byteLength(value) !== Buffer.byteLength(expected))
    return false;
  return timingSafeEqual(Buffer.from(expected), Buffer.from(value));
}

function strongSecret(secret) {
  return typeof secret === 'string' && Buffer.byteLength(secret) >= 32;
}

function workerSignature(secret, path, body, time, nonce) {
  const bodyHash = createHash('sha256').update(body).digest('hex');
  return createHmac('sha256', secret)
    .update(JSON.stringify(['POST', path, bodyHash, time, nonce]))
    .digest('hex');
}

export function signRechargeWorkerRequest(secret, path, body, now = Date.now()) {
  const nonce = token();
  const time = String(now);
  return {
    'x-recharge-worker-time': time,
    'x-recharge-worker-nonce': nonce,
    'x-recharge-worker-signature': workerSignature(secret, path, body, time, nonce)
  };
}

function send(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(value));
}

async function readBody(req, maxBytes) {
  const chunks = [];
  let length = 0;
  for await (const chunk of req.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > maxBytes) {
      req.resume();
      return null;
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

function acceptedSession(raw) {
  // Credential shape, expiry and user enrichment belong to the pinned engine.
  return typeof raw === 'string' && raw.trim().length > 0;
}

function codeKey(value) {
  return typeof value === 'string' && value.trim().length <= 190 ? value.trim() : '';
}

function indexLegacyReceipts(receipts, tasks, registry) {
  if (!Array.isArray(receipts)) throw new TypeError('商城历史回执配置无效');
  const byId = new Map();
  const byCode = new Map();
  const activeCodes = new Set([...tasks.values()].map((task) => task.codeRef));
  for (const { id, codeRef, oldTokenRef, plan, status, codeStatus, updatedAt } of receipts) {
    const hasCode = codeRef !== undefined || codeStatus !== undefined;
    if (typeof id !== 'string' || !/^[a-z0-9-]{1,36}$/i.test(id) ||
        typeof oldTokenRef !== 'string' || !hexFingerprint.test(oldTokenRef) ||
        !plans.has(plan) || !legacyTaskStates.has(status) ||
        !Number.isSafeInteger(updatedAt) || updatedAt <= 0 || updatedAt > 8_640_000_000_000_000 ||
        byId.has(id) || tasks.has(id) ||
        (hasCode && (typeof codeRef !== 'string' || !hexFingerprint.test(codeRef) ||
          !legacyCodeStates.has(codeStatus) || byCode.has(codeRef) || activeCodes.has(codeRef) || registry.has(codeRef))))
      throw new TypeError('商城历史回执格式无效或与现有任务冲突');
    const receipt = { id, codeRef, oldTokenRef, plan, status, codeStatus, updatedAt };
    byId.set(id, receipt);
    if (hasCode) byCode.set(codeRef, receipt);
  }
  return { byId, byCode };
}

/** Isolated bridge with optional project-local storage. It never starts an executor. */
export function createLoopbackVendureRechargeBridge({
  codes,
  vendureKey,
  workerSecret,
  store,
  lookupAdmission,
  acceptSubmissions = true,
  acceptStorefrontSubmissions = () => true,
  legacyReceipts = [],
  now = Date.now
}) {
  if (!strongSecret(vendureKey) || !strongSecret(workerSecret) || vendureKey === workerSecret)
    throw new TypeError('Vendure 与测试执行器需要独立服务凭据');
  if (typeof acceptSubmissions !== 'boolean' || typeof acceptStorefrontSubmissions !== 'function')
    throw new TypeError('商城代充受理开关无效');
  if (lookupAdmission !== undefined && typeof lookupAdmission !== 'function')
    throw new TypeError('商城准入查询配置无效');
  if (!store && legacyReceipts?.length) throw new TypeError('商城历史回执需要正式任务存储密钥');

  const memoryKey = store ? null : randomBytes(32);
  const fingerprint =
    store?.fingerprint ??
    ((purpose, value) =>
      createHmac('sha256', memoryKey).update(purpose).update('\0').update(value).digest('hex'));
  const registry = new Map();
  const assignedCodes = new Set();
  for (const { code, plan, disabled = false, executionCode = code } of codes) {
    const key = codeKey(code);
    const upstreamCode = codeKey(executionCode);
    const ref = fingerprint('code', key);
    if (!key || !upstreamCode || !plans.has(plan) || registry.has(ref) || assignedCodes.has(upstreamCode))
      throw new TypeError('兑换码配置无效或重复分配代充码');
    registry.set(ref, { plan, disabled, upstreamCode });
    assignedCodes.add(upstreamCode);
  }

  const loaded = store?.load();
  let revision = loaded?.revision;
  let tasks = new Map((loaded?.state.tasks ?? []).map((task) => [task.id, task]));
  let nonces = new Map(loaded?.state.nonces ?? []);
  const legacy = indexLegacyReceipts(legacyReceipts, tasks, registry);
  // The authorization never enters the durable snapshot, even during a failed commit.
  const sessions = new Map();
  let closed = false;
  let needsRecovery = false;

  function taskView(task, includeToken = false) {
    const stage = task.status === 'running'
      ? workerProgressStages.has(task.stage) ? task.stage : 'processing'
      : task.status;
    return {
      id: task.id,
      plan: task.plan,
      status: task.status,
      stage,
      message: progressLabels.get(stage) ?? '处理中',
      updatedAt: new Date(task.updatedAt).toISOString(),
      ...(includeToken ? { taskToken: fingerprint('task', task.id) } : {})
    };
  }

  function transition(task, status, at) {
    // Vendure ignores snapshots with a timestamp no later than the last receipt.
    return { ...task, status, updatedAt: Math.max(at, task.updatedAt + 1) };
  }

  function commit(nextTasks, nextNonces = nonces) {
    if (store) {
      try {
        revision = store.commit(revision, {
          tasks: [...nextTasks.values()],
          nonces: [...nextNonces]
        });
      } catch (error) {
        try {
          needsRecovery = store.load().revision !== revision;
        } catch {
          needsRecovery = true;
        }
        if (needsRecovery) sessions.clear();
        throw error;
      }
    }
    tasks = nextTasks;
    nonces = nextNonces;
  }

  function expire(at, afterRestart = false) {
    const nextTasks = new Map(tasks);
    let changed = false;
    for (const task of tasks.values()) {
      const expiredQueued = task.status === 'queued' && (afterRestart || task.queuedUntil <= at);
      const expiredLease = task.status === 'running' && (afterRestart || task.leaseUntil <= at);
      if (!expiredQueued && !expiredLease) continue;
      sessions.delete(task.id);
      nextTasks.set(task.id, transition(task, 'awaiting_review', at));
      changed = true;
    }
    const activeNonces = new Map([...nonces].filter(([, expiresAt]) => expiresAt > at));
    if (changed || activeNonces.size !== nonces.size) commit(nextTasks, activeNonces);
  }

  if (store) expire(now(), true);
  const timer = setInterval(() => {
    if (needsRecovery) return;
    try {
      expire(now());
    } catch {
      // Reads and writes fail closed until the next successful check.
    }
  }, signatureWindowMs);
  timer.unref();

  async function handleVendure(action, body, res, at, clientIp, storefrontChannel) {
    const useAdmission = Boolean(lookupAdmission && storefrontChannel === moyaoRechargeChannel);
    const accepting = () => acceptSubmissions && (!lookupAdmission || (useAdmission && acceptStorefrontSubmissions()));
    if (lookupAdmission && storefrontChannel !== undefined && !useAdmission) {
      if (action === 'config') return send(res, 200, { maintenance: true });
      if (action === 'task') return send(res, 404, { error: '任务不可用' });
      if (action === 'submit') return send(res, 200, { rejected: true });
      return send(res, 400, { reason: 'storefront_code_not_admitted' });
    }
    if (action === 'config') return send(res, 200, { maintenance: !accepting() });
    if (action === 'task') {
      const task = tasks.get(body.id) ?? legacy.byId.get(body.id);
      const supplied = body.taskToken;
      const oldTokenMatches = task?.oldTokenRef && typeof supplied === 'string' && supplied.length <= 100 &&
        secureEqual(task.oldTokenRef, fingerprint('legacy-task', supplied.trim()));
      if (!task || (!oldTokenMatches && !secureEqual(fingerprint('task', task.id), supplied)))
        return send(res, 404, { error: '任务不可用' });
      return send(res, 200, taskView(task));
    }

    const nativeCode = useAdmission ? storefrontRechargeCode(body.code) : '';
    const codeRef = fingerprint('code', nativeCode || codeKey(body.code));
    const lastTask = () => legacy.byCode.get(codeRef) ?? [...tasks.values()].findLast(task => task.codeRef === codeRef);
    const recover = task => task && (useAdmission || task.status !== 'failed' || legacy.byCode.has(codeRef));
    let prior = lastTask();
    if (action === 'submit') {
      if (recover(prior)) return send(res, 200, taskView(prior, true));
      if (!accepting() || !acceptedSession(body.session)) return send(res, 200, { rejected: true });
    }
    const registered = registry.get(codeRef);
    let record = useAdmission ? null : registered && {
      plan: registered.plan, status: registered.disabled ? 'disabled' : 'available', upstreamCode: registered.upstreamCode
    };
    // Existing receipts remain readable even when the issuer is unavailable.
    if (useAdmission && !prior && nativeCode && !registered?.disabled &&
        (!assignedCodes.has(nativeCode) || registered?.upstreamCode === nativeCode)) {
      let admitted;
      try {
        admitted = await lookupAdmission(nativeCode, clientIp);
      } catch (error) {
        if (action === 'submit') {
          const current = lastTask();
          return send(res, 200, recover(current) ? taskView(current, true) : { rejected: true });
        }
        throw error;
      }
      if (closed || needsRecovery) return send(res, 503, { error: '隔离联调暂不可用' });
      at = now();
      expire(at);
      prior = lastTask();
      if (admitted) record = { ...admitted, upstreamCode: nativeCode };
    }
    if (action === 'submit') {
      // Lookup yields to concurrent requests. Reuse their task before claiming this code.
      if (recover(prior)) return send(res, 200, taskView(prior, true));
      if (!accepting() || record?.status !== 'available')
        return send(res, 200, { rejected: true });
      const task = {
        id: randomUUID(),
        codeRef,
        plan: record.plan,
        clientIp,
        queuedUntil: at + queuedLifetimeMs,
        status: 'queued',
        updatedAt: at
      };
      commit(new Map(tasks).set(task.id, task));
      sessions.set(task.id, { session: body.session, executionCode: record.upstreamCode });
      return send(res, 200, taskView(task, true));
    }

    if (!record && !prior)
      return send(res, 400, useAdmission ? { reason: 'storefront_code_not_admitted' } : { error: '兑换码不可用' });
    const status = prior?.codeStatus ?? (prior
      ? prior.status === 'succeeded'
        ? 'used'
        : prior.status === 'failed' && !legacy.byCode.has(codeRef) && !useAdmission && !registered?.disabled
          ? 'available' : 'reserved'
      : record.status);
    const result = { plan: prior?.plan ?? record.plan, status };
    if (useAdmission && status === 'reserved' &&
        (prior?.status === 'awaiting_review' || record?.reason === rechargeManualReviewReason))
      result.reason = rechargeManualReviewReason;
    if (action === 'query') result.task = prior ? taskView(prior, true) : null;
    return send(res, 200, result);
  }

  function handleWorker(action, body, res, at, nonceRef, nonceUntil) {
    const nextTasks = new Map(tasks);
    const nextNonces = new Map(nonces).set(nonceRef, nonceUntil);
    const finish = (status, payload) => {
      commit(nextTasks, nextNonces);
      return send(res, status, payload);
    };
    if (action === 'claim') {
      if (!acceptSubmissions) return finish(200, { task: null });
      for (const task of tasks.values()) {
        if (task.status !== 'queued') continue;
        const authorization = sessions.get(task.id);
        if (!authorization?.executionCode || !acceptedSession(authorization.session)) {
          sessions.delete(task.id);
          nextTasks.set(task.id, transition(task, 'awaiting_review', at));
          continue;
        }
        const leaseToken = token();
        const leaseUntil = at + leaseLifetimeMs;
        const leased = {
          ...transition(task, 'running', at),
          leaseRef: fingerprint('lease', leaseToken),
          leaseUntil
        };
        nextTasks.set(leased.id, leased);
        commit(nextTasks, nextNonces);
        sessions.delete(task.id);
        return send(res, 200, {
          task: { ...taskView(leased), leaseToken, leaseUntil, ...authorization,
            ...(isIP(task.clientIp ?? '') ? { clientIp: task.clientIp } : {}) }
        });
      }
      return finish(200, { task: null });
    }

    const task = tasks.get(body.id);
    if (
      !task?.leaseRef ||
      typeof body.leaseToken !== 'string' ||
      !secureEqual(task.leaseRef, fingerprint('lease', body.leaseToken))
    )
      return finish(404, { error: '执行租约不可用' });
    if (action === 'progress') {
      if (task.status !== 'running' && !(task.status === 'awaiting_review' && !task.result))
        return finish(409, { error: '原任务已结束或需核对' });
      if (!workerProgressStages.has(body.stage) || typeof body.upstreamJobId !== 'string' ||
          !upstreamJobPattern.test(body.upstreamJobId) ||
          (task.upstreamJobId && task.upstreamJobId !== body.upstreamJobId))
        return finish(400, { error: '进度格式无效' });
      const progressed = {
        ...transition(task, 'running', at),
        stage: body.stage,
        upstreamJobId: body.upstreamJobId,
        leaseUntil: at + leaseLifetimeMs
      };
      nextTasks.set(task.id, progressed);
      return finish(200, { ...taskView(progressed), leaseUntil: progressed.leaseUntil });
    }
    const status = workerOutcomes.get(body.outcome);
    const evidenceId = body.evidenceId;
    const upstreamJobId = body.upstreamJobId;
    const confirmed = status === 'succeeded' || status === 'failed';
    if (
      !status ||
      (task.upstreamJobId && upstreamJobId !== task.upstreamJobId) ||
      (upstreamJobId !== undefined && (typeof upstreamJobId !== 'string' || !upstreamJobPattern.test(upstreamJobId))) ||
      (confirmed
        ? typeof evidenceId !== 'string' || !/^[A-Za-z0-9:_-]{1,128}$/.test(evidenceId)
        : evidenceId !== undefined)
    )
      return finish(400, { error: '结果格式无效' });
    const evidenceRef = confirmed ? fingerprint('evidence', evidenceId) : null;
    if (task.result?.status === status && task.result.evidenceRef === evidenceRef &&
        task.result.upstreamJobId === upstreamJobId)
      return finish(200, taskView(task));
    if (
      !['running', 'awaiting_review'].includes(task.status) ||
      (task.status === 'awaiting_review' && confirmed && !upstreamJobId) ||
      (confirmed && [...tasks.values()].some((item) => item.result?.evidenceRef === evidenceRef))
    )
      return finish(409, { error: '已有结果、租约失效或凭证重复，需核对原任务' });
    const completed = {
      ...transition(task, status, at),
      ...(upstreamJobId === undefined ? {} : { upstreamJobId }),
      result: { status, evidenceRef, receiptRef: nonceRef, receivedAt: at,
        ...(upstreamJobId === undefined ? {} : { upstreamJobId }) }
    };
    nextTasks.set(task.id, completed);
    return finish(200, taskView(completed));
  }

  async function handle(req, res) {
    if (closed || needsRecovery) return send(res, 503, { error: '隔离联调服务需重新读取任务库' });
    const { url, method, headers } = req;
    const vendure =
      /^\/api\/id-business-v2\/online-recharge\/integrations\/vendure\/(config|verify|query|submit|task)$/.exec(
        url
      );
    const worker = /^\/integrations\/recharge-worker\/(claim|progress|result)$/.exec(url);
    if ((!vendure && !worker) || method !== 'POST') return send(res, 404, { error: '接口不存在' });
    if (req.socket.remoteAddress !== '127.0.0.1' || headers.origin || headers.cookie)
      return send(res, 403, { error: '只接受本机服务请求' });
    if (vendure && !secureEqual(vendureKey, headers['x-vendure-recharge-key']))
      return send(res, 401, { error: '服务凭据无效' });
    if (vendure && !isIP(headers['x-vendure-client-ip'] ?? ''))
      return send(res, 400, { error: '来源资料无效' });
    if (!/^application\/json(?:\s*;|$)/i.test(headers['content-type'] || ''))
      return send(res, 415, { error: '需要 JSON 请求' });
    const raw = await readBody(req, vendure ? 1_600_000 : 4096);
    if (!raw) return send(res, 413, { error: '请求过大' });
    if (closed || needsRecovery) return send(res, 503, { error: '隔离联调服务需重新读取任务库' });
    const at = now();
    let nonceRef, nonceUntil;
    if (worker) {
      const time = headers['x-recharge-worker-time'];
      const nonce = headers['x-recharge-worker-nonce'];
      const signature = headers['x-recharge-worker-signature'];
      if (
        typeof time !== 'string' ||
        !/^\d{1,15}$/.test(time) ||
        Math.abs(at - Number(time)) >= signatureWindowMs ||
        typeof nonce !== 'string' ||
        !/^[A-Za-z0-9_-]{43}$/.test(nonce) ||
        !secureEqual(workerSignature(workerSecret, url, raw, time, nonce), signature)
      )
        return send(res, 401, { error: '执行器签名无效' });
      nonceRef = fingerprint('nonce', nonce);
      nonceUntil = Number(time) + signatureWindowMs;
    }

    let body;
    try {
      body = JSON.parse(raw.toString());
      if (!body || Array.isArray(body) || typeof body !== 'object') throw new Error();
    } catch {
      return send(res, 400, { error: 'JSON 格式无效' });
    }
    if (vendure && Object.keys(body).some((field) => !vendureFields.get(vendure[1]).includes(field)))
      return send(res, 400, { error: '不支持的请求字段' });
    if (worker && Object.keys(body).some((field) => !workerFields.get(worker[1]).includes(field)))
      return send(res, 400, { error: '不支持的执行字段' });
    expire(at);
    if (worker && nonces.has(nonceRef)) return send(res, 409, { error: '执行请求已接收' });
    return vendure
      ? handleVendure(vendure[1], body, res, at, headers['x-vendure-client-ip'], headers['x-vendure-recharge-channel'])
      : handleWorker(worker[1], body, res, at, nonceRef, nonceUntil);
  }

  return {
    handle(req, res) {
      return handle(req, res).catch(() => {
        if (!res.headersSent && !res.destroyed) send(res, 503, { error: '隔离联调暂不可用' });
      });
    },
    close() {
      closed = true;
      clearInterval(timer);
      tasks.clear();
      registry.clear();
      nonces.clear();
      sessions.clear();
      legacy.byId.clear();
      legacy.byCode.clear();
      memoryKey?.fill(0);
    }
  };
}

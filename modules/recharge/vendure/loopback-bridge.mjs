import { createHash, createHmac, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto';
import { isIP } from 'node:net';

export const vendureRechargePrefix = '/api/id-business-v2/online-recharge/integrations/vendure';
export const rechargeWorkerPrefix = '/integrations/recharge-worker';
const plans = new Set(['plus', 'pro_5x', 'pro_20x']);
const vendureFields = new Map([
  ['config', []],
  ['verify', ['code']],
  ['query', ['code']],
  ['submit', ['code', 'session']],
  ['task', ['id', 'taskToken']]
]);
const workerOutcomes = new Map([
  ['confirmed_success', 'succeeded'],
  ['confirmed_failure', 'failed'],
  ['unknown', 'awaiting_review']
]);
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

function acceptedSession(raw, now) {
  if (typeof raw !== 'string' || !raw.trim() || Buffer.byteLength(raw) > 256_000) return false;
  try {
    const parsed = JSON.parse(raw);
    const accessToken = parsed?.accessToken ?? parsed?.access_token;
    const expires = typeof parsed?.expires === 'string' ? Date.parse(parsed.expires) : undefined;
    if (
      typeof parsed?.user?.id !== 'string' ||
      !parsed.user.id.trim() ||
      typeof parsed.user.email !== 'string' ||
      !/^[^\s@]+@[^\s@]+$/.test(parsed.user.email) ||
      typeof accessToken !== 'string' ||
      accessToken.length < 20 ||
      accessToken.length > 24_000 ||
      (expires !== undefined && (!Number.isFinite(expires) || expires <= now))
    )
      return false;
    try {
      const claims = JSON.parse(Buffer.from(accessToken.split('.')[1] ?? '', 'base64url'));
      if (typeof claims?.exp === 'number' && claims.exp * 1000 <= now) return false;
    } catch {
      // A worker must verify the credential and target before execution.
    }
    return true;
  } catch {
    return false;
  }
}

function codeKey(value) {
  return typeof value === 'string' && value.trim().length <= 190 ? value.trim() : '';
}

/** Isolated bridge with optional project-local storage. It never starts an executor. */
export function createLoopbackVendureRechargeBridge({
  codes,
  vendureKey,
  workerSecret,
  store,
  now = Date.now
}) {
  if (!strongSecret(vendureKey) || !strongSecret(workerSecret) || vendureKey === workerSecret)
    throw new TypeError('Vendure 与测试执行器需要独立服务凭据');

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
  // The authorization never enters the durable snapshot, even during a failed commit.
  const sessions = new Map();
  let closed = false;
  let needsRecovery = false;

  function taskView(task, includeToken = false) {
    return {
      id: task.id,
      plan: task.plan,
      status: task.status,
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

  function handleVendure(action, body, res, at) {
    if (action === 'config') return send(res, 200, { maintenance: false });
    if (action === 'task') {
      const task = tasks.get(body.id);
      if (!task || !secureEqual(fingerprint('task', task.id), body.taskToken))
        return send(res, 404, { error: '任务不可用' });
      return send(res, 200, taskView(task));
    }

    const codeRef = fingerprint('code', codeKey(body.code));
    const record = registry.get(codeRef);
    const prior = [...tasks.values()].find((task) => task.codeRef === codeRef);
    if (action === 'submit') {
      if (prior) return send(res, 200, taskView(prior, true));
      if (!record || record.disabled || !acceptedSession(body.session, at))
        return send(res, 200, { rejected: true });
      const task = {
        id: randomUUID(),
        codeRef,
        plan: record.plan,
        queuedUntil: at + queuedLifetimeMs,
        status: 'queued',
        updatedAt: at
      };
      commit(new Map(tasks).set(task.id, task));
      sessions.set(task.id, body.session);
      return send(res, 200, taskView(task, true));
    }

    if (!record && !prior) return send(res, 400, { error: '兑换码不可用' });
    const status = prior
      ? prior.status === 'succeeded'
        ? 'used'
        : 'reserved'
      : record.disabled
        ? 'disabled'
        : 'available';
    const result = { plan: prior?.plan ?? record.plan, status };
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
      for (const task of tasks.values()) {
        if (task.status !== 'queued') continue;
        const session = sessions.get(task.id);
        const record = registry.get(task.codeRef);
        if (!record || record.disabled || record.plan !== task.plan || !acceptedSession(session, at)) {
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
          task: { ...taskView(leased), leaseToken, leaseUntil, session, executionCode: record.upstreamCode }
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
    const status = workerOutcomes.get(body.outcome);
    const evidenceId = body.evidenceId;
    const upstreamJobId = body.upstreamJobId;
    const confirmed = status === 'succeeded' || status === 'failed';
    if (
      !status ||
      (upstreamJobId !== undefined && (typeof upstreamJobId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(upstreamJobId))) ||
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
      task.status !== 'running' ||
      (confirmed && [...tasks.values()].some((item) => item.result?.evidenceRef === evidenceRef))
    )
      return finish(409, { error: '已有结果、租约失效或凭证重复，需核对原任务' });
    const completed = {
      ...transition(task, status, at),
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
    const worker = /^\/integrations\/recharge-worker\/(claim|result)$/.exec(url);
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
    expire(at);
    if (worker && nonces.has(nonceRef)) return send(res, 409, { error: '执行请求已接收' });
    return vendure
      ? handleVendure(vendure[1], body, res, at)
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
      memoryKey?.fill(0);
    }
  };
}

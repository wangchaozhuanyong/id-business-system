import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { originalRechargeNeedsReview, rechargeTaskStepHistory } from '../modules/recharge/codexdaichong/progress-presentation.mjs';
import { rechargePlanLabels } from './order-policy.mjs';
import { codeReturnEntry, rechargeCodeItemId } from './recharge-code-returns.mjs';

export const rechargeActivityDomain = 'recharge-activity';
export const rechargeActivityRoute = '/api/local/' + rechargeActivityDomain;

const jobPattern = /^(\d{13})-[a-z0-9]{12}$/;
const activityPattern = /^[a-f0-9]{32}$/;
const codePattern = /^[^\x00-\x1f\x7f]{1,32}$/u;
const retentionMs = 30 * 24 * 60 * 60_000;
const pageSize = 20;
const upstreamPageSize = 100;
const maximumPages = 5;
const maximumDetails = 8;
const planRetryMs = 30_000;
const planAliases = { pro_5x: 'pro100', pro_20x: 'pro200', pro_50x: 'pro500' };
const canManage = actor => actor.role === 'admin' || actor.role === 'super';
const canRead = actor => Boolean(actor?.id && actor.active !== false &&
  ['employee', 'admin', 'super'].includes(actor.role));
const digest = value => createHash('sha256').update(value).digest('hex').slice(0, 32);
const activityId = jobKey => digest('recharge-activity\0' + jobKey);
const latest = row => row?.events.at(-1);
const inProgress = row => !latest(row) || latest(row).status === 'running';
const phaseBeforeExecution = new Set(['created_browser', 'created_provider', 'attempt_started', 'started', 'worker_retry']);

function planLabel(value) {
  const plan = Object.hasOwn(planAliases, value) ? planAliases[value] : value;
  return Object.hasOwn(rechargePlanLabels, plan) ? rechargePlanLabels[plan] : '';
}

function emailAddress(value) {
  const email = typeof value === 'string' ? value.trim() : '';
  return email.length <= 254 && /^[^\s@<>\x00-\x1f]+@[A-Za-z0-9.-]+\.[A-Za-z0-9-]+$/.test(email) ? email : '';
}

function maskEmail(email) {
  if (!email) return '';
  const [local, domain] = email.split('@');
  return [...local].slice(0, Math.min(2, [...local].length - 1)).join('') + '•••@' + domain;
}

function nativeSession(row) {
  const match = jobPattern.exec(row?.job_key);
  const code = row?.cdk_code;
  if (!match || row.has_session !== true || typeof code !== 'string' || !codePattern.test(code) ||
      !code.trim() || code === '[checkout-debug]' || code.startsWith('ADMIN_PRODUCT_GEN:')) return null;
  return {
    id: activityId(row.job_key), jobKey: row.job_key, createdAt: Number(match[1]),
    code, email: emailAddress(row.token_preview),
    status: row.status, message: row.message, progress: Number.isFinite(row.progress) ? row.progress : 0
  };
}

function outcome(task, startedAt, now) {
  const message = typeof task.message === 'string' ? task.message : '';
  if (task.status === 'running' && (task.progress > 3 || startedAt))
    return { status: 'running', at: startedAt || now };
  if (task.status === 'success' && task.progress === 100) {
    const renewalUnconfirmed = message === '开通成功，但自动续订取消状态未确认，请到目标账户账单页核对';
    return { status: 'success', at: now, ...(renewalUnconfirmed && { reason: '自动续订取消状态待核对' }) };
  }
  if (task.status === 'manual' || (task.status === 'failed' && originalRechargeNeedsReview(message)))
    return { status: 'review', at: now, reason: '付款结果待核对，请勿重复提交' };
  if (task.status === 'maintenance')
    return { status: 'failed', at: now, reason: '原任务因代充服务维护而结束' };
  if (task.status === 'failed') {
    let reason = '原代充任务已返回失败';
    if (/无激活权限|无开通资格|不具备.*资格/.test(message)) reason = '该账号不符合套餐开通条件';
    else if (/^(?:Session 格式或有效期检查失败|授权资料无效)/i.test(message)) reason = '账号授权资料未通过校验';
    return { status: 'failed', at: now, reason };
  }
  return null;
}

function issuedCodes(data) {
  const index = new Map();
  for (const row of data?.requests || []) {
    if (row.status !== 'issued' || !row.applicantId || !Array.isArray(row.codes)) continue;
    for (const code of row.codes) {
      if (typeof code !== 'string') continue;
      const key = code.toUpperCase();
      index.set(key, index.has(key) ? null : { row, code });
    }
  }
  return index;
}

function ownerFor(issued, task) {
  if (!issued) return null;
  const { row, code } = issued;
  if (Date.parse(row.issuedAt) > task.createdAt) return null;
  const returned = codeReturnEntry(row, code);
  if (returned?.state === 'returned' && Date.parse(returned.returnedAt) <= task.createdAt) return null;
  return {
    id: row.applicantId, name: row.applicantName || '',
    requestId: row.id, itemId: rechargeCodeItemId(row.id, code),
    batchNo: row.batchNo || '', issuedAt: row.issuedAt || ''
  };
}

function summary(row, actor) {
  const event = latest(row);
  return {
    id: row.id, plan: row.plan, email: row.email, codeTail: row.codeTail, jobTail: row.jobTail,
    owner: row.owner ? { name: row.owner.name } : null, createdAt: row.createdAt, updatedAt: row.updatedAt,
    status: event.status, event: row.events.length, unread: !row.readBy.includes(actor.id)
  };
}

function responseJson(response, status, body) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' });
  response.end(JSON.stringify(body));
}

export function createRechargeActivity({ store, client, publicOrigin, getActor, clock = Date.now, intervalMs = 5000 }) {
  let snapshot = { version: 0, data: null };
  try { snapshot = store.featureDocument(rechargeActivityDomain); } catch { /* Retry with the first scan. */ }
  let coverage = 'checking', timer, running, closed = false, checkedThrough = snapshot.data?.checkedThrough;
  let detailCursor = 0, lastPlanRead = -Infinity, planReadFailed = false;
  let nativePlans = new Map();
  const revisions = new Map();

  function changeCoverage(next) {
    if (next === coverage || closed) return;
    coverage = next;
    revisions.clear();
    store.notifyChanges();
  }

  function update(change) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const current = store.featureDocument(rechargeActivityDomain);
      const data = change(current.data);
      try {
        const next = isDeepStrictEqual(data, current.data) ? current :
          store.saveFeatureDocument(rechargeActivityDomain, current.version, data);
        if (next.version !== snapshot.version) revisions.clear();
        snapshot = next;
        return;
      } catch (error) {
        if (error.status !== 409 || attempt === 2) throw error;
      }
    }
  }

  function visible(actor) {
    return (snapshot.data?.rows || []).filter(row => latest(row) && (canManage(actor) || row.owner?.id === actor.id));
  }

  async function readRecent(floor, cutoff) {
    const tasks = new Map();
    for (let page = 0; page < maximumPages; page++) {
      const offset = page * upstreamPageSize;
      const { items, total } = await client.get('/api/admin/sessions?limit=' + upstreamPageSize + '&offset=' + offset);
      if (!Array.isArray(items) || !Number.isSafeInteger(total) || total < 0 || items.length > upstreamPageSize ||
          (!items.length && offset < total)) throw new Error('代充任务读取不完整');
      for (const raw of items) {
        const task = nativeSession(raw);
        if (task && task.createdAt >= cutoff && !tasks.has(task.id)) tasks.set(task.id, task);
      }
      const oldestKey = jobPattern.exec(items.at(-1)?.job_key);
      if (offset + items.length >= total || (oldestKey && Number(oldestKey[1]) < floor))
        return { tasks, complete: true };
    }
    return { tasks, complete: false };
  }

  // The stored reference is not the native customer's task lookup credential.
  async function findOriginal(row) {
    const { items } = await client.get('/api/admin/sessions?limit=10&offset=0&search=' + row.jobTail);
    if (!Array.isArray(items)) throw new Error('代充任务读取不完整');
    return items.map(nativeSession).find(task => task?.id === row.id);
  }

  async function scan() {
    const now = clock();
    if (!snapshot.data) update(data => data || { since: now, checkedThrough: now, rows: [] });
    const cutoff = Math.max(snapshot.data.since, now - retentionMs);
    const floor = Math.max(cutoff, (checkedThrough ?? snapshot.data.checkedThrough) - 60_000);
    const result = await readRecent(floor, cutoff);
    if (closed) return;
    const { tasks, complete } = result;
    const known = new Map(snapshot.data.rows.map(row => [row.id, row]));
    const pending = [
      ...snapshot.data.rows.filter(row => inProgress(row) && !tasks.has(row.id)).map(row => ({ row })),
      ...[...tasks.values()].filter(task => task.status === 'running' && !(task.progress > 3) && !latest(known.get(task.id)))
        .map(task => ({ task }))
    ];
    const cursor = pending.length ? detailCursor % pending.length : 0;
    const checks = pending.slice(cursor).concat(pending.slice(0, cursor)).slice(0, maximumDetails);
    detailCursor = cursor + checks.length;
    const started = new Map();
    const details = await Promise.allSettled(checks.map(async ({ row, task }) => {
      if (row) {
        task = await findOriginal(row);
        if (!task) return false;
        tasks.set(task.id, task);
      }
      if (task.status === 'running' && !(task.progress > 3) && !latest(known.get(task.id))) {
        const source = await client.get('/api/admin/task-logs/' + task.jobKey);
        if (source.task?.cdk !== task.code || source.task.status !== 'running') return false;
        const steps = rechargeTaskStepHistory(source, { jobKey: task.jobKey, status: task.status })?.steps;
        const actual = steps?.find(step => !phaseBeforeExecution.has(step.stage) && step.at >= task.createdAt && step.at <= now);
        if (actual) started.set(task.id, actual.at);
      }
      return true;
    }));
    if (closed) return;

    const candidates = [...tasks.values()].filter(task => task.createdAt <= now + 30_000 &&
      ['running', 'success', 'failed', 'manual', 'maintenance'].includes(task.status));
    const needsPlan = candidates.some(task => !known.get(task.id)?.plan);
    if (candidates.some(task => !known.has(task.id)) || (needsPlan && now - lastPlanRead >= planRetryMs)) {
      lastPlanRead = now;
      try {
        nativePlans = new Map((await client.listCodes()).filter(row => row.type === '自助' && typeof row.code === 'string')
          .map(row => [row.code.toUpperCase(), planLabel(row.plan_type)]));
        planReadFailed = false;
      } catch { planReadFailed = true; }
    }
    if (closed) return;
    let issued = new Map(), ownershipReadFailed = false;
    if (candidates.some(task => !known.get(task.id)?.owner)) {
      try { issued = issuedCodes(store.featureDocument('recharge-codes').data); }
      catch { ownershipReadFailed = true; }
    }
    const limited = !complete || (needsPlan && planReadFailed) || ownershipReadFailed ||
      details.some(result => result.status === 'rejected' || result.value === false);
    if (complete) checkedThrough = now;
    update(data => {
      const rows = new Map(data.rows.filter(row => row.updatedAt >= cutoff || ['running', 'review'].includes(latest(row)?.status))
        .map(row => [row.id, row]));
      for (const task of candidates) {
        const previous = rows.get(task.id);
        const key = task.code.toUpperCase();
        const issue = issued.get(key);
        const owner = previous?.owner || ownerFor(issue, task);
        const plan = previous?.plan || (planReadFailed ? '' : nativePlans.get(key)) || '';
        const characters = [...task.code];
        const row = {
          id: task.id, plan, owner, email: maskEmail(task.email) || previous?.email || '',
          codeTail: characters.length > 4 ? characters.slice(-4).join('') : '',
          jobTail: task.jobKey.slice(-8), createdAt: task.createdAt,
          updatedAt: previous?.updatedAt ?? now, events: previous?.events ?? [], readBy: previous?.readBy ?? []
        };
        const current = latest(row);
        const next = outcome(task, started.get(task.id), now);
        if (next && next.status !== current?.status && current?.status !== 'success' &&
            (next.status !== 'running' || !current)) {
          row.events = [...row.events, next];
          row.updatedAt = now;
          row.readBy = [];
        }
        rows.set(row.id, row);
      }
      return { ...data, rows: [...rows.values()], checkedThrough: complete &&
        now - data.checkedThrough >= 60_000 ? now : data.checkedThrough };
    });
    changeCoverage(limited ? 'limited' : 'ready');
  }

  function collect() {
    if (closed) return Promise.resolve();
    running ??= scan().catch(() => changeCoverage('unavailable')).finally(() => { running = undefined; });
    return running;
  }

  function findOwnedCode(row, actor) {
    if (row.owner?.id !== actor.id) return '';
    const { data } = store.featureDocument('recharge-codes');
    const request = data?.requests?.find(item => item.id === row.owner.requestId &&
      item.status === 'issued' && item.applicantId === actor.id);
    return request?.codes?.find(code => rechargeCodeItemId(request.id, code) === row.owner.itemId &&
      !['returned', 'pending'].includes(codeReturnEntry(request, code)?.state)) || '';
  }

  async function handle(request, response, actor) {
    const send = (status, body) => responseJson(response, status, body);
    if (!canRead(actor)) return send(401, { error: '请先登录业务管理系统' });
    const origin = publicOrigin || 'http://' + request.headers.host;
    if ((request.headers.origin && request.headers.origin !== origin) ||
        (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site'])))
      return send(403, { error: '请求来源未通过校验' });
    try {
      const url = new URL(request.url, origin);
      const rows = visible(actor);
      if (url.pathname === rechargeActivityRoute && request.method === 'GET') {
        const wanted = Number(url.searchParams.get('page') ?? '1');
        if (!Number.isSafeInteger(wanted) || wanted < 1) return send(400, { error: '页码无效' });
        const unread = rows.filter(row => !row.readBy.includes(actor.id)).length;
        const pages = Math.max(1, Math.ceil(rows.length / pageSize));
        const page = Math.min(wanted, pages);
        rows.sort((a, b) => b.updatedAt - a.updatedAt || b.createdAt - a.createdAt || a.id.localeCompare(b.id));
        return send(200, { coverage, unread, page, pages,
          items: rows.slice((page - 1) * pageSize, page * pageSize).map(row => summary(row, actor)) });
      }
      const [id, action, extra] = url.pathname.slice(rechargeActivityRoute.length + 1).split('/');
      if (!activityPattern.test(id) || extra !== undefined) return send(404, { error: '未找到代充动态' });
      const row = rows.find(item => item.id === id);
      if (!row) return send(404, { error: '未找到代充动态' });
      if (request.method === 'GET' && action === undefined) {
        const view = summary(row, actor);
        const original = canManage(actor) ? await findOriginal(row).catch(() => null) : null;
        const current = getActor ? getActor(request) : actor;
        if (!canRead(current) || current.id !== actor.id || current.role !== actor.role)
          return send(403, { error: '当前账号无权查看这条代充动态' });
        let fullCode = original?.code, synced = false;
        if (!fullCode) {
          try { fullCode = findOwnedCode(row, actor); } catch { /* The masked task is still readable. */ }
        }
        if (view.status === 'success') {
          try {
            synced = store.featureDocument('order-sync').data?.rows?.some(item =>
              typeof item.jobKey === 'string' && activityId(item.jobKey) === row.id && Boolean(item.orderNo) && !item.excluded);
          } catch { /* Keep the order unconfirmed if its receipt cannot be read. */ }
        }
        return send(200, {
          ...view, events: row.events, batchNo: row.owner?.batchNo || '', issuedAt: row.owner?.issuedAt || '',
          ...(view.status === 'success' && { orderSynced: Boolean(synced) }),
          ...(fullCode && { fullCode }), ...(original?.email && { fullEmail: original.email })
        });
      }
      if (request.method !== 'POST' || action !== 'read') return send(405, { error: '不支持此操作' });
      if (request.headers.origin !== origin) return send(403, { error: '请求来源未通过校验' });
      const event = Number(url.searchParams.get('event'));
      if (!Number.isSafeInteger(event) || event < 1) return send(400, { error: '代充动态版本无效' });
      let read = false;
      update(data => {
        read = false;
        return { ...data, rows: data.rows.map(item => {
          if (item.id !== id || item.events.length !== event || (!canManage(actor) && item.owner?.id !== actor.id)) return item;
          read = true;
          return item.readBy.includes(actor.id) ? item : { ...item, readBy: [...item.readBy, actor.id] };
        }) };
      });
      return read ? send(200, { read: true }) : send(409, { error: '代充动态已更新' });
    } catch {
      return send(503, { error: '暂时无法读取代充动态，请稍后重试' });
    }
  }

  return {
    handle, collect,
    version(actor) {
      if (!canRead(actor)) return undefined;
      const key = actor.role + ':' + actor.id;
      if (!revisions.has(key)) revisions.set(key, digest(JSON.stringify([coverage, visible(actor).map(row => summary(row, actor))])));
      return revisions.get(key);
    },
    start() {
      const tick = async () => {
        await collect();
        if (!closed) timer = setTimeout(tick, intervalMs).unref();
      };
      void tick();
    },
    close() {
      closed = true;
      clearTimeout(timer);
    }
  };
}

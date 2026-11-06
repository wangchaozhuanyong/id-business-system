import { randomBytes, randomUUID } from 'node:crypto';

export const rechargeCodesRoute = '/api/local/recharge-codes';

const plans = new Set(['plus', 'pro100', 'pro200', 'pro500']);
const roles = new Set(['employee', 'admin', 'super']);
const approvers = new Set(['admin', 'super']);
const codeStatuses = new Set(['unused', 'processing', 'used']);
const requestKeyPattern = /^[a-zA-Z0-9._-]{1,120}$/;
const idPattern = /^[0-9a-f-]{36}$/;

class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function reply(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(body));
}

async function readAction(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || ''))
    throw new RequestError(400, '请提交 JSON 格式的充值码申请');
  const chunks = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > 4096) {
      request.resume();
      throw new RequestError(400, '充值码申请内容过长');
    }
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks));
    if (body && typeof body === 'object' && !Array.isArray(body)) return body;
  } catch {}
  throw new RequestError(400, '充值码申请格式不正确');
}

function visibleRequest(row, actorId) {
  const {
    id, plan, count, applicantId, applicantName, status, createdAt, updatedAt, approvedById,
    approvedAt, issuedAt, rejectedById, rejectedAt, reason, issueProblem
  } = row;
  return {
    id, plan, count, applicantId, applicantName, status, createdAt, updatedAt, approvedById,
    approvedAt, issuedAt, rejectedById, rejectedAt, reason, issueProblem,
    ...(status === 'issued' && actorId === applicantId ? { codes: row.codes } : {})
  };
}

function codeReadback(row, upstream) {
  if (!Array.isArray(upstream)) throw new Error('充值码回读格式不正确');
  const found = new Map();
  const candidates = new Set(row.codes.map(code => code.toUpperCase()));
  let conflict = false;
  for (const item of upstream) {
    if (typeof item?.code !== 'string' || !candidates.has(item.code.toUpperCase())) continue;
    if (
      found.has(item.code) ||
      !row.codes.includes(item.code) ||
      item.plan_type !== row.plan ||
      item.type !== '自助' ||
      item.status !== 'unused' ||
      item.shipped !== false
    ) conflict = true;
    found.set(item.code, item);
  }
  return { conflict, foundCount: found.size, missing: row.codes.filter(code => !found.has(code)) };
}

export function lookupRechargeCodeOwner(data, code) {
  if (typeof code !== 'string' || !code) return null;
  const normalized = code.trim().toUpperCase();
  const row = data?.requests?.find(entry => entry.status === 'issued' && entry.codes.includes(normalized));
  return row ? { requestId: row.id, employeeId: row.applicantId } : null;
}

export function createRechargeCodeHandler({ store, transport, publicOrigin, clock = Date.now }) {
  const issuing = new Set();
  const time = () => new Date(clock()).toISOString();

  async function listIssuedCodes(rows, actorId) {
    const issued = rows.filter(row => row.status === 'issued');
    if (!issued.length) return [];
    const codes = new Set(issued.flatMap(row => row.codes));
    const current = new Map();
    try {
      const upstream = await transport?.listCodes();
      if (Array.isArray(upstream)) {
        for (const item of upstream) {
          if (!codes.has(item?.code)) continue;
          current.set(item.code, current.has(item.code) ? null : item);
        }
      }
    } catch {
      current.clear();
    }
    return issued.flatMap(row => row.codes.map(code => {
      const record = current.get(code);
      const status = record?.plan_type === row.plan && record.type === '自助' && codeStatuses.has(record.status)
        ? record.status : 'unavailable';
      return {
        requestId: row.id,
        plan: row.plan,
        applicantId: row.applicantId,
        applicantName: row.applicantName,
        ...(actorId === row.applicantId ? { code } : {}),
        last4: code.slice(-4),
        status,
        usedAt: status === 'used' && typeof record.used_at === 'string' ? record.used_at : null
      };
    }));
  }

  async function change(actor, prepare) {
    // A concurrent change to another application can advance the document version.
    for (let attempt = 0; attempt < 4; attempt++) {
      const snapshot = await store.load();
      const previous = snapshot.data?.requests ?? [];
      const { row, action } = prepare(previous);
      if (!action) return row;
      const requests = previous.some(entry => entry.id === row.id)
        ? previous.map(entry => entry.id === row.id ? row : entry)
        : [row, ...previous];
      try {
        await store.save(snapshot.version, { requests }, { action, targetId: row.id, actor });
        return row;
      } catch (error) {
        if (error?.status !== 409 || attempt === 3) throw error;
      }
    }
  }

  function findRequest(rows, id) {
    const row = rows.find(entry => entry.id === id);
    if (!row) throw new RequestError(404, '没有找到这条充值码申请');
    return row;
  }

  async function createRequest(body, actor) {
    if (
      !plans.has(body.plan) || !Number.isSafeInteger(body.count) || body.count < 1 || body.count > 100 ||
      typeof body.requestKey !== 'string' || !requestKeyPattern.test(body.requestKey)
    ) throw new RequestError(400, '请选择套餐并填写 1 至 100 的申请数量');
    let created = false;
    const row = await change(actor, rows => {
      const existing = rows.find(entry => entry.applicantId === actor.id && entry.requestKey === body.requestKey);
      created = !existing;
      if (existing) {
        if (existing.plan !== body.plan || existing.count !== body.count)
          throw new RequestError(409, '同一申请编号的套餐或数量已变化，请重新发起申请');
        return { row: existing };
      }
      const at = time();
      return {
        row: {
          id: randomUUID(), requestKey: body.requestKey, plan: body.plan, count: body.count,
          applicantId: actor.id, applicantName: actor.name, status: 'pending', createdAt: at, updatedAt: at
        },
        action: 'recharge_code_request'
      };
    });
    return { row, created };
  }

  function rejectRequest(body, actor) {
    const reason = body.reason === undefined ? '' : body.reason;
    if (typeof reason !== 'string' || reason.length > 200 || /[\x00-\x1f\x7f]/.test(reason))
      throw new RequestError(400, '退回原因最多 200 个字符');
    return change(actor, rows => {
      const row = findRequest(rows, body.id);
      if (row.status === 'rejected') return { row };
      if (row.status !== 'pending') throw new RequestError(409, '只有待审批申请可以退回');
      const at = time();
      return {
        row: { ...row, status: 'rejected', rejectedById: actor.id, rejectedAt: at, updatedAt: at, reason: reason.trim() },
        action: 'recharge_code_reject'
      };
    });
  }

  async function approveRequest(body, actor) {
    const { id, action } = body;
    if (!transport) throw new RequestError(503, '线上代充服务尚未接入');
    if (issuing.has(id)) throw new RequestError(409, '正在核对这批充值码，请稍后刷新');
    issuing.add(id);
    try {
      let row = await change(actor, rows => {
        const current = findRequest(rows, id);
        if (current.status === 'issued' || current.status === 'issuing') return { row: current };
        if (current.status !== 'pending' || action !== 'approve')
          throw new RequestError(409, '这条申请尚未通过审批或已经退回');
        const at = time();
        return {
          row: {
            ...current, status: 'issuing', approvedById: actor.id, approvedAt: at, updatedAt: at,
            codes: Array.from({ length: current.count }, () => 'KC-' + randomBytes(14).toString('hex').toUpperCase())
          },
          action: 'recharge_code_approve'
        };
      });
      if (row.status === 'issued') return row;

      async function recordIssue(patch, issueAction) {
        return change(actor, rows => {
          const current = findRequest(rows, id);
          if (current.status === 'issued') return { row: current };
          if (issueAction === 'recharge_code_issue_pending' && current.issueProblem === patch.issueProblem)
            return { row: current };
          return { row: { ...current, ...patch, updatedAt: time() }, action: issueAction };
        });
      }

      const pending = issueProblem => recordIssue({ issueProblem }, 'recharge_code_issue_pending');
      const readback = async () => {
        try { return codeReadback(row, await transport.listCodes()); }
        catch { return null; }
      };
      let receipt = await readback();
      if (!receipt) return await pending('暂时无法核对代充卡池，请重试核对');
      if (receipt.conflict || (!row.importStartedAt && receipt.foundCount))
        return await pending('代充卡池存在冲突记录，请管理员核对');

      if (receipt.missing.length) {
        if (!row.importStartedAt) {
          row = await recordIssue({ importStartedAt: time() }, 'recharge_code_import_started');
          if (row.status === 'issued') return row;
        }
        try {
          await transport.importCodes({ codes: receipt.missing, plan: row.plan });
        } catch {
          // The upstream may have committed even if the response timed out.
        }
        receipt = await readback();
      }
      if (receipt?.conflict) return await pending('代充卡池存在冲突记录，请管理员核对');
      if (!receipt || receipt.missing.length)
        return await pending('充值码尚未全部核对成功，请重试核对');
      return await recordIssue(
        { status: 'issued', issuedAt: time(), issueProblem: undefined },
        'recharge_code_issued'
      );
    } finally {
      issuing.delete(id);
    }
  }

  return async function handleRechargeCodeRequests(request, response, actor) {
    try {
      if (!actor?.id || actor.active !== true || !roles.has(actor.role))
        throw new RequestError(401, '请先登录后管理充值码申请');
      const canApprove = approvers.has(actor.role);
      if (request.method === 'GET') {
        const { data } = await store.load();
        const rows = (data?.requests ?? []).filter(row => canApprove || row.applicantId === actor.id);
        const params = new URLSearchParams((request.url || '').split('?', 2)[1]);
        if (params.get('view') === 'codes')
          return reply(response, 200, { canApprove, items: await listIssuedCodes(rows, actor.id) });
        return reply(response, 200, {
          canApprove,
          requests: rows.map(row => visibleRequest(row, actor.id))
        });
      }
      if (request.method !== 'POST') throw new RequestError(405, '仅支持读取或提交充值码申请');
      if (
        request.headers.origin !== (publicOrigin || 'http://' + request.headers.host) ||
        (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin')
      ) throw new RequestError(403, '请在本系统提交充值码申请');
      const body = await readAction(request);
      if (body.action === 'request') {
        const { row, created } = await createRequest(body, actor);
        return reply(response, created ? 201 : 200, { request: visibleRequest(row, actor.id) });
      }
      if (!['approve', 'reject', 'reconcile'].includes(body.action))
        throw new RequestError(400, '请选择有效的充值码申请操作');
      if (!canApprove) throw new RequestError(403, '当前账号没有审批充值码的权限');
      if (typeof body.id !== 'string' || !idPattern.test(body.id))
        throw new RequestError(400, '充值码申请编号不正确');
      const row = body.action === 'reject' ? await rejectRequest(body, actor) : await approveRequest(body, actor);
      return reply(response, 200, { request: visibleRequest(row, actor.id) });
    } catch (error) {
      if (response.destroyed || response.headersSent) return;
      if (error instanceof RequestError) return reply(response, error.status, { error: error.message });
      if (error?.status === 409) return reply(response, 409, { error: '申请记录已变化，请刷新后重试' });
      return reply(response, 500, { error: '未能确认充值码申请结果，请刷新后核对' });
    }
  };
}

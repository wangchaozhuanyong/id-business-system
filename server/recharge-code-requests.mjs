import { createCodeReturnManager, codeReturnEntry, publicReturnRecord } from './recharge-code-returns.mjs';
import { numberedRechargeRequests } from './recharge-code-numbers.mjs';
import { generatedCdkPattern } from '../modules/recharge/codexdaichong/native-code-returns.mjs';
import { randomUUID } from 'node:crypto';

export const rechargeCodesRoute = '/api/local/recharge-codes';

const plans = new Set(['plus', 'pro100', 'pro200', 'pro500']);
const roles = new Set(['employee', 'admin', 'super']);
const approvers = new Set(['admin', 'super']);
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
    if (bytes > 8192) {
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
    id, batchNo, plan, count, applicantId, applicantName, status, createdAt, updatedAt, approvedById,
    approvedAt, issuedAt, rejectedById, rejectedAt, reason, issueProblem
  } = row;
  return {
    id, batchNo, plan, count, applicantId, applicantName, status, createdAt, updatedAt, approvedById,
    approvedAt, issuedAt, rejectedById, rejectedAt, reason, issueProblem,
    returns: (row.returns || []).map(publicReturnRecord),
    ...(status === 'issued' && actorId === applicantId ? { codes: row.codes.filter(code => !['returned', 'pending'].includes(codeReturnEntry(row, code)?.state)) } : {})
  };
}

export function unassignedRechargeStock(stock, rows, reservedCodes = []) {
  // Keep former assignments and the original codes of interrupted batches excluded.
  const assigned = new Set(rows.flatMap(row => (row.codes || []).map(code => code.toUpperCase())));
  for (const code of reservedCodes) assigned.add(code);
  return stock.filter(({ code }) => !assigned.has(code));
}

export function lookupRechargeCodeOwner(data, code) {
  if (typeof code !== 'string' || !code) return null;
  const normalized = code.trim().toUpperCase();
  const row = data?.requests?.find(entry => entry.status === 'issued' && entry.codes.includes(normalized));
  return row ? { requestId: row.id, employeeId: row.applicantId } : null;
}

export function createRechargeCodeHandler({ store, transport, publicOrigin, clock = Date.now }) {
  const time = () => new Date(clock()).toISOString();

  async function change(actor, prepare) {
    // A concurrent change to another application can advance the document version.
    for (let attempt = 0; attempt < 4; attempt++) {
      const snapshot = await store.load();
      // Fix legacy display numbers before adding a request; the versioned save persists both together.
      const previous = numberedRechargeRequests(snapshot.data?.requests ?? []);
      const { row, action } = await prepare(previous, snapshot.data?.partnerReservedCodes ?? []);
      if (!action) return row;
      const requests = numberedRechargeRequests(previous.some(entry => entry.id === row.id)
        ? previous.map(entry => entry.id === row.id ? row : entry)
        : [row, ...previous]);
      try {
        await store.save(snapshot.version, { ...snapshot.data, requests }, { action, targetId: row.id, actor });
        return requests.find(entry => entry.id === row.id);
      } catch (error) {
        if (error?.status !== 409 || attempt === 3) throw error;
      }
    }
  }

  const returns = createCodeReturnManager({ store, transport, change, time });

  async function readStock() {
    try {
      const stock = await transport?.listCodeStock();
      if (Array.isArray(stock) && stock.every(item => typeof item?.code === 'string' &&
        generatedCdkPattern.test(item.code) && plans.has(item.plan)) &&
        new Set(stock.map(item => item.code)).size === stock.length) return stock;
    } catch {
      // A missing or invalid reply is distinct from a verified empty pool.
    }
    throw new RequestError(503, '暂时无法核对充值码库存，请刷新后重试');
  }

  async function codesFor(rows, reservedCodes, plan, count) {
    const available = unassignedRechargeStock(await readStock(), rows, reservedCodes).filter(item => item.plan === plan);
    if (available.length < count)
      throw new RequestError(409, `该套餐当前可提取 ${available.length} 个，库存不足`);
    return available.slice(0, count).map(item => item.code);
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
    const row = await change(actor, async (rows, reservedCodes) => {
      const existing = rows.find(entry => entry.applicantId === actor.id && entry.requestKey === body.requestKey);
      created = !existing;
      if (existing) {
        if (existing.plan !== body.plan || existing.count !== body.count)
          throw new RequestError(409, '同一申请编号的套餐或数量已变化，请重新发起申请');
        return { row: existing };
      }
      await codesFor(rows, reservedCodes, body.plan, body.count);
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
      if (!['pending', 'issuing'].includes(row.status))
        throw new RequestError(409, '只有待审核或待发码核对的申请可以驳回');
      const at = time();
      return {
        row: { ...row, status: 'rejected', rejectedById: actor.id, rejectedAt: at, updatedAt: at,
          reason: reason.trim(), issueProblem: undefined },
        action: 'recharge_code_reject'
      };
    });
  }

  async function originalBatchProblem(row) {
    const codes = row.codes || [];
    const incomplete = '旧批次的原码未全部核对成功，可驳回后按库存重新申请';
    if (!row.importStartedAt || codes.length !== row.count || new Set(codes).size !== row.count) return incomplete;
    try {
      const checks = await transport?.checkReturns(codes.map(code => ({ code, plan: row.plan })));
      if (Array.isArray(checks) && checks.length === codes.length &&
        codes.every(code => checks.some(item => item?.code === code && item.plan === row.plan &&
          item.eligible === true && item.state === 'unused'))) return '';
      return incomplete;
    } catch {
      return '暂时无法核对旧批次，请重试';
    }
  }

  function approveRequest({ id, action }, actor) {
    return change(actor, async (rows, reservedCodes) => {
      const row = findRequest(rows, id);
      if (row.status === 'issued') return { row };
      let codes;
      if (row.status === 'issuing') {
        const issueProblem = await originalBatchProblem(row);
        if (issueProblem) return row.issueProblem === issueProblem ? { row }
          : { row: { ...row, issueProblem, updatedAt: time() }, action: 'recharge_code_issue_pending' };
        codes = row.codes;
      } else {
        if (row.status !== 'pending' || action !== 'approve')
          throw new RequestError(409, '这条申请不在待审核状态');
        codes = await codesFor(rows, reservedCodes, row.plan, row.count);
      }
      const at = time();
      return {
        row: { ...row, status: 'issued', approvedById: row.approvedById ?? actor.id,
          approvedAt: row.approvedAt ?? at, issuedAt: at, updatedAt: at, codes, issueProblem: undefined },
        action: 'recharge_code_issued'
      };
    });
  }

  return async function handleRechargeCodeRequests(request, response, actor) {
    try {
      if (!actor?.id || actor.active !== true || !roles.has(actor.role))
        throw new RequestError(401, '请先登录后管理充值码申请');
      const canApprove = approvers.has(actor.role);
      if (request.method === 'GET') {
        const view = new URLSearchParams((request.url || '').split('?', 2)[1]).get('view');
        if (view === 'pending-summary' && !canApprove)
          throw new RequestError(403, '当前账号没有审批充值码的权限');
        const { version, data } = await store.load();
        const requests = data?.requests ?? [];
        if (view === 'pending-summary')
          return reply(response, 200, { version,
            pending: requests.filter(row => row.status === 'pending' || row.status === 'issuing').length });
        const rows = numberedRechargeRequests(requests).filter(row => canApprove || row.applicantId === actor.id);
        if (view === 'codes')
          return reply(response, 200, { canApprove, items: await returns.view(rows, actor.id) });
        const [items, stock] = await Promise.all([
          returns.view(rows, actor.id),
          readStock().then(codes => {
            const counts = Object.fromEntries([...plans].map(plan => [plan, 0]));
            for (const { plan } of unassignedRechargeStock(codes, requests, data?.partnerReservedCodes)) counts[plan]++;
            return counts;
          }).catch(() => null)
        ]);
        return reply(response, 200, {
          canApprove,
          stock,
          requests: rows.map(row => {
            const own = items.filter(item => item.requestId === row.id);
            return { ...visibleRequest(row, actor.id), counts: {
              returnable: own.filter(item => item.eligible).length,
              unused: own.filter(item => item.status === 'unused').length,
              used: own.filter(item => item.status === 'used').length,
              processing: own.filter(item => item.status === 'processing').length,
              unavailable: own.filter(item => item.status === 'unavailable').length,
              returned: own.filter(item => item.status === 'returned').length,
              pendingReturns: own.filter(item => item.status === 'return-pending').length
            } };
          })
        });
      }
      if (request.method !== 'POST') throw new RequestError(405, '仅支持读取或提交充值码申请');
      if (
        request.headers.origin !== (publicOrigin || 'http://' + request.headers.host) ||
        (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin')
      ) throw new RequestError(403, '请在本系统提交充值码申请');
      const body = await readAction(request);
      if (body.action === 'return-preview')
        return reply(response, 200, { items: await returns.preview(body.itemIds, actor) });
      if (['return', 'return-reconcile'].includes(body.action))
        return reply(response, 200, { items: await returns.execute(body.itemIds, actor, body.note, body.action === 'return-reconcile') });
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
      if (error instanceof returns.ReturnError) return reply(response, error.status, { error: error.message, ...(error.items && { items: error.items }) });
      if (error instanceof RequestError) return reply(response, error.status, { error: error.message });
      if (error?.status === 409) return reply(response, 409, { error: '申请记录已变化，请刷新后重试' });
      return reply(response, 500, { error: '未能确认充值码申请结果，请刷新后核对' });
    }
  };
}

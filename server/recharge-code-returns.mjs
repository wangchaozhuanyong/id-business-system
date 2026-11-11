import { createHash } from 'node:crypto';
import { numberedRechargeRequests, rechargeCodeItemNumber } from './recharge-code-numbers.mjs';
export const rechargeCodeItemId = (requestId, code) => 'code-' + createHash('sha256').update(requestId + ':' + code).digest('hex').slice(0, 32);
export const codeReturnEntry = (row, code) => row.returns?.find(entry => entry.itemId === rechargeCodeItemId(row.id, code));
export const publicReturnRecord = entry => {
  const { id, itemId, state, actorId, actorName, note, startedAt, returnedAt, reason } = entry;
  return { id, itemId, state, actorId, actorName, note, startedAt, returnedAt, reason };
};
const states = new Set(['unused', 'used', 'processing']);
const pending = entry => entry?.state === 'pending';
const metadata = (row, code) => ({ id: rechargeCodeItemId(row.id, code), requestId: row.id,
  batchNo: row.batchNo, itemNo: rechargeCodeItemNumber(row, code), plan: row.plan,
  applicantId: row.applicantId, applicantName: row.applicantName, issuedAt: row.issuedAt, last4: code.slice(-4) });
class ReturnError extends Error { constructor(status, message, items) { super(message); this.status = status; this.items = items; } }

export function createCodeReturnManager({ store, transport, change, time }) {
  const locate = rows => new Map(rows.filter(row => row.status === 'issued').flatMap(row => row.codes.map(code =>
    [rechargeCodeItemId(row.id, code), { row, code }])));
  async function upstreamChecks(targets) {
    const checks = new Map();
    if (!targets.length || !transport?.checkReturns) return checks;
    try {
      for (let offset = 0; offset < targets.length; offset += 100) {
        const batch = targets.slice(offset, offset + 100);
        const result = await transport.checkReturns(batch.map(({ row, code }) => ({ code, plan: row.plan })));
        if (!Array.isArray(result) || result.length !== batch.length) throw new Error('invalid_return_check');
        for (const item of batch) {
          const matches = result.filter(check => check.code === item.code && check.plan === item.row.plan);
          if (matches.length !== 1 || typeof matches[0].eligible !== 'boolean' ||
              !['unused', 'returned', 'blocked', 'conflict'].includes(matches[0].state) ||
              typeof matches[0].reason !== 'string') throw new Error('invalid_return_check');
          checks.set(rechargeCodeItemId(item.row.id, item.code), matches[0]);
        }
      }
    } catch { checks.clear(); }
    return checks;
  }
  async function view(rows, actorId) {
    const targets = [...locate(rows).values()];
    if (!targets.length) return [];
    const native = new Map();
    try {
      const codes = await transport?.listCodes();
      if (Array.isArray(codes)) for (const row of codes) native.set(row.code, native.has(row.code) ? null : row);
    } catch { /* Unknown is never unused. */ }
    const checks = await upstreamChecks(targets.filter(({ row, code }) => codeReturnEntry(row, code)?.state !== 'returned'));
    return targets.map(({ row, code }) => {
      const id = rechargeCodeItemId(row.id, code), record = codeReturnEntry(row, code), current = native.get(code);
      const state = current?.plan_type === row.plan && current.type === '自助' && states.has(current.status) ? current.status : 'unavailable';
      const status = record?.state === 'returned' ? 'returned' : pending(record) ? 'return-pending' : state;
      const check = checks.get(id);
      const owner = row.applicantId === actorId;
      const eligible = owner && !pending(record) && status === 'unused' && current.shipped === false &&
        check?.eligible === true && check.state === 'unused';
      const reason = status === 'returned' ? '已归还' : !owner ? '仅领码人可归还' : pending(record)
        ? '归还结果待核对' : current?.shipped ? '已交付，不能直接归还' : status === 'used'
          ? '已使用' : status === 'processing' ? '正在使用，不能归还' : check?.reason || '状态待核对，暂不可归还';
      return { ...metadata(row, code), ...(owner && !['returned', 'return-pending'].includes(status) ? { code } : {}),
        status, eligible, returnReason: reason, ...(record ? { returnRecord: publicReturnRecord(record) } : {}),
        usedAt: status === 'used' && typeof current.used_at === 'string' ? current.used_at : null };
    });
  }
  function selected(rows, ids, actor) {
    if (!Array.isArray(ids) || !ids.length || ids.length > 100 || new Set(ids).size !== ids.length ||
        !ids.every(id => typeof id === 'string' && /^code-[a-f0-9]{32}$/.test(id)))
      throw new ReturnError(400, '请选择 1 至 100 条不同的领码记录');
    const index = locate(rows);
    return ids.map(id => {
      const item = index.get(id);
      return item && item.row.applicantId === actor.id ? { ...item, id } : { id, missing: true };
    });
  }
  async function preview(ids, actor) {
    const { data } = await store.load(), rows = numberedRechargeRequests(data?.requests || []);
    const targets = selected(rows, ids, actor), checks = await upstreamChecks(targets.filter(row => !row.missing));
    return targets.map(item => {
      if (item.missing) return { id: item.id, eligible: false, reason: '领码记录不存在或不属于当前账号' };
      const record = codeReturnEntry(item.row, item.code), check = checks.get(item.id);
      return { ...metadata(item.row, item.code), eligible: !record || record.state === 'blocked'
        ? check?.eligible === true && check.state === 'unused' : false,
        reason: record?.state === 'returned' ? '已归还' : pending(record) ? '归还结果待核对，请核对并继续'
          : check?.reason || '状态待核对，暂不可归还', state: record?.state || check?.state || 'unavailable' };
    });
  }
  async function recordResult(item, actor, state, reason, returnedAt) {
    return change(actor, rows => {
      const row = rows.find(row => row.id === item.row.id);
      const existing = codeReturnEntry(row, item.code);
      if (!existing) throw new ReturnError(409, '归还操作未登记，请刷新后核对');
      if (existing.state === 'returned') return { row };
      const entry = { ...existing, state, reason, ...(returnedAt ? { returnedAt } : {}) };
      return { row: { ...row, returns: row.returns.map(r => r.id === entry.id ? entry : r), updatedAt: time() },
        action: state === 'returned' ? 'recharge_code_returned' : 'recharge_code_return_pending' };
    });
  }
  async function execute(ids, actor, note = '', reconcile = false) {
    if (typeof note !== 'string' || note.length > 200 || /[\x00-\x1f\x7f]/.test(note))
      throw new ReturnError(400, '归还备注最多 200 字');
    if (!transport?.commitReturn || !transport?.returnReceipt || !transport?.checkReturns)
      throw new ReturnError(503, '归还服务尚未就绪');
    const { data } = await store.load(), targets = selected(numberedRechargeRequests(data?.requests || []), ids, actor);
    if (targets.some(item => item.missing)) throw new ReturnError(403, '只能归还本账号可追溯的领码记录');
    const review = await preview(ids, actor);
    const valid = review.every((row, i) => row.eligible || row.state === 'returned' ||
      (reconcile && pending(codeReturnEntry(targets[i].row, targets[i].code))));
    if (!valid) throw new ReturnError(409, '所选充值码状态已变化，请重新核对后确认', review);
    const results = [];
    for (const item of targets) {
      // Save recoverable intent before any external mutation. Same item always uses the same operation ID.
      const row = await change(actor, rows => {
        const current = rows.find(row => row.id === item.row.id);
        const existing = codeReturnEntry(current, item.code);
        if (existing && existing.state !== 'blocked') return { row: current };
        const at = time(), entry = { id: 'return_' + item.id.slice(5), itemId: item.id,
          state: 'pending', actorId: actor.id, actorName: actor.name, note, startedAt: at, reason: '正在确认原码失效' };
        return { row: { ...current, returns: [...(current.returns || []).filter(r => r.itemId !== item.id), entry], updatedAt: at },
          action: 'recharge_code_return_started' };
      });
      const record = codeReturnEntry(row, item.code);
      if (record.state === 'returned') { results.push({ ...metadata(row, item.code), ...publicReturnRecord(record), id: item.id, returnId: record.id }); continue; }
      const command = { code: item.code, plan: item.row.plan, operationId: record.id };
      let receipt;
      try {
        receipt = await transport.returnReceipt(command);
        if (receipt?.state === 'not-found') {
          const checks = await upstreamChecks([item]), check = checks.get(item.id);
          // A fresh row-locking check precedes a safe replay of the same operation after a lost response.
          receipt = check?.state === 'returned' ? check : check?.eligible === true ? await transport.commitReturn(command)
            : { state: check?.state === 'blocked' ? 'blocked' : 'pending', reason: check?.reason || '状态待核对，请稍后继续核对' };
        }
      } catch {
        try { receipt = await transport.returnReceipt(command); } catch { receipt = null; }
      }
      const confirmed = receipt?.state === 'returned' && receipt.operationId === record.id &&
        typeof receipt.returnedAt === 'string' && Number.isFinite(Date.parse(receipt.returnedAt));
      const state = confirmed ? 'returned' : receipt?.state === 'blocked' ? 'blocked' : 'pending';
      const reason = confirmed ? '已归还，原码已永久失效' : state === 'blocked' ? receipt.reason : '未确认原码失效，请核对并继续';
      try {
        const saved = await recordResult(item, actor, state, reason, confirmed ? receipt.returnedAt : undefined);
        results.push({ ...metadata(item.row, item.code), ...publicReturnRecord(codeReturnEntry(saved, item.code)), id: item.id, returnId: record.id });
      } catch {
        results.push({ ...metadata(item.row, item.code), ...publicReturnRecord(record), id: item.id, returnId: record.id, state: 'pending', reason: '原操作已登记，落账结果待核对，请核对并继续' });
      }
    }
    return results;
  }
  return { view, preview, execute, ReturnError };
}

import { createPaymentApprovals } from './payment-approval.mjs';

export const approvalPath = '/api/admin/payment-approvals';

export function adapterPaymentApprovals(pool) {
  return createPaymentApprovals(async operation => {
    const db = await pool.getConnection();
    try {
      await db.beginTransaction();
      const result = await operation(db);
      await db.commit();
      return result;
    } catch (error) {
      await db.rollback().catch(() => {});
      throw error;
    } finally { db.release(); }
  });
}

export async function handleApproval(req, res, actor, approvals) {
  const send = (code, body) => {
    res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify(body));
  };
  if (!actor?.admin || !actor.sensitive) return send(403, { message: '仅超级管理员可办理付款确认' });
  if (actor.id === 'order-reconciliation' && !(req.method === 'GET' && req.url === approvalPath))
    return send(403, { message: '此服务只可读取付款待办。' });
  if (!approvals) return send(503, { message: '付款确认暂不可用' });
  try {
    if (req.method === 'GET' && req.url === approvalPath) return send(200, { items: await approvals.list() });
    if (req.method === 'GET' && req.url === approvalPath + '/mode') return send(200, await approvals.policy());
    const mode = req.method === 'PUT' && req.url === approvalPath + '/mode';
    const decision = req.method === 'POST' && /^\/api\/admin\/payment-approvals\/([a-f0-9-]{36})\/(approve|cancel)$/.exec(req.url);
    if (!mode && !decision) return send(404, { message: '操作不存在' });
    if (!/^application\/json(?:;|$)/i.test(req.headers['content-type'] || '')) return send(415, { message: '请求格式不符' });
    const parts = [];
    let size = 0;
    for await (const part of req) {
      if ((size += part.length) > 512) return send(413, { message: '请求过长' });
      parts.push(part);
    }
    let input;
    try { input = JSON.parse(Buffer.concat(parts).toString()); } catch { return send(400, { message: '请求格式不符' }); }
    if (!input || typeof input !== 'object' || Array.isArray(input)) return send(400, { message: '请求格式不符' });
    if (mode && Object.keys(input).sort().join() === 'automatic,version')
      return send(200, await approvals.setPolicy(input.automatic, input.version, actor.id));
    if (decision && Object.keys(input).length === 0) {
      await approvals.decide(decision[1], decision[2] === 'approve' ? 'approved' : 'cancelled', actor.id);
      return send(200, { accepted: true });
    }
    return send(400, { message: '请求字段无效' });
  } catch (error) {
    const conflict = error.status === 409 || ['ER_DUP_ENTRY', 'ER_LOCK_DEADLOCK'].includes(error.code);
    return send(conflict ? 409 : 503, { message: conflict ? '确认已失效，请刷新待办。' : '暂时无法核对付款确认状态。' });
  }
}


import { randomUUID } from 'node:crypto';

import { snapshotAction } from '../../modules/finance/accounting.mjs';

export const automaticSnapshotRoute = '/api/local/finance/auto-snapshot';

function reply(response, status, body) {
  response.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store'
  });
  response.end(JSON.stringify(body));
}

async function readOrderIdentity(request) {
  if (!/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || '')) return null;
  let bytes = 0;
  const chunks = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += chunk.length;
    if (bytes > 2048) {
      request.resume();
      return null;
    }
    chunks.push(chunk);
  }
  try {
    const body = JSON.parse(Buffer.concat(chunks));
    if (Object.keys(body).length === 2 && typeof body.orderId === 'string' &&
        /^[A-Za-z0-9._-]{1,120}$/.test(body.orderId) &&
        Number.isSafeInteger(body.version) && body.version > 0) return body;
  } catch {
    return null;
  }
  return null;
}

// Mount after preview's loopback, login and administrator checks. The only trusted
// automatic-snapshot verifier is injected on this server-side transaction.
export function createAutomaticSnapshotHandler({ store, quoteService, clock = Date.now, publicOrigin }) {
  return async (request, response, actor) => {
    if (request.method !== 'POST')
      return reply(response, 405, { error: '自动汇率只接受订单冻结请求' });
    if (request.headers.origin !== (publicOrigin || `http://${request.headers.host}`) ||
        (request.headers['sec-fetch-site'] && request.headers['sec-fetch-site'] !== 'same-origin'))
      return reply(response, 403, { error: '仅允许从本机页面冻结汇率' });
    if (!quoteService.enabled)
      return reply(response, 503, { error: '尚未配置自动汇率来源' });

    try {
      const identity = await readOrderIdentity(request);
      if (!identity) return reply(response, 400, { error: '订单编号或版本格式无效' });
      const findOrder = ({ data }) => data?.orders.find((row) => row.id === identity.orderId);
      const eligible = (order) =>
        order?.version === identity.version && !order.fxSnapshot && !order.cancelled;
      const order = findOrder(store.load('commerce'));
      if (!eligible(order)) return reply(response, 409, { error: '订单已变化或已有汇率快照' });

      let snapshot;
      try {
        snapshot = await quoteService.snapshotFor(order);
      } catch (error) {
        return reply(response, 422, { error: error.message });
      }

      // A manual freeze or order correction may have committed while the provider was in flight.
      const current = store.load('commerce');
      const latest = findOrder(current);
      if (!eligible(latest)) return reply(response, 409, { error: '订单已变化或已有汇率快照' });
      // Commerce timeline text follows the existing Beijing minute format.
      const at = new Date(clock() + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ');
      const actorName = actor?.name || '本机操作员';
      const actorId = actor?.id || 'local-operator';
      Object.assign(latest, {
        fxSnapshot: snapshot, version: latest.version + 1,
        updatedAt: at, updatedBy: actorName, updatedById: actorId
      });
      current.data.logs.unshift({
        id: `commerce-log-${randomUUID()}`, type: snapshotAction, entityId: latest.id,
        detail: latest.orderNo, at, actor: actorName, actorId
      });
      const [saved] = store.saveBatch([{
        domain: 'commerce', version: current.version, data: current.data, action: snapshotAction
      }], { actor, verifyAutomaticSnapshot: quoteService.verifySnapshot });
      return reply(response, 200, { version: saved.version, data: saved.data });
    } catch (error) {
      if (response.destroyed) return;
      if (error?.status === 409)
        return reply(response, 409, { error: '订单或报价已变化，请重新核对' });
      return reply(response, 500, { error: '未能确认自动汇率登记结果，请重新打开订单核对' });
    }
  };
}

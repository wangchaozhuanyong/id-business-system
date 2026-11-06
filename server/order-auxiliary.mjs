import { randomUUID } from 'node:crypto';
import { readPoolCards } from './order-recharge-client.mjs';

export const orderAuxiliaryRoutes = new Set(['/api/local/order-cards', '/api/local/tenant-cards']);
const tenantDomain = 'tenant-cards';

function send(response, status, data) {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' });
  response.end(JSON.stringify(data));
}

async function body(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 4096) throw new Error('请求过长');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

const metadata = ({ number, ...row }) => ({ ...row, last4: number.slice(-4) });
const confirmedCardUse = (row, id) => (row.cardId === id && row.paidConfirmed) ||
  (row.financialEvidence || []).some((entry) => entry.kind === 'payment' && entry.cardId === id);
function iso(value) {
  if (!value) return '';
  const source = /(?:Z|[+-]\d{2}:\d{2})$/.test(value) ? value : String(value).replace(' ', 'T') + '+08:00';
  const time = Date.parse(source);
  return Number.isFinite(time) ? new Date(time).toISOString() : '';
}

export function createOrderAuxiliaryHandler({ store, client, publicOrigin }) {
  return async (request, response, route, actor) => {
    const origin = publicOrigin || `http://${request.headers.host}`;
    if (!actor?.id || !['admin', 'super'].includes(actor.role)) return send(response, 403, { error: '没有管理订单用卡的权限' });
    if ((request.headers.origin && request.headers.origin !== origin) ||
        request.headers['sec-fetch-site'] === 'cross-site')
      return send(response, 403, { error: '请求来源未通过校验' });
    if (route === '/api/local/order-cards') {
      if (request.method !== 'GET') return send(response, 405, { error: '仅支持读取代充卡池' });
      try {
        const pool = await readPoolCards(client);
        const orders = store.load('commerce').data?.orders || [];
        const items = pool.map((card) => {
          const manual = orders.filter((row) => row.source !== '线上代充' && confirmedCardUse(row, card.id));
          const manualLast = manual.flatMap((row) => [
            ...(row.cardId === card.id ? [iso(row.cardUsedAt || row.start)] : []),
            ...(row.financialEvidence || []).filter((entry) => entry.kind === 'payment' &&
              entry.cardId === card.id).map((entry) => iso(entry.at))
          ]).sort().at(-1);
          const autoLast = iso(card.lastUsedAt);
          const lastUsedAt = [autoLast, manualLast].filter(Boolean).sort().at(-1) || null;
          return { ...card, autoUsageCount: card.usageCount, manualUsageCount: manual.length,
            usageCount: card.usageCount === null ? null : card.usageCount + manual.length,
            lastUsedAt, sources: [...(card.usageCount ? ['线上代充'] : []), ...(manual.length ? ['手工录单'] : [])] };
        });
        return send(response, 200, { items });
      } catch {
        return send(response, 503, { error: '代充卡池暂时无法读取，请重试' });
      }
    }

    const view = ({ version, data }, tenantId) => ({
      version, items: (data?.items || []).filter((row) => row.tenantId === tenantId).map(metadata)
    });
    let command;
    if (request.method === 'GET') {
      command = { tenantId: new URL(request.url, origin).searchParams.get('tenantId') };
    } else if (request.method === 'POST' && request.headers.origin === origin &&
      /^application\/json(?:;|$)/i.test(request.headers['content-type'] || '')) {
      try { command = await body(request); }
      catch { return send(response, 400, { error: '无法读取银行卡操作' }); }
    } else {
      return send(response, request.method === 'POST' ? 403 : 405, { error: '不支持此操作' });
    }
    const tenantId = command?.tenantId;
    const tenant = store.load('commerce').data?.tenants?.find((row) => row.id === tenantId);
    if (!tenant) return send(response, 404, { error: '认证人不存在' });
    const current = store.featureDocument(tenantDomain);
    if (request.method === 'GET') return send(response, 200, view(current, tenantId));
    const items = current.data?.items || [];
    const card = items.find((row) => row.id === command.id && row.tenantId === tenantId);
    const audit = (action, targetId) => ({ action, actor, targetId });
    try {
      if (['reveal', 'copy'].includes(command.action)) {
        if (!card?.active || tenant.active === false) return send(response, 404, { error: '银行卡不可用' });
        store.auditFeature(tenantDomain, current.version,
          audit(command.action === 'copy' ? '复制租户银行卡号' : '查看租户银行卡号', card.id));
        return send(response, 200, { number: card.number });
      }
      if (command.version !== current.version) return send(response, 409, { error: '银行卡资料已更新，请刷新重试' });
      let next, action, targetId;
      if (command.action === 'add') {
        const number = typeof command.number === 'string' ? command.number.replace(/[ -]/g, '') : '';
        const label = typeof command.label === 'string' ? command.label.trim() : '';
        if (!/^\d{12,19}$/.test(number) || label.length > 80 || /[\x00-\x1f]/.test(label))
          return send(response, 400, { error: '请填写有效银行卡号，名称最多 80 字' });
        if (tenant.active === false || items.filter((row) => row.tenantId === tenantId).length >= 999 ||
            items.some((row) => row.tenantId === tenantId && row.number === number))
          return send(response, 409, { error: '认证人已停用、银行卡重复或已达 999 张上限' });
        targetId = 'tenant:' + randomUUID();
        next = [...items, { id: targetId, tenantId, number, label: label || '银行卡 ' +
          (items.filter((row) => row.tenantId === tenantId).length + 1), active: true }];
        action = '新增租户银行卡';
      } else if (command.action === 'deactivate' && card?.active) {
        targetId = card.id;
        next = items.map((row) => row.id === card.id ? { ...row, active: false } : row);
        action = '停用租户银行卡';
      } else return send(response, 400, { error: '不支持此银行卡操作' });
      return send(response, 200, view(store.saveFeatureDocument(tenantDomain, current.version, { items: next },
        audit(action, targetId)), tenantId));
    } catch (error) {
      return send(response, error.status === 409 ? 409 : 500, { error: '银行卡操作未完成，请刷新后重试' });
    }
  };
}

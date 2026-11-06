import { signRechargeAssertion } from '../modules/recharge/assertion.mjs';

const service = Object.freeze({
  id: 'order-reconciliation', email: 'order-reconciliation@localhost', admin: true, sensitive: true
});
const readPaths = /^\/api\/admin\/(?:cards|cdks|billing|sessions|orbitcard\/usage|task-logs(?:\/[a-zA-Z0-9_-]+)?)$/;
const maximumResponseBytes = 4 * 1024 * 1024;

async function readBoundedJson(response) {
  if (Number(response.headers.get('content-length')) > maximumResponseBytes) {
    await response.body?.cancel();
    throw new Error('代充资料响应超过处理上限');
  }
  const chunks = [];
  let bytes = 0;
  for await (const chunk of response.body) {
    bytes += chunk.byteLength;
    if (bytes > maximumResponseBytes) throw new Error('代充资料响应超过处理上限');
    chunks.push(chunk);
  }
  return JSON.parse(Buffer.concat(chunks).toString());
}

export function createOrderRechargeClient(config, fetchImpl = fetch) {
  const upstream = config && new URL(config.upstreamUrl);
  async function request(method, path, body, actor = service) {
    if (!upstream || upstream.protocol !== 'http:' || upstream.hostname !== '127.0.0.1' ||
        upstream.pathname !== '/' || upstream.username || upstream.password || !upstream.port ||
        typeof config.secret !== 'string' || Buffer.byteLength(config.secret) < 32)
      throw new Error('代充资料接口未配置');
    const target = new URL(path, upstream);
    const orbitRead = target.pathname !== '/api/admin/orbitcard/usage' ||
      [...target.searchParams.keys()].every((name) => ['page_size', 'keyword', 'recharge_status'].includes(name));
    if (target.origin !== upstream.origin || target.hash ||
        !(method === 'GET' && readPaths.test(target.pathname) && orbitRead ||
          method === 'POST' && path === '/api/admin/cdks/import'))
      throw new Error('不支持此代充资料操作');
    const response = await fetchImpl(target, {
      method, redirect: 'error', signal: AbortSignal.timeout(6000),
      headers: {
        'x-id-recharge-assertion': signRechargeAssertion(config.secret, method, path, actor),
        ...(body && { 'content-type': 'application/json' })
      },
      ...(body && { body: JSON.stringify(body) })
    });
    if (!response.ok) throw new Error('代充资料暂时无法读取');
    const result = await readBoundedJson(response);
    if (!result || result.success === false) throw new Error('代充资料操作未确认');
    return result;
  }
  return Object.freeze({
    get: (path) => request('GET', path),
    async listCodes() {
      const result = await request('GET', '/api/admin/cdks');
      if (!Array.isArray(result)) throw new Error('代充码列表格式不正确');
      return result;
    },
    async importCodes({ codes, plan, actor }) {
      const principal = actor?.id && actor?.email
        ? { id: actor.id, email: actor.email, admin: true, sensitive: true }
        : service;
      await request('POST', '/api/admin/cdks/import', { cdks: codes, plan_type: plan }, principal);
    }
  });
}

export async function readPoolCards(client) {
  const { cards } = await client.get('/api/admin/cards');
  if (!Array.isArray(cards)) throw new Error('代充卡池格式不正确');
  return cards.filter((row) => Number.isSafeInteger(Number(row.id)) && Number(row.id) > 0 &&
    /^\d{4}$/.test(row.last4)).map((row) => ({
    id: 'recharge:' + row.id,
    last4: row.last4,
    active: Number(row.is_active) === 1,
    usageCount: Number.isSafeInteger(row.usage_count) && row.usage_count >= 0 ? row.usage_count : null,
    lastUsedAt: row.last_used_at || null,
    status: String(row.status || '正常')
  }));
}

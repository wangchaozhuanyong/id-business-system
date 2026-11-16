import { currencies } from '../../modules/finance/accounting.mjs';
import { collectionError } from './collection-policy.mjs';

export const financeCollectionRoute = '/api/local/finance/collection';
const send = (response, status, data) => {
  response.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'private, no-store' });
  response.end(JSON.stringify(data));
};
async function readBody(request) {
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > 8192) throw collectionError(413, '采集操作请求过长');
    chunks.push(chunk);
  }
  try {
    const value = JSON.parse(Buffer.concat(chunks));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch { throw collectionError(400, '采集操作格式无效'); }
}
function queryParameters(url) {
  const allowed = ['tab', 'query', 'currency', 'status', 'mode', 'from', 'to', 'page', 'pageSize'];
  const input = Object.fromEntries(url.searchParams);
  if (Object.keys(input).some(key => !allowed.includes(key)) || [...url.searchParams.keys()].some(key => url.searchParams.getAll(key).length !== 1))
    throw collectionError(400, '查询条件无效');
  input.page = Number(input.page || 1); input.pageSize = Number(input.pageSize || 8);
  if (!Number.isSafeInteger(input.page) || input.page < 1 || input.page > 1_000_000 ||
      ![8, 10, 16, 20, 32, 50].includes(input.pageSize) ||
      (input.tab && !['rates', 'runs', 'history', 'settings', 'settings-history', 'status'].includes(input.tab)) ||
      (input.currency && (input.currency === 'CNY' || !currencies.includes(input.currency))) ||
      (input.status && !['running', 'updated', 'unchanged', 'partial', 'failed', 'valid', 'expired', 'missing'].includes(input.status)) ||
      (input.mode && !['automatic', 'manual', 'order'].includes(input.mode)) || (input.query?.length || 0) > 120)
    throw collectionError(400, '查询条件无效');
  for (const key of ['from', 'to']) if (input[key] && (!/^\d{4}-\d{2}-\d{2}$/.test(input[key]) ||
    !Number.isFinite(Date.parse(input[key] + 'T00:00:00Z')) || new Date(input[key] + 'T00:00:00Z').toISOString().slice(0, 10) !== input[key]))
    throw collectionError(400, '请选择有效日期');
  if (input.from && input.to && input.from > input.to) throw collectionError(400, '开始日期不能晚于结束日期');
  return input;
}
export function createFinanceCollectionHandler({ collection, publicOrigin }) {
  return async (request, response, actor) => {
    if (!actor?.id) return send(response, 401, { error: '请先登录' });
    if (!['admin', 'super'].includes(actor.role)) return send(response, 403, { error: '当前账号无权管理汇率采集' });
    const origin = publicOrigin || 'http://' + request.headers.host;
    if ((request.headers.origin && request.headers.origin !== origin) ||
        (request.headers['sec-fetch-site'] && !['same-origin', 'none'].includes(request.headers['sec-fetch-site'])))
      return send(response, 403, { error: '请求来源未通过校验' });
    try {
      if (request.method === 'GET') return send(response, 200, collection.view(queryParameters(new URL(request.url, origin))));
      if (request.method !== 'POST') return send(response, 405, { error: '不支持此采集操作' });
      if (request.headers.origin !== origin || !/^application\/json(?:\s*;|$)/i.test(request.headers['content-type'] || ''))
        return send(response, 403, { error: '请从当前页面提交采集操作' });
      const input = await readBody(request);
      const keys = { settings: ['action', 'version', 'settings'], collect: ['action'],
        'cleanup-preview': ['action'], cleanup: ['action', 'preview', 'confirm'] }[input.action];
      if (!keys || Object.keys(input).some(key => !keys.includes(key))) throw collectionError(400, '采集操作格式无效');
      if (input.action === 'settings') {
        if (!Number.isSafeInteger(input.version) || input.version < 1) throw collectionError(400, '设置版本无效');
        return send(response, 200, { settings: collection.saveSettings(input.version, input.settings, actor) });
      }
      if (input.action === 'collect') return send(response, 200, await collection.collect('manual', actor));
      if (input.action === 'cleanup-preview') return send(response, 200, collection.planCleanup());
      if (input.confirm !== true) throw collectionError(400, '请先核对清理预览并确认');
      return send(response, 200, collection.cleanup(input.preview, actor));
    } catch (error) {
      return send(response, [400, 409, 413, 422, 429, 503].includes(error.status) ? error.status : 503,
        { error: error.status ? error.message : '汇率采集暂时不可用，当前资料已保留' });
    }
  };
}

import { randomUUID } from 'node:crypto';
import { BitBrowserConnectionError } from './bitbrowser-connections.mjs';
export const bitBrowserProxyDomain = 'bitbrowser-proxies';
const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const fail = message => { throw new BitBrowserConnectionError(400, message); };
export function validateBitBrowserProxyWrite(body, previous) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
    Object.keys(body).some(key => !['id', 'version', 'name', 'countryCode', 'kind', 'mode', 'protocol', 'link'].includes(key)) ||
    !Number.isSafeInteger(body.version) || body.version < 0 || body.version >= Number.MAX_SAFE_INTEGER) fail('IP 资料或版本无效');
  const { version, name, countryCode, kind, mode, protocol } = body;
  if (Object.hasOwn(body, 'id') && !uuid.test(body.id || '')) fail('IP 编号无效');
  if (body.id && (!previous || previous.id !== body.id)) throw new BitBrowserConnectionError(404, '该 IP 已不存在，请刷新列表');
  let link = body.link;
  if (body.id && (link === undefined || link === '')) {
    if (mode !== previous.mode || protocol !== previous.protocol) fail('修改连接方式或协议时，请重新填写代理链接');
    link = previous.link;
  }
  if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) fail('请填写 80 字以内的 IP 名称或备注');
  if (typeof countryCode !== 'string' || !/^[a-z]{2}$/i.test(countryCode)) fail('请标记两位国家代码，如 PH、US、MY');
  if (!['mobile', 'dynamic_residential', 'static_residential'].includes(kind)) fail('请选择 IP 类型');
  if (!['dynamic', 'static'].includes(mode) || !['http', 'https', 'socks5'].includes(protocol)) fail('请选择有效的连接方式和协议');
  if (typeof link !== 'string' || link.length > 2048 || /[\x00-\x20\x7f]/.test(link)) fail('请填写有效的代理链接');
  let url;
  try { url = new URL(link); } catch { fail('请填写带协议的完整代理链接'); }
  if (mode === 'dynamic') {
    if (url.protocol !== 'https:' || url.username || url.password || url.hash) fail('动态提取链接须使用 HTTPS，不能含独立账号密码或片段');
  } else {
    if (!['http:', 'https:', 'socks5:'].includes(url.protocol) || !url.hostname || url.search || url.hash ||
      (url.pathname && url.pathname !== '/') || Boolean(url.username) !== Boolean(url.password)) fail('固定代理使用 协议://账号:密码@主机:端口，账号密码可一起省略');
    const port = Number(url.port || (url.protocol === 'https:' ? 443 : url.protocol === 'http:' ? 80 : 0));
    if (!Number.isInteger(port) || port < 1 || port > 65535) fail('固定代理端口须在 1 至 65535 之间');
    try { decodeURIComponent(url.username); decodeURIComponent(url.password); } catch { fail('代理账号或密码编码无效'); }
  }
  return { version, proxy: { id: body.id || randomUUID(), name: name.trim(), countryCode: countryCode.toUpperCase(), kind, mode,
    protocol: mode === 'static' ? url.protocol.slice(0, -1) : protocol, link: url.href } };
}
export function summarizeBitBrowserProxies(items) {
  return items.map(({ link, ...item }) => ({ ...item, endpoint: new URL(link).host }));
}
export function readBitBrowserProxy(current, body) {
  if (!body || Object.keys(body).some(key => !['id', 'version'].includes(key)) || !uuid.test(body.id || '') ||
    !Number.isSafeInteger(body.version)) fail('IP 编号或版本无效');
  if (current.version !== body.version) throw new BitBrowserConnectionError(409, 'IP 列表已更新，请刷新后重新选择');
  const proxy = current.data?.find(item => item.id === body.id);
  if (!proxy) throw new BitBrowserConnectionError(404, '所选 IP 已不存在，请重新选择');
  return proxy;
}

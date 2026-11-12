import { randomUUID } from 'node:crypto';
import { parseBitBrowserProxyInput } from '../modules/recharge/bitbrowser/proxy-input.mjs';
import { isProxyType } from '../modules/recharge/bitbrowser/proxy-types.mjs';
import { BitBrowserConnectionError } from './bitbrowser-connections.mjs';
export const bitBrowserProxyDomain = 'bitbrowser-proxies';
const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const fail = message => { throw new BitBrowserConnectionError(400, message); };
export function validateBitBrowserProxyWrite(body, previous) {
  if (!body || typeof body !== 'object' || Array.isArray(body) ||
    Object.keys(body).some(key => !['id', 'version', 'name', 'countryCode', 'kind', 'mode', 'protocol', 'link'].includes(key)) ||
    !Number.isSafeInteger(body.version) || body.version < 0 || body.version >= Number.MAX_SAFE_INTEGER) fail('IP 资料或版本无效');
  const { version, name, kind } = body;
  const countryCode = body.countryCode ?? previous?.countryCode ?? '';
  let mode = body.mode, protocol = body.protocol;
  if (Object.hasOwn(body, 'id') && !uuid.test(body.id || '')) fail('IP 编号无效');
  if (body.id && (!previous || previous.id !== body.id)) throw new BitBrowserConnectionError(404, '该 IP 已不存在，请刷新列表');
  let link = body.link;
  if (body.id && (link === undefined || link === '')) {
    if ((mode && mode !== previous.mode) || (protocol && protocol !== previous.protocol)) fail('修改连接方式或协议时，请重新填写代理链接');
    link = previous.link; mode = previous.mode; protocol = previous.protocol;
  }
  if (typeof name !== 'string' || !name.trim() || name.length > 80 || /[\x00-\x1f\x7f]/.test(name)) fail('请填写 80 字以内的 IP 名称或备注');
  if (typeof countryCode !== 'string' || !/^(?:[a-z]{2})?$/i.test(countryCode)) fail('国家标记无效，请使用自动识别或有效国家');
  if (!isProxyType(kind)) fail('请选择 IP 类型');
  let parsed;
  try { parsed = parseBitBrowserProxyInput(link, { mode: mode ?? 'auto', protocol: protocol ?? 'auto' }); }
  catch { fail('代理格式无法识别，请直接粘贴账号:密码@主机:端口，或主机:端口:账号:密码。'); }
  return { version, proxy: { id: body.id || randomUUID(), name: name.trim(), countryCode: countryCode.toUpperCase(), kind, mode: parsed.mode,
    protocol: parsed.protocol, link: parsed.link } };
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

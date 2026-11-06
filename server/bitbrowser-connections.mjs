import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { localBrowserUrl } from '../modules/recharge/bitbrowser/login/direct-api.mjs';

export const bitBrowserConnectionDomain = 'bitbrowser-connections';

const profileKeys = [
  'name',
  'url',
  'groupName',
  'tagName',
  'coreVersion',
  'proxyMode',
  'proxyType',
  'expectedCountryCode',
  'staticHost',
  'staticPort',
  'sessionWaitMinutes',
  'sessionRetryLimit'
];
const uuid = /^[\da-f]{8}-(?:[\da-f]{4}-){3}[\da-f]{12}$/i;
const hostName =
  /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)*$/i;
const object = (value) => value && typeof value === 'object' && !Array.isArray(value);
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;

export class BitBrowserConnectionError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function invalid(message) {
  throw new BitBrowserConnectionError(400, message);
}

function label(value, field, required = false) {
  if (typeof value !== 'string' || value.length > 80 || /[\x00-\x1f\x7f-\x9f]/.test(value))
    invalid(`${field}须在 80 字以内且不能包含控制字符`);
  const text = value.trim();
  if (required && !text) invalid(`请填写${field}`);
  return required || !text ? text : value;
}

export function validateBitBrowserConnectionWrite(body) {
  if (
    !object(body) ||
    Object.keys(body).length !== 2 + Number(Object.hasOwn(body, 'interfaceToken')) ||
    !Object.hasOwn(body, 'version') ||
    !integer(body.version, 0, Number.MAX_SAFE_INTEGER - 1) ||
    !Object.hasOwn(body, 'profile') ||
    !object(body.profile)
  )
    invalid('连接配置格式不正确');

  const { profile, version } = body;
  const interfaceToken = Object.hasOwn(body, 'interfaceToken') ? body.interfaceToken : undefined;
  if (Object.hasOwn(body, 'interfaceToken') &&
      (typeof interfaceToken !== 'string' || !interfaceToken.trim() || interfaceToken.length > 1024 ||
        /[^\x21-\x7e]/.test(interfaceToken.trim())))
    invalid('本机接口密钥格式无效');
  const editing = Object.hasOwn(profile, 'id');
  if (
    Object.keys(profile).length !== profileKeys.length + Number(editing) ||
    !profileKeys.every((key) => Object.hasOwn(profile, key))
  )
    invalid('连接配置只接受列出的非敏感字段');
  if (editing && (typeof profile.id !== 'string' || !uuid.test(profile.id)))
    invalid('连接配置编号无效');

  let url;
  try {
    url = localBrowserUrl(typeof profile.url === 'string' ? profile.url.trim() : null);
  } catch {
    invalid('请填写带端口的本机比特 HTTP 地址，地址不得包含凭据、路径或查询参数');
  }
  const name = label(profile.name, '配置名称', true);
  const groupName = label(profile.groupName, '窗口分组');
  const tagName = label(profile.tagName, '窗口标签');
  const {
    coreVersion,
    proxyMode,
    proxyType,
    expectedCountryCode,
    staticHost,
    staticPort,
    sessionWaitMinutes,
    sessionRetryLimit
  } = profile;
  if (typeof coreVersion !== 'string' || !/^\d{2,3}$/.test(coreVersion))
    invalid('请填写两至三位的 Chromium 内核主版本号');
  if (
    !['dynamic', 'static'].includes(proxyMode) ||
    !['http', 'https', 'socks5'].includes(proxyType)
  )
    invalid('代理类型或协议无效');
  if (typeof expectedCountryCode !== 'string' || !/^(?:[a-z]{2})?$/i.test(expectedCountryCode))
    invalid('代理国家须为两位字母');
  if (
    typeof staticHost !== 'string' ||
    staticHost.length > 253 ||
    (staticHost && !isIP(staticHost) && !hostName.test(staticHost)) ||
    (proxyMode === 'static' && !staticHost) ||
    (proxyMode === 'dynamic' && staticHost)
  )
    invalid('固定代理仅接受主机名或 IP，动态代理请留空');
  if (!integer(staticPort, 1, 65535)) invalid('固定代理端口须在 1 至 65535 之间');
  if (!integer(sessionWaitMinutes, 1, 10)) invalid('会话等待须在 1 至 10 分钟之间');
  if (!integer(sessionRetryLimit, 0, 9)) invalid('会话重试须在 0 至 9 次之间');

  return {
    version,
    interfaceToken: interfaceToken?.trim(),
    profile: {
      ...(editing ? { id: profile.id } : {}),
      name,
      url,
      groupName,
      tagName,
      coreVersion,
      proxyMode,
      proxyType,
      expectedCountryCode: expectedCountryCode.toUpperCase(),
      staticHost,
      staticPort,
      sessionWaitMinutes,
      sessionRetryLimit
    }
  };
}

export function summarizeBitBrowserConnections(profiles) {
  return profiles.map(({ interfaceToken, ...profile }) => ({
    ...profile,
    ...(interfaceToken && { hasInterfaceToken: true })
  }));
}

export function readBitBrowserConnectionToken(current, body) {
  if (!object(body) || Object.keys(body).length !== 2 || typeof body.id !== 'string' ||
      !uuid.test(body.id) || !integer(body.version, 0, Number.MAX_SAFE_INTEGER))
    invalid('连接配置编号或版本无效');
  if (current.version !== body.version)
    throw new BitBrowserConnectionError(409, '连接配置已更新，请重新读取后选择');
  const profile = current.data?.find(({ id }) => id === body.id);
  if (!profile?.interfaceToken) throw new BitBrowserConnectionError(404, '此连接尚未保存接口密钥');
  return { interfaceToken: profile.interfaceToken };
}

export function writeBitBrowserConnection(current, { version, profile, interfaceToken }) {
  if (current.version !== version)
    throw new BitBrowserConnectionError(409, '连接配置已在其他页面更新，请刷新后重试');
  const profiles = current.data ?? [];
  const index = profile.id ? profiles.findIndex(({ id }) => id === profile.id) : -1;
  if (profile.id && index === -1) throw new BitBrowserConnectionError(404, '找不到该连接配置');
  const savedId = profile.id ?? randomUUID();
  const previous = profiles[index];
  const token = interfaceToken ?? (previous?.url === profile.url ? previous.interfaceToken : undefined);
  const saved = { ...profile, id: savedId, ...(token && { interfaceToken: token }) };
  const updated = index === -1 ? [...profiles, saved] : profiles.with(index, saved);
  return { version: current.version + 1, profiles: updated, savedId };
}

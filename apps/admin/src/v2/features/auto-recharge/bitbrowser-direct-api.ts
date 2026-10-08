import { normalizeV2RechargeBrowserOptions } from '@apple-business/shared';
import type { V2RechargeBitBrowserOpenLaunch, V2RechargeBrowserCatalog } from './contracts';

export type DirectBrowserSettings = V2RechargeBitBrowserOpenLaunch['bitBrowser'];
const messages = {
  bitbrowser_direct_unreachable:
    '网页无法访问比特浏览器。请启动比特浏览器、开启本地接口，并允许当前网站访问本机网络。',
  bitbrowser_direct_token_invalid:
    '比特接口密钥不匹配，请填写当前电脑比特浏览器系统设置中的接口密钥。',
  bitbrowser_direct_rejected: '比特浏览器拒绝了请求，请检查接口、代理和窗口配置。',
  bitbrowser_direct_protocol: '比特接口返回的数据无法确认，请核对接口地址并更新比特浏览器。',
  bitbrowser_direct_debug_unavailable:
    '窗口已打开，但网页无法连接窗口控制接口。请检查网站本机网络权限，并更新比特浏览器后重试。',
  bitbrowser_direct_command_failed: '窗口控制失败，请检查原窗口；本次不会自动重建或重复登录。',
  bitbrowser_direct_cancelled: '本次网页直连操作已停止，已打开的窗口保留供手动检查。',
  bitbrowser_profile_sync_unverified: '无法确认窗口已关闭登录资料同步，本次已停止登录。',
  bitbrowser_profile_configuration_mismatch:
    '比特窗口的内核、系统或尺寸与所选配置不一致，本次已停止登录。请检查客户端可用内核和窗口设置。',
  bitbrowser_profile_configuration_unverified:
    '无法确认比特窗口实际使用的内核版本，本次已停止登录。请更新客户端后重试。',
  official_login_email_mismatch: '官网已登录账号与本次选择不一致，本次已停止。',
  official_login_not_verified: '未能确认官网账号登录成功，请检查原窗口后重试。',
  invalid_session_json: '授权 JSON 缺少有效的会话、用户或账号资料，请重新授权。'
} as const;
export type DirectBrowserFailure = keyof typeof messages;
export class DirectBrowserError extends Error {
  constructor(readonly reason: DirectBrowserFailure) {
    super(messages[reason]);
  }
}
export function localBrowserUrl(value: string, websocket = false) {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new DirectBrowserError('bitbrowser_direct_protocol');
  }
  if (
    !['127.0.0.1', 'localhost'].includes(url.hostname) ||
    !url.port ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.protocol !== (websocket ? 'ws:' : 'http:') ||
    (websocket ? !/^\/devtools\/browser\/[A-Za-z0-9-]+$/.test(url.pathname) : url.pathname !== '/')
  ) {
    throw new DirectBrowserError('bitbrowser_direct_protocol');
  }
  return websocket ? url.href : url.origin;
}
export function directBrowserApi(url: string, token: string, signal: AbortSignal) {
  const origin = localBrowserUrl(url);
  async function post(path: string, body: object = {}): Promise<Record<string, unknown>> {
    if (!token || /[\r\n]/.test(token))
      throw new DirectBrowserError('bitbrowser_direct_token_invalid');
    let response: Response;
    try {
      response = await fetch(origin + path, {
        method: 'POST',
        mode: 'cors',
        credentials: 'omit',
        cache: 'no-store',
        redirect: 'error',
        headers: { 'Content-Type': 'application/json', 'x-api-key': token },
        body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)])
      });
    } catch {
      throw new DirectBrowserError(
        signal.aborted ? 'bitbrowser_direct_cancelled' : 'bitbrowser_direct_unreachable'
      );
    }
    if ([401, 403].includes(response.status))
      throw new DirectBrowserError('bitbrowser_direct_token_invalid');
    let value: Record<string, unknown>;
    try {
      value = await response.json();
    } catch {
      throw new DirectBrowserError('bitbrowser_direct_protocol');
    }
    if (!value || !response.ok || value.success !== true)
      throw new DirectBrowserError('bitbrowser_direct_rejected');
    return value;
  }
  return { post };
}
function catalogRows(value: unknown): Record<string, unknown>[] {
  for (let depth = 0; depth < 4; depth++) {
    if (Array.isArray(value)) return value as Record<string, unknown>[];
    if (!value || typeof value !== 'object') break;
    const document = value as Record<string, unknown>;
    value = document.list ?? document.data;
  }
  throw new DirectBrowserError('bitbrowser_direct_protocol');
}
function choices(rows: Record<string, unknown>[], key: string) {
  if (rows.length > 2000) throw new DirectBrowserError('bitbrowser_direct_protocol');
  const ids = new Set<string>();
  return rows.map((row) => {
    if (
      !row ||
      typeof row.id !== 'string' ||
      !/^[A-Za-z0-9_-]{8,100}$/.test(row.id) ||
      ids.has(row.id) ||
      typeof row[key] !== 'string' ||
      !row[key].trim() ||
      row[key].length > 80
    )
      throw new DirectBrowserError('bitbrowser_direct_protocol');
    ids.add(row.id);
    return { id: row.id, name: row[key] as string };
  });
}
export async function directBrowserCatalog(
  url: string,
  token: string,
  signal: AbortSignal
): Promise<V2RechargeBrowserCatalog> {
  const api = directBrowserApi(url, token, signal);
  await api.post('/health');
  const groups: Record<string, unknown>[] = [];
  for (let page = 0; ; page++) {
    const rows = catalogRows(await api.post('/group/list', { page, pageSize: 100, all: true }));
    groups.push(...rows);
    if (groups.length > 2000 || page > 20)
      throw new DirectBrowserError('bitbrowser_direct_protocol');
    if (rows.length < 100) break;
  }
  return {
    groups: choices(groups, 'groupName'),
    tags: choices(catalogRows(await api.post('/browserTag/list')), 'tagName')
  };
}
export function directProfileOptions(settings: DirectBrowserSettings) {
  const o = normalizeV2RechargeBrowserOptions(settings.browserOptions);
  const fingerprint: Record<string, unknown> = {
    coreProduct: 'chrome',
    coreVersion: o.coreVersion,
    ostype: 'PC',
    os: o.os,
    osVersion: o.osVersion,
    version: o.coreVersion,
    userAgent: '',
    openWidth: o.openWidth,
    openHeight: o.openHeight,
    isIpCreateTimeZone: o.timezoneFromIp,
    isIpCreatePosition: o.positionFromIp,
    isIpCreateLanguage: o.languageFromIp,
    languages: o.language,
    isIpCreateDisplayLanguage: o.displayLanguageFromIp,
    displayLanguages: o.displayLanguage
  };
  if (!o.timezoneFromIp) {
    // Only the external browser fingerprint follows the selected window timezone.
    const V2_BROWSER_FINGERPRINT_TIME_ZONE = o.timezone;
    const offset =
      new Intl.DateTimeFormat('en-US', {
        timeZone: V2_BROWSER_FINGERPRINT_TIME_ZONE,
        timeZoneName: 'longOffset'
      })
        .formatToParts(new Date())
        .find((part) => part.type === 'timeZoneName')?.value ?? 'GMT';
    const parts = /^GMT([+-])(\d{2}):(\d{2})$/.exec(offset);
    fingerprint.timeZone = o.timezone;
    fingerprint.timeZoneOffset = parts
      ? (parts[1] === '-' ? -1 : 1) * (Number(parts[2]) * 3600 + Number(parts[3]) * 60)
      : 0;
  }
  if (!o.positionFromIp)
    Object.assign(fingerprint, {
      position: '1',
      lat: String(o.latitude),
      lng: String(o.longitude),
      precisionData: String(o.accuracy)
    });
  return {
    proxyMethod: o.proxyMode === 'dynamic' ? 3 : 2,
    proxyType: settings.proxyType,
    ipCheckService: o.ipCheckService,
    syncTabs: false,
    syncCookies: false,
    syncLocalStorage: false,
    syncIndexedDb: false,
    syncAuthorization: false,
    browserFingerPrint: fingerprint,
    ...(o.proxyMode === 'dynamic'
      ? {
          dynamicIpUrl: settings.dynamicProxyUrl,
          dynamicIpChannel: o.dynamicProvider,
          isDynamicIpChangeIp: o.refreshIp
        }
      : {
          host: o.staticHost,
          port: o.staticPort,
          proxyUserName: settings.staticProxyCredentials?.username ?? '',
          proxyPassword: settings.staticProxyCredentials?.password ?? ''
        })
  };
}

export function verifyDirectProfileConfiguration(
  detail: Record<string, unknown>,
  settings: DirectBrowserSettings,
  opened?: Record<string, unknown>
) {
  const expected = directProfileOptions(settings).browserFingerPrint;
  const fingerprint = detail.browserFingerPrint;
  if (fingerprint != null && (typeof fingerprint !== 'object' || Array.isArray(fingerprint))) {
    throw new DirectBrowserError('bitbrowser_profile_configuration_mismatch');
  }
  const observed = (fingerprint ?? {}) as Record<string, unknown>;
  for (const key of [
    'coreProduct',
    'coreVersion',
    'os',
    'osVersion',
    'version',
    'openWidth',
    'openHeight'
  ]) {
    const value = observed[key];
    if (expected[key] === '' || value == null || value === '') continue;
    const matches =
      key === 'coreVersion' || key === 'version'
        ? /^\d+(?:\.\d+)*$/.test(String(value)) && String(value).split('.')[0] === expected[key]
        : String(value) === String(expected[key]);
    if (!matches) {
      throw new DirectBrowserError('bitbrowser_profile_configuration_mismatch');
    }
  }
  const userAgent = typeof observed.userAgent === 'string' ? observed.userAgent : '';
  const major = /(?:Chrome|Chromium)\/(\d+)/.exec(userAgent);
  if (major && major[1] !== expected.coreVersion) {
    throw new DirectBrowserError('bitbrowser_profile_configuration_mismatch');
  }
  const actualCore = opened?.coreVersion;
  if (
    actualCore != null &&
    actualCore !== '' &&
    (!/^\d+(?:\.\d+)*$/.test(String(actualCore)) ||
      String(actualCore).split('.')[0] !== expected.coreVersion)
  ) {
    throw new DirectBrowserError('bitbrowser_profile_configuration_mismatch');
  }
}

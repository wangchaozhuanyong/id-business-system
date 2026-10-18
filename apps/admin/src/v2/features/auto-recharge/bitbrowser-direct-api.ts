import { normalizeV2RechargeBrowserOptions } from '@apple-business/shared';
import { isApiError } from '@/api/apiError';
import type { V2RechargeBitBrowserOpenLaunch, V2RechargeBrowserCatalog } from './contracts';

export type DirectBrowserSettings = V2RechargeBitBrowserOpenLaunch['bitBrowser'];
const messages = {
  bitbrowser_secure_context_required:
    '请通过 HTTPS 安全地址打开管理网站，再连接比特浏览器；当前 HTTP 公网地址无法执行网页直连。',
  bitbrowser_direct_unreachable:
    '网页无法访问比特浏览器。请启动比特浏览器、开启本地接口，并允许当前网站访问本机网络。',
  bitbrowser_direct_token_invalid:
    '比特接口密钥不匹配，请填写当前电脑比特浏览器系统设置中的接口密钥。',
  bitbrowser_direct_rejected: '比特浏览器拒绝了请求，请检查接口、代理和窗口配置。',
  bitbrowser_direct_protocol: '比特接口返回的数据无法确认，请核对接口地址并更新比特浏览器。',
  bitbrowser_direct_debug_unavailable:
    '窗口已打开，但网页无法连接窗口控制接口。请检查网站本机网络权限，并更新比特浏览器后重试。',
  bitbrowser_existing_window_control_unavailable:
    '原窗口已在运行，但网页未能建立窗口控制连接。请关闭这个原窗口，再从本页重新打开；原窗口资料和执行记录已保留。',
  bitbrowser_direct_command_failed: '窗口控制失败，请检查原窗口；本次不会自动重建或重复登录。',
  bitbrowser_direct_cancelled: '本次网页直连操作已停止，已打开的窗口保留供手动检查。',
  bitbrowser_profile_sync_unverified: '无法确认窗口已关闭登录资料同步，本次已停止登录。',
  bitbrowser_profile_configuration_mismatch:
    '比特窗口的内核、系统或尺寸与所选配置不一致，本次已停止登录。请检查客户端可用内核和窗口设置。',
  bitbrowser_profile_configuration_unverified:
    '无法确认比特窗口实际使用的内核版本，本次已停止登录。请更新客户端后重试。',
  official_login_email_mismatch: '官网已登录账号与本次选择不一致，本次已停止。',
  official_login_not_verified: '未能确认官网账号登录成功，请检查原窗口后重试。',
  official_login_token_rejected:
    '官网拒绝了当前访问凭据，单次会话刷新后仍未通过，请更新授权 JSON；本次未建单或付款。',
  access_token_expired:
    '官网接受了会话，但返回的访问令牌已过期，请更新有效授权后重试；本次未付款。',
  official_login_network_failed: '代理或网络连接失败，自动恢复已停止，请检查原窗口后重试。',
  official_login_page_not_ready:
    '官网会话已登录，但页面登录状态尚未就绪，请检查原窗口；本次未付款。',
  bitbrowser_recovery_timeout: '加载恢复已达到时间上限，请检查原窗口后重试。',
  bitbrowser_owned_profile_missing:
    '无法确认原比特窗口已删除，本次未重建，请检查比特浏览器连接和窗口资料。',
  bitbrowser_owned_profile_unverified: '无法确认原比特窗口属于本次账号，本次已停止。',
  bitbrowser_original_checkout_unavailable:
    '原窗口中未找到唯一结账标签，请保留目标原单后再执行。本次未重复建单或付款。',
  proxy_probe_unverified: '无法确认代理可正常访问官网，本次已停止，请检查原窗口。',
  bitbrowser_profile_close_unverified: '无法确认失败窗口已关闭，本次已停止，未重新打开窗口。',
  invalid_session_json: '授权 JSON 缺少有效的会话、用户或账号资料，请重新授权。'
} as const;
export type DirectBrowserFailure = keyof typeof messages;
const operationMessages = {
  local_api: '请求比特接口',
  browser_health: '检测比特接口',
  browser_groups: '读取比特分组',
  browser_tags: '读取比特标签',
  browser_list: '核验原窗口资料',
  browser_update: '创建或更新窗口资料',
  browser_tag_relation: '关联窗口标签',
  browser_detail: '读取窗口资料',
  browser_open: '打开比特窗口',
  browser_close: '关闭比特窗口',
  browser_processes: '核验窗口关闭状态',
  browser_control: '连接窗口控制通道',
  record_progress: '保存执行状态',
  record_profile_check: '保存原窗口核验状态',
  record_profile_missing: '保存原窗口缺失核验状态',
  record_profile_created: '保存新窗口回执',
  record_profile_opened: '保存窗口打开回执',
  record_group: '保存分组核验状态',
  record_restore: '读取账户执行记录',
  record_finished: '保存执行结果',
  record_stop: '停止原任务'
} as const;
export type DirectBrowserOperation = keyof typeof operationMessages;
const apiCodeMessages = {
  BAD_REQUEST: '记录接口参数未通过核验',
  CONFLICT: '执行记录冲突',
  AUTH_INVALID: '执行记录身份未确认',
  AUTH_PERMISSION_DENIED: '执行记录权限未确认',
  NOT_FOUND: '执行记录不存在',
  RATE_LIMITED: '记录接口请求过于频繁',
  SERVICE_UNAVAILABLE: '记录接口暂不可用',
  INTERNAL_SERVER_ERROR: '记录接口内部错误',
  NETWORK_UNAVAILABLE: '记录接口连接未确认',
  REQUEST_FAILED: '记录接口请求失败'
} as const;
type DirectBrowserApiCode = keyof typeof apiCodeMessages;
const apiReasonMessages = {
  callback_credentials_rejected: '本机连接凭据无效',
  job_expired: '执行窗口已结束，请重新核验原订单',
  account_mismatch: '账户标识不一致',
  account_owner_mismatch: '该账户属于另一操作人的原任务',
  profile_conflict: '本次任务已绑定另一比特窗口，不能覆盖原窗口',
  original_payment_profile_unverified: '原单付款状态未安全核实，不能更换比特窗口',
  checkout_conflict: '原订单编号不一致'
} as const;
type DirectBrowserApiReason = keyof typeof apiReasonMessages;
const apiRejections: ReadonlyArray<readonly [number, DirectBrowserApiReason]> = [
  [401, 'callback_credentials_rejected'],
  [409, 'job_expired'],
  [400, 'account_mismatch'],
  [403, 'account_owner_mismatch'],
  [409, 'profile_conflict'],
  [409, 'original_payment_profile_unverified'],
  [409, 'checkout_conflict']
];
export interface DirectBrowserFailureMetadata {
  operation?: DirectBrowserOperation;
  httpStatus?: number;
  apiCode?: string;
  apiReason?: string;
  requestId?: string;
}
function safeFailureMetadata(value: DirectBrowserFailureMetadata) {
  return {
    ...(typeof value.operation === 'string' && Object.hasOwn(operationMessages, value.operation)
      ? { operation: value.operation }
      : {}),
    ...(typeof value.httpStatus === 'number' &&
    Number.isInteger(value.httpStatus) &&
    value.httpStatus >= 100 &&
    value.httpStatus <= 599
      ? { httpStatus: value.httpStatus }
      : {}),
    ...(typeof value.apiCode === 'string' && Object.hasOwn(apiCodeMessages, value.apiCode)
      ? { apiCode: value.apiCode as DirectBrowserApiCode }
      : {}),
    ...(typeof value.apiReason === 'string' && Object.hasOwn(apiReasonMessages, value.apiReason)
      ? { apiReason: value.apiReason as DirectBrowserApiReason }
      : {}),
    ...(typeof value.requestId === 'string' &&
    value.requestId.length === 36 &&
    /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/i.test(value.requestId)
      ? { requestId: value.requestId }
      : {})
  };
}
export class DirectBrowserError extends Error {
  readonly metadata: Readonly<ReturnType<typeof safeFailureMetadata>>;
  constructor(
    readonly reason: DirectBrowserFailure,
    metadata: DirectBrowserFailureMetadata = {}
  ) {
    const safe = safeFailureMetadata(metadata);
    const operation = safe.operation ? operationMessages[safe.operation] : undefined;
    const description = operation
      ? safe.operation?.startsWith('record_')
        ? `${operation}失败${
            reason === 'bitbrowser_direct_cancelled' || reason === 'bitbrowser_recovery_timeout'
              ? `：${messages[reason]}`
              : ''
          }`
        : `${operation}失败：${messages[reason]}`
      : messages[reason];
    const details = [
      ...(safe.httpStatus ? [`HTTP ${safe.httpStatus}`] : []),
      ...(safe.apiCode ? [apiCodeMessages[safe.apiCode]] : []),
      ...(safe.apiReason ? [apiReasonMessages[safe.apiReason]] : []),
      ...(safe.requestId ? [`请求编号：${safe.requestId}`] : [])
    ];
    super(details.length ? `${description}（${details.join('；')}）。` : description);
    this.metadata = Object.freeze(safe);
  }
}
export function directBrowserFailure(error: unknown, operation?: DirectBrowserOperation) {
  if (error instanceof DirectBrowserError) {
    return new DirectBrowserError(
      Object.hasOwn(messages, error.reason) ? error.reason : 'bitbrowser_direct_command_failed',
      { ...error.metadata, ...(operation ? { operation } : {}) }
    );
  }
  return new DirectBrowserError('bitbrowser_direct_command_failed', {
    ...(operation ? { operation } : {}),
    ...(isApiError(error)
      ? {
          httpStatus: error.status ?? undefined,
          apiCode: error.code,
          apiReason: apiRejections.find(
            ([status, reason]) =>
              status === error.status && apiReasonMessages[reason] === error.message
          )?.[1],
          requestId: error.requestId
        }
      : {})
  });
}
const requestOperations: Record<string, DirectBrowserOperation> = {
  '/health': 'browser_health',
  '/group/list': 'browser_groups',
  '/browserTag/list': 'browser_tags',
  '/browser/list': 'browser_list',
  '/browser/update': 'browser_update',
  '/browserTag/updateRelation': 'browser_tag_relation',
  '/browser/detail': 'browser_detail',
  '/browser/open': 'browser_open',
  '/browser/close': 'browser_close',
  '/browser/pids/alive': 'browser_processes'
};
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
  if (globalThis.isSecureContext === false)
    throw new DirectBrowserError('bitbrowser_secure_context_required');
  const origin = localBrowserUrl(url);
  async function post(
    path: string,
    body: object = {},
    timeoutMs = 30_000
  ): Promise<Record<string, unknown>> {
    const operation = requestOperations[path] ?? 'local_api';
    if (!token || /[\r\n]/.test(token))
      throw new DirectBrowserError('bitbrowser_direct_token_invalid', { operation });
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
        signal: AbortSignal.any([
          signal,
          AbortSignal.timeout(Math.max(1, Math.min(30_000, timeoutMs)))
        ])
      });
    } catch {
      throw new DirectBrowserError(
        signal.aborted ? 'bitbrowser_direct_cancelled' : 'bitbrowser_direct_unreachable',
        { operation }
      );
    }
    if ([401, 403].includes(response.status))
      throw new DirectBrowserError('bitbrowser_direct_token_invalid', {
        operation,
        httpStatus: response.status
      });
    let value: Record<string, unknown>;
    try {
      value = await response.json();
    } catch {
      throw new DirectBrowserError('bitbrowser_direct_protocol', {
        operation,
        httpStatus: response.status
      });
    }
    if (!value || !response.ok || value.success !== true)
      throw new DirectBrowserError('bitbrowser_direct_rejected', {
        operation,
        httpStatus: response.status
      });
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
export async function directBrowserProfileExists(
  api: ReturnType<typeof directBrowserApi>,
  profileId: string,
  remaining: () => number
) {
  const seen = new Set<string>();
  let expectedTotal: number | undefined;
  for (let page = 0; page <= 20; page++) {
    const response = await api.post('/browser/list', { page, pageSize: 100 }, remaining());
    let metadata: unknown = response;
    for (let depth = 0; depth < 4 && metadata && typeof metadata === 'object'; depth++) {
      const document = metadata as Record<string, unknown>;
      if (document.total !== undefined) {
        const total = document.total;
        if (
          typeof total !== 'number' ||
          !Number.isSafeInteger(total) ||
          total < 0 ||
          total > 2000 ||
          (expectedTotal !== undefined && total !== expectedTotal)
        )
          throw new DirectBrowserError('bitbrowser_direct_protocol');
        expectedTotal = total;
      }
      metadata = document.data;
    }
    const rows = catalogRows(response);
    if (rows.length > 100) throw new DirectBrowserError('bitbrowser_direct_protocol');
    for (const row of rows) {
      if (
        !row ||
        typeof row.id !== 'string' ||
        !/^[a-fA-F0-9]{32}$/.test(row.id) ||
        seen.has(row.id)
      )
        throw new DirectBrowserError('bitbrowser_direct_protocol');
      seen.add(row.id);
      if (row.id === profileId) return true;
    }
    if (seen.size > 2000) throw new DirectBrowserError('bitbrowser_direct_protocol');
    if (rows.length < 100) {
      if (expectedTotal !== undefined && seen.size !== expectedTotal)
        throw new DirectBrowserError('bitbrowser_direct_protocol');
      return false;
    }
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

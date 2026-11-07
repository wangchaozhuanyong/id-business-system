import { parseBitBrowserAuthorization } from '../authorization.mjs';
import { normalizeV2RechargeBrowserOptions } from './browser-options.mjs';
import { DirectBrowserError, localBrowserUrl, directProfileOptions } from './direct-api.mjs';
import { runDirectJsonSession } from './direct-login.mjs';

export { V2_RECHARGE_BROWSER_DEFAULTS as BIT_BROWSER_LOGIN_DEFAULTS } from './browser-options.mjs';
export { DirectBrowserError as BitBrowserLoginError } from './direct-api.mjs';

const ownedProfiles = new Map();
const activeLogins = new Set();

async function digest(value) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), (part) => part.toString(16).padStart(2, '0')).join('');
}

function requiredName(value, label, maximum) {
  if (
    typeof value !== 'string' ||
    !value.trim() ||
    value.length > maximum ||
    /[\r\n\u0000]/.test(value)
  ) {
    throw new Error(`请提供有效的${label}。`);
  }
  return value;
}

/**
 * Uses the pinned browser login flow without a payment continuation. Authorization and
 * connection secrets exist only in this browser call, never in preview API requests.
 */
export async function runBitBrowserJsonLogin({
  url,
  token,
  groupName,
  tagName,
  windowName,
  sessionJson,
  browserOptions,
  signal = new AbortController().signal,
  onProgress,
  proxyType = 'http',
  dynamicProxyUrl = '',
  staticProxyCredentials,
  expectedCountryCode = '',
  useSelectedProxy = false,
  persistWindow = false,
  connectionId = ''
} = {}) {
  if (globalThis.isSecureContext === false) {
    throw new DirectBrowserError('bitbrowser_secure_context_required');
  }
  if (signal.aborted) throw new DirectBrowserError('bitbrowser_direct_cancelled');
  const localApiUrl = localBrowserUrl(url);
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) {
    throw new DirectBrowserError('bitbrowser_direct_token_invalid');
  }
  const authorization = parseBitBrowserAuthorization(sessionJson);
  sessionJson = '';
  const { email, accountId, userId } = authorization;
  const expected = { email, accountId, userId, token: authorization.token };
  const settings = {
    localApiUrl,
    localApiToken: token,
    groupName: requiredName(groupName, '窗口分组', 80),
    tagName: requiredName(tagName, '窗口标签', 80),
    proxyType,
    dynamicProxyUrl,
    staticProxyCredentials,
    expectedCountryCode,
    browserOptions: normalizeV2RechargeBrowserOptions(browserOptions)
  };
  const browserMajor = settings.browserOptions.coreVersion;
  if (typeof browserMajor !== 'string' || !/^\d{2,3}$/.test(browserMajor)) {
    throw new Error('请填写本机比特浏览器的 Chromium 内核主版本号。');
  }
  if (!['http', 'https', 'socks5'].includes(proxyType)) throw new Error('请选择有效的代理协议。');
  if (!['dynamic', 'static'].includes(settings.browserOptions.proxyMode)) {
    throw new Error('请选择有效的代理类型。');
  }
  if (expectedCountryCode && !/^[A-Z]{2}$/.test(expectedCountryCode)) {
    throw new Error('请填写两位大写字母的代理国家代码。');
  }
  const profileName = requiredName(windowName, '窗口名称', 100);
  const accountKey = await digest(accountId);
  const connectionKey = await digest(JSON.stringify([localApiUrl, await digest(token), connectionId]));
  const key = `${connectionKey}#${accountKey}`;
  const networkOptions = Object.fromEntries(Object.entries(directProfileOptions(settings)).filter(
    ([name]) => !['browserFingerPrint', 'syncTabs', 'syncCookies', 'syncLocalStorage', 'syncIndexedDb', 'syncAuthorization'].includes(name)));
  const proxyConfiguration = await digest(JSON.stringify(networkOptions));
  if (signal.aborted) throw new DirectBrowserError('bitbrowser_direct_cancelled');
  if (activeLogins.has(key)) throw new Error('该账号已有登录任务正在进行。');
  activeLogins.add(key);
  let saved;
  const recordRequest = async (method, body) => {
    let response, data;
    try {
      response = await fetch('/api/local/bitbrowser-login-windows', {
        method, credentials: 'same-origin', cache: 'no-store', redirect: 'error',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        signal: AbortSignal.any([signal, AbortSignal.timeout(15_000)])
      });
      data = await response.json();
    } catch {
      throw new DirectBrowserError(signal.aborted ? 'bitbrowser_direct_cancelled' : 'bitbrowser_window_record_unavailable');
    }
    if (!response.ok) throw new DirectBrowserError(response.status === 409
      ? 'bitbrowser_window_record_conflict' : 'bitbrowser_window_record_unavailable');
    const record = data?.record;
    if (record === null && method === 'POST') return undefined;
    if (!record || record.connectionKey !== connectionKey || record.accountKey !== accountKey ||
        !/^[a-f0-9]{32}$/.test(record.profileId ?? '') ||
        !/^[a-f0-9]{64}$/.test(record.proxyConfiguration ?? '') ||
        !/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/.test(record.sourceJobId ?? '') ||
        !Number.isSafeInteger(record.version) || record.version < 1)
      throw new DirectBrowserError('bitbrowser_window_record_unavailable');
    return { version: record.version, proxyConfiguration: record.proxyConfiguration,
      profile: { accountKey, profileId: record.profileId, sourceJobId: record.sourceJobId } };
  };
  const remember = async (profileId, extra = {}) => {
    if (persistWindow) {
      const body = { connectionKey, accountKey, version: saved?.version ?? 0, profileId, proxyConfiguration,
        ...(extra.browser_profile_missing_confirmed === true && {
          replacedProfileId: extra.replaced_browser_profile_id, missingConfirmed: true
        }) };
      ownedProfiles.set(key, { ...saved, pendingWrite: body });
      saved = await recordRequest('PUT', body);
    } else saved = { proxyConfiguration, profile: { accountKey, profileId, sourceJobId: saved?.profile?.sourceJobId ?? crypto.randomUUID() } };
    ownedProfiles.set(key, saved);
  };
  try {
    const previous = ownedProfiles.get(key);
    saved = persistWindow ? await recordRequest('POST', { connectionKey, accountKey }) : previous;
    if (persistWindow && previous?.pendingWrite) {
      const body = previous.pendingWrite;
      if (saved?.version === body.version + 1 && saved.profile.profileId === body.profileId && saved.proxyConfiguration === body.proxyConfiguration) {
        ownedProfiles.set(key, saved);
      } else {
        saved = await recordRequest('PUT', body);
        ownedProfiles.set(key, saved);
      }
    }
    settings.updateOwnedProxy = Boolean((useSelectedProxy || expectedCountryCode) && saved && saved.proxyConfiguration !== proxyConfiguration);
    const result = await runDirectJsonSession(settings, expected, profileName, signal, {
      accountKey,
      restore: async () => ({ ownedProfile: saved?.profile }),
      progress: async (stage, extra) => {
        const profileId = extra?.browser_profile_id;
        if (['bitbrowser_profile_created', 'bitbrowser_proxy_updated'].includes(stage) && /^[a-f0-9]{32}$/.test(profileId ?? ''))
          await remember(profileId, extra);
        onProgress?.(stage);
      }
    });
    return {
      email,
      profileId: result.browser_profile_id,
      currentPlan: result.current_plan
    };
  } finally {
    expected.token = '';
    settings.localApiToken = '';
    activeLogins.delete(key);
  }
}

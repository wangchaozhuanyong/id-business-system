import { parseBitBrowserAuthorization } from '../authorization.mjs';
import { normalizeV2RechargeBrowserOptions } from './browser-options.mjs';
import { DirectBrowserError, localBrowserUrl } from './direct-api.mjs';
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
  useSelectedProxy = false
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
  const key = `${localApiUrl}#${await digest(token)}#${accountKey}`;
  const { localApiToken, ...profileSettings } = settings;
  const proxyConfiguration = await digest(JSON.stringify(profileSettings));
  const networkKeys = new Set(['proxyMode', 'staticHost', 'staticPort', 'dynamicProvider', 'refreshIp']);
  const profileConfiguration = (useSelectedProxy || expectedCountryCode) ? await digest(JSON.stringify({ localApiUrl,
    groupName, tagName, browserOptions: Object.fromEntries(Object.entries(settings.browserOptions).filter(([key]) => !networkKeys.has(key))) })) : proxyConfiguration;
  if (signal.aborted) throw new DirectBrowserError('bitbrowser_direct_cancelled');
  if (activeLogins.has(key)) throw new Error('该账号已有登录任务正在进行。');
  const saved = ownedProfiles.get(key);
  if (saved && saved.profileConfiguration !== profileConfiguration) {
    throw new Error('该账号已关联本次会话的比特窗口，请用原窗口配置重试。');
  }

  settings.updateOwnedProxy = Boolean((useSelectedProxy || expectedCountryCode) && saved && saved.proxyConfiguration !== proxyConfiguration);
  activeLogins.add(key);
  try {
    const result = await runDirectJsonSession(settings, expected, profileName, signal, {
      accountKey,
      restore: async () => ({ ownedProfile: ownedProfiles.get(key)?.profile }),
      progress: async (stage, extra) => {
        const profileId = extra?.browser_profile_id;
        if (stage === 'bitbrowser_profile_created' && /^[a-f0-9]{32}$/.test(profileId ?? '')) {
          ownedProfiles.set(key, {
            profileConfiguration, proxyConfiguration,
            profile: { accountKey, profileId, sourceJobId: crypto.randomUUID() }
          });
        }
        onProgress?.(stage);
      }
    });
    if (ownedProfiles.has(key)) ownedProfiles.get(key).proxyConfiguration = proxyConfiguration;
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

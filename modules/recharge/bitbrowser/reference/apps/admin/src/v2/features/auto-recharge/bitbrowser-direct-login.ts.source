import type { RechargeLoginChallenge } from './recharge-login-code';
import { BrowserCdp } from './bitbrowser-cdp';
import {
  directBrowserApi,
  directBrowserCatalog,
  directBrowserProfileExists,
  directProfileOptions,
  verifyDirectProfileConfiguration,
  directBrowserFailure,
  DirectBrowserError,
  type DirectBrowserSettings
} from './bitbrowser-direct-api';
import {
  loggedInPageExpression,
  loginPageExpression,
  officialProxyExpression,
  type LoginPageState,
  type inspectOfficialProxy,
  type inspectLoggedInPage
} from './bitbrowser-login-page';
import type {
  V2RechargeBrowserRestore,
  V2RechargeOwnedBrowserProfile
} from '@apple-business/shared';
import type { VerifiedPaymentBrowser } from './bitbrowser-payment-session';
import { isV2TotpCodeCurrent } from '@/v2/components/workspace/totp';

import { parseDirectCredential, type DirectLoginCredential } from './bitbrowser-direct-credential';
export { parseDirectCredential, type DirectLoginCredential } from './bitbrowser-direct-credential';

export type DirectLoginCode = string | { token: string; expiresAt: string };
export interface DirectLoginHooks {
  progress: (stage: string, extra?: Record<string, unknown>) => Promise<void>;
  code: (challenge: RechargeLoginChallenge) => Promise<DirectLoginCode>;
  restore?: (
    accountKey: string
  ) => Promise<
    Pick<
      V2RechargeBrowserRestore,
      'ownedProfile' | 'originalCheckoutIdentifier' | 'unidentifiedCheckoutRecovery'
    >
  >;
  accountKey?: string;
  ownedProfile?: V2RechargeOwnedBrowserProfile;
  /** Payment execution keeps this verified owned connection until its result is recorded. */
  ready?: (browser: VerifiedPaymentBrowser) => Promise<Record<string, unknown>>;
}
export function isLoginPaymentWrite(method: string, rawUrl: string) {
  // Kept for callers using the existing helper; browser requests are never blocked.
  void method;
  void rawUrl;
  return false;
}
function isProxyNetworkError(value: unknown) {
  return (
    typeof value === 'string' &&
    /^(?:net::)?ERR_(?:PROXY_CONNECTION_FAILED|TUNNEL_CONNECTION_FAILED|CONNECTION_CLOSED|CONNECTION_RESET|CONNECTION_REFUSED|CONNECTION_TIMED_OUT|TIMED_OUT|NAME_NOT_RESOLVED|NETWORK_CHANGED|SOCKS_CONNECTION_FAILED)$/.test(
      value
    )
  );
}
function waitDirectLogin(signal: AbortSignal) {
  signal.throwIfAborted();
  return new Promise<void>((resolve, reject) => {
    const abort = () => {
      clearTimeout(timer);
      reject(new DirectBrowserError('bitbrowser_direct_cancelled'));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', abort);
      resolve();
    }, 1000);
    signal.addEventListener('abort', abort, { once: true });
  });
}
export async function runDirectLogin(
  settings: DirectBrowserSettings,
  credential: DirectLoginCredential,
  windowName: string,
  signal: AbortSignal,
  hooks: DirectLoginHooks
) {
  const expected = parseDirectCredential(credential);
  const passwordAvailable = Boolean(credential.login?.password);
  const callerSignal = signal;
  let deadline = Date.now() + 10 * 60_000;
  const hardDeadline = Date.now() + 30 * 60_000;
  let manualStarted: number | undefined;
  const automaticBudget = new AbortController();
  let automaticTimer: ReturnType<typeof setTimeout> | undefined;
  const armAutomaticTimer = () => {
    clearTimeout(automaticTimer);
    automaticTimer = setTimeout(() => automaticBudget.abort(), Math.max(1, deadline - Date.now()));
  };
  armAutomaticTimer();
  signal = AbortSignal.any([signal, automaticBudget.signal, AbortSignal.timeout(30 * 60_000)]);
  const remaining = () => {
    if (Date.now() >= hardDeadline) throw new DirectBrowserError('official_login_not_verified');
    if (manualStarted === undefined && Date.now() >= deadline)
      throw new DirectBrowserError('bitbrowser_recovery_timeout');
    signal.throwIfAborted();
    return (manualStarted === undefined ? deadline : hardDeadline) - Date.now();
  };
  const api = directBrowserApi(settings.localApiUrl, settings.localApiToken, signal);
  let cdp: BrowserCdp | undefined;
  let sessionId = '';
  let removeGuard: (() => void) | undefined;
  let pendingSubmission:
    | {
        kind: 'email' | 'password' | 'code';
        key: string;
        challenge?: RechargeLoginChallenge;
        value: string;
        expiresAt?: string;
        waitingForCode: boolean;
        failure?: { cause: unknown };
      }
    | undefined;
  try {
    let ownedProfile: V2RechargeOwnedBrowserProfile | undefined;
    let discoverOriginalCheckout = false;
    let originalCheckoutIdentifier: string | undefined;
    let expectedAccountKey = hooks.accountKey ?? hooks.ownedProfile?.accountKey;
    if (expected.accountId && (hooks.restore || expectedAccountKey)) {
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(expected.accountId)
      );
      const accountKey = Array.from(new Uint8Array(digest), (part) =>
        part.toString(16).padStart(2, '0')
      ).join('');
      if (expectedAccountKey && expectedAccountKey !== accountKey)
        throw new DirectBrowserError('bitbrowser_owned_profile_unverified');
      expectedAccountKey = accountKey;
    }
    if (expectedAccountKey && hooks.restore) {
      if (!/^[a-f0-9]{64}$/.test(expectedAccountKey))
        throw new DirectBrowserError('bitbrowser_owned_profile_unverified');
      const restored = await hooks.restore(expectedAccountKey);
      ownedProfile = restored.ownedProfile;
      discoverOriginalCheckout = restored.unidentifiedCheckoutRecovery === true;
      originalCheckoutIdentifier = restored.originalCheckoutIdentifier;
      if (discoverOriginalCheckout && (!ownedProfile || originalCheckoutIdentifier))
        throw new DirectBrowserError('bitbrowser_owned_profile_unverified');
      if (
        ownedProfile &&
        (ownedProfile.accountKey !== expectedAccountKey ||
          !/^[a-f0-9]{32}$/.test(ownedProfile.profileId) ||
          typeof ownedProfile.sourceJobId !== 'string' ||
          !ownedProfile.sourceJobId)
      )
        throw new DirectBrowserError('bitbrowser_owned_profile_unverified');
    }
    remaining();
    let profileId: unknown = ownedProfile?.profileId;
    let detail: Record<string, unknown> | undefined;
    let replacedProfileId: string | undefined;
    if (ownedProfile) {
      await hooks.progress('owned_profile_check', { browser_profile_id: profileId });
      try {
        detail = (await api.post('/browser/detail', { id: profileId }, remaining())).data as
          | Record<string, unknown>
          | undefined;
      } catch (error) {
        if (!(error instanceof DirectBrowserError) || error.reason !== 'bitbrowser_direct_rejected')
          throw error;
      }
      if (detail?.id !== profileId) {
        if (detail?.id !== undefined && detail?.id !== null)
          throw new DirectBrowserError('bitbrowser_owned_profile_unverified');
        if (await directBrowserProfileExists(api, ownedProfile.profileId, remaining))
          throw new DirectBrowserError('bitbrowser_owned_profile_missing');
        if (discoverOriginalCheckout)
          throw new DirectBrowserError('bitbrowser_owned_profile_missing');
        replacedProfileId = ownedProfile.profileId;
        await hooks.progress('bitbrowser_profile_missing_confirmed', {
          browser_profile_id: replacedProfileId
        });
        ownedProfile = undefined;
        detail = undefined;
      }
    }
    if (!ownedProfile) {
      const catalog = await directBrowserCatalog(
        settings.localApiUrl,
        settings.localApiToken,
        signal
      );
      const select = (kind: 'groups' | 'tags', name: string) => {
        const values = catalog[kind].filter((item) => item.name === name);
        if (values.length !== 1) throw new DirectBrowserError('bitbrowser_direct_rejected');
        return values[0]!.id;
      };
      const groupId = select('groups', settings.groupName);
      const tagId = select('tags', settings.tagName);
      await hooks.progress('bitbrowser_group');
      const created = await api.post(
        '/browser/update',
        {
          groupId,
          platform: '',
          platformIcon: 'chatgpt.com',
          url: 'https://chatgpt.com/',
          name: windowName,
          remark: settings.tagName,
          userName: '',
          password: '',
          cookie: '',
          isValidUsername: false,
          credentialsEnableService: false,
          ...directProfileOptions(settings)
        },
        remaining()
      );
      profileId = (created.data as Record<string, unknown>)?.id;
      if (typeof profileId !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(profileId))
        throw new DirectBrowserError('bitbrowser_direct_protocol');
      if (profileId === replacedProfileId)
        throw new DirectBrowserError('bitbrowser_direct_protocol');
      await hooks.progress('bitbrowser_profile_created', {
        browser_profile_id: profileId,
        ...(replacedProfileId
          ? {
              replaced_browser_profile_id: replacedProfileId,
              browser_profile_missing_confirmed: true
            }
          : {})
      });
      await api.post(
        '/browserTag/updateRelation',
        {
          browserId: profileId,
          addTagIds: [tagId],
          removeTagIds: []
        },
        remaining()
      );
    }
    if (typeof profileId !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(profileId))
      throw new DirectBrowserError('bitbrowser_direct_protocol');
    if (!detail) {
      detail = (await api.post('/browser/detail', { id: profileId }, remaining())).data as Record<
        string,
        unknown
      >;
    }
    if (
      detail?.id !== profileId ||
      ['syncTabs', 'syncCookies', 'syncLocalStorage', 'syncIndexedDb', 'syncAuthorization'].some(
        (key) => detail[key] !== false
      )
    ) {
      throw new DirectBrowserError('bitbrowser_profile_sync_unverified');
    }
    verifyDirectProfileConfiguration(detail, settings);
    // Launch arguments cannot change a core that was already opened by the client.
    // Keep that window intact if its control connection cannot be established.
    let originallyRunning = false;
    if (ownedProfile) {
      const alive = (await api.post('/browser/pids/alive', { ids: [profileId] }, remaining())).data;
      if (
        !alive ||
        typeof alive !== 'object' ||
        Array.isArray(alive) ||
        Object.keys(alive).some((id) => id !== profileId)
      )
        throw new DirectBrowserError('bitbrowser_direct_protocol', {
          operation: 'browser_processes'
        });
      const pid = (alive as Record<string, unknown>)[profileId];
      if (pid !== undefined && pid !== null && pid !== 0) {
        if (!Number.isSafeInteger(pid) || Number(pid) < 1)
          throw new DirectBrowserError('bitbrowser_direct_protocol', {
            operation: 'browser_processes'
          });
        originallyRunning = true;
      }
    }
    let networkFailed = false;
    let networkReadNeedsProbe = false;
    let attempts = 0;
    const attemptLimit = Math.min(
      10,
      Math.max(1, (settings.browserOptions?.sessionRetryLimit ?? 9) + 1)
    );
    let proxyReady = false;
    let proxyDeadline = 0;
    let canInjectOnUnauthenticated = Boolean(ownedProfile);
    let pageReadyDeadline: number | undefined;
    let expiredDeadline: number | undefined;
    let sessionRefreshRequested = false;
    let tokenRejected = false;
    const sessionTokenFailure = () =>
      new DirectBrowserError(
        tokenRejected ? 'official_login_token_rejected' : 'access_token_expired'
      );
    let suppliedSessionChecked = false;
    let officialTargetId = '';
    const injectCookies = async (onlyIfChanged = false) => {
      if (!expected.token || !cdp) return false;
      const cookies = (
        await cdp.command(
          'Network.getCookies',
          { urls: ['https://chatgpt.com/', 'https://chatgpt.com/api/auth/session'] },
          sessionId,
          remaining()
        )
      ).cookies;
      if (!Array.isArray(cookies)) throw new DirectBrowserError('bitbrowser_direct_protocol');
      if (onlyIfChanged) {
        const current = cookies.filter(
          (cookie) =>
            cookie &&
            typeof cookie.name === 'string' &&
            /^__Secure-next-auth\.session-token(?:\.\d+)?$/.test(cookie.name) &&
            typeof cookie.domain === 'string' &&
            cookie.domain.replace(/^\./, '') === 'chatgpt.com' &&
            cookie.path === '/' &&
            typeof cookie.value === 'string'
        );
        const plain = current.filter(
          (cookie) => cookie.name === '__Secure-next-auth.session-token'
        );
        const chunks = current.filter(
          (cookie) => cookie.name !== '__Secure-next-auth.session-token'
        );
        chunks.sort((a, b) => Number(a.name.split('.').at(-1)) - Number(b.name.split('.').at(-1)));
        if (
          (plain.length === 1 && !chunks.length && plain[0].value === expected.token) ||
          (!plain.length &&
            chunks.length > 0 &&
            chunks.every(
              (cookie, index) => cookie.name === `__Secure-next-auth.session-token.${index}`
            ) &&
            chunks.map((cookie) => cookie.value).join('') === expected.token)
        )
          return false;
      }
      for (const cookie of cookies) {
        if (
          cookie &&
          typeof cookie === 'object' &&
          typeof cookie.name === 'string' &&
          /^__Secure-next-auth\.session-token(?:\.\d+)?$/.test(cookie.name) &&
          typeof cookie.domain === 'string' &&
          cookie.domain.replace(/^\./, '') === 'chatgpt.com' &&
          typeof cookie.path === 'string' &&
          cookie.path.startsWith('/')
        )
          await cdp.command(
            'Network.deleteCookies',
            { name: cookie.name, domain: cookie.domain, path: cookie.path },
            sessionId,
            remaining()
          );
      }
      const chunks = expected.token.match(/.{1,3936}/g)!;
      await cdp.command(
        'Network.setCookies',
        {
          cookies: chunks.map((value, index) => ({
            name: '__Secure-next-auth.session-token' + (chunks.length > 1 ? `.${index}` : ''),
            value,
            url: 'https://chatgpt.com/',
            httpOnly: true,
            secure: true,
            sameSite: 'Lax'
          }))
        },
        sessionId,
        remaining()
      );
      return true;
    };
    const openSession = async (extractIp = false) => {
      remaining();
      attempts++;
      networkFailed = false;
      networkReadNeedsProbe = false;
      proxyReady = false;
      pageReadyDeadline = undefined;
      const opened = await api.post(
        '/browser/open',
        {
          id: profileId,
          queue: true,
          ...(extractIp ? { extractIp: true } : {}),
          args: [`--remote-allow-origins=${window.location.origin}`]
        },
        remaining()
      );
      remaining();
      verifyDirectProfileConfiguration(detail, settings, opened.data as Record<string, unknown>);
      await hooks.progress('bitbrowser_profile_opened');
      const endpoint = (opened.data as Record<string, unknown>)?.ws;
      if (typeof endpoint !== 'string')
        throw new DirectBrowserError('bitbrowser_direct_debug_unavailable');
      await hooks.progress('browser_control_connect');
      try {
        cdp = await BrowserCdp.connect(endpoint, signal);
      } catch (error) {
        if (
          originallyRunning &&
          attempts === 1 &&
          error instanceof DirectBrowserError &&
          error.reason === 'bitbrowser_direct_debug_unavailable'
        )
          throw new DirectBrowserError('bitbrowser_existing_window_control_unavailable', {
            operation: 'browser_control'
          });
        throw directBrowserFailure(error, 'browser_control');
      }
      const version = await cdp.command('Browser.getVersion');
      const actualVersion = /(?:HeadlessChrome|Chrome)\/(\d+)\./.exec(
        String(version.product ?? '')
      );
      if (!actualVersion)
        throw new DirectBrowserError('bitbrowser_profile_configuration_unverified');
      if (actualVersion[1] !== directProfileOptions(settings).browserFingerPrint.coreVersion)
        throw new DirectBrowserError('bitbrowser_profile_configuration_mismatch');
      const targets = (await cdp.command('Target.getTargets')).targetInfos as {
        type: string;
        targetId: string;
        url: string;
      }[];
      const originalPages = targets?.filter((target) => {
        if (target.type !== 'page') return false;
        try {
          const url = new URL(target.url);
          const match =
            /^\/checkout\/[a-z][a-z0-9_]{0,40}\/((?:oaics|cs)_[A-Za-z0-9_]{1,200})\/?$/.exec(
              url.pathname
            );
          return (
            url.origin === 'https://chatgpt.com' &&
            !url.username &&
            !url.password &&
            Boolean(match) &&
            (!originalCheckoutIdentifier || match?.[1] === originalCheckoutIdentifier)
          );
        } catch {
          return false;
        }
      });
      if (discoverOriginalCheckout && originalPages?.length !== 1)
        throw new DirectBrowserError('bitbrowser_original_checkout_unavailable');
      const page =
        ((discoverOriginalCheckout || originalCheckoutIdentifier) && originalPages?.length === 1
          ? originalPages[0]
          : undefined) ??
        targets?.find((target) => target.type === 'page' && target.targetId === officialTargetId) ??
        targets?.find(
          (target) => target.type === 'page' && /^https:\/\/chatgpt\.com(?:\/|$)/.test(target.url)
        ) ??
        targets?.find((target) => target.type === 'page' && target.url === 'about:blank');
      const targetId =
        page?.targetId ??
        String((await cdp.command('Target.createTarget', { url: 'about:blank' })).targetId);
      officialTargetId = targetId;
      sessionId = String(
        (await cdp.command('Target.attachToTarget', { targetId, flatten: true })).sessionId
      );
      const activeSession = sessionId;
      const frameTree = (await cdp.command('Page.getFrameTree', {}, sessionId)).frameTree as
        | { frame?: { id?: string } }
        | undefined;
      const mainFrameId = frameTree?.frame?.id;
      if (!mainFrameId) throw new DirectBrowserError('bitbrowser_direct_protocol');
      const criticalRequests = new Set<string>();
      const identityRequests = new Set<string>();
      removeGuard = cdp.onEvent((method, params, eventSession) => {
        if (eventSession !== activeSession) return;
        if (method === 'Network.requestWillBeSent' && params.frameId === mainFrameId) {
          const request = params.request as { url?: string; method?: string } | undefined;
          try {
            const url = new URL(request?.url ?? '');
            const identityRead =
              request?.method === 'GET' &&
              ['Fetch', 'XHR'].includes(String(params.type)) &&
              ['/api/auth/session', '/backend-api/accounts/check/v4-2023-04-27'].includes(
                url.pathname
              );
            if (
              url.origin === 'https://chatgpt.com' &&
              !url.username &&
              !url.password &&
              (params.type === 'Document' || identityRead) &&
              typeof params.requestId === 'string'
            ) {
              criticalRequests.add(params.requestId);
              if (identityRead) identityRequests.add(params.requestId);
            }
          } catch {
            // Unrelated or malformed resources cannot trigger a proxy change.
          }
        }
        if (
          method === 'Network.loadingFailed' &&
          criticalRequests.has(String(params.requestId)) &&
          params.canceled !== true &&
          !params.blockedReason &&
          !params.corsErrorStatus &&
          isProxyNetworkError(params.errorText)
        ) {
          networkFailed = true;
          networkReadNeedsProbe = identityRequests.has(String(params.requestId));
        }
        if (method === 'Network.loadingFailed' || method === 'Network.loadingFinished') {
          criticalRequests.delete(String(params.requestId));
          identityRequests.delete(String(params.requestId));
        }
      });
      await cdp.command('Network.enable', {}, sessionId);
      const language = String(directProfileOptions(settings).browserFingerPrint.languages);
      await cdp.command(
        'Network.setExtraHTTPHeaders',
        { headers: { 'Accept-Language': `${language},${language.split('-')[0]};q=0.9` } },
        sessionId
      );
      if (expected.token && !ownedProfile && attempts === 1) await injectCookies();
      const officialPage =
        page && /^https:\/\/chatgpt\.com(?:\/|$)/.test(page.url) ? new URL(page.url) : undefined;
      // Pricing dialogs hide the composer. Reusing them would wait forever for home-page UI.
      const paymentNeedsHome =
        hooks.ready &&
        !discoverOriginalCheckout &&
        !(originalCheckoutIdentifier && originalPages?.length === 1) &&
        officialPage &&
        (officialPage.pathname !== '/' || Boolean(officialPage.hash));
      const navigation =
        page &&
        /^https:\/\/chatgpt\.com(?:\/|$)/.test(page.url) &&
        !paymentNeedsHome &&
        !(expected.token && !ownedProfile && attempts === 1)
          ? {}
          : await cdp.command(
              'Page.navigate',
              { url: credential.login ? 'https://chatgpt.com/auth/login' : 'https://chatgpt.com/' },
              sessionId,
              remaining()
            );
      if (navigation.errorText) {
        if (!isProxyNetworkError(navigation.errorText))
          throw new DirectBrowserError('official_login_not_verified');
        networkFailed = true;
      }
      proxyDeadline = Math.min(deadline, Date.now() + 20_000);
      await hooks.progress('session_restore', {
        session_attempt: attempts,
        session_attempt_limit: attemptLimit
      });
    };
    await openSession();
    const submitted = new Set<string>();
    const stateKey = (state: LoginPageState) =>
      state.kind === 'code' ? `code:${'codeType' in state ? state.codeType : 'totp'}` : state.kind;
    let manualReported = false;
    let manualState = '';
    let lastState = '';
    let automaticDeadline = Math.min(
      deadline,
      Date.now() + (settings.browserOptions?.sessionWaitMinutes ?? 2) * 60_000
    );
    const assertJsonPhase = (checkingPage = false) => {
      remaining();
      if (!credential.login && manualStarted === undefined && Date.now() >= automaticDeadline)
        throw new DirectBrowserError(
          checkingPage || pageReadyDeadline !== undefined
            ? 'official_login_page_not_ready'
            : 'official_login_not_verified'
        );
    };
    const enterManualWait = () => {
      if (manualStarted !== undefined) return;
      manualStarted = Date.now();
      clearTimeout(automaticTimer);
    };
    const leaveManualWait = () => {
      if (manualStarted === undefined) return;
      const paused = Date.now() - manualStarted;
      deadline = Math.min(hardDeadline, deadline + paused);
      automaticDeadline = Math.min(deadline, automaticDeadline + paused);
      proxyDeadline = Math.min(deadline, proxyDeadline + paused);
      if (pageReadyDeadline !== undefined)
        pageReadyDeadline = Math.min(
          credential.login ? deadline : automaticDeadline,
          pageReadyDeadline + paused
        );
      if (expiredDeadline !== undefined)
        expiredDeadline = Math.min(automaticDeadline, expiredDeadline + paused);
      manualStarted = undefined;
      armAutomaticTimer();
    };
    const recoverProxy = async () => {
      if (networkReadNeedsProbe && cdp) {
        networkReadNeedsProbe = false;
        const probe = await cdp.evaluate<Awaited<ReturnType<typeof inspectOfficialProxy>>>(
          sessionId,
          officialProxyExpression(Math.min(5000, remaining()), settings.expectedCountryCode),
          Math.min(5000, remaining())
        );
        if (probe.kind === 'proxy_ready') {
          networkFailed = false;
          await waitDirectLogin(signal);
          return;
        }
        if (probe.kind === 'manual') {
          networkFailed = false;
          enterManualWait();
          if (!manualReported)
            await hooks.progress('verification_required', { user_action_required: true });
          manualReported = true;
          manualState = 'manual';
          return;
        }
        if (probe.kind !== 'proxy_network_failed')
          throw new DirectBrowserError('proxy_probe_unverified');
      }
      if (
        discoverOriginalCheckout ||
        credential.login ||
        directProfileOptions(settings).proxyMethod !== 3 ||
        settings.browserOptions?.sessionRetryLimit === 0 ||
        attempts >= attemptLimit
      )
        throw new DirectBrowserError('official_login_network_failed');
      remaining();
      removeGuard?.();
      removeGuard = undefined;
      cdp?.close();
      cdp = undefined;
      sessionId = '';
      const closeDeadline = Date.now() + 15_000;
      await api.post(
        '/browser/close',
        { id: profileId },
        Math.min(remaining(), closeDeadline - Date.now())
      );
      for (;;) {
        signal.throwIfAborted();
        const closeRemaining = Math.min(remaining(), closeDeadline - Date.now());
        if (closeRemaining <= 0)
          throw new DirectBrowserError('bitbrowser_profile_close_unverified');
        const alive = (await api.post('/browser/pids/alive', { ids: [profileId] }, closeRemaining))
          .data;
        if (Date.now() >= closeDeadline)
          throw new DirectBrowserError('bitbrowser_profile_close_unverified');
        if (
          !alive ||
          typeof alive !== 'object' ||
          Array.isArray(alive) ||
          Object.keys(alive).some((id) => id !== profileId)
        )
          throw new DirectBrowserError('bitbrowser_profile_close_unverified');
        const pid = (alive as Record<string, unknown>)[profileId];
        if (pid === undefined || pid === null || pid === 0) break;
        if (Date.now() >= closeDeadline)
          throw new DirectBrowserError('bitbrowser_profile_close_unverified');
        await waitDirectLogin(signal);
      }
      await hooks.progress('proxy_retrying', {
        session_attempt: attempts + 1,
        session_attempt_limit: attemptLimit
      });
      canInjectOnUnauthenticated = Boolean(expected.token);
      await openSession(true);
      expiredDeadline = undefined;
      automaticDeadline = Math.min(
        deadline,
        Date.now() + (settings.browserOptions?.sessionWaitMinutes ?? 2) * 60_000
      );
    };
    while (Date.now() < hardDeadline && (manualStarted !== undefined || Date.now() < deadline)) {
      remaining();
      if (networkFailed && manualStarted !== undefined) networkFailed = false;
      if (networkFailed) {
        await recoverProxy();
        continue;
      }
      const activeCdp = cdp;
      if (!activeCdp) throw new DirectBrowserError('bitbrowser_direct_debug_unavailable');
      if (!credential.login && !proxyReady) {
        const probeRemaining =
          manualStarted === undefined
            ? Math.min(remaining(), proxyDeadline - Date.now())
            : Math.min(20_000, remaining());
        if (probeRemaining <= 0) throw new DirectBrowserError('proxy_probe_unverified');
        const probeReadDeadline = Date.now() + probeRemaining;
        const probe = await activeCdp.evaluate<Awaited<ReturnType<typeof inspectOfficialProxy>>>(
          sessionId,
          officialProxyExpression(probeRemaining, settings.expectedCountryCode),
          Math.min(30_000, probeRemaining + 1000)
        );
        remaining();
        if (
          Date.now() >= probeReadDeadline &&
          !['proxy_network_failed', 'manual'].includes(probe.kind)
        )
          throw new DirectBrowserError('proxy_probe_unverified');
        if (probe.kind === 'proxy_network_failed') {
          if (manualStarted !== undefined) {
            await waitDirectLogin(signal);
            continue;
          }
          networkFailed = true;
          continue;
        }
        if (probe.kind === 'proxy_unverified')
          throw new DirectBrowserError('proxy_probe_unverified');
        if (probe.kind === 'proxy_ready') {
          proxyReady = true;
          if (manualReported && manualState === 'manual') {
            leaveManualWait();
            manualReported = false;
          }
        } else {
          if (probe.kind === 'manual') {
            enterManualWait();
            if (!manualReported)
              await hooks.progress('verification_required', { user_action_required: true });
            manualReported = true;
            manualState = 'manual';
          }
          await waitDirectLogin(signal);
          continue;
        }
      }
      if (
        manualStarted === undefined &&
        expiredDeadline !== undefined &&
        Date.now() >= expiredDeadline
      )
        throw sessionTokenFailure();
      assertJsonPhase();
      let state: LoginPageState;
      try {
        const refreshSession =
          !credential.login && expiredDeadline !== undefined && !sessionRefreshRequested;
        if (refreshSession) sessionRefreshRequested = true;
        const sessionReadBudgetMs = credential.login
          ? undefined
          : Math.min(
              remaining(),
              manualStarted === undefined ? automaticDeadline - Date.now() : 10_000,
              manualStarted === undefined && expiredDeadline !== undefined
                ? expiredDeadline - Date.now()
                : Infinity
            );
        state = await activeCdp.evaluate<LoginPageState>(
          sessionId,
          loginPageExpression('inspect', '', {
            sessionOnly: !credential.login,
            refreshSession,
            ...(sessionReadBudgetMs !== undefined ? { sessionReadBudgetMs } : {})
          }),
          sessionReadBudgetMs === undefined ? 15_000 : Math.min(15_000, sessionReadBudgetMs)
        );
      } catch (error) {
        if (
          signal.aborted ||
          (error instanceof DirectBrowserError &&
            ['bitbrowser_direct_cancelled', 'bitbrowser_direct_debug_unavailable'].includes(
              error.reason
            ))
        )
          throw error;
        state = { kind: 'loading' };
      }
      remaining();
      if (networkFailed && manualStarted !== undefined) networkFailed = false;
      if (networkFailed) {
        await recoverProxy();
        continue;
      }
      const observedKind = state.kind;
      if (
        pendingSubmission?.kind === 'code' &&
        ((state.kind === 'code' &&
          pendingSubmission.challenge?.kind !== ('codeType' in state ? state.codeType : 'totp')) ||
          (state.kind === 'manual' && 'codeType' in state))
      ) {
        submitted.add(pendingSubmission.key);
        pendingSubmission.value = '';
        pendingSubmission = undefined;
      }
      if (
        expected.token &&
        ownedProfile &&
        !suppliedSessionChecked &&
        (state.kind === 'identity' || (state.kind === 'expired' && typeof state.email === 'string'))
      ) {
        if (
          state.email?.toLowerCase() !== expected.email ||
          state.userId !== expected.userId ||
          state.accountId !== expected.accountId
        )
          throw new DirectBrowserError('official_login_email_mismatch');
        suppliedSessionChecked = true;
        // An identity-matched live session may have rotated since the JSON was copied.
        // A different cookie does not prove that the supplied session is newer or usable.
        if (state.kind === 'expired' && (await injectCookies(true))) {
          canInjectOnUnauthenticated = false;
          pageReadyDeadline = automaticDeadline;
          expiredDeadline = undefined;
          await hooks.progress('session_restore', {
            account_matched: true,
            session_step: 'page_refresh',
            session_refresh_count: 1
          });
          await activeCdp.command('Page.reload', {}, sessionId, remaining());
          await waitDirectLogin(signal);
          continue;
        }
      }
      if (
        manualStarted === undefined &&
        expiredDeadline !== undefined &&
        Date.now() >= expiredDeadline
      )
        throw sessionTokenFailure();
      if (state.kind === 'expired') {
        if ('tokenRejected' in state && state.tokenRejected) tokenRejected = true;
        if ('refreshFailed' in state && state.refreshFailed) throw sessionTokenFailure();
        if (credential.login) throw sessionTokenFailure();
        expiredDeadline ??= Math.min(automaticDeadline, Date.now() + 15_000);
      }
      if (state.kind === 'session_error')
        throw new DirectBrowserError('official_login_not_verified');
      if (manualReported && state.kind === 'manual') manualState = 'manual';
      if (state?.kind === 'identity') {
        if (
          state.email.toLowerCase() !== expected.email ||
          (expected.userId && state.userId !== expected.userId) ||
          (expected.accountId && state.accountId !== expected.accountId)
        )
          throw new DirectBrowserError('official_login_email_mismatch');
        if (credential.login && (expectedAccountKey || hooks.restore)) {
          const digest = await crypto.subtle.digest(
            'SHA-256',
            new TextEncoder().encode(state.accountId)
          );
          const accountKey = Array.from(new Uint8Array(digest), (part) =>
            part.toString(16).padStart(2, '0')
          ).join('');
          if (expectedAccountKey && accountKey !== expectedAccountKey)
            throw new DirectBrowserError('official_login_email_mismatch');
          if (!expectedAccountKey && hooks.restore) {
            const restored = (await hooks.restore(accountKey)).ownedProfile;
            if (
              restored &&
              (restored.accountKey !== accountKey || restored.profileId !== profileId)
            )
              throw new DirectBrowserError('bitbrowser_owned_profile_unverified');
            expectedAccountKey = accountKey;
          }
        }
        {
          if (credential.login && manualReported) {
            leaveManualWait();
            manualReported = false;
          }
          const pageBudgetDeadline = () => (credential.login ? deadline : automaticDeadline);
          assertJsonPhase();
          canInjectOnUnauthenticated = false;
          let ui: ReturnType<typeof inspectLoggedInPage>;
          try {
            ui = await activeCdp.evaluate<ReturnType<typeof inspectLoggedInPage>>(
              sessionId,
              loggedInPageExpression(
                discoverOriginalCheckout || Boolean(originalCheckoutIdentifier)
              ),
              Math.min(
                remaining(),
                manualStarted === undefined ? pageBudgetDeadline() - Date.now() : Infinity
              )
            );
          } catch (error) {
            if (
              signal.aborted ||
              (error instanceof DirectBrowserError &&
                ['bitbrowser_direct_cancelled', 'bitbrowser_direct_debug_unavailable'].includes(
                  error.reason
                ))
            )
              throw error;
            ui = { kind: 'page_loading' };
          }
          remaining();
          if (ui.kind === 'manual') {
            enterManualWait();
            if (!manualReported) {
              await hooks.progress('verification_required', { user_action_required: true });
              manualReported = true;
            }
            manualState = 'manual';
            await waitDirectLogin(signal);
            continue;
          }
          if (networkFailed && manualStarted !== undefined) networkFailed = false;
          if (networkFailed) {
            await recoverProxy();
            continue;
          }
          if (manualReported && manualState === 'manual') {
            leaveManualWait();
            manualReported = false;
          }
          assertJsonPhase(true);
          if (ui.kind !== 'page_ready') {
            pageReadyDeadline ??= pageBudgetDeadline();
            if (Date.now() >= pageReadyDeadline) {
              throw new DirectBrowserError('official_login_page_not_ready');
            }
            await waitDirectLogin(signal);
            continue;
          }
        }
        remaining();
        if (hooks.ready) {
          // Login automation's timer must not cancel a later human quote confirmation.
          clearTimeout(automaticTimer);
          return await hooks.ready({
            cdp: activeCdp,
            sessionId,
            signal: callerSignal,
            identity: state,
            profileId: String(profileId)
          });
        }
        return {
          status: 'session_ready',
          stage: 'session_ready',
          session_status: 'restored',
          account_matched: true,
          current_plan: state.plan,
          browser_profile_id: profileId,
          payment_attempted: false,
          payment_requests_sent: 0
        };
      }
      if (!credential.login && state.kind === 'unauthenticated' && canInjectOnUnauthenticated) {
        canInjectOnUnauthenticated = false;
        await injectCookies();
        suppliedSessionChecked = true;
        await activeCdp.command(
          'Page.navigate',
          { url: 'https://chatgpt.com/' },
          sessionId,
          remaining()
        );
        await waitDirectLogin(signal);
        continue;
      }
      if (
        !credential.login &&
        (['unauthenticated', 'login', 'email', 'password', 'code'].includes(state?.kind) ||
          (state?.kind === 'loading' && Date.now() >= automaticDeadline && !manualReported))
      )
        throw new DirectBrowserError('official_login_not_verified');
      if (pendingSubmission?.failure) {
        pendingSubmission.value = '';
        submitted.add(pendingSubmission.key);
        pendingSubmission = undefined;
        state = { kind: 'manual' };
      }
      if (
        credential.login &&
        state.kind === 'password' &&
        !manualReported &&
        (!passwordAvailable || ('passwordRejected' in state && state.passwordRejected))
      ) {
        if (submitted.has('email_login')) state = { kind: 'manual' };
        else {
          submitted.add('email_login');
          await hooks.progress('login_email');
          const switched = await activeCdp.evaluate<LoginPageState>(
            sessionId,
            loginPageExpression('email_login')
          );
          if (switched.kind !== 'submitted') state = { kind: 'manual' };
          else {
            await waitDirectLogin(signal);
            continue;
          }
        }
      }
      if (
        manualReported &&
        credential.login &&
        state.kind !== manualState &&
        ['login', 'email', 'password', 'code'].includes(state?.kind) &&
        !submitted.has(stateKey(state))
      ) {
        // After the user completes an official challenge, resume only stages never submitted.
        manualReported = false;
        leaveManualWait();
        automaticDeadline = Math.min(
          deadline,
          Date.now() + (settings.browserOptions?.sessionWaitMinutes ?? 2) * 60_000
        );
      }
      if (
        !manualReported &&
        Date.now() < automaticDeadline &&
        credential.login &&
        state.kind === 'login' &&
        !submitted.has('login')
      ) {
        await hooks.progress('session_restore');
        const openedLogin = await activeCdp.evaluate<LoginPageState>(
          sessionId,
          loginPageExpression('login')
        );
        if (openedLogin.kind === 'submitted') submitted.add('login');
        else state = openedLogin;
      }
      if (
        !manualReported &&
        Date.now() < automaticDeadline &&
        credential.login &&
        ['email', 'password', 'code'].includes(state?.kind) &&
        !submitted.has(stateKey(state))
      ) {
        const kind = state.kind as 'email' | 'password' | 'code';
        if (!pendingSubmission || pendingSubmission.key !== stateKey(state)) {
          if (pendingSubmission) pendingSubmission.value = '';
          const submission: NonNullable<typeof pendingSubmission> = {
            kind,
            key: stateKey(state),
            ...(kind === 'code'
              ? {
                  challenge: {
                    kind:
                      'codeType' in state && state.codeType === 'email'
                        ? ('email' as const)
                        : ('totp' as const),
                    challengeId: crypto.randomUUID()
                  }
                }
              : {}),
            value:
              kind === 'email'
                ? credential.login.email
                : kind === 'password'
                  ? credential.login.password
                  : '',
            waitingForCode: kind === 'code'
          };
          pendingSubmission = submission;
          await hooks.progress(kind === 'code' ? 'login_code_required' : `login_${kind}`, {
            user_action_required: kind === 'code',
            ...(submission.challenge
              ? {
                  login_code_type: submission.challenge.kind,
                  login_challenge_id: submission.challenge.challengeId
                }
              : {})
          });
          if (kind === 'code') {
            if (submission.challenge?.kind === 'email')
              automaticDeadline = Math.min(
                deadline,
                Math.max(automaticDeadline, Date.now() + 125_000)
              );
            // Keep observing the official window while the task waits for a code.
            void hooks.code(submission.challenge!).then(
              (value) => {
                if (pendingSubmission !== submission || signal.aborted) return;
                submission.value = typeof value === 'string' ? value : value.token;
                submission.expiresAt = typeof value === 'string' ? undefined : value.expiresAt;
                submission.waitingForCode = false;
              },
              (cause: unknown) => {
                if (pendingSubmission !== submission || signal.aborted) return;
                submission.failure = { cause };
                submission.waitingForCode = false;
              }
            );
            await Promise.resolve();
          }
        }
        signal.throwIfAborted();
        if (Date.now() >= deadline) throw new DirectBrowserError('official_login_not_verified');
        if (
          !pendingSubmission.failure &&
          !pendingSubmission.waitingForCode &&
          Date.now() < automaticDeadline
        ) {
          if (
            kind === 'code' &&
            pendingSubmission.expiresAt !== undefined &&
            !isV2TotpCodeCurrent(
              pendingSubmission.value,
              pendingSubmission.expiresAt,
              Date.now() + 3000
            )
          ) {
            pendingSubmission.value = '';
            pendingSubmission = undefined;
            submitted.add(stateKey(state));
            state = { kind: 'manual' };
          } else {
            const filled = await activeCdp.evaluate<LoginPageState>(
              sessionId,
              loginPageExpression(kind, pendingSubmission.value, {
                email: expected.email,
                codeType: pendingSubmission.challenge?.kind
              })
            );
            if (filled.kind === 'filled' && Date.now() < automaticDeadline) {
              signal.throwIfAborted();
              if (
                kind === 'code' &&
                pendingSubmission.expiresAt !== undefined &&
                !isV2TotpCodeCurrent(
                  pendingSubmission.value,
                  pendingSubmission.expiresAt,
                  Date.now() + 3000
                )
              ) {
                pendingSubmission.value = '';
                pendingSubmission = undefined;
                submitted.add(stateKey(state));
                await activeCdp.evaluate(sessionId, loginPageExpression('clear'));
                state = { kind: 'manual' };
              } else {
                const confirmed = await activeCdp.evaluate<LoginPageState>(
                  sessionId,
                  loginPageExpression('submit', pendingSubmission.value, {
                    stage: kind,
                    email: expected.email,
                    codeType: pendingSubmission.challenge?.kind
                  })
                );
                if (confirmed.kind === 'submitted') {
                  submitted.add(pendingSubmission.key);
                  pendingSubmission.value = '';
                  pendingSubmission = undefined;
                  if (kind === 'password') credential.login.password = '';
                  if (kind === 'code') await hooks.progress('login_code_submitted');
                } else state = confirmed;
              }
            } else state = filled;
          }
        }
      }
      if (state.kind === 'manual' && 'codeType' in state && pendingSubmission?.kind === 'code') {
        // A code requested for one challenge must never survive a different challenge.
        pendingSubmission.value = '';
        pendingSubmission = undefined;
        submitted.add(stateKey(state));
      }
      if (!manualReported && (state?.kind === 'manual' || Date.now() >= automaticDeadline)) {
        enterManualWait();
        manualReported = true;
        manualState = observedKind;
        await hooks.progress('verification_required', { user_action_required: true });
      } else if (
        state?.kind !== lastState &&
        !manualReported &&
        !['code', 'password', 'email'].includes(state?.kind)
      ) {
        await hooks.progress('session_restore');
      }
      lastState = state?.kind;
      await waitDirectLogin(signal);
    }
    throw new DirectBrowserError(
      Date.now() >= hardDeadline ? 'official_login_not_verified' : 'bitbrowser_recovery_timeout'
    );
  } catch (error) {
    if (
      !callerSignal.aborted &&
      (automaticBudget.signal.aborted ||
        (manualStarted === undefined && Date.now() >= deadline && Date.now() < hardDeadline))
    )
      throw new DirectBrowserError('bitbrowser_recovery_timeout');
    if (!callerSignal.aborted && Date.now() >= hardDeadline)
      throw new DirectBrowserError('official_login_not_verified');
    throw error;
  } finally {
    clearTimeout(automaticTimer);
    if (pendingSubmission) pendingSubmission.value = '';
    pendingSubmission = undefined;
    expected.token = '';
    if (credential.login) credential.login.password = '';
    if ('sessionJson' in credential) credential.sessionJson = '';
    if (cdp && sessionId && !signal.aborted) {
      try {
        await cdp.evaluate(sessionId, loginPageExpression('clear'));
      } catch {
        /* Window remains available for manual inspection. */
      }
    }
    removeGuard?.();
    cdp?.close();
  }
}

import { BrowserCdp } from './bitbrowser-cdp';
import {
  directBrowserApi,
  directBrowserCatalog,
  directProfileOptions,
  verifyDirectProfileConfiguration,
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
import type { V2RechargeOwnedBrowserProfile } from '@apple-business/shared';

import { parseDirectCredential, type DirectLoginCredential } from './bitbrowser-direct-credential';
export { parseDirectCredential, type DirectLoginCredential } from './bitbrowser-direct-credential';

export interface DirectLoginHooks {
  progress: (stage: string, extra?: Record<string, unknown>) => Promise<void>;
  code: () => Promise<string>;
  restore?: (accountKey: string) => Promise<{ ownedProfile?: V2RechargeOwnedBrowserProfile }>;
}
export function isLoginPaymentWrite(method: string, rawUrl: string) {
  if (['GET', 'HEAD', 'OPTIONS'].includes(method)) return false;
  const url = new URL(rawUrl);
  return (
    url.hostname === 'stripe.com' ||
    url.hostname.endsWith('.stripe.com') ||
    (url.hostname === 'chatgpt.com' && url.pathname.startsWith('/backend-api/payments/'))
  );
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
  let guardError: unknown;
  let removeGuard: (() => void) | undefined;
  let pendingSubmission:
    | {
        kind: 'email' | 'password' | 'code';
        value: string;
        waitingForCode: boolean;
        failure?: { cause: unknown };
      }
    | undefined;
  try {
    let ownedProfile: V2RechargeOwnedBrowserProfile | undefined;
    if (expected.accountId && hooks.restore) {
      const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(expected.accountId)
      );
      const accountKey = Array.from(new Uint8Array(digest), (part) =>
        part.toString(16).padStart(2, '0')
      ).join('');
      ownedProfile = (await hooks.restore(accountKey)).ownedProfile;
      if (
        ownedProfile &&
        (ownedProfile.accountKey !== accountKey ||
          !/^[a-f0-9]{32}$/.test(ownedProfile.profileId) ||
          typeof ownedProfile.sourceJobId !== 'string' ||
          !ownedProfile.sourceJobId)
      )
        throw new DirectBrowserError('bitbrowser_owned_profile_unverified');
    }
    remaining();
    let profileId: unknown = ownedProfile?.profileId;
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
          url: 'about:blank',
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
      await hooks.progress('bitbrowser_profile_created', { browser_profile_id: profileId });
      await api.post(
        '/browserTag/updateRelation',
        {
          browserId: profileId,
          addTagIds: [tagId],
          removeTagIds: []
        },
        remaining()
      );
    } else {
      await hooks.progress('owned_profile_check', { browser_profile_id: profileId });
    }
    if (typeof profileId !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(profileId))
      throw new DirectBrowserError('bitbrowser_direct_protocol');
    let detail: Record<string, unknown>;
    try {
      detail = (await api.post('/browser/detail', { id: profileId }, remaining())).data as Record<
        string,
        unknown
      >;
    } catch (error) {
      if (
        ownedProfile &&
        error instanceof DirectBrowserError &&
        error.reason === 'bitbrowser_direct_rejected'
      )
        throw new DirectBrowserError('bitbrowser_owned_profile_missing');
      throw error;
    }
    if (ownedProfile && detail?.id !== profileId)
      throw new DirectBrowserError('bitbrowser_owned_profile_missing');
    if (
      detail?.id !== profileId ||
      ['syncTabs', 'syncCookies', 'syncLocalStorage', 'syncIndexedDb', 'syncAuthorization'].some(
        (key) => detail[key] !== false
      )
    ) {
      throw new DirectBrowserError('bitbrowser_profile_sync_unverified');
    }
    verifyDirectProfileConfiguration(detail, settings);
    let networkFailed = false;
    let attempts = 0;
    const attemptLimit = Math.min(
      10,
      Math.max(1, (settings.browserOptions?.sessionRetryLimit ?? 9) + 1)
    );
    let proxyReady = false;
    let proxyDeadline = 0;
    let canInjectOnUnauthenticated = Boolean(ownedProfile);
    let pageReadyDeadline: number | undefined;
    let pageReloaded = false;
    let expiredDeadline: number | undefined;
    let sessionRefreshRequested = false;
    let officialTargetId = '';
    const injectCookies = async () => {
      if (!expected.token || !cdp) return;
      const cookies = (
        await cdp.command(
          'Network.getCookies',
          { urls: ['https://chatgpt.com/', 'https://chatgpt.com/api/auth/session'] },
          sessionId,
          remaining()
        )
      ).cookies;
      if (!Array.isArray(cookies)) throw new DirectBrowserError('bitbrowser_direct_protocol');
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
    };
    const openSession = async (extractIp = false) => {
      remaining();
      attempts++;
      networkFailed = false;
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
      cdp = await BrowserCdp.connect(endpoint, signal);
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
      const page =
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
      const activeCdp = cdp;
      const activeSession = sessionId;
      const frameTree = (await cdp.command('Page.getFrameTree', {}, sessionId)).frameTree as
        | { frame?: { id?: string } }
        | undefined;
      const mainFrameId = frameTree?.frame?.id;
      if (!mainFrameId) throw new DirectBrowserError('bitbrowser_direct_protocol');
      const criticalRequests = new Set<string>();
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
            )
              criticalRequests.add(params.requestId);
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
        )
          networkFailed = true;
        if (method === 'Network.loadingFailed' || method === 'Network.loadingFinished')
          criticalRequests.delete(String(params.requestId));
        if (method !== 'Fetch.requestPaused') return;
        const request = params.request as { method: string; url: string };
        const blocked = isLoginPaymentWrite(request.method, request.url);
        void activeCdp
          .command(
            blocked ? 'Fetch.failRequest' : 'Fetch.continueRequest',
            { requestId: params.requestId, ...(blocked ? { errorReason: 'BlockedByClient' } : {}) },
            activeSession
          )
          .catch((error) => {
            if (cdp === activeCdp) guardError = error;
          });
      });
      await cdp.command(
        'Fetch.enable',
        { patterns: [{ urlPattern: '*', requestStage: 'Request' }] },
        sessionId
      );
      await cdp.command('Network.enable', {}, sessionId);
      if (expected.token && !ownedProfile && attempts === 1) await injectCookies();
      const navigation =
        page && /^https:\/\/chatgpt\.com(?:\/|$)/.test(page.url)
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
        pageReadyDeadline = Math.min(automaticDeadline, pageReadyDeadline + paused);
      if (expiredDeadline !== undefined)
        expiredDeadline = Math.min(automaticDeadline, expiredDeadline + paused);
      manualStarted = undefined;
      armAutomaticTimer();
    };
    const recoverProxy = async () => {
      if (
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
      if (guardError) throw guardError;
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
        throw new DirectBrowserError('access_token_expired');
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
          guardError ||
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
        manualStarted === undefined &&
        expiredDeadline !== undefined &&
        Date.now() >= expiredDeadline
      )
        throw new DirectBrowserError('access_token_expired');
      if (state.kind === 'expired') {
        if ('refreshFailed' in state && state.refreshFailed)
          throw new DirectBrowserError('access_token_expired');
        if (credential.login) throw new DirectBrowserError('access_token_expired');
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
        if (!credential.login) {
          assertJsonPhase();
          canInjectOnUnauthenticated = false;
          let ui: ReturnType<typeof inspectLoggedInPage>;
          try {
            ui = await activeCdp.evaluate<ReturnType<typeof inspectLoggedInPage>>(
              sessionId,
              loggedInPageExpression(),
              Math.min(
                remaining(),
                manualStarted === undefined ? automaticDeadline - Date.now() : Infinity
              )
            );
          } catch (error) {
            if (
              signal.aborted ||
              guardError ||
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
            pageReadyDeadline ??= Math.min(automaticDeadline, Date.now() + 10_000);
            if (Date.now() >= pageReadyDeadline) {
              if (pageReloaded) throw new DirectBrowserError('official_login_page_not_ready');
              pageReloaded = true;
              await hooks.progress('session_restore', {
                account_matched: true,
                session_status: 'restored',
                session_step: 'page_refresh'
              });
              await activeCdp.command('Page.reload', { ignoreCache: true }, sessionId, remaining());
              // Every following poll must re-read and compare the authoritative identity.
              pageReadyDeadline = automaticDeadline;
            }
            await waitDirectLogin(signal);
            continue;
          }
        }
        if (guardError) throw guardError;
        remaining();
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
      if (pendingSubmission?.failure) throw pendingSubmission.failure.cause;
      if (
        manualReported &&
        credential.login &&
        state.kind !== manualState &&
        ['login', 'email', 'password', 'code'].includes(state?.kind) &&
        !submitted.has(state.kind)
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
        !submitted.has(state.kind)
      ) {
        const kind = state.kind as 'email' | 'password' | 'code';
        if (!pendingSubmission || pendingSubmission.kind !== kind) {
          if (pendingSubmission) pendingSubmission.value = '';
          const submission: NonNullable<typeof pendingSubmission> = {
            kind,
            value:
              kind === 'email'
                ? credential.login.email
                : kind === 'password'
                  ? credential.login.password
                  : '',
            waitingForCode: kind === 'code'
          };
          pendingSubmission = submission;
          if (kind === 'code') {
            // Keep observing the official window while the task waits for a code.
            void hooks.code().then(
              (value) => {
                if (pendingSubmission !== submission || signal.aborted) return;
                submission.value = value;
                submission.waitingForCode = false;
              },
              (cause: unknown) => {
                if (pendingSubmission !== submission || signal.aborted) return;
                submission.failure = { cause };
                submission.waitingForCode = false;
              }
            );
          }
          await hooks.progress(kind === 'code' ? 'login_code_required' : `login_${kind}`, {
            user_action_required: kind === 'code'
          });
        }
        signal.throwIfAborted();
        if (Date.now() >= deadline) throw new DirectBrowserError('official_login_not_verified');
        if (pendingSubmission.failure) throw pendingSubmission.failure.cause;
        if (!pendingSubmission.waitingForCode && Date.now() < automaticDeadline) {
          const filled = await activeCdp.evaluate<LoginPageState>(
            sessionId,
            loginPageExpression(kind, pendingSubmission.value, { email: expected.email })
          );
          if (filled.kind === 'filled' && Date.now() < automaticDeadline) {
            signal.throwIfAborted();
            const confirmed = await activeCdp.evaluate<LoginPageState>(
              sessionId,
              loginPageExpression('submit', pendingSubmission.value, {
                stage: kind,
                email: expected.email
              })
            );
            if (confirmed.kind === 'submitted') {
              submitted.add(kind);
              pendingSubmission.value = '';
              pendingSubmission = undefined;
              if (kind === 'password') credential.login.password = '';
              if (kind === 'code') await hooks.progress('login_code_submitted');
            } else state = confirmed;
          } else state = filled;
        }
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
        await cdp.command('Fetch.disable', {}, sessionId);
      } catch {
        /* Window remains available for manual inspection. */
      }
    }
    removeGuard?.();
    cdp?.close();
  }
}

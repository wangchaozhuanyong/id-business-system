import { BrowserCdp } from './bitbrowser-cdp';
import {
  directBrowserApi,
  directBrowserCatalog,
  directProfileOptions,
  verifyDirectProfileConfiguration,
  DirectBrowserError,
  type DirectBrowserSettings
} from './bitbrowser-direct-api';
import { loginPageExpression, type LoginPageState } from './bitbrowser-login-page';

import { parseDirectCredential, type DirectLoginCredential } from './bitbrowser-direct-credential';
export { parseDirectCredential, type DirectLoginCredential } from './bitbrowser-direct-credential';

export interface DirectLoginHooks {
  progress: (stage: string, extra?: Record<string, unknown>) => Promise<void>;
  code: () => Promise<string>;
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
export async function runDirectLogin(
  settings: DirectBrowserSettings,
  credential: DirectLoginCredential,
  windowName: string,
  signal: AbortSignal,
  hooks: DirectLoginHooks
) {
  const expected = parseDirectCredential(credential);
  const api = directBrowserApi(settings.localApiUrl, settings.localApiToken, signal);
  let cdp: BrowserCdp | undefined;
  let sessionId = '';
  let guardError: unknown;
  let removeGuard: (() => void) | undefined;
  let pendingSubmission: { kind: 'email' | 'password' | 'code'; value: string } | undefined;
  try {
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
    const created = await api.post('/browser/update', {
      groupId,
      platform: 'https://chatgpt.com',
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
    });
    const profileId = (created.data as Record<string, unknown>)?.id;
    if (typeof profileId !== 'string' || !/^[A-Za-z0-9_-]{32}$/.test(profileId))
      throw new DirectBrowserError('bitbrowser_direct_protocol');
    await hooks.progress('bitbrowser_profile_created', { browser_profile_id: profileId });
    await api.post('/browserTag/updateRelation', {
      browserId: profileId,
      addTagIds: [tagId],
      removeTagIds: []
    });
    const detail = (await api.post('/browser/detail', { id: profileId })).data as Record<
      string,
      unknown
    >;
    if (
      detail?.id !== profileId ||
      ['syncTabs', 'syncCookies', 'syncLocalStorage', 'syncIndexedDb', 'syncAuthorization'].some(
        (key) => detail[key] !== false
      )
    ) {
      throw new DirectBrowserError('bitbrowser_profile_sync_unverified');
    }
    verifyDirectProfileConfiguration(detail, settings);
    const opened = await api.post('/browser/open', {
      id: profileId,
      queue: true,
      args: [`--remote-allow-origins=${window.location.origin}`]
    });
    verifyDirectProfileConfiguration(detail, settings, opened.data as Record<string, unknown>);
    await hooks.progress('bitbrowser_profile_opened');
    const endpoint = (opened.data as Record<string, unknown>)?.ws;
    if (typeof endpoint !== 'string')
      throw new DirectBrowserError('bitbrowser_direct_debug_unavailable');
    cdp = await BrowserCdp.connect(endpoint, signal);
    const version = await cdp.command('Browser.getVersion');
    const actualVersion = /(?:HeadlessChrome|Chrome)\/(\d+)\./.exec(String(version.product ?? ''));
    if (!actualVersion) throw new DirectBrowserError('bitbrowser_profile_configuration_unverified');
    if (actualVersion[1] !== directProfileOptions(settings).browserFingerPrint.coreVersion)
      throw new DirectBrowserError('bitbrowser_profile_configuration_mismatch');
    const targets = (await cdp.command('Target.getTargets')).targetInfos as {
      type: string;
      targetId: string;
      url: string;
    }[];
    const page = targets?.find((target) => target.type === 'page' && target.url === 'about:blank');
    const targetId =
      page?.targetId ??
      String((await cdp.command('Target.createTarget', { url: 'about:blank' })).targetId);
    sessionId = String(
      (await cdp.command('Target.attachToTarget', { targetId, flatten: true })).sessionId
    );
    removeGuard = cdp.onEvent((method, params, eventSession) => {
      if (method !== 'Fetch.requestPaused' || eventSession !== sessionId) return;
      const request = params.request as { method: string; url: string };
      const blocked = isLoginPaymentWrite(request.method, request.url);
      void cdp!
        .command(
          blocked ? 'Fetch.failRequest' : 'Fetch.continueRequest',
          { requestId: params.requestId, ...(blocked ? { errorReason: 'BlockedByClient' } : {}) },
          sessionId
        )
        .catch((error) => {
          guardError = error;
        });
    });
    await cdp.command(
      'Fetch.enable',
      { patterns: [{ urlPattern: '*', requestStage: 'Request' }] },
      sessionId
    );
    if (expected.token) {
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
        sessionId
      );
      expected.token = '';
    }
    await cdp.command(
      'Page.navigate',
      { url: credential.login ? 'https://chatgpt.com/auth/login' : 'https://chatgpt.com/' },
      sessionId
    );
    const submitted = new Set<string>();
    let manualReported = false;
    let manualState = '';
    let lastState = '';
    const deadline = Date.now() + 30 * 60_000;
    let automaticDeadline =
      Date.now() + (settings.browserOptions?.sessionWaitMinutes ?? 2) * 60_000;
    while (Date.now() < deadline) {
      signal.throwIfAborted();
      if (guardError) throw guardError;
      let state: LoginPageState;
      try {
        state = await cdp.evaluate<LoginPageState>(sessionId, loginPageExpression('inspect'));
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
      const observedKind = state.kind;
      if (manualReported && state.kind === 'manual') manualState = 'manual';
      if (state?.kind === 'identity') {
        if (
          state.email.toLowerCase() !== expected.email ||
          (expected.userId && state.userId !== expected.userId) ||
          (expected.accountId && state.accountId !== expected.accountId)
        )
          throw new DirectBrowserError('official_login_email_mismatch');
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
      if (
        !credential.login &&
        (['unauthenticated', 'login', 'email', 'password', 'code'].includes(state?.kind) ||
          (state?.kind === 'loading' && Date.now() >= automaticDeadline && !manualReported))
      )
        throw new DirectBrowserError('official_login_not_verified');
      if (
        manualReported &&
        credential.login &&
        state.kind !== manualState &&
        ['login', 'email', 'password', 'code'].includes(state?.kind) &&
        !submitted.has(state.kind)
      ) {
        // After the user completes an official challenge, resume only stages never submitted.
        manualReported = false;
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
        const openedLogin = await cdp.evaluate<LoginPageState>(
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
          const requestedCode = kind === 'code' ? hooks.code() : undefined;
          void requestedCode?.catch(() => undefined);
          await hooks.progress(kind === 'code' ? 'login_code_required' : `login_${kind}`, {
            user_action_required: kind === 'code'
          });
          pendingSubmission = {
            kind,
            value:
              kind === 'email'
                ? credential.login.email
                : kind === 'password'
                  ? credential.login.password
                  : await requestedCode!
          };
        }
        const filled = await cdp.evaluate<LoginPageState>(
          sessionId,
          loginPageExpression(kind, pendingSubmission.value, { email: expected.email })
        );
        if (filled.kind === 'filled') {
          const confirmed = await cdp.evaluate<LoginPageState>(
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
      if (!manualReported && (state?.kind === 'manual' || Date.now() >= automaticDeadline)) {
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
      await new Promise<void>((resolve, reject) => {
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
    throw new DirectBrowserError('official_login_not_verified');
  } finally {
    if (pendingSubmission) pendingSubmission.value = '';
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

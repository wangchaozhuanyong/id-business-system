// Ported from the pinned BitBrowser implementation e51dd9c9. See README.md.
async function inspectLoginPage(action, value = '', context) {
  const official =
    location.protocol === 'https:' &&
    ['chatgpt.com', 'auth.openai.com', 'auth0.openai.com'].includes(location.hostname);
  if (!official) return { kind: location.href === 'about:blank' ? 'loading' : 'manual' };
  const readingJsonSession =
    action === 'inspect' && context?.sessionOnly === true && location.hostname === 'chatgpt.com';
  if (!readingJsonSession && document.readyState !== 'complete') return { kind: 'loading' };
  const selectors = {
    email: 'input[type="email"], input[name="username"], input[autocomplete="username"]',
    password: 'input[type="password"], input[autocomplete="current-password"]',
    code: 'input[autocomplete="one-time-code"], input[name="code"], input[name*="otp"], input[name="verificationCode"]'
  };
  const visible = (selector) =>
    Array.from(document.querySelectorAll(selector)).filter(
      (input) =>
        input.getClientRects().length &&
        !input.disabled &&
        !input.readOnly &&
        getComputedStyle(input).visibility !== 'hidden'
    );
  const codeType = (input) => {
    const text = (input.form?.innerText ?? '').toLowerCase();
    const path = location.pathname.toLowerCase();
    if (/sms|text message|phone number|短信|手机/.test(text)) return 'sms';
    if (
      /email-verification|email-otp|email-code/.test(path) ||
      /check your (?:email|inbox)|email verification code|(?:sent|emailed).{0,60}code.{0,60}(?:email|inbox)|code.{0,60}(?:sent|emailed).{0,60}(?:email|inbox)|(?:email|inbox).{0,60}(?:sent|emailed).{0,60}code|邮箱验证码|邮箱.{0,30}(?:已发送|发送了).{0,30}验证码|验证码.{0,30}(?:发送|发至).{0,30}邮箱/.test(
        text
      )
    )
      return 'email';
    if (
      /mfa-otp-challenge|authenticator|totp/.test(path) ||
      /authenticator|authentication app|verification app|验证器|身份验证应用/.test(text)
    )
      return 'totp';
    return 'unknown';
  };
  if (action !== 'inspect') return { kind: 'manual' };
  if (/Just a moment|Verify.*human|安全验证|请稍候/i.test(document.title))
    return { kind: 'manual' };
  let unauthenticated = false;
  if (location.hostname === 'chatgpt.com') {
    try {
      const readDeadline =
        Date.now() +
        (Number.isSafeInteger(context?.sessionReadBudgetMs) && context.sessionReadBudgetMs > 0
          ? Math.min(10_000, context.sessionReadBudgetMs)
          : 10_000);
      const readSignal = () => AbortSignal.timeout(Math.max(1, readDeadline - Date.now()));
      const sessionPath =
        readingJsonSession && context?.refreshSession
          ? '/api/auth/session?refresh=true&reason=token_expired&method=GET&path=%2Fapi%2Fauth%2Fsession'
          : '/api/auth/session';
      const response = await fetch(sessionPath, {
        credentials: 'include',
        cache: 'no-store',
        signal: readSignal()
      });
      if (response.status === 403) return { kind: 'manual' };
      const session = response.ok ? await response.json() : null;
      if (session?.error === 'RefreshAccessTokenError')
        return { kind: 'expired', refreshFailed: true };
      if (session?.error) return { kind: 'session_error' };
      unauthenticated = readingJsonSession
        ? response.status === 200 &&
          session !== null &&
          typeof session === 'object' &&
          !Array.isArray(session) &&
          ['error', 'user', 'accessToken', 'access_token', 'account'].every(
            (key) => !Object.hasOwn(session, key)
          )
        : response.status === 401 || (response.ok && !session?.user);
      if (session?.user?.id && session.user.email && session.accessToken) {
        const claims = JSON.parse(
          atob(session.accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))
        );
        const accountId = claims['https://api.openai.com/auth']?.chatgpt_account_id;
        if (typeof accountId !== 'string') return { kind: 'manual' };
        if (Number.isSafeInteger(claims.exp) && claims.exp <= Math.floor(Date.now() / 1_000) + 30)
          return {
            kind: 'expired',
            email: String(session.user.email),
            userId: String(session.user.id),
            accountId
          };
        if (Date.now() >= readDeadline) return { kind: 'loading' };
        const check = await fetch('/backend-api/accounts/check/v4-2023-04-27', {
          cache: 'no-store',
          headers: {
            Authorization: 'Bearer ' + session.accessToken,
            'chatgpt-account-id': accountId
          },
          signal: readSignal()
        });
        if (check.status === 401)
          return {
            kind: 'expired',
            tokenRejected: true,
            refreshFailed: context?.refreshSession === true,
            email: String(session.user.email),
            userId: String(session.user.id),
            accountId
          };
        if (check.ok) {
          const data = await check.json();
          const node = data?.accounts?.[accountId];
          const plan = node?.account?.plan_type ?? node?.plan_type;
          if (
            node?.account &&
            (!node.account.account_id || node.account.account_id === accountId) &&
            [
              'free',
              'plus',
              'pro',
              'promax',
              'team',
              'business',
              'enterprise',
              'edu',
              'go'
            ].includes(plan)
          ) {
            return {
              kind: 'identity',
              email: String(session.user.email),
              userId: String(session.user.id),
              accountId,
              plan: String(plan)
            };
          }
        }
      }
    } catch {}
  }
  if (readingJsonSession) return { kind: unauthenticated ? 'unauthenticated' : 'loading' };
  for (const kind of ['code', 'password', 'email']) {
    const inputs = visible(selectors[kind]);
    if (inputs.length > 1) return { kind: 'manual' };
    if (inputs.length === 1) {
      if (kind === 'code') {
        const type = codeType(inputs[0]);
        if (type !== 'email' && type !== 'totp') return { kind: 'manual', codeType: type };
        return { kind, codeType: type };
      }
      if (kind === 'password') {
        const alerts =
          inputs[0].form?.querySelectorAll(
            '[role="alert"], [aria-live="assertive"], [data-error="true"]'
          ) ?? [];
        const rejected = Array.from(alerts).some(
          (alert) =>
            alert.getClientRects().length &&
            /incorrect password|wrong password|invalid (?:email or )?password|密码(?:错误|不正确)/i.test(
              alert.innerText
            )
        );
        return { kind, passwordRejected: rejected };
      }
      return { kind };
    }
  }
  if (unauthenticated && loginControls().length === 1) return { kind: 'login' };
  return { kind: unauthenticated ? 'unauthenticated' : 'loading' };
}
function loginPageExpression(action, value = '', context) {
  return `(${inspectLoginPage.toString()})(${JSON.stringify(action)},${JSON.stringify(value)},${JSON.stringify(context)})`;
}
function inspectLoggedInPage() {
  if (location.protocol !== 'https:' || location.hostname !== 'chatgpt.com')
    return { kind: 'page_loading' };
  if (/Just a moment|Verify.*human|安全验证|请稍候/i.test(document.title))
    return { kind: 'manual' };
  const visible = (node) => {
    const style = getComputedStyle(node);
    return (
      node.getClientRects().length > 0 &&
      style.visibility !== 'hidden' &&
      style.display !== 'none' &&
      !node.closest('[inert], [aria-hidden="true"]')
    );
  };
  const controls = Array.from(
    document.querySelectorAll(
      '[data-testid="accounts-profile-button"][aria-haspopup="menu"], button[aria-label="打开个人资料菜单"][aria-haspopup="menu"], button[aria-label="Open profile menu"][aria-haspopup="menu"]'
    )
  ).filter(
    (node) =>
      visible(node) &&
      node.matches('button, [role="button"]') &&
      !node.matches(':disabled, [aria-disabled="true"]')
  );
  const composers = Array.from(
    document.querySelectorAll(
      '#prompt-textarea, textarea[data-testid="prompt-textarea"], div[role="textbox"][contenteditable="true"][aria-label="询问 ChatGPT"], div[role="textbox"][contenteditable="true"][aria-label="Ask ChatGPT"]'
    )
  );
  const ready =
    controls.length > 0 &&
    composers.some((node) => {
      if (
        !visible(node) ||
        node.closest('[aria-busy="true"], [data-loading="true"], [aria-disabled="true"]') ||
        getComputedStyle(node).pointerEvents === 'none' ||
        node.matches(':disabled, [readonly], [aria-disabled="true"]') ||
        !(node.matches('textarea') || node.isContentEditable)
      )
        return false;
      const region =
        node.closest('[data-testid="composer"], [data-type="unified-composer"], form') ??
        node.parentElement;
      return (
        region !== null &&
        !Array.from(
          region.querySelectorAll(
            '[aria-busy="true"], [data-loading="true"], [role="progressbar"], .animate-spin, [data-testid*="loading"], [data-testid*="spinner"], [aria-label="Loading"], [aria-label="加载中"], [aria-label="正在加载"]'
          )
        ).some(visible)
      );
    });
  return { kind: ready ? 'page_ready' : 'page_loading' };
}
function loggedInPageExpression() {
  return `(${inspectLoggedInPage.toString()})()`;
}
async function inspectOfficialProxy(timeoutMs, expectedCountry = '') {
  if (location.protocol !== 'https:' || location.hostname !== 'chatgpt.com')
    return { kind: 'loading' };
  if (/Just a moment|Verify.*human|安全验证|请稍候/i.test(document.title))
    return { kind: 'manual' };
  try {
    const response = await fetch('/cdn-cgi/trace', {
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(Math.max(1, Math.min(20_000, timeoutMs)))
    });
    if (response.status === 403) return { kind: 'manual' };
    if (!response.ok) return { kind: 'proxy_unverified' };
    const trace = await response.text();
    const ip = /^ip=([^\r\n]+)$/m.exec(trace)?.[1]?.trim() ?? '';
    const country = /^loc=([A-Z]{2})$/m.exec(trace)?.[1] ?? '';
    const octets = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip) ? ip.split('.').map(Number) : [];
    let publicIp =
      octets.length === 4 &&
      octets.every((part) => part >= 0 && part <= 255) &&
      ![0, 10, 127].includes(octets[0]) &&
      octets[0] < 224 &&
      !(octets[0] === 172 && octets[1] >= 16 && octets[1] <= 31) &&
      !(octets[0] === 192 && octets[1] === 168) &&
      !(octets[0] === 169 && octets[1] === 254) &&
      !(octets[0] === 100 && octets[1] >= 64 && octets[1] <= 127);
    if (!octets.length && /^[0-9a-f:]+$/i.test(ip) && ip.includes(':')) {
      try {
        const parsed = new URL(`https://[${ip}]/`).hostname;
        publicIp = Boolean(parsed) && !/^(?:::|::1|f[cd]|fe[89ab])/i.test(ip);
      } catch {
        publicIp = false;
      }
    }
    if (!publicIp || !country || (expectedCountry && country !== expectedCountry))
      return { kind: 'proxy_unverified' };
    return { kind: 'proxy_ready' };
  } catch {
    return { kind: 'proxy_network_failed' };
  }
}
function officialProxyExpression(timeoutMs, expectedCountry = '') {
  return `(${inspectOfficialProxy.toString()})(${Math.max(1, Math.min(20_000, timeoutMs))},${JSON.stringify(expectedCountry)})`;
}
export {
  inspectLoggedInPage,
  inspectLoginPage,
  inspectOfficialProxy,
  loggedInPageExpression,
  loginPageExpression,
  officialProxyExpression
};

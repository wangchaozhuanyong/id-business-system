/** Runs only inside the newly created official window. Returns no cookies, tokens or passwords. */
export async function inspectLoginPage(
  action: 'inspect' | 'login' | 'email' | 'password' | 'code' | 'submit' | 'clear',
  value = '',
  context?: {
    stage?: 'email' | 'password' | 'code';
    email?: string;
    sessionOnly?: boolean;
    refreshSession?: boolean;
    sessionReadBudgetMs?: number;
  }
) {
  const official =
    location.protocol === 'https:' &&
    ['chatgpt.com', 'auth.openai.com', 'auth0.openai.com'].includes(location.hostname);
  if (!official)
    return { kind: location.href === 'about:blank' ? ('loading' as const) : ('manual' as const) };
  const readingJsonSession =
    action === 'inspect' && context?.sessionOnly === true && location.hostname === 'chatgpt.com';
  if (action !== 'clear' && !readingJsonSession && document.readyState !== 'complete')
    return { kind: 'loading' as const };
  const selectors = {
    email: 'input[type="email"], input[name="username"], input[autocomplete="username"]',
    password: 'input[type="password"], input[autocomplete="current-password"]',
    code: 'input[autocomplete="one-time-code"], input[name="code"], input[name*="otp"], input[name="verificationCode"]'
  };
  const visible = (selector: string) =>
    Array.from(document.querySelectorAll<HTMLInputElement>(selector)).filter(
      (input) =>
        input.getClientRects().length &&
        !input.disabled &&
        !input.readOnly &&
        getComputedStyle(input).visibility !== 'hidden'
    );
  const write = (input: HTMLInputElement, text: string) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, text);
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
  };
  if (action === 'clear') {
    for (const key of ['password', 'code'] as const)
      for (const input of visible(selectors[key])) write(input, '');
    return { kind: 'cleared' as const };
  }
  if (/Just a moment|Verify.*human|安全验证|请稍候/i.test(document.title))
    return { kind: 'manual' as const };
  const loginControls = () =>
    Array.from(document.querySelectorAll<HTMLElement>('button, a')).filter((control) => {
      if (
        !control.getClientRects().length ||
        getComputedStyle(control).visibility === 'hidden' ||
        control.matches(':disabled, [aria-disabled="true"]') ||
        !/^(log\s*in|login|登录|登入)$/i.test((control.textContent ?? '').trim())
      )
        return false;
      if (control instanceof HTMLAnchorElement) {
        const destination = new URL(control.href);
        return (
          destination.protocol === 'https:' &&
          ['chatgpt.com', 'auth.openai.com', 'auth0.openai.com'].includes(destination.hostname)
        );
      }
      return location.hostname === 'chatgpt.com';
    });
  if (action === 'login') {
    if (Object.values(selectors).some((selector) => visible(selector).length))
      return { kind: 'loading' as const };
    const controls = loginControls();
    if (controls.length !== 1) return { kind: 'manual' as const };
    controls[0]!.click();
    return { kind: 'submitted' as const };
  }
  if (action !== 'inspect') {
    const stage = action === 'submit' ? context?.stage : action;
    if (!stage) return { kind: 'manual' as const };
    const matches = visible(selectors[stage]);
    const input = matches[0];
    const form = input?.form;
    if (matches.length !== 1 || !input || !form) return { kind: 'manual' as const };
    const formEmails = Array.from(form.querySelectorAll<HTMLInputElement>(selectors.email)).filter(
      (email) => email.getClientRects().length && getComputedStyle(email).visibility !== 'hidden'
    );
    if (stage === 'password') {
      if (formEmails.length > 1 || (formEmails.length && !context?.email))
        return { kind: 'manual' as const };
      const email = formEmails[0];
      if (
        email &&
        (action === 'submit' || email.disabled || email.readOnly) &&
        email.value.trim().toLowerCase() !== context!.email!.trim().toLowerCase()
      )
        return { kind: 'manual' as const };
    }
    if (action === 'submit') {
      const controls = Array.from(
        form.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
          'button[type="submit"], button:not([type]), input[type="submit"]'
        )
      ).filter(
        (control) =>
          control.form === form &&
          control.getClientRects().length &&
          getComputedStyle(control).visibility !== 'hidden'
      );
      if (controls.length !== 1) return { kind: 'manual' as const };
      if (
        input.value !== value ||
        !form.checkValidity() ||
        controls[0]!.disabled ||
        controls[0]!.getAttribute('aria-disabled') === 'true'
      )
        return { kind: 'loading' as const };
      controls[0]!.click();
      return { kind: 'submitted' as const };
    }
    if (action === 'password') {
      const email = formEmails[0];
      if (email && !email.disabled && !email.readOnly) write(email, context!.email!);
    }
    write(matches[0]!, value);
    matches[0]!.focus();
    return { kind: 'filled' as const };
  }
  let unauthenticated = false;
  if (location.hostname === 'chatgpt.com') {
    try {
      const readDeadline =
        Date.now() +
        (Number.isSafeInteger(context?.sessionReadBudgetMs) && context!.sessionReadBudgetMs! > 0
          ? Math.min(10_000, context!.sessionReadBudgetMs!)
          : 10_000);
      const readSignal = () =>
        AbortSignal.timeout(Math.max(1, Math.min(5000, readDeadline - Date.now())));
      const sessionPath =
        readingJsonSession && context?.refreshSession
          ? '/api/auth/session?refresh=true&reason=token_expired&method=GET&path=%2Fapi%2Fauth%2Fsession'
          : '/api/auth/session';
      const response = await fetch(sessionPath, {
        credentials: 'include',
        cache: 'no-store',
        signal: readSignal()
      });
      if (response.status === 403) return { kind: 'manual' as const };
      const session = response.ok ? await response.json() : null;
      if (session?.error === 'RefreshAccessTokenError')
        return { kind: 'expired' as const, refreshFailed: true as const };
      if (session?.error) return { kind: 'session_error' as const };
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
        if (Number.isSafeInteger(claims.exp) && claims.exp <= Math.floor(Date.now() / 1000) + 30)
          return { kind: 'expired' as const };
        const accountId = claims['https://api.openai.com/auth']?.chatgpt_account_id;
        if (typeof accountId !== 'string') return { kind: 'manual' as const };
        if (Date.now() >= readDeadline) return { kind: 'loading' as const };
        const check = await fetch('/backend-api/accounts/check/v4-2023-04-27', {
          cache: 'no-store',
          headers: {
            Authorization: 'Bearer ' + session.accessToken,
            'chatgpt-account-id': accountId
          },
          signal: readSignal()
        });
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
              kind: 'identity' as const,
              email: String(session.user.email),
              userId: String(session.user.id),
              accountId,
              plan: String(plan)
            };
          }
        }
      }
    } catch {
      /* A loading page never counts as a verified login. */
    }
  }
  // JSON verification never needs a fully loaded DOM or a manual login form.
  if (readingJsonSession)
    return { kind: unauthenticated ? ('unauthenticated' as const) : ('loading' as const) };
  for (const kind of ['code', 'password', 'email'] as const) {
    const inputs = visible(selectors[kind]);
    if (inputs.length > 1) return { kind: 'manual' as const };
    if (inputs.length === 1) return { kind };
  }
  if (unauthenticated && loginControls().length === 1) return { kind: 'login' as const };
  return { kind: unauthenticated ? ('unauthenticated' as const) : ('loading' as const) };
}

export function loginPageExpression(
  action: Parameters<typeof inspectLoginPage>[0],
  value = '',
  context?: Parameters<typeof inspectLoginPage>[2]
) {
  return `(${inspectLoginPage.toString()})(${JSON.stringify(action)},${JSON.stringify(value)},${JSON.stringify(context)})`;
}
export type LoginPageState = Awaited<ReturnType<typeof inspectLoginPage>>;

/** Positive UI evidence is separate from the read-only server identity check. */
export function inspectLoggedInPage() {
  if (location.protocol !== 'https:' || location.hostname !== 'chatgpt.com')
    return { kind: 'page_loading' as const };
  if (/Just a moment|Verify.*human|安全验证|请稍候/i.test(document.title))
    return { kind: 'manual' as const };
  const controls = Array.from(
    document.querySelectorAll<HTMLElement>(
      '[data-testid="accounts-profile-button"][aria-haspopup="menu"]'
    )
  ).filter(
    (node) =>
      node.getClientRects().length > 0 &&
      getComputedStyle(node).visibility !== 'hidden' &&
      node.matches('button, [role="button"]') &&
      !node.matches(':disabled, [aria-disabled="true"]')
  );
  return { kind: controls.length > 0 ? ('page_ready' as const) : ('page_loading' as const) };
}

export function loggedInPageExpression() {
  return `(${inspectLoggedInPage.toString()})()`;
}

/** Uses the actual window proxy; only controlled classifications leave the page. */
export async function inspectOfficialProxy(timeoutMs: number, expectedCountry = '') {
  if (location.protocol !== 'https:' || location.hostname !== 'chatgpt.com')
    return { kind: 'loading' as const };
  if (/Just a moment|Verify.*human|安全验证|请稍候/i.test(document.title))
    return { kind: 'manual' as const };
  try {
    const response = await fetch('/cdn-cgi/trace', {
      credentials: 'omit',
      cache: 'no-store',
      signal: AbortSignal.timeout(Math.max(1, Math.min(20_000, timeoutMs)))
    });
    if (response.status === 403) return { kind: 'manual' as const };
    if (!response.ok) return { kind: 'proxy_unverified' as const };
    const trace = await response.text();
    const ip = /^ip=([^\r\n]+)$/m.exec(trace)?.[1]?.trim() ?? '';
    const country = /^loc=([A-Z]{2})$/m.exec(trace)?.[1] ?? '';
    const octets = /^\d{1,3}(?:\.\d{1,3}){3}$/.test(ip) ? ip.split('.').map(Number) : [];
    let publicIp =
      octets.length === 4 &&
      octets.every((part) => part >= 0 && part <= 255) &&
      ![0, 10, 127].includes(octets[0]!) &&
      octets[0]! < 224 &&
      !(octets[0] === 172 && octets[1]! >= 16 && octets[1]! <= 31) &&
      !(octets[0] === 192 && octets[1] === 168) &&
      !(octets[0] === 169 && octets[1] === 254) &&
      !(octets[0] === 100 && octets[1]! >= 64 && octets[1]! <= 127);
    if (!octets.length && /^[0-9a-f:]+$/i.test(ip) && ip.includes(':')) {
      try {
        const parsed = new URL(`https://[${ip}]/`).hostname;
        publicIp = Boolean(parsed) && !/^(?:::|::1|f[cd]|fe[89ab])/i.test(ip);
      } catch {
        publicIp = false;
      }
    }
    if (!publicIp || !country || (expectedCountry && country !== expectedCountry))
      return { kind: 'proxy_unverified' as const };
    return { kind: 'proxy_ready' as const };
  } catch {
    return { kind: 'proxy_network_failed' as const };
  }
}

export function officialProxyExpression(timeoutMs: number, expectedCountry = '') {
  return `(${inspectOfficialProxy.toString()})(${Math.max(1, Math.min(20_000, timeoutMs))},${JSON.stringify(expectedCountry)})`;
}

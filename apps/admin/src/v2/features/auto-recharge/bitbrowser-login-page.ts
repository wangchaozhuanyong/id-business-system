/** Runs only inside the newly created official window. Returns no cookies, tokens or passwords. */
export async function inspectLoginPage(
  action: 'inspect' | 'login' | 'email' | 'password' | 'code' | 'submit' | 'clear',
  value = '',
  context?: { stage?: 'email' | 'password' | 'code'; email?: string }
) {
  const official =
    location.protocol === 'https:' &&
    ['chatgpt.com', 'auth.openai.com', 'auth0.openai.com'].includes(location.hostname);
  if (!official)
    return { kind: location.href === 'about:blank' ? ('loading' as const) : ('manual' as const) };
  if (action !== 'clear' && document.readyState !== 'complete') return { kind: 'loading' as const };
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
      const response = await fetch('/api/auth/session', {
        credentials: 'include',
        cache: 'no-store',
        signal: AbortSignal.timeout(5000)
      });
      if (response.status === 403) return { kind: 'manual' as const };
      const session = response.ok ? await response.json() : null;
      unauthenticated = response.status === 401 || (response.ok && !session?.user);
      if (session?.user?.id && session.user.email && session.accessToken) {
        const claims = JSON.parse(
          atob(session.accessToken.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))
        );
        const accountId = claims['https://api.openai.com/auth']?.chatgpt_account_id;
        if (typeof accountId !== 'string') return { kind: 'manual' as const };
        const check = await fetch('/backend-api/accounts/check/v4-2023-04-27', {
          cache: 'no-store',
          headers: {
            Authorization: 'Bearer ' + session.accessToken,
            'chatgpt-account-id': accountId
          },
          signal: AbortSignal.timeout(5000)
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

/** Runs only inside the newly created official window. Returns no cookies, tokens or passwords. */
export async function inspectLoginPage(
  action: 'inspect' | 'email' | 'password' | 'code' | 'clear',
  value = ''
) {
  const official =
    location.protocol === 'https:' &&
    ['chatgpt.com', 'auth.openai.com', 'auth0.openai.com'].includes(location.hostname);
  if (!official) return { kind: 'manual' as const };
  const selectors = {
    email: 'input[type="email"], input[name="username"], input[autocomplete="username"]',
    password: 'input[type="password"], input[autocomplete="current-password"]',
    code: 'input[autocomplete="one-time-code"], input[name="code"], input[name*="otp"]'
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
  if (action !== 'inspect') {
    const matches = visible(selectors[action]);
    if (matches.length !== 1 || !matches[0]!.closest('form')) return { kind: 'manual' as const };
    write(matches[0]!, value);
    matches[0]!.focus();
    return { kind: 'filled' as const };
  }
  if (/Just a moment|Verify.*human|安全验证|请稍候/i.test(document.title))
    return { kind: 'manual' as const };
  if (location.hostname === 'chatgpt.com') {
    try {
      const response = await fetch('/api/auth/session', {
        credentials: 'include',
        cache: 'no-store',
        signal: AbortSignal.timeout(5000)
      });
      if (response.status === 403) return { kind: 'manual' as const };
      const session = response.ok ? await response.json() : null;
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
  return { kind: 'loading' as const };
}

export function loginPageExpression(action: Parameters<typeof inspectLoginPage>[0], value = '') {
  return `(${inspectLoginPage.toString()})(${JSON.stringify(action)},${JSON.stringify(value)})`;
}
export type LoginPageState = Awaited<ReturnType<typeof inspectLoginPage>>;

import type { V2RechargePlan } from './contracts';

/** Serialized into the owned official page. No arbitrary URL or selector is accepted. */
export function inspectDirectPaymentPage(
  plan: V2RechargePlan,
  action: 'prepare' | 'create' | 'tier' | 'verify_tier' | 'confirm' | 'inspect',
  expectedCheckout?: string,
  preparation?: { menuRequested?: boolean; personalRequested?: boolean }
) {
  if (location.origin !== 'https://chatgpt.com') return { kind: 'untrusted' };
  if (!document.body) return { kind: 'loading' };
  const rendered = (node: Element) =>
    node.getClientRects().length > 0 && getComputedStyle(node).visibility !== 'hidden';
  const visible = (node: Element) => {
    const style = getComputedStyle(node);
    return (
      rendered(node) &&
      style.pointerEvents !== 'none' &&
      !node.matches(':disabled,[aria-disabled="true"]') &&
      !node.closest('[inert],[aria-hidden="true"],[aria-disabled="true"],[aria-busy="true"]')
    );
  };
  const controls = () =>
    [...document.querySelectorAll<HTMLElement>('button,a,[role="button"]')].filter(visible);
  const text = document.body.innerText.slice(0, 30000);
  const checkout =
    /^\/checkout\/([a-z][a-z0-9_]{0,40})\/((?:oaics|cs)_[A-Za-z0-9_]{1,200})\/?$/.exec(
      location.pathname
    );
  if (
    ['tier', 'verify_tier'].includes(action) &&
    (!checkout || (expectedCheckout && checkout[2] !== expectedCheckout))
  )
    return { kind: 'checkout_mismatch' };
  const failed =
    /there was an error processing your payment|处理(?:你的|您的)?付款时(?:发生|出现)?错误|付款处理错误/i.test(
      text
    );
  const paymentFormLoadFailed =
    /无法加载付款表单[。.]?\s*请重试|(?:unable to|could not|failed to) load (?:the )?payment form[.\s]*(?:please )?try again/i.test(
      text
    );
  const paymentMethodVerificationFailed =
    Boolean(checkout) &&
    /我们未能验证您的支付方式[。.]?\s*请选择另一支付方式并重试|we (?:were )?unable to authenticate your payment method[.\s]+please (?:choose|select) (?:a |another |a different )?payment method/i.test(
      text
    );
  if (action === 'inspect')
    return {
      kind: paymentMethodVerificationFailed
        ? 'payment_method_verification_failed'
        : paymentFormLoadFailed
          ? 'payment_form_load_failed'
          : failed
            ? 'official_error'
            : 'page',
      text,
      url: location.href,
      checkoutId: checkout?.[2],
      entity: checkout?.[1]
    };
  if (paymentMethodVerificationFailed) return { kind: 'payment_method_verification_failed' };
  if (paymentFormLoadFailed) return { kind: 'payment_form_load_failed' };
  if (failed) return { kind: 'official_error' };
  if (action === 'confirm') {
    if (!checkout || !expectedCheckout || checkout[2] !== expectedCheckout)
      return { kind: 'checkout_mismatch' };
    const pattern =
      /^(?:Subscribe(?: now)?|Pay now|Confirm(?: payment)?|订阅|立即订阅|订阅并支付|立即付款|立即支付|确认(?:付款|支付)?|確認)$/i;
    const proConfirmation = /^(?:Upgrade to Pro|升级至\s*Pro|升级到\s*Pro)$/i;
    const buttons = controls().filter(
      (node) =>
        !(node instanceof HTMLAnchorElement) &&
        (pattern.test((node.textContent ?? '').trim()) ||
          (plan.startsWith('pro-') && proConfirmation.test((node.textContent ?? '').trim())))
    );
    if (buttons.length !== 1) return { kind: 'ambiguous', count: buttons.length };
    buttons[0]!.click();
    return { kind: 'submitted' };
  }
  // Pro uses the same wording for entering checkout and submitting its payment.
  // Preparing or creating an order must never click a control on a checkout page.
  if (checkout && (action === 'prepare' || action === 'create'))
    return { kind: 'plan_unavailable', count: 0 };
  const pro = plan.startsWith('pro-');
  if (pro) {
    const names: Record<string, RegExp> = {
      'pro-5x': /Standard|标准|(?:^|\s)5\s*[x×倍](?:\s|$)/i,
      'pro-20x': /More usage|更多使用额度|更高使用额度|(?:^|\s)20\s*[x×倍](?:\s|$)/i,
      'pro-500': /Max usage|最高使用额度/i
    };
    const groups = [...document.querySelectorAll<HTMLElement>('[role="radiogroup"],[role="group"]')]
      .filter(rendered)
      .filter(
        (node) =>
          /Pro|套餐档位/i.test(
            node.getAttribute('aria-label') ??
              (node.getAttribute('aria-labelledby') ?? '')
                .split(/\s+/)
                .filter(Boolean)
                .map((id) => document.getElementById(id)?.textContent ?? '')
                .join(' ')
          ) || node.closest('[data-testid="pro-pricing-modal-column-top-half"]')
      );
    if (groups.length > 1) return { kind: 'ambiguous_tier' };
    const group = groups.length === 1 ? groups[0] : undefined;
    if (group) {
      if (!visible(group)) return { kind: 'tier_loading' };
      const allRadios = [
        ...group.querySelectorAll<HTMLElement>('[role="radio"],input[type="radio"]')
      ].filter(
        (node) =>
          node.getAttribute('aria-hidden') !== 'true' &&
          node.getClientRects().length > 0 &&
          getComputedStyle(node).visibility !== 'hidden'
      );
      const radios = allRadios.filter(visible);
      if (!radios.length || radios.length !== allRadios.length) return { kind: 'tier_loading' };
      const states = radios.map((node) => {
        const native = node instanceof HTMLInputElement ? node.checked : undefined;
        const aria = node.getAttribute('aria-checked');
        if (aria !== null && !['true', 'false'].includes(aria)) return undefined;
        if (native !== undefined && aria !== null && native !== (aria === 'true')) return undefined;
        return native ?? (aria === null ? undefined : aria === 'true');
      });
      if (states.some((state) => state === undefined) || states.filter(Boolean).length !== 1)
        return { kind: 'ambiguous_tier' };
      const matched = radios.filter((node) =>
        names[plan]!.test(
          node.getAttribute('aria-label') ??
            node.closest('label')?.textContent ??
            node.textContent ??
            ''
        )
      );
      if (matched.length !== 1) return { kind: 'ambiguous_tier' };
      const node = matched[0]!;
      const selected =
        node instanceof HTMLInputElement
          ? node.checked
          : node.getAttribute('aria-checked') === 'true';
      if (!selected) {
        if (action === 'verify_tier') return { kind: 'tier_unverified' };
        node.click();
        return { kind: 'tier_changed' };
      }
    } else if (['tier', 'verify_tier'].includes(action) && checkout)
      return { kind: 'tier_unverified' };
  }
  if (['tier', 'verify_tier'].includes(action)) return { kind: 'tier_ready' };
  const personal = [...document.querySelectorAll<HTMLElement>('[role="radio"],[role="tab"]')]
    .filter(rendered)
    .filter((node) =>
      /^(?:Personal|个人|切换以改为个人套餐)$/.test(
        node.getAttribute('aria-label') ?? node.textContent?.trim() ?? ''
      )
    );
  if (personal.length > 1) return { kind: 'plan_unavailable', count: 0 };
  if (personal.length === 1) {
    const node = personal[0]!;
    if (!visible(node)) return { kind: 'plan_unavailable', count: 0 };
    const states = [node.getAttribute('aria-selected'), node.getAttribute('aria-checked')].filter(
      (state) => state !== null
    );
    const native = node instanceof HTMLInputElement ? node.checked : undefined;
    if (
      states.some((state) => !['true', 'false'].includes(state)) ||
      new Set(states).size > 1 ||
      (native !== undefined && states.some((state) => (state === 'true') !== native))
    )
      return { kind: 'plan_unavailable', count: 0 };
    const selected = native ?? (states.length ? states[0] === 'true' : undefined);
    if (selected !== true) {
      if (action === 'prepare' && selected === false) {
        if (preparation?.personalRequested === true) return { kind: 'preparation_waiting' };
        node.click();
        return { kind: 'menu_opened', preparationAction: 'select_personal' };
      }
      return { kind: 'plan_unavailable', count: 0 };
    }
  }
  const pattern =
    plan === 'plus'
      ? /^(?:Get Plus|Upgrade to Plus|Get ChatGPT Plus|获取\s*Plus|升级至\s*Plus|升级到\s*Plus|订阅\s*Plus|获得\s*Plus)$/i
      : plan === 'go'
        ? /^(?:Get Go|Try Go|Upgrade to Go|Get ChatGPT Go|获取\s*Go|试用\s*Go|升级至\s*Go|升级到\s*Go|订阅\s*Go|获得\s*Go)$/i
        : /^(?:Upgrade to Pro|Get Pro|升级至\s*Pro|升级到\s*Pro|获取\s*Pro(?:\s*版本)?)$/i;
  const testId =
    plan === 'plus'
      ? 'select-plan-button-plus-upgrade'
      : pro
        ? 'select-plan-button-pro-upgrade'
        : undefined;
  const identified = testId
    ? [...document.querySelectorAll<HTMLElement>('button,a,[role="button"]')].filter(
        (node) => node.getAttribute('data-testid') === testId
      )
    : [];
  if (
    identified.length &&
    (identified.length !== 1 ||
      !visible(identified[0]!) ||
      !pattern.test((identified[0]!.textContent ?? '').trim()))
  )
    return { kind: 'plan_unavailable', count: identified.length };
  const candidates = identified.length
    ? identified
    : controls().filter((node) => pattern.test((node.textContent ?? '').trim()));
  if (candidates.length !== 1) {
    if (action === 'prepare') {
      const upgrade = controls().filter((node) =>
        /^(?:Upgrade|Upgrade plan|升级|升级套餐|升级订阅)$/.test((node.textContent ?? '').trim())
      );
      // The official home page exposes both a sidebar and a titlebar upgrade entry.
      // Only opening the menu may prefer the uniquely identified titlebar entry.
      const titlebar = upgrade.filter((node) =>
        node.closest('header[data-app-shell-titlebar="true"],header#page-header')
      );
      const menu = titlebar.length === 1 ? titlebar : upgrade;
      if (menu.length === 1) {
        if (preparation?.menuRequested === true) return { kind: 'preparation_waiting' };
        menu[0]!.click();
        return { kind: 'menu_opened', preparationAction: 'open_menu' };
      }
    }
    return { kind: 'plan_unavailable', count: candidates.length };
  }
  if (action === 'create') {
    candidates[0]!.click();
    return { kind: 'submitted' };
  }
  return { kind: 'plan_ready' };
}
export const directPaymentPageExpression = (
  plan: V2RechargePlan,
  action: Parameters<typeof inspectDirectPaymentPage>[1],
  expectedCheckout?: string,
  preparation?: Parameters<typeof inspectDirectPaymentPage>[3]
) =>
  `(${inspectDirectPaymentPage.toString()})(${JSON.stringify(plan)},${JSON.stringify(action)},${JSON.stringify(expectedCheckout)},${JSON.stringify(preparation)})`;

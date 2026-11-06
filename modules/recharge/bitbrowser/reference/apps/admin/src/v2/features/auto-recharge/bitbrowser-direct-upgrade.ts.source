import type { V2RechargeQuote } from '@apple-business/shared';
import type { V2RechargeBitBrowserLaunch, V2RechargeDetails, V2RechargePlan } from './contracts';
import type { DirectPaymentHooks } from './bitbrowser-direct-payment';
import {
  createDirectPaymentSession,
  waitDirectPayment,
  type VerifiedPaymentBrowser
} from './bitbrowser-payment-session';
import { fillDirectPaymentForm, verifyDirectPaymentForm } from './bitbrowser-payment-form';
import { DirectPaymentObserver } from './bitbrowser-payment-observer';
import { directPaymentPageExpression } from './bitbrowser-payment-page';
import {
  billingValues,
  directOfficialPlans,
  directPaymentMoney,
  officialPaymentRead,
  parseDirectVisibleQuote,
  paymentFingerprint,
  paymentObject,
  type PaymentDocument
} from './bitbrowser-payment-evidence';

export function verifyDirectUpgradePreview(
  data: unknown,
  plan: V2RechargePlan,
  text: string,
  currency: string
): V2RechargeQuote {
  const preview = paymentObject(data);
  const due = paymentObject(preview.amount_due);
  const values = [
    preview.positive_line_item_total,
    preview.negative_line_item_total,
    due.amount,
    due.amount_excluding_tax,
    due.tax_amount
  ];
  if (String(preview.currency).toUpperCase() !== currency || !values.every(Number.isSafeInteger))
    throw new Error('官网升级金额或币种尚未核实。');
  const [positive, negative, amount, excluding, tax] = values.map((v) => BigInt(Number(v)));
  if (
    positive! <= 0n ||
    negative! > 0n ||
    amount! <= 0n ||
    tax! < 0n ||
    positive! + negative! !== excluding ||
    excluding! + tax! !== amount ||
    (preview.applied_balance ?? 0) !== 0 ||
    (preview.discount_amount ?? 0) !== 0
  )
    throw new Error('官网升级折抵或税费尚未核实。');
  const lines = text
    .split('\n')
    .map((v) => v.trim())
    .filter(Boolean);
  const cadence = lines.filter((v) =>
    /\bBilled monthly\b|按月(?:收费|计费|付费)|每月(?:收费|计费)/i.test(v)
  );
  if (cadence.length !== 1 || /\bannual(?:ly)?\b|\byearly\b|按年|年付|年度|年缴/i.test(cadence[0]!))
    throw new Error('官网升级订阅周期尚未核实。');
  const renewals = lines.flatMap((line, index) =>
    /^(?:Billed monthly|按月(?:收费|计费|付费)|每月(?:收费|计费))$/i.test(line)
      ? [lines[index - 1] ?? '']
      : []
  );
  const renewal = directPaymentMoney(currency, Number(positive));
  const taxLine =
    tax === 0n &&
    !lines.some((line) =>
      /^(?:Tax|Taxes|Estimated tax|税费|税金|预估税费)(?:\s|:|：|$)/i.test(line)
    )
      ? `\nTax ${currency} 0`
      : '';
  const normalized =
    text + taxLine + (renewals.length === 1 ? `\nThen ${renewals[0]} / month` : '');
  const quote = parseDirectVisibleQuote(normalized, currency, plan);
  if (
    quote.today?.amount_minor !== Number(amount) ||
    quote.tax?.amount_minor !== Number(tax) ||
    quote.renewal?.amount_minor !== renewal.amount_minor
  )
    throw new Error('官网升级页面与接口金额不一致。');
  if (negative! < 0n) quote.credit = directPaymentMoney(currency, Number(-negative!));
  return quote;
}

export function matchingDirectUpgradeMethods(
  data: unknown,
  details: V2RechargeDetails,
  accountId: string
) {
  const response = paymentObject(data);
  if (
    (response.account_id !== undefined && response.account_id !== accountId) ||
    !Array.isArray(response.payment_methods)
  )
    throw new Error('官网付款方式归属尚未核实。');
  const methods = response.payment_methods.map(paymentObject);
  const ids = methods.map((method) => method.id);
  if (
    ids.some((id) => typeof id !== 'string' || !/^pm_[A-Za-z0-9]{1,180}$/.test(id)) ||
    new Set(ids).size !== ids.length
  )
    throw new Error('官网付款方式编号尚未核实。');
  const [month, year] = details.expiry.split('/').map(Number);
  const expectedBilling = JSON.stringify(billingValues(details, details.name));
  const matches = methods.filter((method) => {
    const card = paymentObject(method.card);
    const cardMatches =
      method.type === 'card' &&
      method.is_healthy !== false &&
      method.is_deleted !== true &&
      card.last4 === details.number.slice(-4) &&
      card.exp_month === month &&
      card.exp_year === 2000 + year!;
    if (!cardMatches) return false;
    try {
      const billing = paymentObject(method.billing_details);
      return JSON.stringify(billingValues(billing.address, billing.name)) === expectedBilling;
    } catch {
      return false;
    }
  });
  if (matches.length > 1) throw new Error('官网存在多张相同尾号和有效期的卡片，请先核实付款方式。');
  return { ids: ids as string[], selected: matches[0]?.id as string | undefined };
}

/** Only the visible official upgrade dialog and its explicitly named controls are used. */
function upgradePage(
  action: 'inspect' | 'change' | 'add' | 'continue' | 'select' | 'selected' | 'confirm',
  plan: V2RechargePlan,
  methodId?: string
) {
  if (location.origin !== 'https://chatgpt.com') return { kind: 'untrusted' };
  const visible = (el: Element) =>
    el.getClientRects().length > 0 && getComputedStyle(el).visibility !== 'hidden';
  const enabled = (el: Element) => visible(el) && !el.matches(':disabled,[aria-disabled="true"]');
  const scopes = [
    ...document.querySelectorAll<HTMLElement>(
      '[role="dialog"],[data-testid="modal-plan-upgrade"],[data-testid="plan-upgrade-modal"]'
    )
  ]
    .filter(visible)
    .filter((el) => /Billed monthly|按月(?:收费|计费|付费)|每月(?:收费|计费)/i.test(el.innerText));
  if (scopes.length !== 1) return { kind: 'waiting' };
  const scope = scopes[0]!;
  const text = scope.innerText;
  const family = plan === 'plus' ? /\bPlus\b/i : /\bPro\b/i;
  if (!family.test(text) || /\bannual(?:ly)?\b|\byearly\b|按年|年付|年度|年缴/i.test(text))
    return { kind: 'unverified' };
  const buttons = (root: Element, pattern: RegExp) =>
    [...root.querySelectorAll<HTMLElement>('button,[role="button"]')]
      .filter(enabled)
      .filter((el) => pattern.test((el.textContent ?? '').trim()));
  const radios = [
    ...scope.querySelectorAll<HTMLInputElement>(
      'input[type="radio"][name="plan-upgrade-payment-method"]'
    )
  ];
  if (['select', 'selected', 'confirm'].includes(action)) {
    if (!/^pm_[A-Za-z0-9]{1,180}$/.test(methodId ?? '')) return { kind: 'unverified' };
    const matching = radios.filter((el) => el.value === methodId);
    if (matching.length !== 1) return { kind: 'waiting' };
    if (action === 'select' && !matching[0]!.checked) {
      const label = matching[0]!.closest('label');
      if (label && enabled(label)) (label as HTMLElement).click();
      else if (enabled(matching[0]!)) matching[0]!.click();
      else return { kind: 'unverified' };
    }
    if (radios.filter((el) => el.checked).length !== 1 || !matching[0]!.checked)
      return { kind: 'unverified' };
    if (action !== 'confirm') return { kind: 'selected', text };
  }
  if (action === 'inspect') return { kind: 'ready', text };
  const patterns = {
    change: /^(?:Change payment method|更改付款方式|更換付款方式|修改付款方式)$/i,
    add: /^(?:Add new|Add new card|Add payment method|新增|新增银行卡|新增銀行卡|添加支付方式|添加付款方式)$/i,
    continue: /^(?:Continue|Add|继续|繼續|添加|新增)$/i,
    confirm: /^(?:Pay now|Confirm|立即付款|立即支付|确认|確認)$/i
  };
  let root: Element = scope;
  if (action === 'continue') {
    const modal = [...document.querySelectorAll('[data-testid="modal-add-payment-method"]')].filter(
      visible
    );
    if (modal.length !== 1) return { kind: 'waiting' };
    root = modal[0]!;
  }
  const controls = buttons(root, patterns[action as keyof typeof patterns]);
  if (controls.length !== 1) return { kind: 'waiting' };
  controls[0]!.click();
  return { kind: 'submitted', text };
}

export async function runDirectSubscriptionUpgrade(
  browser: VerifiedPaymentBrowser,
  launch: V2RechargeBitBrowserLaunch,
  plan: V2RechargePlan,
  details: V2RechargeDetails,
  hooks: DirectPaymentHooks
): Promise<PaymentDocument> {
  const source = browser.identity.plan;
  if (!((source === 'go' && plan === 'plus') || (source === 'plus' && plan.startsWith('pro-'))))
    throw new Error('官网当前订阅不能直接升级到所选套餐。');
  const { session, close, ownsSession } = await createDirectPaymentSession(browser);
  const observer = new DirectPaymentObserver(browser, {}, ownsSession);
  const deadline = Date.now() + 120000;
  let report: PaymentDocument = {
    operation: 'subscription_upgrade',
    upgrade_identifier: `upg_${crypto.randomUUID().replaceAll('-', '')}`,
    quote_authority: 'official_upgrade_preview',
    current_plan_before: source,
    current_plan: source,
    account_matched: true,
    target_plan: plan,
    browser_profile_id: browser.profileId,
    payment_attempted: false,
    payment_status: 'not_attempted',
    payment_requests_sent: 0,
    confirmation_requests_sent: 0
  };
  observer.onBinding = async (binding) => {
    const bound = {
      ...report,
      ...binding,
      payment_attempted: true,
      payment_status: 'unknown',
      payment_requests_sent: 1,
      confirmation_requests_sent: 1
    };
    await hooks.progress('payment_submitted_or_pending', bound);
    report = bound;
  };
  observer.onUnexpected = async (facts) => {
    await hooks.unexpected({ ...report, ...facts });
  };
  const remaining = () => {
    session.signal.throwIfAborted();
    if (Date.now() >= deadline) throw new Error('官网升级核价已超时。');
  };
  const evaluate = (action: Parameters<typeof upgradePage>[0], methodId?: string) =>
    session.evaluate<{ kind: string; text?: string }>(
      `(${upgradePage.toString()})(${JSON.stringify(action)},${JSON.stringify(plan)},${JSON.stringify(methodId)})`
    );
  const read = async (path: string) => {
    session.signal.throwIfAborted();
    const response = await session.evaluate<{ ok: boolean; status: number; data?: unknown }>(
      officialPaymentRead(browser.identity, path),
      16000
    );
    if (!response.ok) throw new Error('官网升级资料读取未完成，请保留原任务核实。');
    return paymentObject(response.data);
  };
  const subscriptionPath = `/backend-api/subscriptions?account_id=${encodeURIComponent(browser.identity.accountId)}`;
  const methodsPath = `/backend-api/payments/payment_methods?account_id=${encodeURIComponent(browser.identity.accountId)}`;
  const previewPath = `/backend-api/subscriptions/update/preview?account_id=${encodeURIComponent(browser.identity.accountId)}&updated_plan=${encodeURIComponent(directOfficialPlans[plan])}`;
  const verifySource = async () => {
    const value = await read(subscriptionPath);
    if (
      (value.account_id !== undefined && value.account_id !== browser.identity.accountId) ||
      value.plan_type !== source ||
      value.is_processor_stripe !== true ||
      value.is_delinquent === true ||
      value.will_renew !== true ||
      value.scheduled_billing_period != null
    )
      throw new Error('官网当前订阅、购买渠道或续费状态不支持直接升级。');
  };
  try {
    await browser.cdp.command('Network.enable', {}, browser.sessionId);
    await verifySource();
    await hooks.progress('plan_selection', report);
    let ready = false;
    while (Date.now() < deadline) {
      remaining();
      const state = await session.evaluate<{ kind: string }>(
        directPaymentPageExpression(plan, 'prepare')
      );
      if (state.kind === 'plan_ready') {
        ready = true;
        break;
      }
      if (['untrusted', 'official_error', 'ambiguous_tier'].includes(state.kind))
        throw new Error('官网升级套餐入口未核实。');
      await waitDirectPayment(session.signal);
    }
    if (
      !ready ||
      (await session.evaluate<{ kind: string }>(directPaymentPageExpression(plan, 'create')))
        .kind !== 'submitted'
    )
      throw new Error('官网未提供唯一可用的升级入口。');
    while ((await evaluate('inspect')).kind !== 'ready') {
      remaining();
      await waitDirectPayment(session.signal);
    }
    const before = matchingDirectUpgradeMethods(
      await read(methodsPath),
      details,
      browser.identity.accountId
    );
    let methodId = before.selected;
    if (!methodId || (await evaluate('select', methodId)).kind !== 'selected') {
      if ((await evaluate('change')).kind !== 'submitted')
        throw new Error('官网付款方式入口未核实。');
      if (methodId) {
        if ((await evaluate('select', methodId)).kind !== 'selected')
          throw new Error('官网目标付款方式未选中。');
      } else {
        if ((await evaluate('add')).kind !== 'submitted')
          throw new Error('官网新增卡片入口未核实。');
        await fillDirectPaymentForm(session, details, deadline);
        await verifyDirectPaymentForm(session, details, deadline);
        if ((await evaluate('continue')).kind !== 'submitted')
          throw new Error('官网新增卡片表单未核实。');
        while (!methodId) {
          remaining();
          const after = matchingDirectUpgradeMethods(
            await read(methodsPath),
            details,
            browser.identity.accountId
          );
          if (after.selected && !before.ids.includes(after.selected)) methodId = after.selected;
          else await waitDirectPayment(session.signal, 500);
        }
        if ((await evaluate('select', methodId)).kind !== 'selected')
          throw new Error('官网新增卡片尚未选中。');
      }
    }
    const quote = async () => {
      const state = await evaluate('selected', methodId);
      if (state.kind !== 'selected') throw new Error('官网当前选择的付款方式已变化。');
      const current = matchingDirectUpgradeMethods(
        await read(methodsPath),
        details,
        browser.identity.accountId
      );
      if (current.selected !== methodId) throw new Error('官网付款方式绑定已变化。');
      return verifyDirectUpgradePreview(
        await read(previewPath),
        plan,
        state.text ?? '',
        launch.safety.lockedCurrency
      );
    };
    const finalQuote = await quote();
    observer.bindUpgrade(
      { plan: directOfficialPlans[plan], methodId },
      finalQuote.today!.amount_minor,
      finalQuote.today!.currency
    );
    report = {
      ...report,
      quote: finalQuote,
      final_quote_verified: true,
      stage: 'payment_confirmation',
      billing_fingerprint: await paymentFingerprint({
        ...billingValues(details, details.name),
        payment_method_id: methodId,
        last4: details.number.slice(-4),
        expiry: details.expiry
      })
    };
    const snapshot = JSON.stringify(finalQuote);
    const preflight = async () => {
      await verifySource();
      if (observer.failure || JSON.stringify(await quote()) !== snapshot)
        throw new Error('官网升级报价或付款状态已变化，本次确认失效。');
    };
    await hooks.confirm(report, preflight);
    await preflight();
    session.signal.throwIfAborted();
    observer.arm();
    if ((await evaluate('confirm', methodId)).kind !== 'submitted')
      throw new Error('升级付款授权已保留，提交结果待核实；不会重复点击。');
    await hooks.progress('payment_submitted_or_pending', {
      ...report,
      payment_attempted: true,
      payment_status: 'unknown'
    });
    const resultDeadline = Date.now() + 120000;
    let current = source;
    while (Date.now() < resultDeadline) {
      session.signal.throwIfAborted();
      await observer.settle();
      if (observer.failure || observer.paymentStatus === 'declined') break;
      if (observer.paymentStatus === 'requires_action')
        await hooks.progress('payment_human_verification', {
          ...report,
          payment_attempted: true,
          payment_status: 'requires_action',
          user_action_required: true
        });
      if (observer.evidence) {
        const subscription = await read(subscriptionPath);
        current = String(subscription.plan_type ?? 'unknown');
        if (
          current ===
          (plan === 'plus'
            ? 'plus'
            : plan === 'pro-5x'
              ? 'prolite'
              : plan === 'pro-500'
                ? 'promax'
                : 'pro')
        )
          break;
      }
      await waitDirectPayment(session.signal, 1000);
    }
    const evidence = !observer.failure ? observer.evidence : undefined;
    const paymentStatus =
      observer.paymentStatus === 'paid' && !evidence ? 'unknown' : observer.paymentStatus;
    const active =
      Boolean(evidence) &&
      current ===
        (plan === 'plus'
          ? 'plus'
          : plan === 'pro-5x'
            ? 'prolite'
            : plan === 'pro-500'
              ? 'promax'
              : 'pro');
    return {
      ...report,
      status: active
        ? 'subscription_activated'
        : evidence
          ? 'paid_pending_activation'
          : paymentStatus === 'declined'
            ? 'payment_failed'
            : 'payment_result_unknown',
      stage: 'payment_result',
      payment_attempted: true,
      payment_status: evidence ? 'paid' : paymentStatus,
      payment_requests_sent: observer.confirmationRequests,
      confirmation_requests_sent: observer.confirmationRequests,
      current_plan: current === 'prolite' ? 'pro' : current,
      ...(current === 'prolite'
        ? { current_tier: 5 }
        : current === 'pro'
          ? { current_tier: 20 }
          : {}),
      ...(observer.linkedIntent
        ? { upgrade_payment_intent_identifier: observer.linkedIntent }
        : {}),
      ...(observer.invoiceId ? { upgrade_invoice_identifier: observer.invoiceId } : {}),
      ...(evidence ? { payment_evidence: evidence } : {}),
      subscription_status: active ? plan : 'not_verified',
      payment_outcome: active
        ? 'subscription_activated'
        : evidence
          ? 'paid_pending_activation'
          : 'payment_unknown',
      repeated_payment: 'blocked'
    };
  } catch (error) {
    await observer.settle();
    const attempted = hooks.attempted() || observer.confirmationRequests > 0;
    await hooks
      .progress(attempted ? 'payment_result_unknown' : 'upgrade_quote_ready', {
        ...report,
        payment_attempted: attempted,
        payment_status: attempted ? 'unknown' : 'not_attempted',
        payment_requests_sent: observer.confirmationRequests,
        confirmation_requests_sent: observer.confirmationRequests
      })
      .catch(() => undefined);
    throw error;
  } finally {
    observer.close();
    close();
  }
}

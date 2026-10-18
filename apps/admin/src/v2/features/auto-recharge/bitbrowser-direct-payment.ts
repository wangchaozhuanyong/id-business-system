import type { V2RechargeBrowserRestore, V2RechargeQuote } from '@apple-business/shared';
import type { V2RechargeBitBrowserLaunch, V2RechargeDetails, V2RechargePlan } from './contracts';
import {
  createDirectPaymentSession,
  waitDirectPayment,
  type VerifiedPaymentBrowser
} from './bitbrowser-payment-session';
import { fillDirectPaymentForm, verifyDirectPaymentForm } from './bitbrowser-payment-form';
import { DirectPaymentObserver } from './bitbrowser-payment-observer';
import { runDirectSubscriptionUpgrade } from './bitbrowser-direct-upgrade';
import { prepareDirectNextCycle } from './bitbrowser-direct-cycle';
import {
  DirectPaymentDiagnosticError,
  directPaymentFailure,
  directPaymentOperation,
  directOfficialReadReason,
  type DirectPaymentOperation
} from './bitbrowser-payment-diagnostics';
import { directPaymentPageExpression } from './bitbrowser-payment-page';
import { directCheckoutPlanMatches, verifyDirectCheckoutQuote } from './bitbrowser-stripe-quote';
import {
  directOfficialPlans,
  directPlanMatches,
  officialPaymentRead,
  paymentObject,
  paymentHash,
  type PaymentDocument
} from './bitbrowser-payment-evidence';
export interface DirectPaymentHooks {
  restored?: V2RechargeBrowserRestore;
  callback: (input: object) => Promise<PaymentDocument>;
  progress: (stage: string, result?: PaymentDocument) => Promise<void>;
  confirm: (report: PaymentDocument, preflight: () => Promise<void>) => Promise<void>;
  attempted: () => boolean;
  unexpected: (result: PaymentDocument) => Promise<void>;
}
type PageState = {
  kind: string;
  text?: string;
  url?: string;
  checkoutId?: string;
  entity?: string;
};
export { directPlanMatches } from './bitbrowser-payment-evidence';
export async function runDirectPayment(
  browser: VerifiedPaymentBrowser,
  launch: V2RechargeBitBrowserLaunch,
  plan: V2RechargePlan,
  details: V2RechargeDetails,
  hooks: DirectPaymentHooks
) {
  let operation: DirectPaymentOperation = 'control';
  const step = <T>(next: DirectPaymentOperation, work: () => Promise<T>) => {
    operation = next;
    return directPaymentOperation(next, work);
  };
  const { session, close, ownsSession } = await step('control', () =>
    createDirectPaymentSession(browser)
  );
  // Account keys use the same raw-ID SHA-256 as the existing server ledger.
  const key = await paymentHash(browser.identity.accountId);
  const currentFile = `${key}${plan === 'plus' ? '' : `-${plan}`}.json`;
  const rows = (hooks.restored?.records ?? []).map(paymentObject);
  const row = rows.find((item) => item.fileKey === currentFile);
  let revision = Number(row?.revision ?? 0);
  let document = paymentObject(row?.document);
  const observer = new DirectPaymentObserver(browser, {}, ownsSession);
  const base = {
    account_matched: true,
    session_status: 'restored',
    browser_profile_id: browser.profileId,
    current_plan: browser.identity.plan,
    current_plan_before: browser.identity.plan,
    target_plan: plan,
    transport: 'web_direct',
    payment_attempted: false,
    payment_requests_sent: 0,
    confirmation_requests_sent: 0
  };
  let checkoutId = String(document.checkout_identifier ?? '');
  let entity = String(document.processor_entity ?? '');
  let report: PaymentDocument = { ...base };
  observer.onUnexpected = async (facts) => {
    report = { ...report, ...facts, payment_attempted: true, payment_status: 'unknown' };
    await hooks.unexpected({
      ...report,
      target_plan: plan,
      current_plan_before: browser.identity.plan,
      account_matched: true,
      ...(entity ? { processor_entity: entity } : {}),
      ...facts
    });
  };
  let replacement: { proof: PaymentDocument; retryOf: string } | undefined;
  let finalQuote: V2RechargeQuote | undefined;
  let deadline = Date.now() + 120_000;
  let cycleMarker: PaymentDocument | undefined;
  const remaining = () => {
    session.signal.throwIfAborted();
    if (hooks.restored?.unidentifiedCheckoutRecovery && observer.checkoutRequests)
      throw new Error('官网建单结果未明确，本次不会重复创建。');
    if (observer.failure || observer.confirmationRequests)
      throw new Error('原窗口已观察到付款操作，请只读核实原单。');
    if (Date.now() >= deadline) throw new Error('本轮官网核价已超时，请检查原窗口。');
  };
  const page = () => session.evaluate<PageState>(directPaymentPageExpression(plan, 'inspect'));
  const read = async (path: string) => {
    session.signal.throwIfAborted();
    const response = await session.evaluate<{
      ok: boolean;
      status: number;
      data?: unknown;
      reason?: string;
    }>(officialPaymentRead(browser.identity, path), 16000);
    if (!response.ok)
      throw new DirectPaymentDiagnosticError(operation, directOfficialReadReason(response.reason), {
        http_status: response.status
      });
    return paymentObject(response.data);
  };
  const ledger = async (next: PaymentDocument) => {
    const saved = await hooks.callback({
      type: 'ledger',
      accountKey: key,
      fileKey: currentFile,
      revision,
      document: next
    });
    if (!Number.isSafeInteger(saved.revision) || Number(saved.revision) <= revision)
      throw new Error('官网操作标记未持久化，本次已停止。');
    revision = Number(saved.revision);
    document = next;
  };
  const identity = () =>
    step('identity', async () => {
      const data = await read('/backend-api/accounts/check/v4-2023-04-27');
      const node = paymentObject(paymentObject(data.accounts)[browser.identity.accountId]);
      const account = paymentObject(node.account);
      if (account.account_id !== undefined && account.account_id !== browser.identity.accountId)
        throw new Error('官网账号已变化，本次已停止。');
      const raw = String(account.plan_type ?? node.plan_type ?? '');
      if (raw === 'free' && paymentObject(node.entitlement).has_active_subscription === true)
        throw new Error('官网订阅显示免费但仍有有效订阅，本次不会创建订单。');
      const tier = raw === 'prolite' ? 5 : raw === 'pro' ? 20 : undefined;
      return { current: raw === 'prolite' ? 'pro' : raw, tier };
    });
  try {
    await browser.cdp.command('Network.enable', {}, browser.sessionId);
    const fresh = await identity();
    remaining();
    if (directPlanMatches(plan, fresh.current, fresh.tier))
      return {
        ...base,
        status: 'already_subscribed',
        stage: 'subscription_check',
        current_plan: fresh.current,
        payment_status: 'not_attempted'
      };
    operation = 'existing_checkout_binding';
    if (
      rows.some((item) => {
        const value = paymentObject(item.document);
        const payment =
          !String(item.fileKey).startsWith('history/') &&
          (value.payment_attempted === true ||
            Number(value.confirmation_requests_sent) > 0 ||
            Number(value.payment_requests_sent) > 0 ||
            value.operation === 'subscription_upgrade' ||
            Boolean(value.upgrade_identifier));
        const completed =
          value.payment_status === 'paid' &&
          value.status === 'subscription_activated' &&
          Boolean(value.payment_evidence);
        return payment && !completed;
      })
    )
      throw new Error('该账号历史付款或升级结果仍待核实，本次仅允许复查原单。');
    if (hooks.restored?.unidentifiedCheckoutRecovery && fresh.current !== 'free')
      throw new Error('历史原单账号或套餐绑定未核实。');
    if (fresh.current !== 'free') {
      observer.close();
      close();
      return await step('upgrade', () =>
        runDirectSubscriptionUpgrade(browser, launch, plan, details, hooks)
      );
    }
    const cycle = await step('cycle_prepare', () =>
      prepareDirectNextCycle(browser, launch, plan, hooks.restored, key, hooks)
    );
    if (cycle) {
      revision = cycle.revision;
      cycleMarker = cycle.marker;
      checkoutId = '';
      entity = '';
      document = {};
      deadline = Date.now() + 120_000;
    }
    operation = 'existing_checkout_binding';
    if (
      !cycle &&
      hooks.restored?.originalCheckoutIdentifier &&
      hooks.restored.originalCheckoutIdentifier !== checkoutId
    )
      throw new Error('历史原单记录缺失或绑定不一致，本次不会创建新单。');
    // A historical payment is never treated as an expired checkout, even if its UI disappeared.
    if (
      rows.some((item) => {
        const value = paymentObject(item.document);
        return (
          String(item.fileKey).startsWith('payments/') &&
          value.payment_attempted === true &&
          value.payment_status !== 'paid'
        );
      })
    )
      throw new Error('该账号历史付款结果仍待核实，本次仅允许复查原单。');
    if (hooks.restored?.unidentifiedCheckoutRecovery === true) {
      const owned = hooks.restored.ownedProfile;
      if (
        checkoutId ||
        !row ||
        !Number.isSafeInteger(revision) ||
        !Object.keys(document).length ||
        !owned ||
        owned.profileId !== browser.profileId ||
        owned.accountKey !== key
      )
        throw new Error('历史原单编号未核实。');
      const candidate = await page();
      if (
        candidate.kind !== 'page' ||
        !candidate.checkoutId ||
        !candidate.entity ||
        !/^(?:oaics|cs)_[A-Za-z0-9_]{1,200}$/.test(candidate.checkoutId) ||
        !/^[a-z][a-z0-9_]{0,40}$/.test(candidate.entity)
      )
        throw new Error('历史原单编号未核实。');
      const recovered = paymentObject(
        await step('existing_checkout_read', () =>
          read(`/backend-api/payments/checkout/${candidate.entity}/${candidate.checkoutId}`)
        )
      );
      const old = paymentObject(recovered.checkout_session ?? recovered);
      remaining();
      if (
        observer.checkoutRequests !== 0 ||
        old.checkout_session_id !== candidate.checkoutId ||
        old.processor_entity !== candidate.entity ||
        !directCheckoutPlanMatches(plan, old.plan_name, candidate.checkoutId) ||
        old.status !== 'open' ||
        old.payment_status !== 'unpaid'
      )
        throw new Error('历史原单账号或套餐绑定未核实。');
      checkoutId = candidate.checkoutId;
      entity = candidate.entity;
      await ledger({
        ...document,
        status: 'checkout_created',
        checkout_outcome: 'created',
        checkout_identifier: checkoutId,
        processor_entity: entity,
        checkout_recovered_from_original: true,
        payment_attempted: false,
        payment_requests_sent: 0,
        confirmation_requests_sent: 0
      });
      report = { ...report, checkout_recovered_from_original: true };
    }
    if (checkoutId) {
      if (
        !/^(?:oaics|cs)_[A-Za-z0-9_]{1,200}$/.test(checkoutId) ||
        !/^[a-z][a-z0-9_]{0,40}$/.test(entity)
      )
        throw new Error('历史原单编号未核实。');
      report = {
        ...report,
        current_plan: fresh.current,
        checkout_identifier: checkoutId,
        processor_entity: entity
      };
      await hooks.progress('existing_checkout_read', report);
      const original = await step('existing_checkout_read', () =>
        read(`/backend-api/payments/checkout/${entity}/${checkoutId}`)
      );
      operation = 'existing_checkout_binding';
      const old = paymentObject(original.checkout_session ?? original);
      if (
        old.checkout_session_id !== checkoutId ||
        old.processor_entity !== entity ||
        !directCheckoutPlanMatches(plan, old.plan_name, checkoutId)
      )
        throw new Error('历史原单账号或套餐绑定未核实。');
      if (old.status === 'expired' && old.payment_status === 'unpaid') {
        if (hooks.restored?.unidentifiedCheckoutRecovery)
          throw new Error('原单存在付款或未明确状态，本次仅允许复查。');
        const proof = {
          checkout_identifier: checkoutId,
          processor_entity: entity,
          target_plan: plan,
          account_key: key,
          status: 'expired',
          payment_status: 'unpaid'
        };
        const grant = await step('expired_authorization', () =>
          hooks.callback({
            type: 'replace_expired_checkout',
            accountKey: key,
            checkoutIdentifier: checkoutId,
            proof
          })
        );
        if (
          grant.replacementAuthorized !== true ||
          grant.checkoutIdentifier !== checkoutId ||
          typeof grant.retryOf !== 'string' ||
          !/^[a-f0-9]{64}$/.test(grant.retryOf) ||
          !Number.isSafeInteger(grant.checkoutRecordRevision) ||
          Number(grant.checkoutRecordRevision) < revision
        )
          throw new Error('过期原单的新建资格未核实。');
        replacement = { proof, retryOf: grant.retryOf };
        revision = Number(grant.checkoutRecordRevision ?? revision);
        checkoutId = '';
        entity = '';
      } else if (old.status !== 'open' || old.payment_status !== 'unpaid')
        throw new Error('原单存在付款或未明确状态，本次仅允许复查。');
    } else if (Object.keys(document).length)
      throw new Error('存在未核实的建单记录，本次不会重复创建订单。');
    if (!checkoutId) {
      operation = 'plan_selection';
      await hooks.progress('plan_selection');
      let prepared = false;
      while (Date.now() < deadline) {
        remaining();
        const state = await session.evaluate<PageState>(
          directPaymentPageExpression(plan, 'prepare')
        );
        if (state.kind === 'plan_ready') {
          prepared = true;
          break;
        }
        if (['untrusted', 'official_error', 'ambiguous_tier'].includes(state.kind))
          throw new Error('官网套餐选择未核实。');
        await waitDirectPayment(session.signal);
      }
      if (!prepared) throw new Error('官网未提供可核实的目标套餐入口。');
      operation = 'checkout_create';
      await ledger({
        schema_version: 2,
        run_id: crypto.randomUUID().replaceAll('-', ''),
        created_at: Math.floor(Date.now() / 1000),
        status: 'checkout_attempted',
        stage: 'checkout_create',
        plan: directOfficialPlans[plan],
        target_plan: plan,
        account_matched: true,
        current_plan_before: 'free',
        checkout_outcome: 'unknown',
        payment_status: 'not_attempted',
        transport: 'official_browser',
        ...(replacement
          ? { retry_of: replacement.retryOf, expired_checkout_replacement: replacement.proof }
          : {}),
        ...(cycleMarker ? { next_cycle_grant: cycleMarker } : {})
      });
      await hooks.progress('checkout_create');
      remaining();
      const clicked = await session.evaluate<PageState>(
        directPaymentPageExpression(plan, 'create')
      );
      if (clicked.kind !== 'submitted') throw new Error('官网建单控件未核实，本次不会重复点击。');
      const waitUntil = Math.min(deadline, Date.now() + 45000);
      while (Date.now() < waitUntil && !observer.checkout) {
        remaining();
        if (observer.checkoutFailure) {
          // The HTTP failure is published immediately; finish its bounded passive read before reporting.
          await observer.settle();
          remaining();
          let formLoadFailed = false;
          for (let reads = 0; reads < 6 && !formLoadFailed; reads++) {
            if (reads) await waitDirectPayment(session.signal);
            remaining();
            try {
              formLoadFailed = (await page()).kind === 'payment_form_load_failed';
            } catch {
              // A failed inspection must not replace the observed request failure.
              break;
            }
          }
          throw new DirectPaymentDiagnosticError(
            'checkout_create',
            formLoadFailed ? 'official_payment_form_load_failed' : observer.checkoutFailure.reason,
            {
              ...observer.checkoutFailure,
              ...(formLoadFailed ? { page_state: 'official_error' as const } : {})
            }
          );
        }
        if ((await page()).kind === 'payment_form_load_failed') {
          // Network events may arrive during page inspection; retain that refusal as well.
          await observer.settle();
          const refusal = observer.checkoutFailure as DirectPaymentObserver['checkoutFailure'];
          throw new DirectPaymentDiagnosticError(
            'checkout_create',
            'official_payment_form_load_failed',
            { ...refusal, page_state: 'official_error' }
          );
        }
        await waitDirectPayment(session.signal);
      }
      await observer.settle();
      if (!observer.checkout || observer.checkoutRequests !== 1)
        throw new Error('官网建单结果未明确，本次不会重复创建。');
      const value = observer.checkout;
      checkoutId = String(value.checkout_session_id ?? value.session_id);
      entity = String(value.processor_entity ?? '');
      if (!/^[a-z][a-z0-9_]{0,40}$/.test(entity)) throw new Error('官网结账来源未核实。');
      await ledger({
        ...document,
        status: 'checkout_created',
        checkout_outcome: 'created',
        checkout_identifier: checkoutId,
        processor_entity: entity,
        payment_attempted: false,
        payment_requests_sent: 0,
        confirmation_requests_sent: 0
      });
    }
    operation = 'existing_checkout_binding';
    remaining();
    report = {
      ...report,
      checkout_identifier: checkoutId,
      processor_entity: entity,
      checkout_status: 'created',
      checkout_requests_sent: observer.checkoutRequests,
      payment_status: 'not_attempted'
    };
    const location = await page();
    if (location.checkoutId !== checkoutId || location.entity !== entity) {
      await browser.cdp.command(
        'Page.navigate',
        { url: `https://chatgpt.com/checkout/${entity}/${checkoutId}` },
        browser.sessionId
      );
    }
    if (plan.startsWith('pro-')) {
      operation = 'plan_selection';
      let tierReady = false;
      while (Date.now() < deadline) {
        remaining();
        const state = await session.evaluate<PageState>(
          directPaymentPageExpression(plan, 'tier', checkoutId)
        );
        if (state.kind === 'tier_ready') {
          tierReady = true;
          break;
        }
        if (state.kind === 'official_error' || state.kind === 'ambiguous_tier')
          throw new Error('官网套餐档位未核实。');
        await waitDirectPayment(session.signal);
      }
      if (!tierReady) throw new Error('官网套餐档位未核实。');
    }
    operation = 'payment_form';
    await hooks.progress('payment_preparation', report);
    const billingSnapshot = await step('payment_form', () =>
      fillDirectPaymentForm(session, details, deadline)
    );
    const quote = async () => {
      operation = 'quote_read';
      const currentPage = await page();
      if (
        currentPage.checkoutId !== checkoutId ||
        currentPage.entity !== entity ||
        currentPage.kind === 'official_error'
      )
        throw new DirectPaymentDiagnosticError('quote_read', 'existing_checkout_unavailable', {
          ...(currentPage.kind === 'official_error' ? { page_state: 'official_error' } : {})
        });
      const raw = await step('quote_read', () =>
        read(`/backend-api/payments/checkout/${entity}/${checkoutId}`)
      );
      const tierVerified =
        !plan.startsWith('pro-') ||
        (
          await session.evaluate<PageState>(
            directPaymentPageExpression(plan, 'verify_tier', checkoutId)
          )
        ).kind === 'tier_ready';
      const currentBilling = await step('payment_form', () =>
        verifyDirectPaymentForm(session, details, deadline)
      );
      if (currentBilling.state !== billingSnapshot.state) throw new Error('billing_fields_changed');
      await observer.settle();
      return step('quote_validation', () =>
        verifyDirectCheckoutQuote(
          raw,
          checkoutId,
          entity,
          plan,
          { ...details, state: billingSnapshot.state },
          currentPage.text ?? '',
          launch.safety.lockedCurrency,
          observer.stripeQuotes.get(checkoutId),
          tierVerified,
          true
        )
      );
    };
    let verified: Awaited<ReturnType<typeof quote>> | undefined;
    let last: unknown;
    for (let attempt = 0; attempt < 3; attempt++) {
      remaining();
      try {
        verified = await quote();
        break;
      } catch (error) {
        last = error;
        await waitDirectPayment(session.signal, 500);
      }
    }
    if (!verified) throw last;
    finalQuote = verified.quote;
    report = {
      ...report,
      quote: verified.quote,
      billing_fingerprint: verified.billing_fingerprint,
      quote_authority: 'official_checkout_response',
      final_quote_verified: true,
      quote_stage: 'final',
      stage: 'payment_confirmation'
    };
    observer.bind(checkoutId, verified.quote.today!.amount_minor, verified.quote.today!.currency);
    observer.onBinding = async (binding) => {
      report = { ...report, ...binding };
      await hooks.progress('payment_submitted_or_pending', {
        ...report,
        payment_attempted: true,
        payment_requests_sent: 1,
        confirmation_requests_sent: 1
      });
    };
    const original = JSON.stringify(verified);
    const preflight = () =>
      step('confirmation', async () => {
        session.signal.throwIfAborted();
        if (observer.failure || observer.confirmationRequests)
          throw new Error('原窗口已发生付款操作，需核实原单；本次不会重复提交。');
        const freshIdentity = await identity();
        if (freshIdentity.current !== 'free') throw new Error('官网订阅状态已变化，本次确认失效。');
        const currentBilling = await step('payment_form', () =>
          verifyDirectPaymentForm(session, details, Date.now() + 15000)
        );
        if (currentBilling.state !== billingSnapshot.state)
          throw new Error('billing_fields_changed');
        if (JSON.stringify(await quote()) !== original)
          throw new Error('账单资料或官网报价已变化，请重新核价。');
      });
    operation = 'confirmation';
    await hooks.confirm(report, preflight);
    session.signal.throwIfAborted();
    await preflight();
    operation = 'confirmation';
    observer.arm();
    const submitted = await session.evaluate<PageState>(
      directPaymentPageExpression(plan, 'confirm', checkoutId)
    );
    if (submitted.kind !== 'submitted')
      throw new Error('付款确认已保留，官网提交结果待核实；本次不会重复点击。');
    await hooks.progress('payment_submitted_or_pending', {
      ...report,
      payment_attempted: true,
      payment_status: 'unknown'
    });
    operation = 'payment_result';
    const resultDeadline = Date.now() + 120000;
    let seenPlan = 'free';
    let seenTier: number | undefined;
    let officialPageFailure = false;
    while (Date.now() < resultDeadline) {
      session.signal.throwIfAborted();
      const currentPage = await page();
      if (
        currentPage.checkoutId === checkoutId &&
        currentPage.entity === entity &&
        currentPage.kind === 'payment_method_verification_failed'
      ) {
        officialPageFailure = true;
        break;
      }
      if (observer.failure) break;
      await observer.settle();
      if (observer.paymentStatus === 'declined') break;
      if (observer.paymentStatus === 'requires_action')
        await hooks.progress('payment_human_verification', {
          ...report,
          payment_attempted: true,
          payment_status: 'requires_action',
          user_action_required: true
        });
      if (observer.evidence) {
        const freshIdentity = await identity();
        seenPlan = freshIdentity.current;
        seenTier = freshIdentity.tier;
        if (directPlanMatches(plan, seenPlan, seenTier)) break;
      }
      await waitDirectPayment(session.signal, 1000);
    }
    const activated = Boolean(
      observer.evidence &&
      !observer.failure &&
      !officialPageFailure &&
      observer.confirmationRequests === 1 &&
      directPlanMatches(plan, seenPlan, seenTier)
    );
    const pendingReason = officialPageFailure
      ? 'official_payment_method_verification_failed'
      : observer.failure
        ? directPaymentFailure(new Error(observer.failure), 'payment_result').facts.reason
        : observer.paymentStatus === 'requires_action'
          ? 'direct_payment_bank_verification_required'
          : 'payment_result_unknown';
    return {
      ...report,
      status: activated
        ? 'subscription_activated'
        : observer.evidence
          ? 'paid_pending_activation'
          : observer.paymentStatus === 'declined'
            ? 'payment_failed'
            : 'payment_result_unknown',
      stage:
        observer.paymentStatus === 'requires_action'
          ? 'payment_human_verification'
          : 'payment_result',
      ...(!activated && !observer.evidence ? { reason: pendingReason } : {}),
      ...(officialPageFailure && observer.failure
        ? {
            last_reason: directPaymentFailure(new Error(observer.failure), 'payment_result').facts
              .reason
          }
        : {}),
      ...(observer.paymentStatus === 'requires_action' ? { user_action_required: true } : {}),
      payment_attempted: true,
      payment_status: observer.evidence ? 'paid' : observer.paymentStatus,
      payment_requests_sent: observer.confirmationRequests,
      confirmation_requests_sent: observer.confirmationRequests,
      ...(observer.evidence ? { payment_evidence: observer.evidence } : {}),
      current_plan: seenPlan,
      ...(observer.linkedIntent ? { payment_intent_identifier: observer.linkedIntent } : {}),
      ...(seenTier ? { current_tier: seenTier } : {}),
      subscription_status: activated ? plan : 'not_verified',
      payment_outcome: activated
        ? 'subscription_activated'
        : observer.evidence
          ? 'paid_pending_activation'
          : 'payment_unknown',
      repeated_payment: 'blocked'
    };
  } catch (error) {
    const failure = directPaymentFailure(error, operation);
    try {
      await observer.settle();
    } catch {
      /* Preserve the original controlled failure. */
    }
    const attempted = hooks.attempted() || observer.confirmationRequests > 0;
    await hooks
      .progress(attempted ? 'payment_result_unknown' : failure.facts.stage, {
        ...report,
        ...failure.facts,
        ...(finalQuote ? { quote: finalQuote } : {}),
        checkout_requests_sent: observer.checkoutRequests,
        payment_attempted: attempted,
        payment_status: attempted ? 'unknown' : 'not_attempted',
        payment_requests_sent: observer.confirmationRequests,
        confirmation_requests_sent: observer.confirmationRequests
      })
      .catch(() => undefined);
    throw failure;
  } finally {
    observer.close();
    close();
  }
}

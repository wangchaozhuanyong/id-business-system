import type {
  V2RechargeBrowserRestore,
  V2RechargeNextCycleContext,
  V2RechargePlan,
  V2RechargeSubscriptionPeriod
} from '@apple-business/shared';
import type { V2RechargeBitBrowserLaunch } from './contracts';
import type { DirectPaymentHooks } from './bitbrowser-direct-payment';
import {
  officialPaymentRead,
  paymentObject,
  type PaymentDocument
} from './bitbrowser-payment-evidence';
import {
  createDirectPaymentSession,
  waitDirectPayment,
  type VerifiedPaymentBrowser
} from './bitbrowser-payment-session';

export function boundDirectCyclePeriod(
  value: unknown,
  key: string,
  plan: V2RechargePlan
): V2RechargeSubscriptionPeriod | undefined {
  const period = paymentObject(value);
  const zoned = (value: unknown) =>
    typeof value === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value);
  const start = typeof period.start === 'string' ? Date.parse(period.start) : NaN;
  const end = typeof period.end === 'string' ? Date.parse(period.end) : NaN;
  if (
    period.source !== 'official_subscription_response' ||
    period.account_key !== key ||
    period.target_plan !== plan ||
    !zoned(period.start) ||
    !zoned(period.end) ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    end <= start ||
    end - start > 32 * 86400000
  )
    return;
  return {
    source: 'official_subscription_response',
    start: String(period.start),
    end: String(period.end),
    account_key: key,
    target_plan: plan
  };
}

export function directCycleMarker(
  value: unknown,
  context: V2RechargeNextCycleContext,
  jobId: string
) {
  const grant = paymentObject(value);
  const file = `${context.accountKey}${context.targetPlan === 'plus' ? '' : `-${context.targetPlan}`}.json`;
  if (
    grant.protocol !== 1 ||
    grant.jobId !== jobId ||
    grant.accountKey !== context.accountKey ||
    grant.targetPlan !== context.targetPlan ||
    grant.status !== 'granted' ||
    grant.checkoutFileKey !== file ||
    !Number.isSafeInteger(grant.checkoutRevision) ||
    Number(grant.checkoutRevision) < 0 ||
    typeof grant.reviewDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(grant.reviewDigest) ||
    typeof grant.expiresAt !== 'string' ||
    !(Date.parse(grant.expiresAt) > Date.now())
  )
    throw new Error('新周期一次建单资格未核实。');
  return {
    revision: Number(grant.checkoutRevision),
    marker: {
      protocol: 1,
      jobId,
      accountKey: context.accountKey,
      targetPlan: context.targetPlan,
      reviewDigest: grant.reviewDigest
    }
  };
}

/** Existing cycle review protocol, with read-only official inspection before inspect and commit. */
export async function prepareDirectNextCycle(
  browser: VerifiedPaymentBrowser,
  launch: V2RechargeBitBrowserLaunch,
  plan: V2RechargePlan,
  restored: V2RechargeBrowserRestore | undefined,
  accountKey: string,
  hooks: DirectPaymentHooks
) {
  const context = restored?.nextCycleContext;
  if (!context || !context.sources.length || context.grant?.status === 'consumed') return;
  if (
    launch.subscriptionCycleProtocol !== 1 ||
    context.protocol !== 1 ||
    context.jobId !== launch.id ||
    context.accountKey !== accountKey ||
    context.targetPlan !== plan
  )
    throw new Error('新周期核实范围与当前任务不一致。');
  const { session, close } = await createDirectPaymentSession(browser);
  const read = async (path: string, optional = false) => {
    session.signal.throwIfAborted();
    const response = await session.evaluate<{ ok: boolean; data?: unknown }>(
      officialPaymentRead(browser.identity, path),
      16000
    );
    if (!response.ok && !optional) throw new Error('官网新周期订阅状态尚未核实。');
    return response.ok ? paymentObject(response.data) : {};
  };
  const account = async () => {
    const data = await read('/backend-api/accounts/check/v4-2023-04-27');
    const node = paymentObject(paymentObject(data.accounts)[browser.identity.accountId]);
    const identity = paymentObject(node.account);
    if (
      (identity.account_id !== undefined && identity.account_id !== browser.identity.accountId) ||
      (identity.plan_type ?? node.plan_type) !== 'free' ||
      paymentObject(node.entitlement).has_active_subscription !== false
    )
      throw new Error('官网未明确确认当前无有效订阅，不能创建新周期订单。');
  };
  const inspect = async () => {
    await account();
    const subscription = await read(
      `/backend-api/subscriptions?account_id=${encodeURIComponent(browser.identity.accountId)}`,
      true
    );
    if (
      subscription.account_id !== undefined &&
      subscription.account_id !== browser.identity.accountId
    )
      throw new Error('官网订阅账号不一致。');
    if (
      subscription.active_until !== undefined &&
      subscription.active_until !== null &&
      (typeof subscription.active_until !== 'string' ||
        !Number.isFinite(Date.parse(subscription.active_until)) ||
        Date.parse(subscription.active_until) > Date.now())
    )
      throw new Error('官网原订阅尚未结束或期限未核实。');
    const mapping: Record<string, V2RechargePlan> = {
      go: 'go',
      plus: 'plus',
      prolite: 'pro-5x',
      pro: 'pro-20x',
      promax: 'pro-500'
    };
    const previousPlan = mapping[String(subscription.plan_type)];
    const candidates = context.sources
      .map((source) =>
        boundDirectCyclePeriod(source.subscriptionPeriod, accountKey, source.targetPlan)
      )
      .filter((value): value is V2RechargeSubscriptionPeriod => Boolean(value));
    if (
      subscription.account_id === browser.identity.accountId &&
      previousPlan &&
      context.sources.some((source) => source.targetPlan === previousPlan)
    ) {
      const previous = boundDirectCyclePeriod(
        {
          source: 'official_subscription_response',
          start: subscription.active_start,
          end: subscription.active_until,
          account_key: accountKey,
          target_plan: previousPlan
        },
        accountKey,
        previousPlan
      );
      if (previous) candidates.push(previous);
    }
    if (candidates.some((period) => Date.parse(period.end) > Date.now()))
      throw new Error('已核实的原订阅账期尚未结束。');
    candidates.sort((a, b) => Date.parse(b.end) - Date.parse(a.end));
    await account();
    return {
      source: 'official_account_response',
      account_key: accountKey,
      account_matched: true,
      current_plan: 'free',
      has_active_subscription: false,
      checked_at: new Date().toISOString(),
      ...(candidates[0] ? { previous_period: candidates[0] } : {})
    };
  };
  const send = async (phase: string, values: PaymentDocument) => {
    session.signal.throwIfAborted();
    const response = await hooks.callback({
      type: 'prepare_next_subscription_cycle',
      subscriptionCycleProtocol: 1,
      accountKey,
      phase,
      ...values
    });
    const review = paymentObject(response.cycleReview);
    if (
      review.protocol !== 1 ||
      typeof review.reviewDigest !== 'string' ||
      !/^[a-f0-9]{64}$/.test(review.reviewDigest) ||
      typeof review.expiresAt !== 'string' ||
      !Number.isFinite(Date.parse(review.expiresAt)) ||
      !['awaiting_previous_cycle_confirmation', 'ready', 'consumed', 'revoked'].includes(
        String(review.status)
      )
    )
      throw new Error('新周期核实回执不完整。');
    return { response, review };
  };
  try {
    const inspection = await inspect();
    let { review } = await send('inspect', { subscription_inspection: inspection });
    const digest = review.reviewDigest;
    const deadline = Math.min(Date.now() + 300000, Date.parse(String(review.expiresAt)));
    await hooks.progress('next_subscription_cycle_review', {
      account_matched: inspection.account_matched,
      current_plan: inspection.current_plan,
      cycle_review: review,
      subscription_inspection: inspection,
      user_action_required: review.status === 'awaiting_previous_cycle_confirmation',
      payment_attempted: false,
      payment_requests_sent: 0,
      checkout_requests_sent: 0
    });
    while (review.status === 'awaiting_previous_cycle_confirmation') {
      if (Date.now() >= deadline) throw new Error('原账期确认已过期，请检查原任务。');
      await waitDirectPayment(session.signal, Math.min(1000, deadline - Date.now()));
      const next = await send('status', { reviewDigest: digest });
      review = next.review;
      if (review.reviewDigest !== digest) throw new Error('原账期核实范围已变化。');
    }
    if (review.status !== 'ready' || Date.now() >= deadline)
      throw new Error('新周期资格尚未确认或已撤销。');
    const committed = await send('commit', {
      reviewDigest: digest,
      subscription_inspection: await inspect()
    });
    if (committed.review.status !== 'ready' || committed.review.reviewDigest !== digest)
      throw new Error('新周期建单资格未核实。');
    const updated = paymentObject(committed.response.nextCycleContext);
    const result = directCycleMarker(updated.grant, context, launch.id);
    if (result.marker.reviewDigest !== digest) throw new Error('新周期资格与本次核实摘要不一致。');
    return result;
  } finally {
    close();
  }
}

import type { OnlineRechargeTask } from '@prisma/client';
import { createHash } from 'node:crypto';
import type { VerifiedOnlineRechargeOrderFact } from '../auto-recharge/public-api';
import { Amount4 } from '../runtime/public-api';
import { ONLINE_RECHARGE_CONFIRMED_PLAN_NAMES } from './contracts';

const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const decimal = (value: unknown) =>
  typeof value === 'string' && /^\d{1,14}(\.\d{1,4})?$/.test(value) ? value : null;
const identifier = (value: unknown) =>
  typeof value === 'string' && /^[A-Za-z0-9:_-]{1,190}$/.test(value) ? value : null;
const timestamp = (value: unknown) =>
  typeof value === 'string' && Number.isFinite(Date.parse(value))
    ? new Date(value).toISOString()
    : null;
const providerSuccessStatuses = new Set([
  'success',
  'succeeded',
  'completed',
  'paid',
  'active',
  '开通成功',
  '成功'
]);
function providerReceipt(task: OnlineRechargeTask, result: Record<string, unknown>) {
  const provider = record(result.providerResult);
  const business = record(provider.result);
  const orderId = provider.order_id ?? record(provider.order).id;
  const taskId = provider.task_id ?? record(provider.task).id;
  const status =
    business.status ??
    provider.status ??
    provider.state ??
    record(provider.order).status ??
    record(provider.task).status;
  return task.provider === 'third_party' &&
    Boolean(orderId || taskId) &&
    (!orderId || String(orderId) === task.providerOrderId) &&
    (!taskId || String(taskId) === task.providerTaskId) &&
    (!task.providerOrderId || result.providerOrderId === task.providerOrderId) &&
    (!task.providerTaskId || result.providerTaskId === task.providerTaskId) &&
    result.success === true &&
    business.ok !== false &&
    providerSuccessStatuses.has(
      String(status ?? '')
        .trim()
        .toLowerCase()
    )
    ? provider
    : null;
}

export type OnlineOrderFactResult =
  | { eligible: true; fact: VerifiedOnlineRechargeOrderFact }
  | { eligible: false; reasonCode: string };

/** Only durable, same-account exact-tier confirmation is an order source. Bills alone are not. */
export function verifiedOnlineOrderFact(
  task: OnlineRechargeTask,
  expectedAccountId: string,
  card: { id: string; last4: string; holderName: string | null } | null = null
): OnlineOrderFactResult {
  if (task.operation !== 'recharge') return { eligible: false, reasonCode: 'NOT_RECHARGE' };
  if (task.status !== 'succeeded') return { eligible: false, reasonCode: 'NOT_CONFIRMED_SUCCESS' };
  const result = record(task.result);
  const proof = record(result.confirmation);
  if (
    !expectedAccountId ||
    proof.source !== 'subscription' ||
    proof.querySucceeded !== true ||
    proof.verified !== true ||
    proof.hasActiveSubscription !== true ||
    proof.accountId !== expectedAccountId ||
    proof.expectedAccountId !== expectedAccountId ||
    proof.targetPlan !== task.plan ||
    !(
      (proof.tierVerified === true && proof.observedCanonicalPlan === task.plan) ||
      (proof.tierVerified === undefined &&
        task.plan !== 'pro_500' &&
        typeof proof.observedPlan === 'string' &&
        ONLINE_RECHARGE_CONFIRMED_PLAN_NAMES[task.plan].includes(
          proof.observedPlan.trim().toLowerCase()
        ))
    )
  )
    return { eligible: false, reasonCode: 'ACCOUNT_OR_TIER_UNVERIFIED' };
  const context = record(record(task.payload).paymentContext);
  const evidence = record(result.paymentEvidence);
  const hasContext = Object.keys(context).length > 0;
  const receipt = providerReceipt(task, result);
  const providerPayment = record(receipt?.payment);
  const actualAmount = receipt
    ? (providerPayment.actual_paid_amount ??
      record(receipt.result).actual_paid_amount ??
      receipt.actual_paid_amount)
    : evidence.amount;
  const actualCurrency = receipt
    ? (providerPayment.paid_currency ??
      record(receipt.result).paid_currency ??
      receipt.paid_currency)
    : evidence.currency;
  const amount = decimal(actualAmount);
  const currency =
    typeof actualCurrency === 'string' && /^[A-Z]{3}$/.test(actualCurrency) ? actualCurrency : null;
  const paymentReference = identifier(
    evidence.paymentReference ?? evidence.paymentIntentId ?? evidence.transactionId
  );
  const evidenceVerified =
    evidence.verified === true &&
    ['checkout', 'subscription_change'].includes(String(evidence.source)) &&
    evidence.accountId === expectedAccountId &&
    evidence.targetPlan === task.plan &&
    evidence.cardId === task.cardId &&
    evidence.cardLast4 === task.cardLast4 &&
    (hasContext
      ? amount !== null &&
        currency !== null &&
        ['kind', 'sourcePlan', 'targetPlan', 'accountId', 'cardId', 'cardLast4', 'currency'].every(
          (key) => evidence[key] === context[key]
        ) &&
        (!context.quoteId || evidence.quoteId === context.quoteId) &&
        decimal(context.amount) !== null &&
        Amount4.from(amount).equals(String(context.amount))
      : evidence.taskId === task.id &&
        Boolean(task.cardId) &&
        /^\d{4}$/.test(task.cardLast4 ?? '') &&
        paymentReference !== null);
  if (hasContext && !evidenceVerified)
    return { eligible: false, reasonCode: 'PAYMENT_EVIDENCE_CONFLICT' };
  if (task.provider === 'local' && task.plan === 'pro_500' && !hasContext)
    return { eligible: false, reasonCode: 'PRO_500_PAYMENT_EVIDENCE_MISSING' };
  if (!receipt && !evidenceVerified)
    return { eligible: false, reasonCode: 'CURRENT_PAYMENT_EVIDENCE_MISSING' };
  if (task.provider === 'third_party' && !receipt)
    return { eligible: false, reasonCode: 'PROVIDER_ORIGINAL_RECEIPT_UNVERIFIED' };
  const zeroChange =
    evidenceVerified &&
    amount !== null &&
    context.kind === 'upgrade' &&
    Amount4.from(amount!).isZero() &&
    result.subscriptionChangedVerified === true;
  if (!zeroChange && !task.confirmedPaid)
    return { eligible: false, reasonCode: 'PAYMENT_UNVERIFIED' };
  if (
    !zeroChange &&
    (evidenceVerified || receipt) &&
    amount !== null &&
    Amount4.from(amount).isZero()
  )
    return { eligible: false, reasonCode: 'ZERO_CHANGE_UNVERIFIED' };
  const verifiedAt = timestamp(proof.queriedAt) ?? task.updatedAt.toISOString();
  const country = evidenceVerified ? (evidence.countryCode ?? evidence.country) : null;
  return {
    eligible: true,
    fact: {
      taskId: task.id,
      actorUserId: task.operatorId,
      provider: task.provider,
      plan: task.plan,
      accountKey: createHash('sha256').update(expectedAccountId).digest('hex'),
      emailEncrypted: task.emailEncrypted,
      cardId: card?.id === task.cardId ? task.cardId : null,
      cardLabel: card?.id === task.cardId ? card.holderName : null,
      cardLast4: task.cardLast4,
      chargeAmount: evidenceVerified || receipt ? amount : null,
      chargeCurrencyCode: evidenceVerified || receipt ? currency : null,
      chargeCountryCode: typeof country === 'string' && /^[A-Z]{2}$/.test(country) ? country : null,
      paymentReference: receipt
        ? identifier(`third_party:${task.providerOrderId ?? task.providerTaskId}`)
        : evidenceVerified
          ? paymentReference
          : null,
      checkoutIdentifier: evidenceVerified ? identifier(evidence.checkoutId) : null,
      zeroAmountChange: zeroChange,
      paymentKind:
        hasContext && ['initial', 'upgrade'].includes(String(context.kind))
          ? (context.kind as 'initial' | 'upgrade')
          : 'unknown',
      verifiedAt,
      openedAt: timestamp(proof.openedAt),
      dueAt: timestamp(proof.expiresAt)
    }
  };
}

import type { IdBusinessV2RechargeJob, IdBusinessV2RechargeRecord } from '@prisma/client';
import { hash, object, safeDocument } from './recharge-validation';
import {
  hasOfficialRechargeQuote,
  isRechargeUpgrade,
  rechargeOperationIdentifier,
  rechargeUpgradePaymentReference
} from './recharge-upgrade-protocol';

type PaymentJob = Pick<
  IdBusinessV2RechargeJob,
  'ownerId' | 'accountKey' | 'plan' | 'state' | 'createdAt' | 'leaseUntil'
> & { result: unknown };
type PaymentRecord = Pick<
  IdBusinessV2RechargeRecord,
  'ownerId' | 'accountKey' | 'fileKey' | 'updatedAt'
> & { document: unknown };

const checkoutPattern = /^(?:cs|oaics)_[A-Za-z0-9_]{1,200}$/;
const count = (value: unknown) => (value === 1 ? 1 : 0);

function quoteMaterial(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const quote = value as Record<string, unknown>;
  const money = (value: unknown) => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const item = value as Record<string, unknown>;
    return [item.currency, item.amount_minor, item.amount];
  };
  return JSON.stringify([
    quote.plan,
    money(quote.today),
    money(quote.tax),
    money(quote.renewal),
    quote.renewal_interval
  ]);
}

// 付款事实只前进；进度或迟到回执不能把已持久化的付款退回“未尝试”。
export function mergeRechargePaymentFacts(
  previous: Record<string, unknown>,
  next: Record<string, unknown>
) {
  const result = { ...previous, ...next };
  if (previous.payment_attempted === true) result.payment_attempted = true;
  for (const key of ['confirmation_requests_sent', 'payment_requests_sent'] as const) {
    if (previous[key] === 1) result[key] = 1;
  }
  if (previous.payment_status === 'paid') result.payment_status = 'paid';
  else if (previous.payment_attempted === true && next.payment_status === 'not_attempted')
    result.payment_status = previous.payment_status;
  if (previous.payment_evidence) result.payment_evidence = previous.payment_evidence;
  if (previous.recheck_only === true) result.payment_requests_sent = 0;
  return result;
}

export function projectRechargePaymentRecord(
  job: Pick<PaymentJob, 'accountKey' | 'plan' | 'result'>,
  fileKey: string,
  document: unknown
) {
  const previous = object(job.result);
  let payment: Record<string, unknown>;
  try {
    payment = safeDocument(document);
  } catch {
    return null;
  }
  const upgrade = isRechargeUpgrade(payment);
  const identifier = rechargeOperationIdentifier(payment);
  const previousIdentifier = rechargeOperationIdentifier(previous);
  const upgradeEvidence = payment.payment_evidence as
    | { amount_minor?: unknown; currency?: unknown }
    | undefined;
  const upgradeToday = (
    payment.quote as { today?: { amount_minor?: unknown; currency?: unknown } } | undefined
  )?.today;
  if (
    typeof identifier !== 'string' ||
    !(upgrade ? /^upg_[a-f0-9]{32}$/ : checkoutPattern).test(identifier) ||
    fileKey !== `payments/${hash(identifier)}.json` ||
    payment.account_key !== job.accountKey ||
    String(payment.target_plan ?? 'plus') !== job.plan ||
    payment.payment_attempted !== true ||
    ![0, 1].includes(payment.confirmation_requests_sent as number) ||
    !['unknown', 'paid', 'declined', 'requires_action'].includes(String(payment.payment_status)) ||
    (payment.payment_status === 'paid' && !payment.payment_evidence) ||
    (upgrade &&
      (previous.operation !== 'subscription_upgrade' ||
        !isRechargeUpgrade(previous) ||
        previous.current_plan_before !== payment.current_plan_before)) ||
    (upgrade &&
      payment.payment_status === 'paid' &&
      (!rechargeUpgradePaymentReference(payment) ||
        upgradeEvidence?.amount_minor !== upgradeToday?.amount_minor ||
        upgradeEvidence?.currency !== upgradeToday?.currency)) ||
    (typeof previousIdentifier === 'string' && previousIdentifier !== identifier) ||
    !hasOfficialRechargeQuote(previous) ||
    !previous.quote ||
    quoteMaterial(previous.quote) !== quoteMaterial(payment.quote)
  )
    return null;
  return mergeRechargePaymentFacts(previous, {
    ...(upgrade
      ? {
          operation: payment.operation,
          upgrade_identifier: identifier,
          current_plan_before: payment.current_plan_before,
          target_plan: payment.target_plan,
          ...(payment.upgrade_invoice_identifier
            ? { upgrade_invoice_identifier: payment.upgrade_invoice_identifier }
            : {}),
          ...(payment.upgrade_payment_intent_identifier
            ? { upgrade_payment_intent_identifier: payment.upgrade_payment_intent_identifier }
            : {})
        }
      : { checkout_identifier: identifier }),
    ...(payment.subscription_period ? { subscription_period: payment.subscription_period } : {}),
    payment_attempted: true,
    confirmation_requests_sent: count(payment.confirmation_requests_sent),
    payment_requests_sent:
      previous.recheck_only === true ? 0 : count(payment.confirmation_requests_sent),
    payment_status: payment.payment_status,
    ...(payment.payment_evidence ? { payment_evidence: payment.payment_evidence } : {}),
    ...(typeof payment.card_last4 === 'string' && /^\d{4}$/.test(payment.card_last4)
      ? { card_last4: payment.card_last4 }
      : {}),
    repeated_payment: 'blocked'
  });
}

export function recoverRechargePaymentResult(job: PaymentJob, records: PaymentRecord[]) {
  const previous = object(job.result);
  const boundIdentifier = typeof rechargeOperationIdentifier(previous) === 'string';
  const candidates = records.flatMap((record) => {
    if (record.ownerId !== job.ownerId || record.accountKey !== job.accountKey) return [];
    const projected = projectRechargePaymentRecord(job, record.fileKey, record.document);
    if (!projected) return [];
    if (!boundIdentifier) {
      // 旧硬中断没有编号时，仅使用原任务租约内唯一、同报价的付款记录。
      // 已结束任务不能凭同账号后续付款反推归属；读取不延长租约。
      const payment = object(record.document);
      const created = Number(payment.created_at) * 1000;
      if (
        job.state === 'finished' ||
        !Number.isSafeInteger(payment.created_at) ||
        created < Math.floor(job.createdAt.getTime() / 1000) * 1000 ||
        created > job.leaseUntil.getTime() ||
        record.updatedAt.getTime() < job.createdAt.getTime() ||
        record.updatedAt.getTime() > job.leaseUntil.getTime()
      )
        return [];
    }
    return [projected];
  });
  return candidates.length === 1 ? candidates[0]! : previous;
}

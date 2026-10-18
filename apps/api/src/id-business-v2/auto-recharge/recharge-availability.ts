import {
  hasVerifiedRechargePayment,
  rechargeOperationIdentifier
} from './recharge-upgrade-protocol';
import {
  resolvedDeclinedPayment,
  resolvedVerificationFailureRecheck
} from './recharge-noncharge-proof';
import type { IdBusinessV2RechargeJob } from '@prisma/client';
import type { V2RechargeAvailability } from '@apple-business/shared';
import { hash, object } from './recharge-validation';
import { resolvedUnknownPayment } from './recharge-resolution';
import { cycleSources } from './recharge-cycle-state';
import type { CycleRecord } from './recharge-cycle-state';

export function rechargeAvailability(
  job: IdBusinessV2RechargeJob,
  records: CycleRecord[],
  now = Date.now()
): V2RechargeAvailability {
  const result = object(job.result);
  const execution =
    job.state === 'finished' ? 'released' : job.leaseUntil.getTime() <= now ? 'expired' : 'active';
  const attempted =
    result.payment_attempted === true ||
    Number(result.payment_requests_sent ?? 0) > 0 ||
    Number(result.confirmation_requests_sent ?? 0) > 0;
  const evidence =
    result.payment_evidence &&
    typeof result.payment_evidence === 'object' &&
    !Array.isArray(result.payment_evidence)
      ? (result.payment_evidence as Record<string, unknown>)
      : {};
  const quote =
    result.quote && typeof result.quote === 'object'
      ? (result.quote as Record<string, unknown>)
      : {};
  const today =
    quote.today && typeof quote.today === 'object' ? (quote.today as Record<string, unknown>) : {};
  const reference = rechargeOperationIdentifier(result);
  const verifiedEvidence =
    Number.isSafeInteger(evidence.amount_minor) &&
    Number(evidence.amount_minor) > 0 &&
    evidence.amount_minor === today.amount_minor &&
    typeof evidence.currency === 'string' &&
    evidence.currency === today.currency &&
    ((evidence.kind === 'checkout_session' &&
      evidence.identifier === reference &&
      /^(?:cs|oaics)_[A-Za-z0-9_]{1,200}$/.test(String(reference))) ||
      (evidence.kind === 'payment_intent' &&
        /^pi_[A-Za-z0-9]{1,180}$/.test(String(evidence.identifier))));
  let payment: V2RechargeAvailability['payment'];
  if (
    resolvedUnknownPayment(job) ||
    resolvedDeclinedPayment(result) ||
    resolvedVerificationFailureRecheck(job, records)
  )
    payment = 'resolved';
  else if (result.payment_status === 'paid' && verifiedEvidence)
    payment = hasVerifiedRechargePayment(result, job) ? 'completed' : 'paid_pending';
  else if (result.payment_status === 'declined' && !result.payment_evidence) payment = 'declined';
  else if (
    attempted ||
    result.payment_evidence ||
    ['paid', 'unknown', 'requires_action'].includes(String(result.payment_status)) ||
    ['confirming'].includes(job.state) ||
    ['payment_request_sending', 'payment_result'].includes(String(result.stage))
  )
    payment = 'unknown';
  else payment = 'no_request';
  let accountPaymentRestricted =
    payment === 'unknown' || payment === 'paid_pending' || payment === 'declined';
  const ownRecords = records.filter(
    (record) => record.ownerId === job.ownerId && record.accountKey === job.accountKey
  );
  if (job.accountKey && ownRecords.length) {
    try {
      cycleSources(ownRecords, job);
    } catch {
      accountPaymentRestricted = true;
    }
  }
  return {
    execution,
    payment,
    accountPaymentRestricted,
    ...(job.accountKey ? { accountReference: hash(job.accountKey) } : {}),
    canInspect: execution !== 'active'
  };
}

import type { IdBusinessV2RechargeJob } from '@prisma/client';
import { object } from './recharge-validation';
import { rechargePaymentHoldDeadline } from './persistence/recharge-payment-hold.repository';

export function rechargeCallbackLease(
  job: IdBusinessV2RechargeJob,
  eventType: unknown,
  report: Record<string, unknown>
) {
  if (
    job.action === 'bitbrowser' &&
    eventType === 'progress' &&
    report.stage !== 'next_subscription_cycle_review'
  )
    return { leaseUntil: rechargePaymentHoldDeadline(job) ?? new Date(Date.now() + 45 * 60000) };
  const previous = object(job.result);
  if (
    job.action === 'server' &&
    job.state === 'running' &&
    eventType === 'progress' &&
    ['proxy_verifying', 'proxy_retrying'].includes(String(previous.stage)) &&
    report.stage === 'session_restore' &&
    previous.server_business_lease_started !== true
  ) {
    // Only the API writes this one-time handoff, so late proxy progress cannot extend it again.
    report.server_business_lease_started = true;
    return { leaseUntil: new Date(Date.now() + 16 * 60000) };
  }
  return {};
}

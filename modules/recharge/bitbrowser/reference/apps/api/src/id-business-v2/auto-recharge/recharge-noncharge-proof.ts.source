import { createHash } from 'node:crypto';
import { BadRequestException } from '@nestjs/common';
import { isRechargeUpgrade, rechargeOperationIdentifier } from './recharge-upgrade-protocol';
import { manualRechargeSettlement } from './recharge-manual-settlement-proof';

const uuid = /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;

export const TERMINAL_FAILURE_KEY = '_official_terminal_failure_v1';

export function hasOfficialTerminalNoncharge(
  value: unknown
): value is Record<string, unknown> & { _official_terminal_failure_v1: Record<string, unknown> } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>,
    raw = result[TERMINAL_FAILURE_KEY];
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return false;
  const proof = raw as Record<string, unknown>;
  const upgrade = result.operation === 'subscription_upgrade';
  return (
    proof.kind === 'bound_payment_intent_declined' &&
    typeof proof.sourceJobId === 'string' &&
    uuid.test(proof.sourceJobId) &&
    typeof proof.accountKey === 'string' &&
    /^[a-f0-9]{64}$/.test(proof.accountKey) &&
    (!upgrade || isRechargeUpgrade(result)) &&
    typeof proof.checkoutIdentifier === 'string' &&
    (upgrade ? /^upg_[a-f0-9]{32}$/ : /^(?:cs|oaics)_[A-Za-z0-9_]{1,200}$/).test(
      proof.checkoutIdentifier
    ) &&
    proof.checkoutIdentifier === rechargeOperationIdentifier(result) &&
    (result.account_key === undefined || result.account_key === proof.accountKey) &&
    proof.plan === (result.target_plan ?? 'plus') &&
    typeof proof.paymentIntentIdentifier === 'string' &&
    /^pi_[A-Za-z0-9]{1,180}$/.test(proof.paymentIntentIdentifier) &&
    (result.payment_intent_identifier === undefined ||
      result.payment_intent_identifier === proof.paymentIntentIdentifier) &&
    (!upgrade ||
      result.upgrade_payment_intent_identifier === undefined ||
      result.upgrade_payment_intent_identifier === proof.paymentIntentIdentifier) &&
    typeof proof.confirmedAt === 'string' &&
    Number.isFinite(Date.parse(proof.confirmedAt)) &&
    new Date(Date.parse(proof.confirmedAt)).toISOString() === proof.confirmedAt &&
    ['declined', 'not_attempted'].includes(String(result.payment_status)) &&
    !result.payment_evidence
  );
}

export function resolvedUnknownPayment(job: { result: unknown }) {
  if (!job.result || typeof job.result !== 'object' || Array.isArray(job.result))
    throw new BadRequestException('输入格式无效');
  const result = job.result as Record<string, unknown>;
  return (
    result.operator_resolution === 'confirmed_no_bank_request' &&
    typeof result.resolution_job_id === 'string' &&
    uuid.test(result.resolution_job_id)
  );
}

export function hasDeclineResolution(value: unknown): boolean {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.operator_resolution === 'confirmed_declined_no_charge' ||
      (v.operator_resolution === 'confirmed_verification_failed_no_charge' &&
        ['captured_official_failure', 'operator_observed_official_failure'].includes(
          String(v.resolution_basis)
        ))) &&
    !v.payment_evidence &&
    typeof v.resolved_at === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3,6})?Z$/.test(v.resolved_at) &&
    ['resolution_job_id', 'source_job_id', 'verification_job_id'].every(
      (key) => typeof v[key] === 'string' && uuid.test(v[key])
    )
  );
}
export function resolvedDeclinedPayment(value: unknown): boolean {
  if (manualRechargeSettlement(value)?.outcome === 'failure') return true;
  if (hasOfficialTerminalNoncharge(value)) {
    const result = value as Record<string, unknown>;
    return (
      result.payment_status === 'declined' &&
      result.payment_attempted === true &&
      result.confirmation_requests_sent === 1 &&
      result.payment_requests_sent === 1
    );
  }
  if (!hasDeclineResolution(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    (v.operator_resolution === 'confirmed_declined_no_charge'
      ? v.payment_status === 'declined'
      : v.payment_status === 'unknown' && v.payment_requests_sent === 1) &&
    v.payment_attempted === true &&
    v.confirmation_requests_sent === 1
  );
}
export function resolvedDeclinedCheckout(value: unknown): boolean {
  if (manualRechargeSettlement(value)?.outcome === 'failure') return true;
  if (hasOfficialTerminalNoncharge(value))
    return (
      (value as Record<string, unknown>).payment_status === 'not_attempted' &&
      (value as Record<string, unknown>).payment_attempted !== true
    );
  if (!hasDeclineResolution(value)) return false;
  const v = value as Record<string, unknown>;
  return (
    v.payment_status === 'not_attempted' &&
    (v.operator_resolution !== 'confirmed_verification_failed_no_charge' ||
      v.payment_requests_sent === undefined ||
      v.payment_requests_sent === 0) &&
    v.payment_attempted !== true &&
    (v.confirmation_requests_sent === undefined || v.confirmation_requests_sent === 0) &&
    typeof v.checkout_identifier === 'string' &&
    /^(?:cs|oaics)_[A-Za-z0-9_]{1,200}$/.test(v.checkout_identifier)
  );
}

export function declinedResolutionEligible(job: {
  action: string;
  state: string;
  accountKey: string | null;
  result: unknown;
}) {
  const v = (job.result ?? {}) as Record<string, unknown>;
  return (
    job.action === 'bitbrowser' &&
    job.state === 'finished' &&
    Boolean(job.accountKey) &&
    v.recheck_only !== true &&
    !hasOfficialTerminalNoncharge(v) &&
    v.operation !== 'subscription_upgrade' &&
    v.payment_status === 'declined' &&
    v.payment_attempted === true &&
    v.confirmation_requests_sent === 1 &&
    !v.payment_evidence &&
    !v.operator_resolution &&
    !v.manual_settlement &&
    typeof v.checkout_identifier === 'string' &&
    /^(?:cs|oaics)_[A-Za-z0-9_]{1,200}$/.test(v.checkout_identifier)
  );
}

/** 仅提供人工核实入口，不能把官网失败提示或免费状态当成无扣款证明。 */
export function verificationFailureResolutionEligible(job: {
  action: string;
  state: string;
  accountKey: string | null;
  result: unknown;
}) {
  const v = (job.result ?? {}) as Record<string, unknown>;
  const unexpected = v._direct_unexpected_payment_v1;
  return (
    job.action === 'bitbrowser' &&
    job.state === 'finished' &&
    typeof job.accountKey === 'string' &&
    /^[a-f0-9]{64}$/.test(job.accountKey) &&
    v.transport === 'web_direct' &&
    v.recheck_only !== true &&
    v.resolution_only !== true &&
    v.operation !== 'subscription_upgrade' &&
    !v.manual_settlement &&
    v.payment_status === 'unknown' &&
    v.payment_attempted === true &&
    v.payment_requests_sent === 1 &&
    v.confirmation_requests_sent === 1 &&
    !v.payment_evidence &&
    [
      'operator_resolution',
      'resolution_basis',
      'resolved_at',
      'resolution_job_id',
      'source_job_id',
      'verification_job_id'
    ].every((key) => v[key] === undefined) &&
    v.status !== 'subscription_activated' &&
    v.payment_outcome !== 'subscription_activated' &&
    (unexpected === undefined ||
      (unexpected !== null &&
        typeof unexpected === 'object' &&
        !Array.isArray(unexpected) &&
        (unexpected as Record<string, unknown>).observed === true &&
        (unexpected as Record<string, unknown>).observedRequests === 1)) &&
    typeof v.checkout_identifier === 'string' &&
    /^(?:cs|oaics)_[A-Za-z0-9_]{1,200}$/.test(v.checkout_identifier)
  );
}

/** 只读历史保留原结果；仅以同源、同原单的服务端处理账本派生当前可用性。 */
export function resolvedVerificationFailureRecheck(
  job: {
    id: string;
    ownerId: string;
    accountKey: string | null;
    plan: string;
    action: string;
    state: string;
    createdAt: Date;
    updatedAt: Date;
    result: unknown;
  },
  records: { ownerId: string; accountKey: string; fileKey: string; document: unknown }[]
) {
  if (!job.result || typeof job.result !== 'object' || Array.isArray(job.result)) return false;
  const v = job.result as Record<string, unknown>;
  if (
    job.action !== 'bitbrowser' ||
    job.state !== 'finished' ||
    typeof job.accountKey !== 'string' ||
    !/^[a-f0-9]{64}$/.test(job.accountKey) ||
    v.transport !== 'web_direct' ||
    v.recheck_only !== true ||
    v.resolution_only === true ||
    v.operation === 'subscription_upgrade' ||
    v.payment_evidence ||
    !['unknown', 'declined', 'requires_action'].includes(String(v.payment_status)) ||
    v.status === 'subscription_activated' ||
    v.payment_outcome === 'subscription_activated' ||
    v.operator_resolution !== undefined ||
    (v.payment_requests_sent !== undefined && v.payment_requests_sent !== 0) ||
    (v.confirmation_requests_sent !== undefined && v.confirmation_requests_sent !== 0) ||
    typeof v.source_job_id !== 'string' ||
    !uuid.test(v.source_job_id) ||
    v.source_job_id === job.id ||
    typeof v.checkout_identifier !== 'string' ||
    !/^(?:cs|oaics)_[A-Za-z0-9_]{1,200}$/.test(v.checkout_identifier) ||
    !(job.createdAt instanceof Date) ||
    !(job.updatedAt instanceof Date) ||
    !Number.isFinite(job.createdAt.getTime()) ||
    !Number.isFinite(job.updatedAt.getTime())
  )
    return false;
  const fileKey = `payments/${createHash('sha256').update(v.checkout_identifier).digest('hex')}.json`;
  const candidates = records.filter(
    (record) =>
      record.ownerId === job.ownerId &&
      record.accountKey === job.accountKey &&
      record.fileKey === fileKey
  );
  if (candidates.length !== 1) return false;
  const payment = candidates[0]!.document as Record<string, unknown> | null;
  return Boolean(
    payment &&
    resolvedDeclinedPayment(payment) &&
    payment.operator_resolution === 'confirmed_verification_failed_no_charge' &&
    payment.source_job_id === v.source_job_id &&
    payment.checkout_identifier === v.checkout_identifier &&
    payment.account_key === job.accountKey &&
    String(payment.target_plan ?? 'plus') === job.plan &&
    typeof payment.resolved_at === 'string' &&
    job.createdAt.getTime() <= Date.parse(payment.resolved_at) &&
    job.updatedAt.getTime() <= Date.parse(payment.resolved_at)
  );
}

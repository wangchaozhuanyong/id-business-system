import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import type { IdBusinessV2RechargeJob } from '@prisma/client';
import {
  V2_RECHARGE_PLANS,
  type V2RechargeCycleReview,
  type V2RechargeNextCycleContext,
  type V2RechargeNextCycleGrant,
  type V2RechargeNextCycleSource,
  type V2RechargeSubscriptionInspection,
  type V2RechargeSubscriptionPeriod
} from '@apple-business/shared';
import { hash, object, safeDocument } from './recharge-validation';
import { rechargeDocumentDigest } from './recharge-callback-receipts';
import {
  isRechargeUpgrade,
  rechargeOperationIdentifier,
  rechargeUpgradePaymentReference
} from './recharge-upgrade-protocol';

export const cyclePrivateKey = '_subscription_cycle_private_v1';
export interface CycleRecord {
  ownerId: string;
  accountKey: string;
  fileKey: string;
  revision: number;
  document: unknown;
}
export interface CyclePrivateState {
  sources: V2RechargeNextCycleSource[];
  review: V2RechargeCycleReview;
  inspection: V2RechargeSubscriptionInspection;
  manualConfirmed?: true;
  commitDigest?: string;
  grant?: V2RechargeNextCycleGrant;
  markerDigest?: string;
  markerRevision?: number;
  checkoutCandidate?: Pick<V2RechargeNextCycleSource, 'fileKey' | 'revision' | 'documentDigest'>;
}

export function assertNoClientCycleFields(value: unknown) {
  if (!value || typeof value !== 'object') return;
  for (const [key, item] of Object.entries(value)) {
    if (['cycle_resolution', 'cycle_origin', 'client_cycle_protocol'].includes(key))
      throw new BadRequestException('执行回执包含不可写入的周期字段');
    assertNoClientCycleFields(item);
  }
}

function confirmedNoBankResolution(document: Record<string, unknown>) {
  return (
    !document.payment_evidence &&
    document.operator_resolution === 'confirmed_no_bank_request' &&
    typeof document.resolved_at === 'string' &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{3,6})?Z$/.test(document.resolved_at) &&
    ['resolution_job_id', 'source_job_id', 'verification_job_id'].every(
      (key) =>
        typeof document[key] === 'string' &&
        /^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(document[key])
    )
  );
}

export function resolvedCyclePayment(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const document = object(value);
  if (document.payment_evidence) return false;
  return (
    (document.cancelled_before_confirmation === true &&
      document.payment_status === 'cancelled' &&
      document.confirmation_requests_sent === 0) ||
    (confirmedNoBankResolution(document) &&
      document.payment_status === 'unknown' &&
      document.payment_attempted === true &&
      document.confirmation_requests_sent === 1)
  );
}

export function safeUnpaidCycleCheckout(value: unknown) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const document = object(value);
  // A consumed next-cycle marker can precede an uncertain external create.
  // Zero payment/cancellation reports cannot turn that operation into a new grant.
  if (document.cycle_origin) return false;
  const cancelled =
    document.status === 'cancelled' &&
    document.checkout_outcome === 'cancelled' &&
    document.cancelled_before_confirmation === true &&
    document.payment_status === 'not_attempted' &&
    document.payment_attempted === false &&
    document.confirmation_requests_sent === 0 &&
    Number(document.payment_requests_sent ?? 0) === 0 &&
    !document.payment_evidence;
  return (
    cancelled ||
    (confirmedNoBankResolution(document) &&
      document.payment_status === 'not_attempted' &&
      document.payment_attempted !== true &&
      (document.confirmation_requests_sent === undefined ||
        document.confirmation_requests_sent === null ||
        document.confirmation_requests_sent === 0) &&
      document.checkout_outcome === 'created' &&
      typeof document.checkout_identifier === 'string' &&
      /^(?:cs|oaics)_[A-Za-z0-9_]{1,200}$/.test(document.checkout_identifier) &&
      typeof document.processor_entity === 'string' &&
      /^[a-z][a-z0-9_]{0,40}$/.test(document.processor_entity))
  );
}

export function readCycleState(job: Pick<IdBusinessV2RechargeJob, 'result'>) {
  const value = object(job.result ?? {})[cyclePrivateKey];
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as CyclePrivateState)
    : undefined;
}

export function revokeUnusedCycleGrant(result: Record<string, unknown>) {
  const state = readCycleState({ result } as never);
  if (!state || state.grant?.status === 'consumed') return result;
  const revoked: CyclePrivateState = {
    ...state,
    grant: undefined,
    review: { ...state.review, status: 'revoked', reason: 'subscription_state_changed' }
  };
  return { ...result, [cyclePrivateKey]: revoked, cycle_review: revoked.review };
}

export function cycleProtocolEnabled(
  job: Pick<IdBusinessV2RechargeJob, 'action' | 'result'>,
  protocol: unknown
) {
  const result = object(job.result ?? {});
  return (
    job.action === 'bitbrowser' &&
    protocol === 1 &&
    result.client_cycle_protocol === 1 &&
    result.mode !== 'open_browser' &&
    result.recheck_only !== true &&
    result.resolution_only !== true
  );
}

export function checkoutCycleFileKey(accountKey: string, plan: string) {
  return `${accountKey}${plan === 'plus' ? '' : `-${plan}`}.json`;
}

export function isClosedCycleDocument(value: unknown, accountKey: string) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const document = object(value);
  const closed = document.cycle_resolution;
  if (!closed || typeof closed !== 'object' || Array.isArray(closed)) return false;
  const closure = object(closed);
  return (
    closure.protocol === 1 &&
    closure.status === 'closed' &&
    closure.account_key === accountKey &&
    typeof closure.source_job_id === 'string' &&
    /^[a-f0-9-]{36}$/.test(closure.source_job_id) &&
    typeof closure.review_digest === 'string' &&
    /^[a-f0-9]{64}$/.test(closure.review_digest) &&
    typeof closure.original_document_digest === 'string' &&
    /^[a-f0-9]{64}$/.test(closure.original_document_digest)
  );
}

export function originalCycleDocument(value: unknown) {
  const document = { ...object(value) };
  delete document.cycle_resolution;
  return document;
}

export function subscriptionInspection(
  value: unknown,
  job: Pick<IdBusinessV2RechargeJob, 'accountKey'>
) {
  const input = object(value);
  const time = typeof input.checked_at === 'string' ? Date.parse(input.checked_at) : NaN;
  if (
    input.source !== 'official_account_response' ||
    input.account_key !== job.accountKey ||
    input.account_matched !== true ||
    typeof input.current_plan !== 'string' ||
    !['free', 'go', 'plus', 'pro', 'promax'].includes(input.current_plan) ||
    ![true, false, null].includes(input.has_active_subscription as boolean | null) ||
    !Number.isFinite(time) ||
    time > Date.now() ||
    time < Date.now() - 5 * 60000
  )
    throw new BadRequestException('官网订阅核实资料不完整或已过期');
  const period = safeDocument({ subscription_period: input.previous_period }).subscription_period;
  if (input.previous_period && (!period || object(period).account_key !== job.accountKey))
    throw new BadRequestException('旧官网账期与原账户不一致');
  return {
    source: input.source,
    account_key: input.account_key,
    account_matched: true,
    current_plan: input.current_plan,
    has_active_subscription: input.has_active_subscription,
    checked_at: new Date(time).toISOString(),
    ...(period ? { previous_period: period } : {})
  } as V2RechargeSubscriptionInspection;
}

function completePaidDocument(value: unknown, accountKey: string) {
  const document = safeDocument(value);
  const target = document.target_plan ?? object(document.quote ?? {}).plan ?? 'plus';
  const evidence = object(document.payment_evidence ?? {});
  const today = object(object(document.quote ?? {}).today ?? {});
  const identifier = rechargeOperationIdentifier(document);
  const family =
    target === 'pro-500' ? 'promax' : String(target).startsWith('pro-') ? 'pro' : target;
  const tier = target === 'pro-5x' ? 5 : target === 'pro-20x' ? 20 : undefined;
  const quote = object(document.quote ?? {});
  const tax = object(quote.tax ?? {});
  const renewal = object(quote.renewal ?? {});
  const canonicalQuote = {
    plan: quote.plan,
    today,
    tax,
    renewal,
    renewal_interval: quote.renewal_interval
  };
  const activated =
    document.status === 'subscription_activated' &&
    document.subscription_status === target &&
    document.current_plan === family &&
    (tier === undefined || document.current_tier === tier);
  if (
    !V2_RECHARGE_PLANS.includes(target as never) ||
    document.account_key !== accountKey ||
    typeof identifier !== 'string' ||
    document.payment_attempted !== true ||
    document.confirmation_requests_sent !== 1 ||
    document.payment_status !== 'paid' ||
    !activated ||
    !document.payment_evidence ||
    quote.plan !== target ||
    quote.renewal_interval !== 'monthly' ||
    !Number.isSafeInteger(today.amount_minor) ||
    Number(today.amount_minor) <= 0 ||
    today.currency !== tax.currency ||
    today.currency !== renewal.currency ||
    !Number.isSafeInteger(tax.amount_minor) ||
    !Number.isSafeInteger(renewal.amount_minor) ||
    document.quote_digest !== rechargeDocumentDigest(canonicalQuote) ||
    evidence.amount_minor !== today.amount_minor ||
    evidence.currency !== today.currency ||
    (!isRechargeUpgrade(document) &&
      !(
        (evidence.kind === 'checkout_session' &&
          evidence.identifier === identifier &&
          /^(?:cs|oaics)_[A-Za-z0-9_]{1,200}$/.test(identifier)) ||
        (evidence.kind === 'payment_intent' &&
          typeof evidence.identifier === 'string' &&
          /^pi_[A-Za-z0-9]{1,180}$/.test(evidence.identifier) &&
          /^(?:cs|oaics)_[A-Za-z0-9_]{1,200}$/.test(identifier))
      )) ||
    (isRechargeUpgrade(document) && !rechargeUpgradePaymentReference(document))
  )
    throw new ConflictException('该账户仍有未核实付款或订阅待生效，只能复查原订单');
  return { document, target: target as V2RechargeNextCycleSource['targetPlan'], identifier };
}

export function cycleSources(
  records: CycleRecord[],
  job: Pick<IdBusinessV2RechargeJob, 'ownerId' | 'accountKey' | 'plan'>
) {
  if (!job.accountKey) throw new ConflictException('原账户尚未核实');
  if (
    records.some((record) => record.ownerId !== job.ownerId || record.accountKey !== job.accountKey)
  )
    throw new ForbiddenException('该账户属于另一操作人的原任务');
  const current = records.filter((record) => !record.fileKey.startsWith('history/'));
  const sources: V2RechargeNextCycleSource[] = [];
  const paid = new Map<string, ReturnType<typeof completePaidDocument>>();
  for (const record of current.filter((record) => record.fileKey.startsWith('payments/'))) {
    if (resolvedCyclePayment(record.document)) continue;
    const settled = completePaidDocument(record.document, job.accountKey);
    const period = settled.document.subscription_period as V2RechargeSubscriptionPeriod | undefined;
    if (period && (period.account_key !== job.accountKey || period.target_plan !== settled.target))
      throw new ConflictException('旧官网账期没有绑定原账户和原套餐');
    if (record.fileKey !== `payments/${hash(settled.identifier)}.json`)
      throw new ConflictException('旧付款文件未绑定原操作，不能转换周期');
    paid.set(settled.identifier, settled);
    sources.push({
      fileKey: record.fileKey,
      revision: record.revision,
      operationIdentifier: settled.identifier,
      documentDigest: rechargeDocumentDigest(originalCycleDocument(record.document)),
      targetPlan: settled.target,
      ...(settled.document.subscription_period
        ? {
            subscriptionPeriod: settled.document
              .subscription_period as unknown as V2RechargeSubscriptionPeriod
          }
        : {})
    });
  }
  if (!sources.length) return [];
  for (const record of current.filter((record) => !record.fileKey.startsWith('payments/'))) {
    const raw = object(record.document);
    const targetPlan = raw.target_plan ?? 'plus';
    if (
      !V2_RECHARGE_PLANS.includes(targetPlan as never) ||
      record.fileKey !== checkoutCycleFileKey(job.accountKey, String(targetPlan))
    )
      throw new ConflictException('旧结算文件未绑定原账号和套餐');
    if (safeUnpaidCycleCheckout(record.document)) continue;
    const document = safeDocument(record.document);
    const identifier = rechargeOperationIdentifier(document);
    const settled = typeof identifier === 'string' ? paid.get(identifier) : undefined;
    if (!settled) throw new ConflictException('该账户仍有未完成的原结算，不能创建新周期订单');
    const period = document.subscription_period as V2RechargeSubscriptionPeriod | undefined;
    if (period && (period.account_key !== job.accountKey || period.target_plan !== settled.target))
      throw new ConflictException('旧官网账期没有绑定原账户和原套餐');
    if (period) {
      for (const source of sources.filter((source) => source.operationIdentifier === identifier))
        source.subscriptionPeriod ??= period;
    }
    sources.push({
      fileKey: record.fileKey,
      revision: record.revision,
      operationIdentifier: identifier as string,
      documentDigest: rechargeDocumentDigest(originalCycleDocument(record.document)),
      targetPlan: settled.target,
      ...(document.subscription_period
        ? {
            subscriptionPeriod:
              document.subscription_period as unknown as V2RechargeSubscriptionPeriod
          }
        : settled.document.subscription_period
          ? {
              subscriptionPeriod: settled.document
                .subscription_period as unknown as V2RechargeSubscriptionPeriod
            }
          : {})
    });
  }
  return sources.sort((a, b) => a.fileKey.localeCompare(b.fileKey));
}

export function cycleContext(
  job: IdBusinessV2RechargeJob,
  records: CycleRecord[],
  protocol: unknown
): V2RechargeNextCycleContext | undefined {
  if (!cycleProtocolEnabled(job, protocol) || !job.accountKey) return undefined;
  const state = readCycleState(job);
  const sources = state?.grant ? state.sources : cycleSources(records, job);
  if (!sources.length) return undefined;
  return {
    protocol: 1,
    jobId: job.id,
    accountKey: job.accountKey,
    targetPlan: job.plan as never,
    sources,
    ...(state ? { review: state.review } : {}),
    ...(state?.grant &&
    (state.grant.status === 'consumed' || Date.parse(state.grant.expiresAt) > Date.now())
      ? { grant: state.grant }
      : {})
  };
}

export function automaticallyEnded(
  sources: V2RechargeNextCycleSource[],
  inspection: V2RechargeSubscriptionInspection
) {
  if (
    inspection.previous_period &&
    Date.parse(inspection.previous_period.end) > Date.parse(inspection.checked_at)
  )
    return false;
  const payments = sources.filter((source) => source.fileKey.startsWith('payments/'));
  const operations = new Set(payments.map((source) => source.operationIdentifier));
  const periods = payments.map(
    (source) =>
      source.subscriptionPeriod ??
      (operations.size === 1 && inspection.previous_period?.target_plan === source.targetPlan
        ? inspection.previous_period
        : undefined)
  );
  return (
    periods.length > 0 &&
    periods.every((period) => period && Date.parse(period.end) <= Date.parse(inspection.checked_at))
  );
}

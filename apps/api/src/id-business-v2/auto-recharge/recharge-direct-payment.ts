import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import type { IdBusinessV2RechargeJob } from '@prisma/client';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  toV2JsonDocument,
  type V2CommandTransaction,
  type V2CommandTransactionManager,
  type V2TransactionalAuditService
} from '../runtime/public-api';
import type { RechargeRepository } from './persistence/recharge.repository';
import { projectRechargePaymentRecord } from './recharge-payment-facts';
import { rechargeDocumentDigest } from './recharge-callback-receipts';
import { mergeRechargeCallbackResult } from './recharge-bank-callback';
import { rechargeOperationIdentifier } from './recharge-upgrade-protocol';
import { assertFinalQuote, hash, object, safeDocument, uuidPattern } from './recharge-validation';
import { assertReplacementCheckoutReport } from './recharge-expired-checkout';

const privateKey = '_direct_confirmation_v1';
const observationKey = '_direct_unexpected_payment_v1';
const digestPattern = /^[a-f0-9]{64}$/;
const identifierPattern = /^(?:cs_[A-Za-z0-9_]{1,180}|oaics_[A-Za-z0-9_]{1,200}|upg_[a-f0-9]{32})$/;

function directQuoteDigest(
  job: Pick<IdBusinessV2RechargeJob, 'accountKey' | 'plan'>,
  report: Record<string, unknown>
) {
  return rechargeDocumentDigest({
    accountKey: job.accountKey,
    plan: job.plan,
    checkoutIdentifier: rechargeOperationIdentifier(report),
    billingFingerprint: report.billing_fingerprint,
    quote: report.quote
  });
}

export function isDirectRechargePayment(job: Pick<IdBusinessV2RechargeJob, 'action' | 'result'>) {
  const result = object(job.result);
  return (
    job.action === 'bitbrowser' &&
    result.transport === 'web_direct' &&
    result.mode !== 'open_browser' &&
    result.recheck_only !== true &&
    result.resolution_only !== true
  );
}

export function directRechargeAuthorized(job: Pick<IdBusinessV2RechargeJob, 'action' | 'result'>) {
  return (
    isDirectRechargePayment(job) &&
    !directRechargeObserved(job) &&
    object(object(job.result)[privateKey] ?? {}).consumed === true
  );
}

export function directRechargeObserved(job: Pick<IdBusinessV2RechargeJob, 'result'>) {
  return object(object(job.result)[observationKey] ?? {}).observed === true;
}

export function assertDirectRechargeReport(
  job: IdBusinessV2RechargeJob,
  report: Record<string, unknown>,
  replacementCheckoutCreated = false,
  ledgerReport = false
) {
  assertReplacementCheckoutReport(
    job,
    report,
    replacementCheckoutCreated,
    directRechargeObserved(job) || directRechargeAuthorized(job),
    ledgerReport
  );
  if (!isDirectRechargePayment(job)) return;
  const previous = object(job.result);
  if (directRechargeObserved(job)) {
    if (
      report.payment_evidence ||
      (report.payment_status !== undefined && report.payment_status !== 'unknown') ||
      ['subscription_activated', 'paid_pending_activation', 'payment_failed', 'cancelled'].includes(
        String(report.status)
      )
    )
      throw new ConflictException('已观察到未授权付款请求，只能保留未知事实并只读核实');
  } else if (!directRechargeAuthorized(job)) {
    if (
      (report.payment_attempted !== undefined && report.payment_attempted !== false) ||
      (report.payment_requests_sent !== undefined && report.payment_requests_sent !== 0) ||
      (report.confirmation_requests_sent !== undefined &&
        report.confirmation_requests_sent !== 0) ||
      report.payment_evidence
    )
      throw new ConflictException('本次网页充值尚未取得单次付款授权');
    return;
  }
  const identifier = rechargeOperationIdentifier(report);
  if (
    (identifier !== undefined && identifier !== rechargeOperationIdentifier(previous)) ||
    (report.quote_digest !== undefined && report.quote_digest !== previous.quote_digest) ||
    (report.quote !== undefined &&
      rechargeDocumentDigest(report.quote) !== rechargeDocumentDigest(previous.quote)) ||
    (previous.payment_intent_identifier !== undefined &&
      report.payment_intent_identifier !== undefined &&
      previous.payment_intent_identifier !== report.payment_intent_identifier)
  )
    throw new ConflictException('已确认的付款订单或报价不可更换');
}

/** Negative evidence only: an observed website write can lock payment, never authorize it. */
export async function completeDirectRechargeControl(input: {
  tx: V2CommandTransaction;
  job: IdBusinessV2RechargeJob;
  callback: Record<string, unknown>;
  repository: RechargeRepository;
  audit: V2TransactionalAuditService;
}) {
  if (input.callback.type === 'direct_quote')
    return prepareDirectRechargeQuote({ ...input, report: input.callback.result });
  if (input.callback.type !== 'direct_unexpected_payment')
    throw new BadRequestException('网页控制事件无效');
  const { tx, job, repository, audit } = input;
  const report = object(input.callback.result);
  const previous = object(job.result);
  const count = report.confirmation_requests_sent;
  const allowed = new Set([
    'checkout_identifier',
    'upgrade_identifier',
    'processor_entity',
    'account_matched',
    'current_plan_before',
    'target_plan',
    'payment_requests_sent',
    'confirmation_requests_sent'
  ]);
  const identifier = report.upgrade_identifier ?? report.checkout_identifier;
  const bound = rechargeOperationIdentifier(previous);
  if (
    !isDirectRechargePayment(job) ||
    job.state === 'finished' ||
    !job.accountKey ||
    previous.account_matched !== true ||
    report.account_matched !== true ||
    report.target_plan !== job.plan ||
    !['free', 'go', 'plus'].includes(String(report.current_plan_before)) ||
    (previous.current_plan_before !== undefined &&
      previous.current_plan_before !== report.current_plan_before) ||
    Object.keys(report).some((key) => !allowed.has(key)) ||
    !Number.isSafeInteger(count) ||
    Number(count) < 1 ||
    Number(count) > 10 ||
    report.payment_requests_sent !== count ||
    typeof identifier !== 'string' ||
    !identifierPattern.test(identifier) ||
    (bound !== undefined && identifier !== bound) ||
    (previous.operation === 'subscription_upgrade') !==
      (typeof report.upgrade_identifier === 'string') ||
    (report.checkout_identifier !== undefined && report.upgrade_identifier !== undefined)
  )
    throw new ConflictException('未授权付款观察未绑定本次账号与原单');
  const records = await repository.records(tx, job.accountKey);
  if (records.some((record) => record.ownerId !== job.ownerId))
    throw new ForbiddenException('原付款记录归属不一致');
  if (previous.operation !== 'subscription_upgrade') {
    const checkout = object(
      records.find(
        (record) =>
          record.fileKey === `${job.accountKey}${job.plan === 'plus' ? '' : `-${job.plan}`}.json`
      )?.document ?? {}
    );
    if (
      checkout.checkout_identifier !== identifier ||
      (checkout.target_plan ?? 'plus') !== job.plan ||
      (report.processor_entity !== undefined &&
        checkout.processor_entity !== report.processor_entity)
    )
      throw new ConflictException('未授权付款观察缺少本次持久原单');
  } else if (bound !== identifier) throw new ConflictException('升级原单未绑定');
  const fileKey = `payments/${hash(identifier)}.json`;
  const stored = records.find((record) => record.fileKey === fileKey);
  const document = object(stored?.document ?? {});
  if (
    previous.payment_evidence ||
    document.payment_evidence ||
    previous.payment_status === 'paid' ||
    document.payment_status === 'paid'
  )
    throw new ConflictException('已核实的付款事实不可降为未知');
  const observed = object(previous[observationKey] ?? {});
  if (observed.observed === true && Number(observed.observedRequests) >= Number(count))
    return { ok: true as const, paymentLocked: true as const };
  const payment = safeDocument({
    ...previous,
    ...document,
    ...report,
    account_key: job.accountKey,
    status: 'payment_result_unknown',
    stage: 'payment_result_unknown',
    reason: Number(count) > 1 ? 'duplicate_payment_observed' : 'unexpected_payment_observed',
    payment_attempted: true,
    payment_status: 'unknown',
    payment_requests_sent: 1,
    confirmation_requests_sent: 1,
    repeated_payment: 'blocked',
    created_at: document.created_at ?? Math.floor(Date.now() / 1000)
  });
  await repository.saveRecord(tx, {
    accountKey: job.accountKey,
    ownerId: job.ownerId,
    fileKey,
    revision: stored?.revision ?? 0,
    document: payment
  });
  await repository.updateJob(tx, job.id, {
    result: toV2JsonDocument({
      ...previous,
      ...payment,
      [observationKey]: { observed: true, observedRequests: count, identifier }
    })
  });
  await audit.append(tx, {
    userId: job.ownerId,
    module: 'id_business_v2',
    action: 'id_business_v2.auto_recharge.web_direct.unexpected_payment',
    objectType: 'recharge_job',
    objectId: job.id,
    afterData: { operationIdentifier: identifier, observedRequests: Number(count) },
    remark: '官网出现未授权付款请求，仅持久保留未知事实并锁定重试；未放行或核实成功'
  });
  return { ok: true as const, paymentLocked: true as const };
}

export async function prepareDirectRechargeQuote(input: {
  tx: V2CommandTransaction;
  job: IdBusinessV2RechargeJob;
  report: unknown;
  repository: RechargeRepository;
  audit: V2TransactionalAuditService;
}) {
  const { tx, job, repository, audit } = input;
  const previous = object(job.result);
  const report = safeDocument(input.report);
  const identifier = rechargeOperationIdentifier(report);
  if (
    !isDirectRechargePayment(job) ||
    !['running', 'awaiting_confirmation'].includes(job.state) ||
    !job.accountKey ||
    report.account_matched !== true ||
    previous.recheck_only === true ||
    previous.resolution_only === true ||
    (previous.payment_attempted !== undefined && previous.payment_attempted !== false) ||
    (previous.payment_requests_sent !== undefined && previous.payment_requests_sent !== 0) ||
    (previous.confirmation_requests_sent !== undefined &&
      previous.confirmation_requests_sent !== 0) ||
    directRechargeAuthorized(job) ||
    typeof identifier !== 'string' ||
    !identifierPattern.test(identifier) ||
    !digestPattern.test(String(report.billing_fingerprint ?? ''))
  )
    throw new ConflictException('本次网页充值尚未完成账号、账单与原单核实');
  assertDirectRechargeReport(job, report);
  const quote = object(report.quote);
  assertFinalQuote(quote as never, job.plan, report.quote_authority, report);
  const today = object(quote.today);
  if (
    today.currency !== previous.locked_currency ||
    !Number.isSafeInteger(today.amount_minor) ||
    Number(today.amount_minor) <= 0
  )
    throw new ConflictException('官网最终报价币种或金额不一致');
  const bound = rechargeOperationIdentifier(previous);
  if (bound !== undefined && bound !== identifier)
    throw new ConflictException('官网最终报价与本次原单不一致');
  const digest = directQuoteDigest(job, report);
  const nonce = randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + 5 * 60000).toISOString();
  const result = object(
    mergeRechargeCallbackResult(job, {
      ...report,
      status: 'awaiting_confirmation',
      quote_digest: digest,
      confirmation_expires_at: expiresAt,
      payment_attempted: false,
      payment_requests_sent: 0,
      confirmation_requests_sent: 0
    })
  );
  await repository.updateJob(tx, job.id, {
    state: 'awaiting_confirmation',
    result: toV2JsonDocument({
      ...result,
      [privateKey]: {
        nonceHash: hash(nonce),
        quoteDigest: digest,
        checkoutIdentifier: identifier,
        expiresAt,
        consumed: false
      }
    })
  });
  await audit.append(tx, {
    userId: job.ownerId,
    module: 'id_business_v2',
    action: 'id_business_v2.auto_recharge.web_direct.quote_verified',
    objectType: 'recharge_job',
    objectId: job.id,
    afterData: {
      plan: job.plan,
      currency: String(today.currency),
      amountMinor: Number(today.amount_minor)
    },
    remark: '网页直连最终报价已核实，等待本人单次确认；尚未付款'
  });
  return { ok: true as const, nonce, quote_digest: digest, confirmation_expires_at: expiresAt };
}

export async function confirmDirectRechargePayment(input: {
  tx: V2CommandTransaction;
  job: IdBusinessV2RechargeJob | null;
  value: unknown;
  operator: AuthenticatedUser;
  repository: RechargeRepository;
  audit: V2TransactionalAuditService;
}) {
  const { tx, job, operator, repository, audit } = input;
  if (!job || job.ownerId !== operator.id) throw new ForbiddenException('无权确认此充值任务');
  const request = object(input.value);
  if (
    Object.keys(request).some(
      (key) => !['nonce', 'quoteDigest', 'checkoutIdentifier'].includes(key)
    ) ||
    typeof request.nonce !== 'string' ||
    !digestPattern.test(request.nonce) ||
    typeof request.quoteDigest !== 'string' ||
    !digestPattern.test(request.quoteDigest) ||
    typeof request.checkoutIdentifier !== 'string' ||
    !identifierPattern.test(request.checkoutIdentifier)
  )
    throw new BadRequestException('本次付款确认凭据无效');
  const previous = object(job.result);
  const confirmation = object(previous[privateKey] ?? {});
  const nonceHash = hash(request.nonce);
  if (
    !isDirectRechargePayment(job) ||
    job.state !== 'awaiting_confirmation' ||
    !job.accountKey ||
    job.leaseUntil.getTime() <= Date.now() ||
    confirmation.consumed !== false ||
    typeof confirmation.nonceHash !== 'string' ||
    confirmation.nonceHash.length !== nonceHash.length ||
    !timingSafeEqual(Buffer.from(confirmation.nonceHash), Buffer.from(nonceHash)) ||
    confirmation.quoteDigest !== request.quoteDigest ||
    previous.quote_digest !== request.quoteDigest ||
    confirmation.checkoutIdentifier !== request.checkoutIdentifier ||
    rechargeOperationIdentifier(previous) !== request.checkoutIdentifier ||
    !(Date.parse(String(confirmation.expiresAt)) > Date.now()) ||
    previous.account_matched !== true ||
    (previous.payment_attempted !== undefined && previous.payment_attempted !== false) ||
    (previous.payment_requests_sent !== undefined && previous.payment_requests_sent !== 0) ||
    (previous.confirmation_requests_sent !== undefined &&
      previous.confirmation_requests_sent !== 0) ||
    previous.payment_evidence
  )
    throw new ConflictException('本次付款确认已使用、过期或报价已变化，请只读核对原任务');
  assertFinalQuote(object(previous.quote) as never, job.plan, previous.quote_authority, previous);
  if (directQuoteDigest(job, previous) !== request.quoteDigest)
    throw new ConflictException('本次最终报价或账单已变化，请重新核价');
  const payment = safeDocument({
    ...previous,
    account_key: job.accountKey,
    target_plan: job.plan,
    status: 'payment_result_unknown',
    stage: 'payment_confirm',
    payment_attempted: true,
    confirmation_requests_sent: 1,
    payment_requests_sent: 1,
    payment_status: 'unknown',
    created_at: Math.floor(Date.now() / 1000)
  });
  const paymentRecord = await repository.saveRecord(tx, {
    accountKey: job.accountKey,
    ownerId: job.ownerId,
    fileKey: `payments/${hash(request.checkoutIdentifier)}.json`,
    revision: 0,
    document: payment
  });
  await repository.updateJob(tx, job.id, {
    state: 'confirming',
    result: toV2JsonDocument({
      ...previous,
      ...payment,
      manual_confirmation_accepted: true,
      [privateKey]: { ...confirmation, consumed: true, consumedAt: new Date().toISOString() }
    })
  });
  await audit.append(tx, {
    userId: operator.id,
    module: 'id_business_v2',
    action: 'id_business_v2.auto_recharge.web_direct.confirm',
    objectType: 'recharge_job',
    objectId: job.id,
    afterData: { quoteDigest: request.quoteDigest, checkoutIdentifier: request.checkoutIdentifier },
    remark: '单次付款授权已持久保留；断线或回执不明时仅核对原单，不重复放行'
  });
  return {
    id: job.id,
    paymentAllowed: true as const,
    paymentRecordRevision: paymentRecord.revision
  };
}

export async function persistDirectRechargeObservation(input: {
  tx: V2CommandTransaction;
  job: IdBusinessV2RechargeJob;
  report: Record<string, unknown>;
  repository: RechargeRepository;
}) {
  const { tx, job, report, repository } = input;
  if (!directRechargeAuthorized(job) || !job.accountKey) return;
  const previous = object(job.result);
  const identifier = String(rechargeOperationIdentifier(previous));
  const fileKey = `payments/${hash(identifier)}.json`;
  const records = await repository.records(tx, job.accountKey);
  const record = records.find((item) => item.fileKey === fileKey);
  if (!record || record.ownerId !== job.ownerId)
    throw new ConflictException('本次单次付款授权的持久记录缺失');
  const stored = object(record.document);
  if (
    stored.payment_evidence &&
    report.payment_evidence &&
    rechargeDocumentDigest(stored.payment_evidence) !==
      rechargeDocumentDigest(report.payment_evidence)
  )
    throw new ConflictException('已核实的付款凭据不能替换');
  const document = safeDocument({
    ...stored,
    ...report,
    account_key: job.accountKey,
    target_plan: job.plan,
    quote: stored.quote,
    quote_digest: stored.quote_digest,
    payment_attempted: true,
    confirmation_requests_sent: 1,
    payment_requests_sent: 1,
    payment_status: ['paid', 'declined', 'requires_action', 'unknown'].includes(
      String(report.payment_status)
    )
      ? report.payment_status
      : stored.payment_status,
    ...(stored.payment_evidence ? { payment_evidence: stored.payment_evidence } : {})
  });
  if (!projectRechargePaymentRecord(job, fileKey, document))
    throw new ConflictException('官网付款观察未绑定已确认的原单及报价');
  if (document.payment_status === 'paid') {
    const evidence = object(document.payment_evidence);
    const today = object(object(stored.quote).today);
    if (
      evidence.amount_minor !== today.amount_minor ||
      evidence.currency !== today.currency ||
      (stored.operation !== 'subscription_upgrade' &&
        !(
          (evidence.kind === 'checkout_session' && evidence.identifier === identifier) ||
          (evidence.kind === 'payment_intent' &&
            evidence.identifier === stored.payment_intent_identifier)
        ))
    )
      throw new ConflictException('官网实付凭据与已确认的原单金额不一致');
  }
  await repository.saveRecord(tx, {
    accountKey: job.accountKey,
    ownerId: job.ownerId,
    fileKey,
    revision: record.revision,
    document
  });
}

export function confirmDirectRechargeRequest(input: {
  id: string;
  value: unknown;
  operator: AuthenticatedUser;
  repository: RechargeRepository;
  transactions: V2CommandTransactionManager;
  audit: V2TransactionalAuditService;
}) {
  const { id, value, operator, repository, transactions, audit } = input;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !Object.hasOwn(value, 'quoteDigest')
  )
    throw new ConflictException('付款确认必须通过所属本机充值助手执行');
  if (!uuidPattern.test(id)) throw new BadRequestException('任务编号无效');
  return transactions.execute(
    async (tx) => {
      await repository.lock(tx);
      const job = await repository.findJob(tx, id);
      return confirmDirectRechargePayment({ tx, job, value, operator, repository, audit });
    },
    { changedScopes: ['auto-recharge'], requestId: id, operator, retryMode: 'none' }
  );
}

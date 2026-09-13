import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  toV2JsonDocument,
  type V2CommandTransaction,
  type V2TransactionalAuditService
} from '../runtime/public-api';
import { RechargeRepository } from './persistence/recharge.repository';
import { object, uuidPattern } from './recharge-validation';

export interface RechargeResolutionJob {
  id: string;
  ownerId: string;
  plan: string;
  action: string;
  state: string;
  accountKey: string | null;
  createdAt: Date;
  result: unknown;
}

const checkoutPattern = /^(?:cs|oaics)_[A-Za-z0-9_]{1,200}$/;

export function unknownPaymentCanBeResolved(job: RechargeResolutionJob) {
  const result = object(job.result);
  return Boolean(
    ['prepare', 'flow', 'bitbrowser'].includes(job.action) &&
    job.state === 'finished' &&
    typeof job.accountKey === 'string' &&
    /^[a-f0-9]{64}$/.test(job.accountKey) &&
    result.payment_attempted === true &&
    Number(result.confirmation_requests_sent) === 1 &&
    result.payment_status === 'unknown' &&
    !result.payment_evidence &&
    result.status !== 'subscription_activated' &&
    result.payment_outcome !== 'subscription_activated' &&
    result.operator_resolution !== 'confirmed_no_bank_request' &&
    typeof result.checkout_identifier === 'string' &&
    checkoutPattern.test(result.checkout_identifier)
  );
}

export function isFreeAccountVerification(
  source: RechargeResolutionJob,
  verification: RechargeResolutionJob
) {
  const result = object(verification.result);
  return Boolean(
    verification.id !== source.id &&
    verification.ownerId === source.ownerId &&
    verification.accountKey === source.accountKey &&
    verification.state === 'finished' &&
    verification.createdAt.getTime() > source.createdAt.getTime() &&
    result.account_matched === true &&
    result.current_plan === 'free' &&
    result.payment_attempted !== true &&
    Number(result.payment_requests_sent ?? 0) === 0 &&
    Number(result.confirmation_requests_sent ?? 0) === 0 &&
    !result.payment_evidence
  );
}

export function resolvedUnknownPayment(job: RechargeResolutionJob) {
  const result = object(job.result);
  return (
    result.operator_resolution === 'confirmed_no_bank_request' &&
    typeof result.resolution_job_id === 'string' &&
    uuidPattern.test(result.resolution_job_id)
  );
}

export function withResolutionVerification<T extends Record<string, unknown>>(
  result: T,
  job: RechargeResolutionJob,
  jobs: RechargeResolutionJob[]
) {
  if (!unknownPaymentCanBeResolved(job)) return result;
  const verification = jobs.find((candidate) => isFreeAccountVerification(job, candidate));
  return verification ? { ...result, resolution_verification_job_id: verification.id } : result;
}

export async function completeUnknownPaymentResolution(input: {
  tx: V2CommandTransaction;
  job: RechargeResolutionJob;
  callback: Record<string, unknown>;
  repository: RechargeRepository;
  audit: V2TransactionalAuditService;
}) {
  const { tx, job, callback, repository, audit } = input;
  const expectedKeys = new Set([
    'type',
    'plan',
    'accountKey',
    'checkoutIdentifier',
    'sourceJobId',
    'verificationJobId'
  ]);
  const stored = object(job.result);
  const accountKey = callback.accountKey;
  if (
    Object.keys(callback).some((key) => !expectedKeys.has(key)) ||
    Object.keys(callback).length !== expectedKeys.size ||
    job.action !== 'bitbrowser' ||
    stored.resolution_only !== true ||
    callback.plan !== job.plan ||
    typeof accountKey !== 'string' ||
    accountKey !== job.accountKey ||
    callback.checkoutIdentifier !== stored.checkout_identifier ||
    callback.sourceJobId !== stored.source_job_id ||
    callback.verificationJobId !== stored.verification_job_id
  ) {
    throw new BadRequestException('历史付款处理请求不一致');
  }
  const source = await repository.findJob(tx, String(callback.sourceJobId));
  const verification = await repository.findJob(tx, String(callback.verificationJobId));
  if (
    !source ||
    !verification ||
    source.ownerId !== job.ownerId ||
    source.plan !== job.plan ||
    source.accountKey !== accountKey ||
    !unknownPaymentCanBeResolved(source) ||
    !isFreeAccountVerification(source, verification)
  ) {
    throw new ConflictException('历史付款状态或账号核验结果已经变化');
  }
  const resolvedAt = new Date().toISOString();
  const resolution = {
    operator_resolution: 'confirmed_no_bank_request',
    resolved_at: resolvedAt,
    resolution_job_id: job.id,
    source_job_id: source.id,
    verification_job_id: verification.id
  };
  await repository.resolveUnknownPaymentRecords(tx, {
    accountKey,
    checkoutIdentifier: String(callback.checkoutIdentifier),
    plan: source.plan,
    ownerId: job.ownerId,
    resolutionJobId: job.id,
    sourceJobId: source.id,
    verificationJobId: verification.id,
    resolvedAt
  });
  await repository.updateJob(tx, source.id, {
    result: toV2JsonDocument({
      ...object(source.result),
      ...resolution,
      status: 'payment_unknown_resolved'
    })
  });
  await repository.updateJob(tx, job.id, {
    state: 'finished',
    nonceHash: null,
    leaseUntil: new Date(),
    result: toV2JsonDocument({
      ...stored,
      ...resolution,
      status: 'payment_unknown_resolved',
      stage: 'payment_unknown_resolution',
      account_matched: true,
      current_plan: 'free',
      payment_attempted: false,
      confirmation_requests_sent: 0,
      payment_requests_sent: 0
    })
  });
  await audit.append(tx, {
    userId: job.ownerId,
    module: 'id_business_v2',
    action: 'id_business_v2.auto_recharge.payment_resolution.complete',
    objectType: 'recharge_job',
    objectId: source.id,
    beforeData: {
      paymentStatus: String(object(source.result).payment_status ?? 'unknown'),
      paymentAttempted: object(source.result).payment_attempted === true,
      confirmationRequestsSent: Number(object(source.result).confirmation_requests_sent ?? 0)
    },
    afterData: {
      resolution: 'confirmed_no_bank_request',
      resolutionJobId: job.id,
      verificationJobId: verification.id
    },
    remark: '管理员确认银行卡未收到付款请求，保留原付款尝试证据并解除历史锁'
  });
  return { ok: true };
}

import { declinedResolutionEligible } from './recharge-noncharge-proof';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { randomBytes, randomUUID } from 'node:crypto';
import { normalizeV2RechargeConnectorUrl } from '@apple-business/shared';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  toV2JsonDocument,
  type V2CommandTransaction,
  type V2CommandTransactionManager,
  type V2TransactionalAuditService
} from '../runtime/public-api';
import { SHARED_CARD_SCOPES } from '../bank-card-pool/public-api';
import { RechargeRepository } from './persistence/recharge.repository';
import { hash, object, uuidPattern } from './recharge-validation';
import { assertOriginalRechargeConnection } from './recharge-connection-access';
import { validateRechargeNoBankRequest } from './recharge-local-validation';
import type { RechargeSettingsService } from './recharge-settings.service';
import type { BankRechargeCardService } from './bank-recharge-card.service';

export interface RechargeResolutionJob {
  id: string;
  ownerId: string;
  plan: string;
  action: string;
  state: string;
  accountKey: string | null;
  createdAt: Date;
  updatedAt?: Date;
  result: unknown;
}

const checkoutPattern = /^(?:cs|oaics)_[A-Za-z0-9_]{1,200}$/;

export function unknownPaymentCanBeResolved(job: RechargeResolutionJob) {
  const result = object(job.result);
  const hasSingleHistoricalRequest =
    Number(result.confirmation_requests_sent ?? 0) === 1 ||
    (Number(result.confirmation_requests_sent ?? 0) === 0 &&
      Number(result.payment_requests_sent ?? 0) === 1);
  return Boolean(
    ['prepare', 'flow', 'bitbrowser'].includes(job.action) &&
    job.state === 'finished' &&
    typeof job.accountKey === 'string' &&
    /^[a-f0-9]{64}$/.test(job.accountKey) &&
    result.payment_attempted === true &&
    hasSingleHistoricalRequest &&
    (!object(result._direct_unexpected_payment_v1 ?? {}).observed ||
      object(result._direct_unexpected_payment_v1 ?? {}).observedRequests === 1) &&
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
  if (!unknownPaymentCanBeResolved(job) && !declinedResolutionEligible(job)) return result;
  const verification = jobs.find(
    (candidate) =>
      isFreeAccountVerification(job, candidate) &&
      (!declinedResolutionEligible(job) ||
        candidate.createdAt.getTime() > (job.updatedAt ?? job.createdAt).getTime())
  );
  return verification ? { ...result, resolution_verification_job_id: verification.id } : result;
}

export async function startUnknownPaymentResolution(input: {
  sourceId: string;
  value: unknown;
  operator: AuthenticatedUser;
  repository: RechargeRepository;
  transactions: V2CommandTransactionManager;
  audit: V2TransactionalAuditService;
  settings: RechargeSettingsService;
  cards?: BankRechargeCardService;
}) {
  const { sourceId, operator, repository, transactions, audit, settings, cards } = input;
  if (!uuidPattern.test(sourceId)) throw new BadRequestException('原任务编号无效');
  const request = validateRechargeNoBankRequest(input.value);
  const id = randomUUID();
  const agentToken = randomBytes(32).toString('hex');
  return transactions.execute(
    async (tx) => {
      await repository.lock(tx);
      const source = await repository.findJob(tx, sourceId);
      if (!source || source.ownerId !== operator.id)
        throw new ForbiddenException('无权处理此付款记录');
      if (resolvedUnknownPayment(source))
        return {
          alreadyResolved: true as const,
          id: String(object(source.result).resolution_job_id)
        };
      if (!unknownPaymentCanBeResolved(source))
        throw new ConflictException('该记录不是可处理的付款结果未知记录');
      if (await repository.findRunningJob(tx, operator.id))
        throw new ConflictException('本人已有一笔充值任务执行中，请先处理原任务');
      const verification = await repository.findJob(tx, request.verificationJobId);
      if (!verification || !isFreeAccountVerification(source, verification))
        throw new ConflictException('找不到该账号付款后的 Free 状态核验记录');
      const sourceResult = object(source.result);
      const checkoutIdentifier = String(sourceResult.checkout_identifier);
      const direct = request.directMode === true || sourceResult.transport === 'web_direct';
      const runtime = direct ? undefined : await settings.runtime(operator.id);
      if (runtime) assertOriginalRechargeConnection(sourceResult, runtime.connectionMetadata);
      const created = await repository.createJob(tx, {
        id,
        ownerId: operator.id,
        plan: source.plan,
        action: 'bitbrowser',
        state: 'running',
        accountKey: source.accountKey,
        nonceHash: direct ? null : hash(agentToken),
        leaseUntil: new Date(Date.now() + 5 * 60000),
        result: toV2JsonDocument({
          ...runtime?.connectionMetadata,
          ...(direct ? { transport: 'web_direct' } : {}),
          status: direct ? 'running' : 'waiting_local_connector',
          stage: 'connector_dispatch',
          resolution_only: true,
          source_job_id: source.id,
          verification_job_id: verification.id,
          checkout_identifier: checkoutIdentifier,
          target_plan: source.plan,
          payment_attempted: false,
          confirmation_requests_sent: 0,
          payment_requests_sent: 0
        })
      });
      await audit.append(tx, {
        userId: operator.id,
        module: 'id_business_v2',
        action: 'id_business_v2.auto_recharge.payment_resolution.start',
        objectType: 'recharge_job',
        objectId: source.id,
        afterData: {
          resolutionJobId: created.id,
          verificationJobId: verification.id,
          plan: source.plan,
          confirmation: 'confirmed_no_bank_request'
        },
        remark: '创建银行卡未收到付款请求的历史记录处理任务'
      });
      if (direct) {
        await completeUnknownPaymentResolution({
          tx,
          job: created,
          repository,
          audit,
          cards,
          callback: {
            type: 'resolve_unknown_payment',
            plan: source.plan,
            accountKey: source.accountKey,
            checkoutIdentifier,
            sourceJobId: source.id,
            verificationJobId: verification.id
          }
        });
        return { id: created.id, alreadyResolved: true as const };
      }
      return {
        id: created.id,
        plan: source.plan,
        accountKey: source.accountKey!,
        checkoutIdentifier,
        sourceJobId: source.id,
        verificationJobId: verification.id,
        mode: 'resolve_unknown_payment' as const,
        connectorUrl: normalizeV2RechargeConnectorUrl(runtime!.connectorUrl),
        connectorToken: runtime!.connectorToken,
        agentToken
      };
    },
    { changedScopes: SHARED_CARD_SCOPES, requestId: id, operator, retryMode: 'none' }
  );
}

export async function completeUnknownPaymentResolution(input: {
  tx: V2CommandTransaction;
  job: RechargeResolutionJob;
  callback: Record<string, unknown>;
  repository: RechargeRepository;
  audit: V2TransactionalAuditService;
  cards?: import('./bank-recharge-card.service').BankRechargeCardService;
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
  await input.cards?.finishSharedCard(
    tx,
    source.id,
    { payment_attempted: false, payment_requests_sent: 0 },
    false
  );
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

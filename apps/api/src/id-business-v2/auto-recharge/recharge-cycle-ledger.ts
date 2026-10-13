import { BadRequestException, ConflictException } from '@nestjs/common';
import type { IdBusinessV2RechargeJob } from '@prisma/client';
import {
  toV2JsonDocument,
  type V2CommandTransaction,
  type V2TransactionalAuditService
} from '../runtime/public-api';
import type { RechargeRepository } from './persistence/recharge.repository';
import { object } from './recharge-validation';
import { rechargeDocumentDigest } from './recharge-callback-receipts';
import {
  cyclePrivateKey,
  isClosedCycleDocument,
  readCycleState,
  resolvedCyclePayment,
  safeUnpaidCycleCheckout
} from './recharge-cycle-state';

export function isNextCycleCheckoutMarker(
  job: IdBusinessV2RechargeJob,
  callback: Record<string, unknown>
) {
  const document = object(callback.document);
  return (
    Boolean(readCycleState(job)?.grant || document.next_cycle_grant) &&
    document.status === 'checkout_attempted' &&
    document.stage === 'checkout_create'
  );
}

export async function consumeNextCycleMarker(input: {
  tx: V2CommandTransaction;
  job: IdBusinessV2RechargeJob;
  callback: Record<string, unknown>;
  document: Record<string, unknown>;
  repository: RechargeRepository;
  audit: V2TransactionalAuditService;
}) {
  const { job, callback, document, tx, repository, audit } = input;
  const state = readCycleState(job);
  const requested = object(object(callback.document).next_cycle_grant ?? {});
  const grant = state?.grant;
  const isMarker = document.status === 'checkout_attempted' && document.stage === 'checkout_create';
  if (!grant && !Object.keys(requested).length) {
    if (state && isMarker) throw new ConflictException('新周期尚未核实或资格已撤销，不能创建订单');
    return undefined;
  }
  if (!grant) throw new ConflictException('本次任务没有新周期建单资格');
  if (
    isMarker &&
    (callback.fileKey !== grant.checkoutFileKey || callback.revision !== grant.checkoutRevision)
  )
    throw new BadRequestException('新周期首次建单标记与所属原记录不一致');
  if (!Object.keys(requested).length) {
    if (grant.status === 'granted')
      throw new ConflictException('首次新周期建单必须消费所属任务资格');
    if (isMarker) {
      if (state?.markerDigest === rechargeDocumentDigest(document))
        return { revision: state.markerRevision!, replayed: true as const };
      throw new ConflictException('本次新周期已建单，只能恢复原操作');
    }
    return undefined;
  }
  if (
    !isMarker ||
    Object.keys(requested).length !== 5 ||
    Object.keys(requested).some(
      (key) => !['protocol', 'jobId', 'accountKey', 'targetPlan', 'reviewDigest'].includes(key)
    ) ||
    requested.protocol !== 1 ||
    requested.jobId !== job.id ||
    requested.accountKey !== job.accountKey ||
    requested.targetPlan !== job.plan ||
    requested.reviewDigest !== grant.reviewDigest ||
    callback.fileKey !== grant.checkoutFileKey ||
    callback.accountKey !== grant.accountKey ||
    callback.revision !== grant.checkoutRevision ||
    document.target_plan !== job.plan ||
    document.checkout_outcome !== 'unknown' ||
    document.payment_status !== 'not_attempted' ||
    document.account_matched !== true ||
    document.current_plan_before !== 'free' ||
    document.payment_attempted === true ||
    document.payment_evidence ||
    document.checkout_identifier ||
    Number(document.confirmation_requests_sent ?? 0) !== 0 ||
    Number(document.payment_requests_sent ?? 0) !== 0
  )
    throw new BadRequestException('新周期首次建单标记与所属资格不一致');
  const digest = rechargeDocumentDigest(document);
  if (grant.status === 'consumed') {
    if (state.markerDigest === digest)
      return { revision: state.markerRevision!, replayed: true as const };
    throw new ConflictException('本次新周期已建单，只能恢复原操作');
  }
  if (Date.parse(grant.expiresAt) <= Date.now())
    throw new ConflictException('新周期建单资格已过期，请重新核实');
  const records = await repository.records(tx, job.accountKey!);
  if (
    records.some((record) => record.ownerId !== job.ownerId || record.accountKey !== job.accountKey)
  )
    throw new ConflictException('原账户付款记录归属已经变化，不能转换周期');
  const previous = records.find((record) => record.fileKey === grant.checkoutFileKey);
  if (
    (previous?.revision ?? 0) !== grant.checkoutRevision ||
    (previous &&
      (previous.ownerId !== job.ownerId ||
        !isClosedCycleDocument(previous.document, job.accountKey!) ||
        rechargeDocumentDigest(previous.document) !== grant.previousDocumentDigest))
  )
    throw new ConflictException('原周期记录已变化，不能创建第二笔结算');
  if (
    records.some(
      (record) =>
        !record.fileKey.startsWith('history/') &&
        record.fileKey !== grant.checkoutFileKey &&
        !isClosedCycleDocument(record.document, job.accountKey!) &&
        !(record.fileKey.startsWith('payments/')
          ? resolvedCyclePayment(record.document)
          : safeUnpaidCycleCheckout(record.document))
    )
  )
    throw new ConflictException('该账户出现新的未核实操作，只能复查原任务');
  const saved = await repository.saveRecord(tx, {
    accountKey: job.accountKey!,
    ownerId: job.ownerId,
    fileKey: grant.checkoutFileKey,
    revision: grant.checkoutRevision,
    document,
    allowCycleReplacement: true,
    cycleOrigin: {
      protocol: 1,
      job_id: job.id,
      review_digest: grant.reviewDigest,
      ...(grant.previousDocumentDigest
        ? { previous_document_digest: grant.previousDocumentDigest }
        : {})
    }
  });
  const consumed = {
    ...state,
    grant: { ...grant, status: 'consumed' as const },
    review: {
      ...state.review,
      status: 'consumed' as const,
      reason: 'new_checkout_pending' as const
    },
    markerDigest: digest,
    markerRevision: saved.revision
  };
  await repository.updateJob(tx, job.id, {
    result: toV2JsonDocument({
      ...object(job.result),
      ...document,
      checkout_requests_sent: 1,
      [cyclePrivateKey]: consumed,
      cycle_review: consumed.review
    })
  });
  await audit.append(tx, {
    userId: job.ownerId,
    module: 'id_business_v2',
    action: 'id_business_v2.auto_recharge.subscription_cycle.consume',
    objectType: 'recharge_job',
    objectId: job.id,
    afterData: { targetPlan: job.plan, revision: saved.revision },
    remark: '首次新建单标记与周期资格一并保存；不能重复建单，尚未付款'
  });
  return saved;
}

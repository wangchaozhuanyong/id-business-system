import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { V2CommandTransaction, V2TransactionalAuditService } from '../runtime/public-api';
import { toV2JsonDocument } from '../runtime/public-api';
import type { RechargeRepository } from './persistence/recharge.repository';
import { object, uuidPattern } from './recharge-validation';
import { isFreeAccountVerification } from './recharge-resolution';
import { hasDeclineResolution, resolvedDeclinedPayment } from './recharge-noncharge-proof';

export async function resolveDeclinedRecharge(
  tx: V2CommandTransaction,
  repository: RechargeRepository,
  audit: V2TransactionalAuditService,
  sourceId: string,
  value: unknown,
  operator: AuthenticatedUser
) {
  const input = object(value);
  if (
    !uuidPattern.test(sourceId) ||
    input.confirmNoDebit !== true ||
    typeof input.verificationJobId !== 'string' ||
    !uuidPattern.test(input.verificationJobId) ||
    Object.keys(input).some((key) => !['confirmNoDebit', 'verificationJobId'].includes(key))
  )
    throw new BadRequestException('请提供原单核验记录并确认银行没有扣款或待入账交易');
  await repository.lock(tx);
  const source = await repository.findJob(tx, sourceId);
  if (!source || source.ownerId !== operator.id) throw new ForbiddenException('无权处理此付款记录');
  const before = object(source.result);
  if (resolvedDeclinedPayment(before))
    return { id: String(before.resolution_job_id), alreadyResolved: true };
  if (
    source.action !== 'bitbrowser' ||
    source.state !== 'finished' ||
    !source.accountKey ||
    before.recheck_only === true ||
    before.operation === 'subscription_upgrade' ||
    before.payment_status !== 'declined' ||
    before.payment_attempted !== true ||
    before.confirmation_requests_sent !== 1 ||
    before.payment_evidence ||
    hasDeclineResolution(before) ||
    typeof before.checkout_identifier !== 'string' ||
    !/^(?:cs|oaics)_[A-Za-z0-9_]{1,200}$/.test(before.checkout_identifier)
  )
    throw new ConflictException(
      '只有已明确拒付且原订单完整的任务可以核实结束；未知付款不能使用此入口'
    );
  const verification = await repository.findJob(tx, input.verificationJobId);
  if (
    !verification ||
    !isFreeAccountVerification(source, verification) ||
    verification.createdAt.getTime() <= source.updatedAt.getTime()
  )
    throw new ConflictException('需要付款之后同一账号的官网免费版状态核验记录');
  if (await repository.findRunningJob(tx, operator.id))
    throw new ConflictException('当前仍有任务执行中，请结束后再核对原单');
  const id = randomUUID(),
    now = new Date();
  const resolution = {
    operator_resolution: 'confirmed_declined_no_charge',
    resolved_at: now.toISOString(),
    resolution_job_id: id,
    source_job_id: source.id,
    verification_job_id: verification.id
  };
  await repository.resolveUnknownPaymentRecords(tx, {
    accountKey: source.accountKey,
    checkoutIdentifier: before.checkout_identifier,
    plan: source.plan,
    ownerId: source.ownerId,
    resolutionJobId: id,
    sourceJobId: source.id,
    verificationJobId: verification.id,
    resolvedAt: now.toISOString(),
    kind: 'confirmed_declined_no_charge'
  });
  await repository.createJob(tx, {
    id,
    ownerId: operator.id,
    accountKey: source.accountKey,
    plan: source.plan,
    action: 'bitbrowser',
    state: 'finished',
    leaseUntil: now,
    result: toV2JsonDocument({
      ...resolution,
      resolution_only: true,
      status: 'payment_decline_resolved',
      payment_attempted: false,
      confirmation_requests_sent: 0,
      payment_requests_sent: 0
    })
  });
  await repository.updateJob(tx, source.id, {
    result: toV2JsonDocument({ ...before, ...resolution, status: 'payment_decline_resolved' })
  });
  await audit.append(tx, {
    userId: operator.id,
    module: 'id_business_v2',
    action: 'id_business_v2.auto_recharge.decline_resolution.complete',
    objectType: 'recharge_job',
    objectId: source.id,
    afterData: {
      resolutionJobId: id,
      verificationJobId: verification.id,
      bankNoDebitConfirmed: true,
      originalPaymentFactsPreserved: true
    },
    remark: '核对官网拒付、原单和 Free 状态后，由本人确认银行无扣款或待入账交易；保留原付款尝试'
  });
  return { id, alreadyResolved: false };
}

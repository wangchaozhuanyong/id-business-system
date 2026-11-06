import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { V2CommandTransaction, V2TransactionalAuditService } from '../runtime/public-api';
import { toV2JsonDocument } from '../runtime/public-api';
import type { RechargeRepository } from './persistence/recharge.repository';
import { object, uuidPattern } from './recharge-validation';
import { isFreeAccountVerification } from './recharge-resolution';
import {
  declinedResolutionEligible,
  resolvedDeclinedPayment,
  verificationFailureResolutionEligible
} from './recharge-noncharge-proof';
import type { BankRechargeCardService } from './bank-recharge-card.service';
import { settleResolvedRechargeCard } from './persistence/recharge-payment-hold.repository';

export async function resolveDeclinedRecharge(
  tx: V2CommandTransaction,
  repository: RechargeRepository,
  audit: V2TransactionalAuditService,
  sourceId: string,
  value: unknown,
  operator: AuthenticatedUser,
  cards?: BankRechargeCardService
) {
  const input = object(value);
  if (
    !uuidPattern.test(sourceId) ||
    input.confirmNoDebit !== true ||
    typeof input.verificationJobId !== 'string' ||
    !uuidPattern.test(input.verificationJobId) ||
    Object.keys(input).some(
      (key) =>
        !['confirmNoDebit', 'verificationJobId', 'verificationFailureObservation'].includes(key)
    )
  )
    throw new BadRequestException('请提供原单核验记录并确认银行没有扣款或待入账交易');
  await repository.lock(tx);
  const source = await repository.findJob(tx, sourceId);
  if (!source || source.ownerId !== operator.id) throw new ForbiddenException('无权处理此付款记录');
  const before = object(source.result);
  if (resolvedDeclinedPayment(before)) {
    await settleResolvedRechargeCard(tx, source, cards);
    if (cards)
      await repository.updateJob(
        tx,
        source.id,
        { result: toV2JsonDocument(object(source.result)) },
        { factsOnly: true }
      );
    return { id: String(before.resolution_job_id ?? source.id), alreadyResolved: true };
  }
  const verificationFailure = verificationFailureResolutionEligible(source);
  if (!declinedResolutionEligible(source) && !verificationFailure)
    throw new ConflictException('只有明确拒付或符合支付方式验证失败人工核实条件的完整原单可以结束');
  const capturedFailure = before.reason === 'official_payment_method_verification_failed';
  let observedFailure = false;
  if (input.verificationFailureObservation !== undefined) {
    const observation = object(input.verificationFailureObservation);
    if (
      !verificationFailure ||
      Object.keys(observation).length !== 2 ||
      Object.keys(observation).some(
        (key) => !['checkoutIdentifier', 'officialMessage'].includes(key)
      ) ||
      observation.checkoutIdentifier !== before.checkout_identifier ||
      observation.officialMessage !== 'payment_method_verification_failed'
    )
      throw new BadRequestException('请仅确认本人在该原单看到的官网支付方式验证失败提示');
    observedFailure = true;
  }
  if (verificationFailure && !capturedFailure && !observedFailure)
    throw new ConflictException('原任务未记录官网验证失败，需要本人对绑定原单明确声明观察结果');
  const verification = await repository.findJob(tx, input.verificationJobId);
  if (
    !verification ||
    !isFreeAccountVerification(source, verification) ||
    (verificationFailure &&
      (object(verification.result).recheck_only === true ||
        object(verification.result).resolution_only === true)) ||
    verification.createdAt.getTime() <= source.updatedAt.getTime()
  )
    throw new ConflictException('需要付款之后同一账号的官网免费版状态核验记录');
  if (await repository.findRunningJob(tx, operator.id))
    throw new ConflictException('当前仍有任务执行中，请结束后再核对原单');
  const id = randomUUID(),
    now = new Date();
  const resolution = {
    operator_resolution: verificationFailure
      ? ('confirmed_verification_failed_no_charge' as const)
      : ('confirmed_declined_no_charge' as const),
    ...(verificationFailure
      ? {
          resolution_basis: capturedFailure
            ? ('captured_official_failure' as const)
            : ('operator_observed_official_failure' as const)
        }
      : {}),
    resolved_at: now.toISOString(),
    resolution_job_id: id,
    source_job_id: source.id,
    verification_job_id: verification.id
  };
  await repository.resolveUnknownPaymentRecords(tx, {
    accountKey: source.accountKey!,
    checkoutIdentifier: String(before.checkout_identifier),
    plan: source.plan,
    ownerId: source.ownerId,
    resolutionJobId: id,
    sourceJobId: source.id,
    verificationJobId: verification.id,
    resolvedAt: now.toISOString(),
    kind: resolution.operator_resolution,
    ...(resolution.resolution_basis ? { resolutionBasis: resolution.resolution_basis } : {})
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
      status: verificationFailure ? 'payment_verification_resolved' : 'payment_decline_resolved',
      payment_attempted: false,
      confirmation_requests_sent: 0,
      payment_requests_sent: 0
    })
  });
  await settleResolvedRechargeCard(tx, source, cards);
  await repository.updateJob(tx, source.id, {
    result: toV2JsonDocument({
      ...object(source.result),
      ...resolution,
      ...(!verificationFailure ? { status: 'payment_decline_resolved' } : {})
    })
  });
  await audit.append(tx, {
    userId: operator.id,
    module: 'id_business_v2',
    action: verificationFailure
      ? 'id_business_v2.auto_recharge.verification_failure_resolution.complete'
      : 'id_business_v2.auto_recharge.decline_resolution.complete',
    objectType: 'recharge_job',
    objectId: source.id,
    afterData: toV2JsonDocument({
      resolutionJobId: id,
      verificationJobId: verification.id,
      bankNoDebitConfirmed: true,
      ...(verificationFailure
        ? {
            checkoutIdentifier: String(before.checkout_identifier),
            resolutionBasis: resolution.resolution_basis,
            officialFailureCaptured: capturedFailure,
            operatorObservedOfficialFailure: observedFailure
          }
        : {}),
      originalPaymentFactsPreserved: true
    }),
    remark: verificationFailure
      ? '核对绑定原单及付款后免费状态，由本人确认官网支付方式验证失败且银行无扣款或待入账；原付款事实保持不变'
      : '核对官网拒付、原单和 Free 状态后，由本人确认银行无扣款或待入账交易；保留原付款尝试'
  });
  return { id, alreadyResolved: false };
}

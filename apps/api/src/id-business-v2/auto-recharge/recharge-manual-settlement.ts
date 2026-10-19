import {
  findManualSettlementJobs,
  writeManualSettlementRecord
} from './persistence/recharge-manual-settlement.repository';
import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  toV2JsonDocument,
  type V2CommandTransaction,
  type V2TransactionalAuditService
} from '../runtime/public-api';
import type { RechargeRepository } from './persistence/recharge.repository';
import type { BankRechargeOrderService } from './bank-recharge-order.service';
import type { BankRechargeCardService } from './bank-recharge-card.service';
import { object, hash, uuidPattern } from './recharge-validation';
import { rechargeOperationIdentifier } from './recharge-upgrade-protocol';
import { manualRechargeSettlement } from './recharge-manual-settlement-proof';
import {
  recoverRechargeCardAttempt,
  CARD_ATTEMPT_KEY
} from './persistence/recharge-payment-hold.repository';

function safeReference(value: unknown, label: string) {
  if (
    typeof value !== 'string' ||
    !(
      label === '核对说明'
        ? /^[\p{L}\p{N}_. ，。-]{1,120}$/u
        : /^[A-Za-z0-9][A-Za-z0-9_. -]{0,119}$/
    ).test(value) ||
    /(?:token|cookie|session|password|secret)/i.test(value) ||
    /(?:\d[ -]*){12,}/.test(value)
  )
    throw new BadRequestException(
      `${label}请只填写凭据编号或简短核对说明，不填卡号、网址或登录资料`
    );
  return value;
}

export async function settleRechargeManually(input: {
  tx: V2CommandTransaction;
  repository: RechargeRepository;
  orders: BankRechargeOrderService;
  cards: BankRechargeCardService;
  audit: V2TransactionalAuditService;
  id: string;
  value: unknown;
  operator: AuthenticatedUser;
}) {
  const { tx, repository, orders, cards, audit, id, operator } = input;
  const value = object(input.value);
  const common = [
    'outcome',
    'operationId',
    'expectedUpdatedAt',
    'identifier',
    'confirmed',
    'reason'
  ];
  const successKeys = [
    'amount',
    'currency',
    'evidenceRef',
    'openedAt',
    'dueAt',
    'subscriptionConfirmed'
  ];
  const failureKeys = ['noDebitConfirmed', 'notActivatedConfirmed'];
  if (
    !uuidPattern.test(id) ||
    typeof value.operationId !== 'string' ||
    !uuidPattern.test(value.operationId) ||
    !['success', 'failure'].includes(String(value.outcome)) ||
    value.confirmed !== true ||
    Object.keys(value).some(
      (key) =>
        ![...common, ...(value.outcome === 'success' ? successKeys : failureKeys)].includes(key)
    )
  )
    throw new BadRequestException('人工结单资料无效');
  const reason = safeReference(value.reason, '核对说明');
  const success = value.outcome === 'success';
  if (
    success
      ? value.subscriptionConfirmed !== true
      : value.noDebitConfirmed !== true || value.notActivatedConfirmed !== true
  )
    throw new BadRequestException('请本人核对订阅状态以及银行扣款或待入账情况');
  const evidenceRef = success ? safeReference(value.evidenceRef, '付款凭据') : undefined;
  const digest = hash(
    JSON.stringify(
      Object.entries({ ...value, reason, evidenceRef }).sort(([a], [b]) => a.localeCompare(b))
    )
  );
  await repository.lock(tx);
  const source = await repository.findJob(tx, id);
  if (!source || source.ownerId !== operator.id) throw new ForbiddenException('无权处理此充值任务');
  const before = object(source.result),
    prior = manualRechargeSettlement(before);
  if (prior) {
    if (
      prior.sourceJobId !== id ||
      prior.requestDigest !== digest ||
      prior.operationId !== value.operationId
    )
      throw new ConflictException('原任务已经结单；重复或相反的确认内容不能覆盖原结果');
    return { id, orderId: prior.orderId as string | undefined, alreadyResolved: true };
  }
  const identifier = rechargeOperationIdentifier(before);
  if (
    source.action !== 'bitbrowser' ||
    before.mode === 'open_browser' ||
    before.recheck_only ||
    before.resolution_only ||
    before.operator_resolution ||
    !source.accountKey ||
    source.updatedAt.toISOString() !== value.expectedUpdatedAt ||
    (source.state !== 'finished' && source.leaseUntil.getTime() > Date.now()) ||
    typeof identifier !== 'string' ||
    identifier !== value.identifier ||
    !/^(?:(?:cs|oaics)_[A-Za-z0-9_]{1,200}|upg_[a-f0-9]{32})$/.test(identifier) ||
    before.payment_attempted !== true ||
    before.confirmation_requests_sent !== 1
  )
    throw new ConflictException('原任务已变化、仍在执行或没有可核对的付款；请刷新原记录');
  const records = await repository.records(tx, source.accountKey);
  const relevant = records.filter(
    (r) =>
      !r.fileKey.startsWith('history/') &&
      rechargeOperationIdentifier(object(r.document)) === identifier
  );
  const payment = relevant.filter((r) => r.fileKey === `payments/${hash(identifier)}.json`);
  const checkout = relevant.filter(
    (r) =>
      r.fileKey === `${source.accountKey}${source.plan === 'plus' ? '' : `-${source.plan}`}.json`
  );
  if (
    payment.length !== 1 ||
    checkout.length !== 1 ||
    relevant.length !== 2 ||
    relevant.some(
      (r) =>
        r.ownerId !== source.ownerId ||
        (object(r.document).target_plan ?? 'plus') !== source.plan ||
        object(r.document).manual_settlement ||
        object(r.document).operator_resolution
    ) ||
    object(payment[0]!.document).account_key !== source.accountKey ||
    object(payment[0]!.document).payment_attempted !== true ||
    object(payment[0]!.document).confirmation_requests_sent !== 1
  )
    throw new ConflictException('原账号付款和结账记录不唯一或已处理，不能人工覆盖');
  if (
    !success &&
    [before, ...relevant.map((r) => object(r.document))].some(
      (r) =>
        r.payment_evidence ||
        r.payment_status === 'paid' ||
        r.status === 'subscription_activated' ||
        r.payment_outcome === 'subscription_activated'
    )
  )
    throw new ConflictException('已有付款或开通成功证据，不能确认失败；请核对原充值订单');
  if (!success) await orders.assertNoOrderForManualFailure(tx, source, identifier);
  const jobs = await findManualSettlementJobs(tx, source);
  if (jobs.length > 500) throw new ConflictException('同账号历史过多，请定向核对原任务');
  const relatedJobs = jobs.filter(
    (job) => rechargeOperationIdentifier(object(job.result)) === identifier
  );
  if (
    relatedJobs.some(
      (job) => job.id !== id && job.state !== 'finished' && job.leaseUntil.getTime() > Date.now()
    )
  )
    throw new ConflictException('该原单仍有复查执行中，请结束后再确认结果');
  if (
    relatedJobs.some(
      (job) => object(job.result).manual_settlement || object(job.result).operator_resolution
    )
  )
    throw new ConflictException('同一原单已有处理记录，请刷新核对');
  const attempt = await recoverRechargeCardAttempt(tx, source, cards);
  if (!attempt || attempt.outcome === 'paid' || (success && attempt.outcome !== 'pending'))
    throw new ConflictException('原银行卡付款额度记录未核实或已结算');
  await cards.assertSharedAttemptBinding(tx, source.cardId, attempt);
  const order = success
    ? await orders.recordManualSettlement(tx, source, {
        identifier,
        evidenceRef: evidenceRef!,
        amount: String(value.amount ?? ''),
        currency: String(value.currency ?? ''),
        openedAt: String(value.openedAt ?? ''),
        dueAt: String(value.dueAt ?? '')
      })
    : undefined;
  const now = new Date();
  const settlement = {
    version: 1,
    outcome: success ? 'success' : 'failure',
    operationId: value.operationId,
    sourceJobId: id,
    operatorId: operator.id,
    accountKey: source.accountKey,
    identifier,
    plan: source.plan,
    resolvedAt: now.toISOString(),
    requestDigest: digest,
    ...(order ? { orderId: order.id } : {})
  };
  const settled = await cards.finishSharedCard(
    tx,
    id,
    { payment_attempted: false, payment_requests_sent: 0 },
    success,
    attempt
  );
  if (
    !settled ||
    (success ? settled.outcome !== 'paid' : !['resolved', 'declined'].includes(settled.outcome))
  )
    throw new ConflictException('银行卡额度结算未完成，原单保持待核实');
  for (const record of relevant) await writeManualSettlementRecord(tx, record, settlement);
  // Keep every observed request/response fact; only add a human conclusion.
  for (const job of new Map([
    [source.id, source],
    ...relatedJobs.map((job) => [job.id, job] as const)
  ]).values())
    await repository.updateJob(tx, job.id, {
      state: 'finished',
      leaseUntil: now,
      result: toV2JsonDocument({
        ...object(job.result),
        manual_settlement: settlement,
        ...(job.id === id && settled ? { [CARD_ATTEMPT_KEY]: settled } : {})
      })
    });
  await audit.append(tx, {
    userId: operator.id,
    module: 'id_business_v2',
    action: 'id_business_v2.auto_recharge.manual_settlement.complete',
    objectType: 'recharge_job',
    objectId: id,
    afterData: toV2JsonDocument({ ...settlement, reason, ...(evidenceRef ? { evidenceRef } : {}) }),
    remark: success
      ? '人工核实付款及开通成功，关联充值订单进入现有记账流程'
      : '人工核实未开通且无扣款或待入账，结束原单防重并释放未决额度；原始付款事实保留'
  });
  return { id, orderId: order?.id, alreadyResolved: false };
}

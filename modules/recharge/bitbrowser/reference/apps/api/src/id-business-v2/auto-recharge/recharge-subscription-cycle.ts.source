import { BadRequestException, ConflictException, ForbiddenException } from '@nestjs/common';
import type { IdBusinessV2RechargeJob } from '@prisma/client';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  toV2JsonDocument,
  type V2CommandTransaction,
  type V2CommandTransactionManager,
  type V2TransactionalAuditService
} from '../runtime/public-api';
import type { RechargeRepository } from './persistence/recharge.repository';
import { hash, object, uuidPattern } from './recharge-validation';
import { rechargeDocumentDigest } from './recharge-callback-receipts';
import {
  automaticallyEnded,
  checkoutCycleFileKey,
  cycleContext,
  cyclePrivateKey,
  cycleProtocolEnabled,
  cycleSources,
  readCycleState,
  subscriptionInspection,
  originalCycleDocument,
  safeUnpaidCycleCheckout,
  type CyclePrivateState,
  type CycleRecord
} from './recharge-cycle-state';

type Dependencies = {
  tx: V2CommandTransaction;
  job: IdBusinessV2RechargeJob;
  repository: RechargeRepository;
  audit: V2TransactionalAuditService;
};

async function saveState(input: Dependencies, state: CyclePrivateState) {
  await input.repository.updateJob(input.tx, input.job.id, {
    result: toV2JsonDocument({
      ...object(input.job.result ?? {}),
      [cyclePrivateKey]: state,
      cycle_review: state.review,
      subscription_inspection: state.inspection
    })
  });
}

function preparationResponse(
  job: IdBusinessV2RechargeJob,
  state: CyclePrivateState,
  records?: CycleRecord[]
) {
  const updated = { ...job, result: { ...object(job.result ?? {}), [cyclePrivateKey]: state } };
  return {
    cycleReview: state.review,
    ...(records ? { records, nextCycleContext: cycleContext(updated as never, records, 1) } : {})
  };
}

async function revoke(
  input: Dependencies,
  state: CyclePrivateState,
  reason: 'review_expired' | 'subscription_state_changed'
) {
  const next: CyclePrivateState = {
    ...state,
    grant:
      state.grant?.status === 'granted'
        ? {
            ...state.grant,
            expiresAt: new Date(
              Math.min(Date.parse(state.grant.expiresAt), Date.now())
            ).toISOString()
          }
        : undefined,
    review: { ...state.review, status: 'revoked', reason }
  };
  await saveState(input, next);
  return preparationResponse(input.job, next);
}

function assertSourcesUnchanged(
  state: CyclePrivateState,
  records: CycleRecord[],
  job: IdBusinessV2RechargeJob
) {
  if (rechargeDocumentDigest(state.sources) !== rechargeDocumentDigest(cycleSources(records, job)))
    throw new ConflictException('原付款记录已经变化，请重新核实原任务');
}

function assertFreshFree(inspection: CyclePrivateState['inspection'], state?: CyclePrivateState) {
  return (
    inspection.current_plan === 'free' &&
    inspection.has_active_subscription === false &&
    (!state || Date.parse(inspection.checked_at) > Date.parse(state.inspection.checked_at))
  );
}

function knownFuturePeriod(
  sources: CyclePrivateState['sources'],
  inspection: CyclePrivateState['inspection']
) {
  return (
    sources.some(
      (source) =>
        source.subscriptionPeriod &&
        Date.parse(source.subscriptionPeriod.end) > Date.parse(inspection.checked_at)
    ) ||
    Boolean(
      inspection.previous_period &&
      Date.parse(inspection.previous_period.end) > Date.parse(inspection.checked_at)
    )
  );
}

async function archiveRecord(
  input: Dependencies,
  record: CycleRecord,
  review: CyclePrivateState['review'],
  manual: boolean,
  records: CycleRecord[]
) {
  const original = originalCycleDocument(record.document);
  const digest = rechargeDocumentDigest(original);
  const archiveKey = `history/${digest}.json`;
  const existing = records.find((item) => item.fileKey === archiveKey);
  if (
    existing &&
    (existing.ownerId !== input.job.ownerId || rechargeDocumentDigest(existing.document) !== digest)
  )
    throw new ConflictException('旧周期归档发生冲突，保留原付款记录');
  if (!existing) {
    await input.repository.createCycleArchive(input.tx, input.job, archiveKey, original);
    if (!records.some((item) => item.fileKey === archiveKey))
      records.push({ ...record, fileKey: archiveKey, revision: 1, document: original });
  }
  await input.repository.closeCycleRecord(input.tx, input.job, record, {
    protocol: 1,
    status: 'closed',
    source_job_id: input.job.id,
    account_key: input.job.accountKey,
    target_plan: input.job.plan,
    review_digest: review.reviewDigest,
    closed_at: new Date().toISOString(),
    original_document_digest: digest,
    ...(review.previousPeriodEnd ? { previous_period_end: review.previousPeriodEnd } : {}),
    ...(manual ? { manual_previous_cycle_ended: true } : {})
  });
}

export async function prepareNextSubscriptionCycle(
  input: Dependencies & { callback: Record<string, unknown> }
) {
  const { tx, job, repository, audit, callback } = input;
  if (
    !cycleProtocolEnabled(job, callback.subscriptionCycleProtocol) ||
    callback.accountKey !== job.accountKey
  )
    throw new ConflictException('当前客户端与充值助手尚未共同支持新周期核实');
  if (!['inspect', 'status', 'commit'].includes(String(callback.phase)))
    throw new BadRequestException('订阅周期核实阶段无效');
  const allowed = [
    'type',
    'subscriptionCycleProtocol',
    'accountKey',
    'phase',
    ...(callback.phase === 'status' ? ['reviewDigest'] : ['subscription_inspection']),
    ...(callback.phase === 'commit' ? ['reviewDigest'] : [])
  ];
  if (Object.keys(callback).some((key) => !allowed.includes(key)))
    throw new BadRequestException('订阅周期核实请求包含未知字段');
  const previous = object(job.result ?? {});
  if (
    previous.payment_attempted === true ||
    previous.payment_evidence ||
    Number(previous.payment_requests_sent) > 0 ||
    Number(previous.confirmation_requests_sent) > 0
  )
    throw new ConflictException('本次任务已有付款事实，只能核查原订单');
  const state = readCycleState(job);
  if (state?.grant?.status === 'consumed')
    return preparationResponse(job, state, await repository.records(tx, job.accountKey!));
  if (
    callback.phase !== 'inspect' &&
    (!state || callback.reviewDigest !== state.review.reviewDigest)
  )
    throw new ConflictException('订阅周期核实资料已变化');
  if (
    state?.grant &&
    callback.phase === 'commit' &&
    state.commitDigest === rechargeDocumentDigest(callback)
  )
    return preparationResponse(job, state, await repository.records(tx, job.accountKey!));
  if (state && Date.parse(state.review.expiresAt) <= Date.now() && callback.phase !== 'inspect')
    return state.review.status === 'revoked'
      ? preparationResponse(job, state)
      : revoke(input, state, 'review_expired');
  if (callback.phase === 'status') return preparationResponse(job, state!);
  const inspection = subscriptionInspection(callback.subscription_inspection, job);
  if (state && !assertFreshFree(inspection))
    return revoke(input, state, 'subscription_state_changed');
  const records = await repository.records(tx, job.accountKey!);
  const sources = cycleSources(records, job);
  if (!sources.length) throw new ConflictException('不存在可核实的完整旧付款周期');
  if (state?.grant?.status === 'granted') {
    // Conversion already committed, but no marker/create was recorded. A fresh
    // official read renews only this conversion; history and manual proof stay put.
    assertSourcesUnchanged(state, records, job);
    if (
      !assertFreshFree(inspection, state) ||
      knownFuturePeriod(sources, inspection) ||
      (!state.manualConfirmed && !automaticallyEnded(sources, inspection))
    )
      return revoke(input, state, 'subscription_state_changed');
    const checkout = records.find((record) => record.fileKey === state.grant!.checkoutFileKey);
    if (
      (checkout?.revision ?? 0) !== state.grant.checkoutRevision ||
      (checkout && rechargeDocumentDigest(checkout.document) !== state.grant.previousDocumentDigest)
    )
      throw new ConflictException('本周期已经写入新建单标记，只能复查原操作');
    const expiresAt = new Date(Date.now() + 5 * 60000).toISOString();
    const renewed: CyclePrivateState = {
      ...state,
      inspection,
      review: { ...state.review, expiresAt, status: 'ready' },
      grant: { ...state.grant, expiresAt }
    };
    await saveState(input, renewed);
    return preparationResponse(job, renewed, records);
  }
  if (callback.phase === 'inspect') {
    if (
      state &&
      Date.parse(state.review.expiresAt) > Date.now() &&
      state.review.status !== 'revoked'
    )
      return preparationResponse(job, state);
    const automatic = automaticallyEnded(sources, inspection);
    const eligible = assertFreshFree(inspection) && !knownFuturePeriod(sources, inspection);
    const expiresAt = new Date(Date.now() + 5 * 60000).toISOString();
    const periodEnds = sources
      .map((source) => source.subscriptionPeriod?.end)
      .filter((end): end is string => Boolean(end));
    const previousPeriodEnd = periodEnds.sort().at(-1) ?? inspection.previous_period?.end;
    const review = {
      protocol: 1 as const,
      status: !eligible
        ? ('revoked' as const)
        : automatic
          ? ('ready' as const)
          : ('awaiting_previous_cycle_confirmation' as const),
      reviewDigest: hash(
        rechargeDocumentDigest({
          jobId: job.id,
          accountKey: job.accountKey,
          targetPlan: job.plan,
          sources,
          inspection,
          expiresAt
        })
      ),
      expiresAt,
      ...(previousPeriodEnd ? { previousPeriodEnd } : {}),
      reason: !eligible
        ? ('subscription_state_changed' as const)
        : automatic
          ? ('previous_period_ended' as const)
          : ('previous_period_unavailable' as const)
    };
    const candidate = records.find(
      (record) => record.fileKey === checkoutCycleFileKey(job.accountKey!, job.plan)
    );
    const next: CyclePrivateState = {
      sources,
      inspection,
      review,
      ...(candidate && safeUnpaidCycleCheckout(candidate.document)
        ? {
            checkoutCandidate: {
              fileKey: candidate.fileKey,
              revision: candidate.revision,
              documentDigest: rechargeDocumentDigest(candidate.document)
            }
          }
        : {})
    };
    await saveState(input, next);
    await audit.append(tx, {
      userId: job.ownerId,
      module: 'id_business_v2',
      action: 'id_business_v2.auto_recharge.subscription_cycle.inspect',
      objectType: 'recharge_job',
      objectId: job.id,
      afterData: { status: review.status, sources: sources.length, automatic },
      remark: '只读核实旧订阅周期，尚未建单或付款'
    });
    return preparationResponse(job, next);
  }
  if (!state || state.review.status !== 'ready')
    throw new ConflictException('旧订阅周期尚未核实结束');
  if (Date.parse(inspection.checked_at) <= Date.parse(state.inspection.checked_at))
    throw new ConflictException('恢复前必须重新读取官网当前订阅状态');
  assertSourcesUnchanged(state, records, job);
  if (
    knownFuturePeriod(sources, inspection) ||
    (!state.manualConfirmed && !automaticallyEnded(sources, inspection))
  )
    return revoke(input, state, 'subscription_state_changed');
  const targetKey = checkoutCycleFileKey(job.accountKey!, job.plan);
  for (const source of sources) {
    const record = records.find((record) => record.fileKey === source.fileKey)!;
    await archiveRecord(input, record, state.review, state.manualConfirmed === true, records);
  }
  if (state.checkoutCandidate) {
    const candidate = records.find((record) => record.fileKey === state.checkoutCandidate!.fileKey);
    if (
      !candidate ||
      candidate.revision !== state.checkoutCandidate.revision ||
      rechargeDocumentDigest(candidate.document) !== state.checkoutCandidate.documentDigest ||
      !safeUnpaidCycleCheckout(candidate.document)
    )
      throw new ConflictException('旧未付款原单状态已经变化，不能创建新周期');
    await archiveRecord(input, candidate, state.review, state.manualConfirmed === true, records);
  }
  await repository.closeCycleJobs(
    tx,
    job,
    sources.map((source) => source.operationIdentifier),
    state.review.reviewDigest
  );
  const afterRecords = await repository.records(tx, job.accountKey!);
  const checkout = afterRecords.find((record) => record.fileKey === targetKey);
  const next: CyclePrivateState = {
    ...state,
    inspection,
    sources: cycleSources(afterRecords, job),
    commitDigest: rechargeDocumentDigest(callback),
    grant: {
      protocol: 1,
      jobId: job.id,
      accountKey: job.accountKey!,
      targetPlan: job.plan as never,
      reviewDigest: state.review.reviewDigest,
      expiresAt: state.review.expiresAt,
      status: 'granted',
      checkoutFileKey: targetKey,
      checkoutRevision: checkout?.revision ?? 0,
      ...(checkout ? { previousDocumentDigest: rechargeDocumentDigest(checkout.document) } : {})
    }
  };
  const result: Record<string, unknown> = {
    ...previous,
    [cyclePrivateKey]: next,
    cycle_review: next.review,
    subscription_inspection: inspection
  };
  for (const key of [
    'checkout_identifier',
    'operation',
    'upgrade_identifier',
    'upgrade_invoice_identifier',
    'upgrade_payment_intent_identifier',
    'current_plan_before',
    'quote',
    'quote_digest',
    'quote_authority',
    'confirmation_expires_at'
  ])
    delete result[key];
  await repository.updateJob(tx, job.id, { result: toV2JsonDocument(result) });
  await audit.append(tx, {
    userId: job.ownerId,
    module: 'id_business_v2',
    action: 'id_business_v2.auto_recharge.subscription_cycle.commit',
    objectType: 'recharge_job',
    objectId: job.id,
    afterData: {
      sources: sources.length,
      targetPlan: job.plan,
      manual: state.manualConfirmed === true
    },
    remark: '旧周期已归档，仅授予本次任务一次新建单资格；未授权付款'
  });
  return preparationResponse(job, next, afterRecords);
}

export async function confirmNextSubscriptionCycle(
  id: string,
  value: unknown,
  operator: AuthenticatedUser,
  dependencies: {
    repository: RechargeRepository;
    transactions: V2CommandTransactionManager;
    audit: V2TransactionalAuditService;
  }
) {
  const callback = object(value);
  if (
    !uuidPattern.test(id) ||
    callback.confirmedPreviousCycleEnded !== true ||
    typeof callback.reviewDigest !== 'string' ||
    !/^[a-f0-9]{64}$/.test(callback.reviewDigest) ||
    Object.keys(callback).some(
      (key) => !['reviewDigest', 'confirmedPreviousCycleEnded'].includes(key)
    )
  )
    throw new BadRequestException('请明确核实旧周期已结束');
  return dependencies.transactions.execute(
    async (tx) => {
      await dependencies.repository.lock(tx);
      const job = await dependencies.repository.active(tx, id);
      if (job.ownerId !== operator.id || !cycleProtocolEnabled(job, 1))
        throw new ForbiddenException('无权核实此任务旧周期');
      const state = readCycleState(job);
      if (
        !state ||
        state.review.reviewDigest !== callback.reviewDigest ||
        Date.parse(state.review.expiresAt) <= Date.now() ||
        state.inspection.current_plan !== 'free' ||
        state.inspection.has_active_subscription !== false
      )
        throw new ConflictException('旧周期核实已过期或官网订阅状态不符');
      if (state.manualConfirmed && state.review.status === 'ready')
        return preparationResponse(job, state);
      if (state.review.status !== 'awaiting_previous_cycle_confirmation')
        throw new ConflictException('当前任务不需要人工核实旧周期');
      assertSourcesUnchanged(
        state,
        await dependencies.repository.records(tx, job.accountKey!),
        job
      );
      const next: CyclePrivateState = {
        ...state,
        manualConfirmed: true,
        review: { ...state.review, status: 'ready', manualPreviousCycleEnded: true }
      };
      await saveState({ ...dependencies, tx, job }, next);
      await dependencies.audit.append(tx, {
        userId: operator.id,
        module: 'id_business_v2',
        action: 'id_business_v2.auto_recharge.subscription_cycle.confirm_previous',
        objectType: 'recharge_job',
        objectId: id,
        afterData: { targetPlan: job.plan },
        remark: '原操作人核实旧周期结束；未授权扣款，仍须核对官网现状和报价'
      });
      return preparationResponse(job, next);
    },
    { changedScopes: ['auto-recharge'], requestId: id, operator, retryMode: 'none' }
  );
}

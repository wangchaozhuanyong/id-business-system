import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { Prisma, type OnlineRechargeTask } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import { FieldEncryptionService } from '../../../common/crypto/field-encryption.service';
import type { V2CommandTransaction } from '../../runtime/public-api';
import { OnlineRechargeRepository } from './online-recharge.repository';
import { OnlineRechargeEphemeralCredentials } from '../ephemeral-credentials.service';
import { OnlineRechargeSettingsService } from '../settings.service';
import {
  ONLINE_RECHARGE_CONFIRMED_PLAN_NAMES,
  ONLINE_RECHARGE_DEFAULTS,
  ONLINE_RECHARGE_PLANS,
  type OnlineRechargePaymentContext,
  type OnlineRechargePlan,
  type OnlineRechargeWorkerRpc
} from '../contracts';
import { id, integer, object, redact, sanitize, sessionAccountId, text } from '../validation';
import { safeProxyTestTaskResult } from '../../proxy-pool/public-api';
import { OnlineRechargeOrderSyncService } from '../order-sync.service';

const LEASE_MS = 90000;
function hasRenewalSubmission(row: OnlineRechargeTask) {
  return Boolean(row.payload && object(row.payload).renewalSubmission);
}
export function requireTaskLease(row: OnlineRechargeTask | null, rpc: OnlineRechargeWorkerRpc) {
  if (
    !row ||
    !['running', 'awaiting_credentials'].includes(row.status) ||
    row.leaseOwner !== rpc.workerId ||
    row.leaseId !== rpc.leaseId ||
    row.leaseVersion !== rpc.leaseVersion ||
    !row.leaseExpiresAt ||
    row.leaseExpiresAt.getTime() <= Date.now()
  )
    throw new ConflictException('任务租约失效，必须立即停止外部操作');
  return row;
}
function subscriptionProof(
  value: Record<string, unknown>,
  targetPlan: OnlineRechargePlan,
  expectedAccountId: string
) {
  const confirmation = value.confirmation;
  if (!confirmation || typeof confirmation !== 'object' || Array.isArray(confirmation)) return null;
  const proof = confirmation as Record<string, unknown>;
  return expectedAccountId &&
    proof.source === 'subscription' &&
    proof.querySucceeded === true &&
    proof.targetPlan === targetPlan &&
    proof.accountId === expectedAccountId &&
    proof.expectedAccountId === expectedAccountId
    ? proof
    : null;
}
export function confirmedSubscription(
  value: Record<string, unknown>,
  targetPlan: OnlineRechargePlan,
  expectedAccountId: string
) {
  const proof = subscriptionProof(value, targetPlan, expectedAccountId);
  return Boolean(
    proof &&
    proof.verified === true &&
    proof.hasActiveSubscription === true &&
    ((proof.tierVerified === true && proof.observedCanonicalPlan === targetPlan) ||
      (proof.tierVerified === undefined &&
        targetPlan !== 'pro_500' &&
        typeof proof.observedPlan === 'string' &&
        ONLINE_RECHARGE_CONFIRMED_PLAN_NAMES[targetPlan].includes(
          proof.observedPlan.trim().toLowerCase()
        )))
  );
}

function paymentContext(row: OnlineRechargeTask): OnlineRechargePaymentContext | null {
  const value = row.payload ? object(row.payload).paymentContext : null;
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as unknown as OnlineRechargePaymentContext)
    : null;
}

function validatedPaymentContext(
  value: unknown,
  row: OnlineRechargeTask,
  accountId: string,
  last4: string
): OnlineRechargePaymentContext {
  const context = object(value);
  const ranks: Record<string, number> = { free: 0, plus: 1, pro_5x: 2, pro_20x: 3, pro_500: 4 };
  const source = String(context.sourcePlan);
  const validRoute =
    (context.kind === 'initial' && source === 'free') ||
    (context.kind === 'upgrade' &&
      ['plus', 'pro_5x', 'pro_20x'].includes(source) &&
      ranks[source]! < ranks[row.plan]!);
  if (
    !validRoute ||
    !ONLINE_RECHARGE_PLANS.includes(context.targetPlan as OnlineRechargePlan) ||
    context.targetPlan !== row.plan ||
    !accountId ||
    context.accountId !== accountId ||
    context.cardId !== row.cardId ||
    context.cardLast4 !== last4 ||
    typeof context.amount !== 'string' ||
    !/^\d{1,14}(\.\d{1,4})?$/.test(context.amount) ||
    typeof context.currency !== 'string' ||
    !/^[A-Z]{3}$/.test(context.currency) ||
    (context.kind === 'initial' && new Prisma.Decimal(context.amount).isZero())
  )
    throw new ConflictException('付款账号、升级路线、实际卡或官网报价不明确，禁止提交');
  return {
    kind: context.kind as OnlineRechargePaymentContext['kind'],
    sourcePlan: source as OnlineRechargePaymentContext['sourcePlan'],
    targetPlan: row.plan,
    accountId,
    cardId: row.cardId!,
    cardLast4: last4,
    amount: context.amount,
    currency: context.currency,
    ...(context.quoteId ? { quoteId: text(context.quoteId, '报价编号', 255) } : {})
  };
}

export function matchesPaymentEvidence(value: unknown, row: OnlineRechargeTask): boolean {
  const context = paymentContext(row);
  if (!context || !value || typeof value !== 'object' || Array.isArray(value)) return false;
  const evidence = value as Record<string, unknown>;
  if (
    evidence.verified !== true ||
    !(context.kind === 'upgrade'
      ? ['subscription_change', 'checkout'].includes(String(evidence.source))
      : evidence.source === 'checkout') ||
    typeof evidence.amount !== 'string' ||
    !/^\d{1,14}(\.\d{1,4})?$/.test(evidence.amount)
  )
    return false;
  return (
    ['kind', 'sourcePlan', 'targetPlan', 'accountId', 'cardId', 'cardLast4', 'currency'].every(
      (key) => evidence[key] === context[key as keyof OnlineRechargePaymentContext]
    ) &&
    (!context.quoteId || evidence.quoteId === context.quoteId) &&
    new Prisma.Decimal(evidence.amount).equals(context.amount)
  );
}

@Injectable()
export class OnlineRechargeWorkerRepository {
  constructor(
    private readonly repository: OnlineRechargeRepository,
    private readonly settings: OnlineRechargeSettingsService,
    private readonly encryption: FieldEncryptionService,
    private readonly memory: OnlineRechargeEphemeralCredentials,
    private readonly orderSync: OnlineRechargeOrderSyncService
  ) {}
  withLease<T>(
    rpc: OnlineRechargeWorkerRpc,
    work: (tx: V2CommandTransaction, row: OnlineRechargeTask) => Promise<T>
  ) {
    const taskId = id(rpc.taskId ?? rpc.args?.taskId ?? rpc.args?.ownerKey);
    return this.repository.transaction(`task:${taskId}`, async (tx) =>
      work(
        tx,
        requireTaskLease(await tx.onlineRechargeTask.findUnique({ where: { id: taskId } }), rpc)
      )
    );
  }
  async claim(workerId: string) {
    return this.repository.transaction('workers-claim', async (tx) => {
      const config = await tx.onlineRechargeConfig.findUnique({ where: { id: 'global' } });
      const settings = { ...ONLINE_RECHARGE_DEFAULTS, ...(config ? object(config.settings) : {}) };
      const expired = await tx.onlineRechargeTask.findMany({
        where: { status: 'running', leaseExpiresAt: { lt: new Date() } },
        take: 100
      });
      for (const task of expired) {
        const uncertain =
          task.paymentStarted ||
          task.confirmedPaid ||
          Boolean(task.providerOrderId) ||
          hasRenewalSubmission(task);
        await tx.onlineRechargeTask.update({
          where: { id: task.id },
          data: {
            status: uncertain ? 'awaiting_review' : 'queued',
            leaseOwner: null,
            leaseId: null,
            leaseExpiresAt: null,
            message: uncertain
              ? '执行器离线且存在外部提交，等待核对，禁止自动重放'
              : '执行器离线，尚未提交付款，等待重新领取'
          }
        });
        if (!uncertain)
          await tx.onlineRechargeCard.updateMany({
            where: { leaseOwner: task.id },
            data: { leaseOwner: null, leaseId: null, leaseExpiresAt: null }
          });
      }
      const active = await tx.onlineRechargeTask.count({ where: { status: 'running' } });
      if (active >= Number(settings.maxConcurrent)) return null;
      // 维护只拒绝新请求；已接受的持久化任务仍要执行完毕，避免兑换码永远停在预约状态。
      const row = await tx.onlineRechargeTask.findFirst({
        where: { status: 'queued', deletedAt: null, paymentStarted: false },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }]
      });
      if (!row) {
        return null;
      }
      const leaseId = randomUUID(),
        leaseVersion = row.leaseVersion + 1;
      const updated = await tx.onlineRechargeTask.update({
        where: { id: row.id },
        data: {
          status: 'running',
          leaseOwner: workerId,
          leaseId,
          leaseVersion,
          leaseExpiresAt: new Date(Date.now() + LEASE_MS),
          stage: 'started'
        }
      });
      const code = row.codeId
        ? await tx.onlineRechargeCode.findUnique({ where: { id: row.codeId } })
        : null;
      await this.repository.log(tx, 'worker.claim', undefined, row.id, { workerId, leaseVersion });
      return {
        id: row.id,
        jobKey: row.id,
        operation: row.operation,
        plan: row.plan,
        provider: row.provider,
        session: this.encryption.decrypt(updated.sessionEncrypted),
        payload: row.payload ?? {},
        code: this.encryption.decrypt(code?.codeEncrypted),
        workerId,
        leaseId,
        leaseVersion,
        leaseExpiresAt: updated.leaseExpiresAt
      };
    });
  }
  async heartbeat(rpc: OnlineRechargeWorkerRpc) {
    return this.withLease(rpc, async (tx, row) => {
      const until = new Date(Date.now() + LEASE_MS);
      await tx.onlineRechargeTask.update({
        where: { id: row.id },
        data: { leaseExpiresAt: until }
      });
      await tx.onlineRechargeCard.updateMany({
        where: { leaseOwner: row.id },
        data: { leaseExpiresAt: until }
      });
      return { ok: true, leaseExpiresAt: until };
    });
  }
  async progress(rpc: OnlineRechargeWorkerRpc) {
    const args = rpc.args ?? {};
    return this.withLease(rpc, async (tx, row) => {
      const progress =
        args.progress === undefined ? row.progress : integer(args.progress, '任务进度', 0, 100);
      const message =
        typeof args.message === 'string' ? redact(args.message).slice(0, 12000) : row.message;
      const stage =
        typeof args.stage === 'string'
          ? redact(text(args.stage, '执行阶段', 100)).slice(0, 100)
          : row.stage;
      await tx.onlineRechargeTask.update({
        where: { id: row.id },
        data: {
          progress,
          message,
          stage,
          ...(args.providerOrderId
            ? { providerOrderId: text(args.providerOrderId, '上游订单编号', 128) }
            : {}),
          ...(args.providerTaskId
            ? { providerTaskId: text(args.providerTaskId, '上游任务编号', 128) }
            : {})
        }
      });
      if (args.message || args.logs)
        await tx.onlineRechargeEvent.create({
          data: {
            taskId: row.id,
            message,
            stage,
            metadata: sanitize({ logs: args.logs }) as Prisma.InputJsonValue
          }
        });
      return { ok: true };
    });
  }
  async beforeSubmit(rpc: OnlineRechargeWorkerRpc) {
    return this.withLease(rpc, async (tx, row) => {
      if (row.operation === 'debug') throw new ConflictException('调试任务必须在付款前停止');
      const args = rpc.args ?? {};
      if (row.operation === 'renewal' || args.stage === 'renewal_update')
        return this.beforeRenewalSubmit(tx, row, args);
      if (row.operation !== 'recharge' || !row.cardId)
        throw new ConflictException('付款前必须预约当前任务的银行卡');
      if (row.paymentStarted) throw new ConflictException('付款已经提交，禁止再次建单或重复提交');
      const card = await this.requireCard(tx, row.id, row.cardId);
      if (
        !card.leaseExpiresAt ||
        card.leaseExpiresAt.getTime() <= Date.now() ||
        (args.cardId !== undefined && args.cardId !== card.id) ||
        (args.cardLeaseId !== undefined && args.cardLeaseId !== card.leaseId) ||
        (args.cardLeaseVersion !== undefined && args.cardLeaseVersion !== card.leaseVersion)
      )
        throw new ConflictException('银行卡租约失效，禁止提交付款');
      const payload = row.payload ? object(row.payload) : {};
      if (args.paymentContext !== undefined) {
        payload.paymentContext = validatedPaymentContext(
          args.paymentContext,
          row,
          sessionAccountId(this.encryption.decrypt(row.sessionEncrypted)),
          card.last4
        );
      } else if (row.plan === 'pro_500')
        throw new ConflictException('Pro 500 缺少可核实的付款报价与实际卡资料');
      await tx.onlineRechargeTask.update({
        where: { id: row.id },
        data: {
          paymentStarted: true,
          stage: 'payment_submitted',
          payload: payload as Prisma.InputJsonValue
        }
      });
      await this.repository.log(tx, 'worker.payment_submitted', undefined, row.id, {
        leaseVersion: row.leaseVersion
      });
      return { ok: true, idempotencyKey: row.codeId ?? row.id };
    });
  }
  private async beforeRenewalSubmit(
    tx: V2CommandTransaction,
    row: OnlineRechargeTask,
    args: Record<string, unknown>
  ) {
    const payload = row.payload ? object(row.payload) : {};
    const action = row.operation === 'renewal' ? payload.action : 'disable';
    const allowed =
      row.status === 'running' &&
      row.provider === 'local' &&
      !(row.operation === 'recharge' && paymentContext(row)?.kind === 'upgrade') &&
      (row.operation === 'renewal' || (row.operation === 'recharge' && row.confirmedPaid)) &&
      ['enable', 'disable'].includes(String(action)) &&
      args.stage === 'renewal_update' &&
      args.renewalAction === action;
    if (!allowed) throw new ConflictException('当前任务不允许提交此续费变更');
    if (hasRenewalSubmission(row))
      throw new ConflictException('续费变更已经提交，等待核对，禁止重复提交');
    if (!sessionAccountId(this.encryption.decrypt(row.sessionEncrypted)))
      throw new ConflictException('续费变更缺少可核对的账号资料');
    await tx.onlineRechargeTask.update({
      where: { id: row.id },
      data: {
        payload: {
          ...payload,
          renewalSubmission: {
            action,
            leaseVersion: row.leaseVersion,
            submittedAt: new Date().toISOString()
          }
        } as Prisma.InputJsonValue,
        ...(row.operation === 'renewal' ? { stage: 'renewal_submitted' } : {})
      }
    });
    await this.repository.log(tx, 'worker.renewal_submitted', undefined, row.id, {
      action,
      leaseVersion: row.leaseVersion
    });
    return { ok: true, idempotencyKey: `${row.id}:renewal:${action}` };
  }
  async finish(rpc: OnlineRechargeWorkerRpc, failed: boolean) {
    const args = rpc.args ?? {};
    return this.withLease(rpc, async (tx, row) => {
      let status = String(args.status ?? (failed ? 'failed' : 'succeeded'));
      if (status === 'pending_credentials') status = 'awaiting_credentials';
      if (['result_unknown', 'unknown'].includes(status)) status = 'awaiting_review';
      if (!['succeeded', 'failed', 'awaiting_review', 'awaiting_credentials'].includes(status))
        throw new BadRequestException('任务终态无效');
      const payload = row.payload ? object(row.payload) : {};
      const result: Record<string, unknown> =
        row.operation === 'proxy_test'
          ? typeof payload.proxyConnectionVersion !== 'string'
            ? {
                ok: false,
                ip: null,
                latencyMs: null,
                errorCode: 'legacy_test',
                message: '旧检测缺少连接版本，已停止，请重新检测'
              }
            : safeProxyTestTaskResult(args.result, payload.proxyId)
          : args.result
            ? object(args.result)
            : {};
      if (
        row.operation === 'proxy_test' &&
        (typeof payload.proxyConnectionVersion !== 'string' ||
          status === 'awaiting_review' ||
          status === 'awaiting_credentials' ||
          (status === 'succeeded' && result.ok !== true))
      )
        status = 'failed';
      if (row.operation === 'debug' && typeof result.checkoutUrl === 'string')
        payload.debugCheckoutEncrypted = this.encryption.encrypt(result.checkoutUrl);
      const renewalResult =
        row.operation === 'renewal' ||
        (row.operation === 'subscription' && payload.originalOperation === 'renewal');
      const context = paymentContext(row);
      const evidenceVerified = context
        ? matchesPaymentEvidence(result.paymentEvidence, row)
        : row.plan !== 'pro_500';
      const zeroChange =
        context?.kind === 'upgrade' &&
        new Prisma.Decimal(context.amount).isZero() &&
        evidenceVerified &&
        result.subscriptionChangedVerified === true;
      const paid =
        !renewalResult &&
        !zeroChange &&
        evidenceVerified &&
        (!context || new Prisma.Decimal(context.amount).greaterThan(0)) &&
        (result.confirmedPaid === true || args.confirmedPaid === true);
      const expectedAccountId = sessionAccountId(this.encryption.decrypt(row.sessionEncrypted));
      const verified = confirmedSubscription(result, row.plan, expectedAccountId);
      if (row.operation === 'renewal' && hasRenewalSubmission(row)) {
        const data =
          result.data && typeof result.data === 'object' && !Array.isArray(result.data)
            ? (result.data as Record<string, unknown>)
            : {};
        const renewalVerified =
          result.ok === true &&
          Boolean(expectedAccountId) &&
          data.upstreamAccountId === expectedAccountId &&
          ['enable', 'disable'].includes(String(payload.action)) &&
          data.autoRenewRaw === (payload.action === 'enable');
        const rejected =
          args.definitiveFailure === true &&
          result.renewalRejected === true &&
          [401, 403].includes(Number(result.statusCode));
        if ((status === 'failed' && !rejected) || (status === 'succeeded' && !renewalVerified))
          status = 'awaiting_review';
      }
      if (
        row.operation === 'recharge' &&
        status === 'succeeded' &&
        ((!paid && !zeroChange) || !verified)
      )
        status = 'awaiting_review';
      if (
        status === 'failed' &&
        (row.confirmedPaid || paid || (row.paymentStarted && args.definitiveFailure !== true))
      )
        status = 'awaiting_review';
      if (status === 'awaiting_credentials' && row.paymentStarted) status = 'awaiting_review';
      const terminal = status === 'succeeded' || status === 'failed';
      await tx.onlineRechargeTask.update({
        where: { id: row.id },
        data: {
          status: status as OnlineRechargeTask['status'],
          result: sanitize(result) as Prisma.InputJsonValue,
          payload: payload as Prisma.InputJsonValue,
          confirmedPaid: row.confirmedPaid || paid,
          progress: terminal ? 100 : row.progress,
          stage: terminal ? 'finished' : status,
          message:
            row.operation === 'proxy_test'
              ? String(result.message)
              : redact(
                  String(
                    args.message ??
                      result.message ??
                      (status === 'awaiting_review'
                        ? row.operation === 'renewal'
                          ? '续费变更结果待核对，禁止自动重试'
                          : '付款结果待核对，禁止自动重试'
                        : '任务结束')
                  )
                ).slice(0, 12000),
          leaseOwner: null,
          leaseId: null,
          leaseExpiresAt: null
        }
      });
      if (row.codeId) {
        if (status === 'succeeded')
          await tx.onlineRechargeCode.updateMany({
            where: { id: row.codeId, taskId: row.id, status: 'reserved' },
            data: { status: 'used' }
          });
        if (status === 'failed')
          await tx.onlineRechargeCode.updateMany({
            where: { id: row.codeId, taskId: row.id, status: 'reserved' },
            data: { status: 'available', taskId: null }
          });
      }
      if (row.operation === 'subscription' && typeof payload.recheckTaskId === 'string') {
        await this.resolveRecheck(
          tx,
          row,
          payload,
          result,
          verified,
          args.definitiveFailure === true
        );
      }
      if (row.operation === 'recharge' && status === 'succeeded')
        await this.orderSync.enqueueInTransaction(tx, row.id);
      if (terminal || status === 'awaiting_credentials')
        await tx.onlineRechargeCard.updateMany({
          where: { leaseOwner: row.id },
          data: { leaseOwner: null, leaseId: null, leaseExpiresAt: null }
        });
      await this.repository.log(tx, 'worker.finish', undefined, row.id, {
        status,
        confirmedPaid: row.confirmedPaid || paid
      });
      return { ok: true, status };
    });
  }
  private async resolveRecheck(
    tx: V2CommandTransaction,
    recheck: OnlineRechargeTask,
    payload: Record<string, unknown>,
    result: Record<string, unknown>,
    verified: boolean,
    definitiveFailure: boolean
  ) {
    const original = await tx.onlineRechargeTask.findUnique({
      where: { id: id(payload.recheckTaskId) }
    });
    if (
      !original ||
      original.status !== 'awaiting_review' ||
      original.leaseVersion !== payload.sourceVersion ||
      original.sessionIdentityHash !== recheck.sessionIdentityHash ||
      original.plan !== recheck.plan
    )
      return;
    if (original.operation === 'renewal') {
      const originalPayload = original.payload ? object(original.payload) : {};
      const data =
        result.data && typeof result.data === 'object' && !Array.isArray(result.data)
          ? (result.data as Record<string, unknown>)
          : {};
      const expectedAccountId = sessionAccountId(
        this.encryption.decrypt(original.sessionEncrypted)
      );
      if (
        payload.originalOperation !== 'renewal' ||
        !hasRenewalSubmission(original) ||
        !['enable', 'disable'].includes(String(originalPayload.action)) ||
        payload.renewalAction !== originalPayload.action ||
        result.success !== true ||
        result.renewalVerified !== true ||
        !expectedAccountId ||
        data.upstreamAccountId !== expectedAccountId ||
        data.autoRenewRaw !== (originalPayload.action === 'enable')
      )
        return;
      await tx.onlineRechargeTask.update({
        where: { id: original.id },
        data: {
          status: 'succeeded',
          confirmedPaid: original.confirmedPaid,
          progress: 100,
          leaseVersion: { increment: 1 },
          leaseOwner: null,
          leaseId: null,
          leaseExpiresAt: null,
          stage: 'rechecked',
          message: '原续费变更经同账号实际续费状态确认成功',
          result: sanitize({
            ...result,
            confirmedPaid: false,
            recheckedByTaskId: recheck.id
          }) as Prisma.InputJsonValue
        }
      });
      await this.repository.log(tx, 'tasks.recheck.resolve', undefined, original.id, {
        recheckTaskId: recheck.id,
        status: 'succeeded',
        operation: 'renewal'
      });
      return;
    }
    if (original.operation !== 'recharge') return;
    const context = paymentContext(original);
    const evidenceVerified = context
      ? matchesPaymentEvidence(result.paymentEvidence, original)
      : original.plan !== 'pro_500';
    const zeroChange =
      context?.kind === 'upgrade' &&
      new Prisma.Decimal(context.amount).isZero() &&
      evidenceVerified &&
      verified &&
      result.subscriptionChangedVerified === true;
    const paid =
      verified &&
      evidenceVerified &&
      (!context || new Prisma.Decimal(context.amount).greaterThan(0)) &&
      result.confirmedPaid === true;
    const proof = subscriptionProof(
      result,
      original.plan,
      sessionAccountId(this.encryption.decrypt(original.sessionEncrypted))
    );
    const conclusivelyFailed =
      original.provider === 'third_party' &&
      !original.confirmedPaid &&
      definitiveFailure &&
      result.confirmedPaid === false &&
      result.providerFinalStatus === 'failed' &&
      proof?.verified === false &&
      (proof.hasActiveSubscription === false ||
        (typeof proof.observedPlan === 'string' &&
          Object.values(ONLINE_RECHARGE_CONFIRMED_PLAN_NAMES).some((names) =>
            names.includes(String(proof.observedPlan).trim().toLowerCase())
          )));
    if (!paid && !zeroChange && !conclusivelyFailed) return;
    const status = paid || zeroChange ? 'succeeded' : 'failed';
    await tx.onlineRechargeTask.update({
      where: { id: original.id },
      data: {
        status,
        confirmedPaid: paid || original.confirmedPaid,
        progress: 100,
        leaseVersion: { increment: 1 },
        leaseOwner: null,
        leaseId: null,
        leaseExpiresAt: null,
        stage: 'rechecked',
        message:
          paid || zeroChange
            ? '原任务经同账号准确套餐和付款证据确认成功'
            : '原上游订单确认失败且账号未开通',
        result: sanitize({ ...result, recheckedByTaskId: recheck.id }) as Prisma.InputJsonValue
      }
    });
    if (status === 'succeeded') await this.orderSync.enqueueInTransaction(tx, original.id);
    if (original.codeId)
      await tx.onlineRechargeCode.updateMany({
        where: { id: original.codeId, taskId: original.id, status: 'reserved' },
        data: paid || zeroChange ? { status: 'used' } : { status: 'available', taskId: null }
      });
    if (original.cardId && paid) {
      const dedupeKey = `${original.id}:${original.cardId}:recordCardUsage`;
      if (!(await tx.onlineRechargeEvent.findUnique({ where: { dedupeKey } }))) {
        const card = await tx.onlineRechargeCard.findUnique({ where: { id: original.cardId } });
        if (card) {
          const { maxSubscriptionCount } = await this.settings.cardPolicy();
          await tx.onlineRechargeCard.update({
            where: { id: card.id },
            data: {
              successCount: { increment: 1 },
              declineCount: 0,
              status: card.successCount + 1 >= maxSubscriptionCount ? 'exhausted' : 'active',
              lastUsedAt: new Date()
            }
          });
          await tx.onlineRechargeEvent.create({
            data: {
              taskId: original.id,
              dedupeKey,
              message: '原任务核对成功，银行卡使用次数已记录'
            }
          });
        }
      }
    }
    if (paid && original.provider === 'local') {
      const existing = await tx.onlineRechargeBill.findFirst({
        where: { taskId: original.id, status: 'success' }
      });
      if (!existing)
        await tx.onlineRechargeBill.create({
          data: {
            taskId: original.id,
            cardId: original.cardId,
            cardLast4: original.cardLast4,
            plan: original.plan,
            status: 'success',
            amount: context ? new Prisma.Decimal(context.amount) : null,
            currency:
              context?.currency ??
              (typeof result.currency === 'string' ? result.currency.slice(0, 8) : 'USD'),
            idempotencyKey: `${original.id}:recheck`,
            message: context ? '原单实际付款卡和官网报价已核对' : '订阅已确认，实际扣款金额尚无证据'
          }
        });
    }
    await tx.onlineRechargeCard.updateMany({
      where: { leaseOwner: original.id },
      data: { leaseOwner: null, leaseId: null, leaseExpiresAt: null }
    });
    await this.repository.log(tx, 'tasks.recheck.resolve', undefined, original.id, {
      recheckTaskId: recheck.id,
      status
    });
  }
  async reserveCard(rpc: OnlineRechargeWorkerRpc) {
    const policy = await this.settings.cardPolicy();
    const args = rpc.args ?? {},
      excluded = Array.isArray(args.excludedIds ?? args.excludedCardIds)
        ? ((args.excludedIds ?? args.excludedCardIds) as string[])
        : [];
    return this.repository.transaction('cards-reserve', async (tx) => {
      const row = requireTaskLease(
        await tx.onlineRechargeTask.findUnique({ where: { id: id(rpc.taskId ?? args.ownerKey) } }),
        rpc
      );
      if (row.paymentStarted) throw new ConflictException('付款已经提交，不能更换银行卡或重新提交');
      const prior = await tx.onlineRechargeCard.findFirst({ where: { leaseOwner: row.id } });
      const resumed =
        row.cardId && !row.paymentStarted && !excluded.includes(row.cardId)
          ? await tx.onlineRechargeCard.findFirst({
              where: {
                id: row.cardId,
                status: 'active',
                leaseOwner: null,
                successCount: { lt: policy.maxSubscriptionCount }
              }
            })
          : null;
      const card =
        prior ??
        resumed ??
        (await tx.onlineRechargeCard.findFirst({
          where: {
            status: 'active',
            successCount: { lt: policy.maxSubscriptionCount },
            leaseOwner: null,
            id: { notIn: excluded.map(id) }
          },
          orderBy: [{ successCount: 'asc' }, { lastUsedAt: 'asc' }, { id: 'asc' }]
        }));
      if (!card) return null;
      const hasCvc = (await this.memory.available([card.id])).includes(card.id);
      if (!hasCvc && args.requireCvc !== false) {
        await tx.onlineRechargeTask.update({
          where: { id: row.id },
          data: {
            status: 'awaiting_credentials',
            cardId: card.id,
            cardLast4: card.last4,
            stage: 'awaiting_credentials',
            message: '安全码仅临时保留，当前缺失，请管理员补充'
          }
        });
        return { pendingCredentials: true, cardId: card.id };
      }
      const leaseId = prior?.leaseId ?? randomUUID(),
        leaseVersion = prior?.leaseVersion ?? card.leaseVersion + 1;
      await tx.onlineRechargeCard.update({
        where: { id: card.id },
        data: { leaseOwner: row.id, leaseId, leaseVersion, leaseExpiresAt: row.leaseExpiresAt }
      });
      await tx.onlineRechargeTask.update({
        where: { id: row.id },
        data: { cardId: card.id, cardLast4: card.last4 }
      });
      await this.repository.log(tx, 'worker.cards.credentials', undefined, row.id, {
        cardId: card.id
      });
      const number = this.encryption.decrypt(card.numberEncrypted),
        expiry = `${String(card.expiryMonth).padStart(2, '0')}/${String(card.expiryYear).slice(-2)}`;
      return {
        id: card.id,
        card_number: number,
        card_expiry: expiry,
        hasCvc,
        card_holder: card.holderName,
        exp_month: card.expiryMonth,
        exp_year: card.expiryYear,
        name: card.holderName,
        usage_count: card.successCount,
        bind_count: card.successCount,
        decline_count: card.declineCount,
        address_id: card.addressId,
        leaseId,
        leaseVersion
      };
    });
  }
  private requireCard(tx: V2CommandTransaction, taskId: string, cardId: string) {
    return tx.onlineRechargeCard
      .findFirst({ where: { id: cardId, leaseOwner: taskId } })
      .then((card) => {
        if (!card || !card.leaseExpiresAt || card.leaseExpiresAt.getTime() <= Date.now())
          throw new ConflictException('银行卡租约不属于当前任务或已到期');
        return card;
      });
  }
  async cardAction(rpc: OnlineRechargeWorkerRpc, action: string) {
    const args = rpc.args ?? {},
      cardId = id(args.cardId ?? args.id),
      policy = await this.settings.cardPolicy();
    return this.withLease(rpc, async (tx, row) => {
      const card = await this.requireCard(tx, row.id, cardId);
      if (
        (args.cardLeaseId !== undefined && args.cardLeaseId !== card.leaseId) ||
        (args.cardLeaseVersion !== undefined && args.cardLeaseVersion !== card.leaseVersion)
      )
        throw new ConflictException('银行卡租约版本已变化');
      if (action === 'releaseCard') {
        const knownDecline = await tx.onlineRechargeEvent.findUnique({
          where: { dedupeKey: `${row.id}:${cardId}:recordCardDecline` }
        });
        if (row.confirmedPaid || (row.paymentStarted && !knownDecline))
          throw new ConflictException('付款结果待核对，不能释放银行卡');
        await tx.onlineRechargeCard.update({
          where: { id: card.id },
          data: { leaseOwner: null, leaseId: null, leaseExpiresAt: null }
        });
        return { ok: true };
      }
      const dedupeKey = `${row.id}:${cardId}:${action}`;
      if (await tx.onlineRechargeEvent.findUnique({ where: { dedupeKey } }))
        return {
          ok: true,
          duplicate: true,
          usageCount: card.successCount,
          declineCount: card.declineCount
        };
      if (action === 'recordCardUsage') {
        const context = paymentContext(row);
        if (
          (row.plan === 'pro_500' && !context) ||
          (context &&
            (!row.paymentStarted ||
              !new Prisma.Decimal(context.amount).greaterThan(0) ||
              !matchesPaymentEvidence(args.paymentEvidence, row)))
        )
          throw new ConflictException('实际付款卡或金额未核实，不能记录扣款次数');
        const usageCount = card.successCount + 1,
          exhausted = usageCount >= policy.maxSubscriptionCount;
        await tx.onlineRechargeCard.update({
          where: { id: card.id },
          data: {
            successCount: usageCount,
            declineCount: 0,
            status: exhausted ? 'exhausted' : 'active',
            lastUsedAt: new Date()
          }
        });
        await tx.onlineRechargeTask.update({
          where: { id: row.id },
          data: { confirmedPaid: true }
        });
      } else if (action === 'recordCardDecline') {
        const declineCount = card.declineCount + 1;
        await tx.onlineRechargeCard.update({
          where: { id: card.id },
          data: {
            declineCount,
            status: declineCount >= policy.maxDeclineCount ? 'retired' : 'active'
          }
        });
      } else if (action === 'bindCardPaymentProfile') {
        const profile = args.profile ? object(args.profile) : args;
        await tx.onlineRechargeCard.update({
          where: { id: card.id },
          data: {
            paymentName: text(
              profile.holderName ?? profile.payment_holder_name ?? '',
              '付款姓名',
              120,
              false
            ),
            ...((profile.addressId ?? profile.payment_address_id)
              ? { addressId: id(profile.addressId ?? profile.payment_address_id) }
              : {})
          }
        });
      } else throw new BadRequestException('银行卡操作无效');
      await tx.onlineRechargeEvent.create({
        data: {
          taskId: row.id,
          dedupeKey,
          stage: action,
          message: '银行卡使用结果已记录',
          metadata: { cardId }
        }
      });
      const after = (await tx.onlineRechargeCard.findUnique({ where: { id: card.id } }))!;
      return {
        ok: true,
        usageCount: after.successCount,
        declineCount: after.declineCount,
        exhausted: after.status !== 'active'
      };
    });
  }
  async billing(rpc: OnlineRechargeWorkerRpc) {
    const args = rpc.args ?? {},
      source = args.record ? object(args.record) : args;
    return this.withLease(rpc, async (tx, row) => {
      if (row.provider === 'third_party') throw new ConflictException('第三方路径不写入本地账单');
      const status = text(source.status ?? 'success', '账单状态', 16);
      if (!['success', 'failed', 'result_unknown'].includes(status))
        throw new BadRequestException('账单状态无效');
      const amountValue = source.amount;
      if (
        amountValue !== null &&
        amountValue !== undefined &&
        (typeof amountValue !== 'string' || !/^\d{1,14}(\.\d{1,4})?$/.test(amountValue))
      )
        throw new BadRequestException('实际金额必须为Decimal字符串');
      const actual =
        source.amountSource === 'checkout' && amountValue !== undefined && amountValue !== null
          ? new Prisma.Decimal(amountValue as string)
          : null;
      const context = paymentContext(row);
      if (row.plan === 'pro_500' && !context && status === 'success')
        throw new ConflictException('Pro 500 缺少已提交的付款证据，不能生成成功账单');
      if (
        context &&
        status === 'success' &&
        (!row.paymentStarted ||
          !actual?.greaterThan(0) ||
          !actual.equals(context.amount) ||
          source.currency !== context.currency ||
          !matchesPaymentEvidence(source.paymentEvidence, row))
      )
        throw new ConflictException('实际付款卡或金额未核实，不能生成成功扣款账单');
      const checkoutId = source.checkoutId ?? source.stripe_session_id;
      const idempotencyKey = `${row.id}:${row.cardId ?? 'none'}:${checkoutId ?? status}`.slice(
        0,
        190
      );
      const bill = await tx.onlineRechargeBill.upsert({
        where: { idempotencyKey },
        create: {
          taskId: row.id,
          idempotencyKey,
          cardId: row.cardId,
          cardLast4: row.cardLast4,
          plan: row.plan,
          status,
          amount: actual,
          currency: text(source.currency ?? 'USD', '币种', 8),
          checkoutId: checkoutId ? text(checkoutId, '结账编号', 255) : null,
          errorCode: source.error_code ? text(source.error_code, '错误码', 100) : null,
          message: redact(String(source.message ?? source.error_message ?? '')).slice(0, 12000)
        },
        update: {}
      });
      await this.repository.log(tx, 'worker.billing.create', undefined, row.id, {
        billId: bill.id,
        status,
        amountSource: actual ? 'checkout' : 'unknown'
      });
      return { id: bill.id };
    });
  }
  async markAddress(rpc: OnlineRechargeWorkerRpc) {
    const args = rpc.args ?? {},
      addressId = id(args.addressId),
      cardId = id(args.cardId);
    return this.withLease(rpc, async (tx, row) => {
      await this.requireCard(tx, row.id, cardId);
      const dedupeKey = `${row.id}:${addressId}:addressBound`;
      if (await tx.onlineRechargeEvent.findUnique({ where: { dedupeKey } }))
        return { success: true, duplicate: true };
      if (!(await tx.onlineRechargeAddress.findFirst({ where: { id: addressId, active: true } })))
        throw new NotFoundException('地址不存在');
      await tx.onlineRechargeAddress.update({
        where: { id: addressId },
        data: { successCount: { increment: 1 } }
      });
      await tx.onlineRechargeCard.update({ where: { id: cardId }, data: { addressId } });
      await tx.onlineRechargeEvent.create({
        data: {
          taskId: row.id,
          dedupeKey,
          message: '付款账单地址已关联',
          metadata: { addressId, cardId }
        }
      });
      return { success: true };
    });
  }
}

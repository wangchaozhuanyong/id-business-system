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
  type OnlineRechargePlan,
  type OnlineRechargeWorkerRpc
} from '../contracts';
import { id, integer, object, redact, sanitize, sessionAccountId, text } from '../validation';

const LEASE_MS = 90000;
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
    typeof proof.observedPlan === 'string' &&
    ONLINE_RECHARGE_CONFIRMED_PLAN_NAMES[targetPlan].includes(
      proof.observedPlan.trim().toLowerCase()
    )
  );
}

@Injectable()
export class OnlineRechargeWorkerRepository {
  constructor(
    private readonly repository: OnlineRechargeRepository,
    private readonly settings: OnlineRechargeSettingsService,
    private readonly encryption: FieldEncryptionService,
    private readonly memory: OnlineRechargeEphemeralCredentials
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
          task.paymentStarted || task.confirmedPaid || Boolean(task.providerOrderId);
        await tx.onlineRechargeTask.update({
          where: { id: task.id },
          data: {
            status: uncertain ? 'awaiting_review' : 'queued',
            leaseOwner: null,
            leaseId: null,
            leaseExpiresAt: null,
            message: uncertain
              ? '执行器离线且存在付款提交，等待核对，禁止自动重放'
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
      if (row.operation !== 'recharge' || !row.cardId)
        throw new ConflictException('付款前必须预约当前任务的银行卡');
      const card = await this.requireCard(tx, row.id, row.cardId);
      const args = rpc.args ?? {};
      if (
        !card.leaseExpiresAt ||
        card.leaseExpiresAt.getTime() <= Date.now() ||
        (args.cardId !== undefined && args.cardId !== card.id) ||
        (args.cardLeaseId !== undefined && args.cardLeaseId !== card.leaseId) ||
        (args.cardLeaseVersion !== undefined && args.cardLeaseVersion !== card.leaseVersion)
      )
        throw new ConflictException('银行卡租约失效，禁止提交付款');
      // 同一仍存活的本地任务允许明确拒付后换卡；绝不重新领取已提交任务。
      if (row.provider === 'third_party' && row.paymentStarted)
        throw new ConflictException('第三方订单已经提交，禁止再次建单');
      await tx.onlineRechargeTask.update({
        where: { id: row.id },
        data: { paymentStarted: true, stage: 'payment_submitted' }
      });
      await this.repository.log(tx, 'worker.payment_submitted', undefined, row.id, {
        leaseVersion: row.leaseVersion
      });
      return { ok: true, idempotencyKey: row.codeId ?? row.id };
    });
  }
  async finish(rpc: OnlineRechargeWorkerRpc, failed: boolean) {
    const args = rpc.args ?? {};
    return this.withLease(rpc, async (tx, row) => {
      let status = String(args.status ?? (failed ? 'failed' : 'succeeded'));
      if (status === 'pending_credentials') status = 'awaiting_credentials';
      if (['result_unknown', 'unknown'].includes(status)) status = 'awaiting_review';
      if (!['succeeded', 'failed', 'awaiting_review', 'awaiting_credentials'].includes(status))
        throw new BadRequestException('任务终态无效');
      const result = args.result ? object(args.result) : {};
      const payload = row.payload ? object(row.payload) : {};
      if (row.operation === 'debug' && typeof result.checkoutUrl === 'string')
        payload.debugCheckoutEncrypted = this.encryption.encrypt(result.checkoutUrl);
      const paid = result.confirmedPaid === true || args.confirmedPaid === true;
      const expectedAccountId = sessionAccountId(this.encryption.decrypt(row.sessionEncrypted));
      const verified = confirmedSubscription(result, row.plan, expectedAccountId);
      if (row.operation === 'recharge' && status === 'succeeded' && (!paid || !verified))
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
          message: redact(
            String(
              args.message ??
                result.message ??
                (status === 'awaiting_review' ? '付款结果待核对，禁止自动重试' : '任务结束')
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
    const paid = verified && result.confirmedPaid === true;
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
    if (!paid && !conclusivelyFailed) return;
    const status = paid ? 'succeeded' : 'failed';
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
        message: paid ? '原任务经同账号订阅证据确认成功' : '原上游订单确认失败且账号未开通',
        result: sanitize({ ...result, recheckedByTaskId: recheck.id }) as Prisma.InputJsonValue
      }
    });
    if (original.codeId)
      await tx.onlineRechargeCode.updateMany({
        where: { id: original.codeId, taskId: original.id, status: 'reserved' },
        data: paid ? { status: 'used' } : { status: 'available', taskId: null }
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
            amount: null,
            currency: typeof result.currency === 'string' ? result.currency.slice(0, 8) : 'USD',
            idempotencyKey: `${original.id}:recheck`,
            message: '订阅已确认，实际扣款金额尚无证据'
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
      if (!hasCvc) {
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

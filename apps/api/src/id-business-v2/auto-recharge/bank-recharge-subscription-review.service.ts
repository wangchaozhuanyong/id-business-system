import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  normalizeV2ExpectedUpdatedAt,
  toV2JsonDocument,
  type V2CommandTransaction
} from '../runtime/public-api';
import {
  bankRechargeDate,
  bankRechargeId,
  bankRechargeObject,
  bankRechargeText
} from './bank-recharge-validation';
import { BankRechargeLifecycleRepository } from './persistence/bank-recharge-lifecycle.repository';

@Injectable()
export class BankRechargeSubscriptionReviewService {
  constructor(
    private readonly repository: BankRechargeLifecycleRepository,
    private readonly transactions: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService
  ) {}
  private async context(tx: V2CommandTransaction, id: string) {
    const order = await this.repository.order(tx, id);
    if (!order || order.deletedAt) throw new NotFoundException('银充订单不存在或已删除');
    if (
      !order.accountId ||
      order.status === 'cancelled' ||
      order.status === 'refunded' ||
      (order.source === 'automatic' && !order.verifiedAt)
    )
      throw new ConflictException('请先核对原付款、关联账号及订单状态');
    const account = await this.repository.account(tx, order.accountId);
    if (!account || account.deletedAt || account.status !== 'active')
      throw new ConflictException('账号已停用或删除');
    if (order.source === 'automatic') {
      const source = order.rechargeJobId
        ? await this.repository.originalPaymentAccountKey(tx, order.rechargeJobId)
        : null;
      if (!account.officialAccountKey || source?.accountKey !== account.officialAccountKey)
        throw new ConflictException('自动订单账号尚未核对原付款的官网身份');
    }
    return { order, subscription: await this.repository.subscription(tx, order.accountId) };
  }
  async preview(id: string) {
    bankRechargeId(id, '银充订单');
    return this.repository.read(async (tx) => {
      const { order, subscription } = await this.context(tx, id);
      return {
        orderId: order.id,
        orderNo: order.orderNo,
        expectedUpdatedAt: order.updatedAt.toISOString(),
        expectedCurrentOrderId: subscription?.currentOrderId ?? null,
        expectedSubscriptionUpdatedAt: subscription?.updatedAt.toISOString() ?? null,
        openedAt: order.openedAt?.toISOString() ?? null,
        dueAt: order.dueAt?.toISOString() ?? null,
        currentOpenedAt: subscription?.openedAt.toISOString() ?? null
      };
    });
  }
  async verify(id: string, value: unknown, operator: AuthenticatedUser) {
    bankRechargeId(id, '银充订单');
    const input = bankRechargeObject(value);
    if (
      Object.keys(input).some(
        (key) =>
          ![
            'expectedUpdatedAt',
            'expectedCurrentOrderId',
            'expectedSubscriptionUpdatedAt',
            'openedAt',
            'dueAt',
            'dateEvidenceRef',
            'reason',
            'operationId',
            'confirmedOfficialDates',
            'makeCurrent'
          ].includes(key)
      )
    )
      throw new BadRequestException('订阅核对包含未知字段');
    if (input.makeCurrent !== undefined && typeof input.makeCurrent !== 'boolean')
      throw new BadRequestException('当前订阅选择无效');
    const makeCurrent = input.makeCurrent === true;
    const version = normalizeV2ExpectedUpdatedAt(input.expectedUpdatedAt, '订单');
    const pointer =
      input.expectedCurrentOrderId === null
        ? null
        : bankRechargeId(input.expectedCurrentOrderId, '当前订阅订单');
    const subscriptionVersion =
      input.expectedSubscriptionUpdatedAt === null
        ? null
        : normalizeV2ExpectedUpdatedAt(input.expectedSubscriptionUpdatedAt, '订阅');
    const openedAt = bankRechargeDate(input.openedAt, '官网开通时间');
    const dueAt = bankRechargeDate(input.dueAt, '官网到期时间');
    if (dueAt <= openedAt || openedAt > new Date())
      throw new BadRequestException('官网开通与到期时间范围无效');
    if (input.confirmedOfficialDates !== true)
      throw new BadRequestException('请确认日期来自已核对的官网付款或订阅凭据');
    const dateEvidenceRef = bankRechargeText(input.dateEvidenceRef, '官网日期凭据编号', 220);
    const reason = bankRechargeText(input.reason, '核对原因', 500);
    const operationId = bankRechargeId(input.operationId, '核对操作编号');
    const requestDigest = createHash('sha256')
      .update(
        JSON.stringify({
          id,
          operator: operator.id,
          version: version.toISOString(),
          pointer,
          subscriptionVersion: subscriptionVersion?.toISOString() ?? null,
          openedAt: openedAt.toISOString(),
          dueAt: dueAt.toISOString(),
          dateEvidenceRef,
          reason,
          makeCurrent
        })
      )
      .digest('hex');
    return this.transactions.execute(
      async (tx) => {
        await this.repository.lock(tx);
        const prior = await this.repository.command(tx, operationId);
        if (prior) {
          const data = bankRechargeObject(prior.afterData);
          if (data.requestDigest !== requestDigest)
            throw new ConflictException('操作编号已用于其他确认内容');
          return data.outcome;
        }
        const { order, subscription } = await this.context(tx, id);
        if (
          order.updatedAt.toISOString() !== version.toISOString() ||
          (subscription?.currentOrderId ?? null) !== pointer ||
          (subscription?.updatedAt.toISOString() ?? null) !==
            (subscriptionVersion?.toISOString() ?? null)
        )
          throw new ConflictException('订单或当前订阅已变化，请重新预览核对');
        if (
          makeCurrent &&
          subscription &&
          subscription.currentOrderId !== id &&
          openedAt <= subscription.openedAt
        )
          throw new ConflictException('历史或同时间订单不能覆盖较新的当前订阅');
        const updated = await this.repository.updateDates(tx, id, openedAt, dueAt, operator.id);
        const updateCurrent = makeCurrent || subscription?.currentOrderId === id;
        if (updateCurrent)
          await this.repository.activateReviewed(tx, {
            ...updated,
            accountId: order.accountId!,
            openedAt,
            dueAt
          });
        const outcome = {
          id,
          openedAt: openedAt.toISOString(),
          dueAt: dueAt.toISOString(),
          currentOrderId: updateCurrent ? id : (subscription?.currentOrderId ?? null),
          dateOnly: !updateCurrent
        };
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.bank_recharge.subscription.verify',
          objectType: 'bank_recharge_order',
          objectId: id,
          beforeData: toV2JsonDocument({
            currentOrderId: pointer,
            subscriptionUpdatedAt: subscriptionVersion,
            openedAt: order.openedAt,
            dueAt: order.dueAt
          }),
          afterData: toV2JsonDocument({
            lifecycleOperationId: operationId,
            requestDigest,
            outcome,
            dateEvidenceRef
          }),
          remark: reason
        });
        return outcome;
      },
      {
        changedScopes: ['auto-recharge', 'renewals', 'renewal-warning-summary'],
        requestId: randomUUID(),
        operator,
        retryMode: 'none'
      }
    );
  }
}

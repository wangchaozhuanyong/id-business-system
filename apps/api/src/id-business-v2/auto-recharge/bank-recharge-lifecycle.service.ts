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
import { bankRechargeId, bankRechargeObject, bankRechargeText } from './bank-recharge-validation';
import { BankRechargeLifecycleRepository } from './persistence/bank-recharge-lifecycle.repository';

type Entity = 'account' | 'order';
type Action = 'cancel' | 'delete' | 'restore';
function fingerprint(value: unknown) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

@Injectable()
export class BankRechargeLifecycleService {
  constructor(
    private readonly repository: BankRechargeLifecycleRepository,
    private readonly transactions: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService
  ) {}

  private async context(tx: V2CommandTransaction, entity: Entity, id: string, action: Action) {
    if (entity === 'account') {
      if (action === 'restore')
        throw new ConflictException('软删除账号恢复需通过数据治理填写备份证据并由另一管理员审批');
      const account = await this.repository.account(tx, id);
      if (!account) throw new NotFoundException('ChatGPT 账号不存在');
      if (action === 'cancel') throw new BadRequestException('账号不支持作废');
      if (account.deletedAt) throw new ConflictException('账号已删除，请通过数据治理恢复原记录');
      const references = await this.repository.accountReferences(tx, id);
      if (account.officialAccountKey || Object.values(references).some((count) => count > 0))
        throw new ConflictException('账号已有官网核验或业务关联，请改为停用');
      return {
        id,
        entity,
        action,
        label: account.emailMasked,
        status: account.status,
        deletedAt: null,
        expectedUpdatedAt: account.updatedAt.toISOString(),
        references
      };
    }
    const order = await this.repository.order(tx, id);
    if (!order) throw new NotFoundException('银充订单不存在');
    if (action === 'restore' && order.deletedAt)
      throw new ConflictException('回收站订单恢复需通过数据治理填写备份证据并由另一管理员审批');
    if (action === 'restore' ? order.status !== 'cancelled' : Boolean(order.deletedAt))
      throw new ConflictException(action === 'restore' ? '只允许恢复已作废误录单' : '订单已删除');
    if (action === 'delete' && order.status !== 'cancelled')
      throw new ConflictException('请先作废误录订单，再移入回收站');
    if (
      action === 'cancel' &&
      !['pending_details', 'pending_finance', 'pending_receipt'].includes(order.status)
    )
      throw new ConflictException('只允许作废未过账的手工误录单');
    const references = await this.repository.orderReferences(tx, id, order.accountId);
    if (
      order.source !== 'manual' ||
      order.financeStatus !== 'unposted' ||
      order.rechargeJobId ||
      order.checkoutIdentifier ||
      order.paymentEvidenceId ||
      order.verifiedAt ||
      (order.receivedAmount && !order.receivedAmount.isZero()) ||
      references.journals > 0 ||
      references.successor > 0
    )
      throw new ConflictException('订单已有付款、收款、账务或续费事实，必须按实际更正或退款处理');
    return {
      id,
      entity,
      action,
      label: order.orderNo,
      status: order.status,
      deletedAt: order.deletedAt?.toISOString() ?? null,
      expectedUpdatedAt: order.updatedAt.toISOString(),
      references
    };
  }

  async preview(entity: Entity, id: string, action: Action) {
    bankRechargeId(id, entity === 'account' ? 'ChatGPT 账号' : '银充订单');
    return this.repository.read(async (tx) => {
      const context = await this.context(tx, entity, id, action);
      return { ...context, previewFingerprint: fingerprint(context) };
    });
  }

  async execute(
    entity: Entity,
    id: string,
    action: Action,
    value: unknown,
    operator: AuthenticatedUser
  ) {
    bankRechargeId(id, entity === 'account' ? 'ChatGPT 账号' : '银充订单');
    const input = bankRechargeObject(value);
    if (
      Object.keys(input).some(
        (key) =>
          ![
            'expectedUpdatedAt',
            'reason',
            'operationId',
            'previewFingerprint',
            'confirmNoPaymentOrReceipt'
          ].includes(key)
      )
    )
      throw new BadRequestException('操作确认资料包含未知字段');
    const expected = normalizeV2ExpectedUpdatedAt(input.expectedUpdatedAt, '资料');
    const reason = bankRechargeText(input.reason, '操作原因', 500);
    const operationId = bankRechargeId(input.operationId, '操作编号');
    if (
      typeof input.previewFingerprint !== 'string' ||
      !/^[a-f0-9]{64}$/.test(input.previewFingerprint)
    )
      throw new BadRequestException('请先预览影响再确认');
    if (entity === 'order' && input.confirmNoPaymentOrReceipt !== true)
      throw new BadRequestException('请核对并确认本单为误录且没有真实付款或收款');
    const requestDigest = fingerprint({
      entity,
      id,
      action,
      expected: expected.toISOString(),
      reason,
      previewFingerprint: input.previewFingerprint,
      operator: operator.id
    });
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
        const before = await this.context(tx, entity, id, action);
        if (
          before.expectedUpdatedAt !== expected.toISOString() ||
          fingerprint(before) !== input.previewFingerprint
        )
          throw new ConflictException('资料或关联状态已变化，请重新预览确认');
        const deletedAt = action === 'delete' ? new Date() : null;
        const item =
          entity === 'account'
            ? await this.repository.updateAccount(tx, id, deletedAt, operator.id)
            : await this.repository.updateOrder(
                tx,
                id,
                deletedAt,
                action === 'restore',
                operator.id
              );
        if (entity === 'order' && action !== 'restore')
          await this.repository.cancelProjection(tx, id);
        const outcome = {
          id: item.id,
          status: item.status,
          deletedAt: item.deletedAt?.toISOString() ?? null,
          updatedAt: item.updatedAt.toISOString()
        };
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action:
            entity === 'account'
              ? `id_business_v2.auto_recharge.chatgpt_account.${action}`
              : `id_business_v2.bank_recharge.order.${action}`,
          objectType: entity === 'account' ? 'chatgpt_account' : 'bank_recharge_order',
          objectId: id,
          beforeData: toV2JsonDocument(before),
          afterData: toV2JsonDocument({
            lifecycleOperationId: operationId,
            requestDigest,
            outcome,
            noPaymentOrReceiptConfirmed: entity === 'order'
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

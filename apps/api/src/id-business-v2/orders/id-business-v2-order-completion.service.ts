import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { IdBusinessV2FinancePostingService } from '../finance/public-api';
import {
  Amount4,
  Rate8,
  V2CommandTransactionManager,
  type V2CommandTransaction
} from '../runtime/public-api';
import { IdBusinessV2OrdersService } from './id-business-v2-orders.service';
import { IdBusinessV2OrdersRepository } from './persistence/id-business-v2-orders.repository';
import type {
  IdBusinessV2BalanceLedgerRecord,
  IdBusinessV2OrderActivationRecord,
  IdBusinessV2OrderRecord
} from './id-business-v2-order.types';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class IdBusinessV2OrderCompletionService {
  constructor(
    private readonly ordersService: IdBusinessV2OrdersService,
    private readonly financePostingService: IdBusinessV2FinancePostingService,
    private readonly repository: IdBusinessV2OrdersRepository,
    private readonly transactionManager: V2CommandTransactionManager
  ) {}

  async complete(orderIdValue: string, operator?: AuthenticatedUser) {
    const orderId = this.normalizeRequiredUuid(orderIdValue);
    const execute = async (tx: V2CommandTransaction, context: { businessTime: Date }) => {
      const order = await this.lockOrder(tx, orderId);
      const [consumption, reversal, existingActivation] = await Promise.all([
        this.findLedger(tx, order.id, 'order_consumption'),
        this.findLedger(tx, order.id, 'order_consumption_reversal'),
        this.repository.findActivationByOrder(tx, order.id)
      ]);

      this.assertCompletionEvidence(order, consumption, reversal);

      if (existingActivation) {
        this.assertReplayEvidence(order, existingActivation);
        return {
          orderId: order.id,
          activation: existingActivation,
          consumptionLedgerId: consumption.id,
          idempotentReplay: true
        };
      }
      if (order.status !== 'processing') {
        throw new ConflictException('只有已真实扣款、等待开通的订单可以确认完成');
      }

      const completedAt = context.businessTime;
      const account = await this.repository.lockAccountForSale(tx, order.accountId!);
      if (!account) {
        throw new ConflictException('订单绑定的 ID 不存在或已删除');
      }
      const isInventorySale =
        order.accountSource === 'inventory' && order.accountDisposition === 'sold';
      if (isInventorySale && account.soldByOrderId !== order.id) {
        throw new ConflictException('订单售出 ID 的归属证据不一致，请刷新后核对');
      }
      if (order.accountSource === 'customer_owned' && !account.ownershipTransferredAt) {
        const recoveredSource =
          order.sourceSoldOrderId &&
          (await this.repository.findRecoveredCustomerOwnedSource(tx, {
            sourceOrderId: order.sourceSoldOrderId,
            accountId: account.id,
            customerId: order.customerId
          }));
        if (!recoveredSource) {
          throw new ConflictException('客户已购 ID 尚未完成所有权转移，不能确认售后订单');
        }
      }
      const transferredBalanceCostAmount = isInventorySale
        ? account.balanceCostAmount
        : Amount4.zero();
      const appliedBalanceCostAmount = order.appliedBalanceCostAmount.add(
        transferredBalanceCostAmount
      );
      const profitAmount = order.receivedAmount
        .sub(order.platformFeeAmount)
        .sub(order.appliedAccountCostAmount)
        .sub(appliedBalanceCostAmount)
        .sub(order.refundCostAmount ?? 0);

      if (isInventorySale) {
        const transfer = await this.repository.transferSoldAccountOwnership(tx, {
          accountId: account.id,
          orderId: order.id,
          transferredAt: completedAt,
          updatedByUserId: operator?.id
        });
        if (transfer.count !== 1) {
          throw new ConflictException('ID 所有权已经变化，请刷新后核对');
        }
      }
      const activation = await this.repository.createActivation(tx, {
        orderId: order.id,
        customerId: order.customerId,
        accountId: order.accountId!,
        serviceOptionId: order.serviceOptionId,
        openedAt: order.openedAt!,
        dueAt: order.dueAt,
        status: 'active',
        statusChangedAt: completedAt,
        remark: order.remark,
        createdByUserId: operator?.id,
        updatedByUserId: operator?.id
      });

      await this.repository.updateOrder(tx, order.id, {
        transferredBalanceCostAmount: transferredBalanceCostAmount.toString(),
        appliedBalanceCostAmount: appliedBalanceCostAmount.toString(),
        profitAmount: profitAmount.toString(),
        status: 'completed',
        statusChangedAt: completedAt,
        updatedByUserId: operator?.id
      });
      const releasedLocks = await this.repository.releaseActiveLocksForOrder(tx, {
        orderId: order.id,
        endedAt: completedAt,
        endReason: '订单完成后释放'
      });
      const financeJournal = await this.postCompletionJournalInTransaction(
        tx,
        {
          ...order,
          transferredBalanceCostAmount,
          appliedBalanceCostAmount,
          profitAmount
        },
        completedAt,
        operator
      );

      await this.repository.appendAudit(tx, {
        userId: operator?.id,
        module: 'id_business_v2',
        action: 'id_business_v2.order.complete',
        objectType: 'id_business_v2_order',
        objectId: order.id,
        beforeData: {
          status: order.status,
          accountId: order.accountId,
          consumptionLedgerId: consumption.id
        },
        afterData: {
          status: 'completed',
          activationId: activation.id,
          openedAt: activation.openedAt,
          dueAt: activation.dueAt,
          releasedLockCount: releasedLocks.count,
          transferredBalanceCostAmount: transferredBalanceCostAmount.toString(),
          appliedBalanceCostAmount: appliedBalanceCostAmount.toString(),
          financeJournalId: financeJournal.id
        },
        remark: `V2 订单完成并生成开通记录：${order.orderNo}`
      });

      return {
        orderId: order.id,
        activation,
        consumptionLedgerId: consumption.id,
        idempotentReplay: false
      };
    };
    const result = await this.transactionManager.execute(execute, {
      changedScopes: ['orders'],
      requestId: randomUUID(),
      operator,
      retryMode: 'fullReplay',
      idempotencyKey: `order_complete:${orderId}`,
      replay: execute,
      uniqueConflictMessage: '订单已生成开通记录，请刷新后核对'
    });

    return {
      order: await this.ordersService.get(result.orderId),
      activation: this.toActivationResponse(result.activation),
      consumptionLedgerId: result.consumptionLedgerId,
      idempotentReplay: result.idempotentReplay
    };
  }

  postCompletionJournalInTransaction(
    tx: V2CommandTransaction,
    order: IdBusinessV2OrderRecord,
    completedAt: Date,
    operator?: AuthenticatedUser
  ) {
    const receivedOriginalAmount = order.receivedOriginalAmount;
    const receivedAmount = order.receivedAmount;
    const rate = order.receivedFxRateToCny;
    const platformFeeAmount = order.platformFeeAmount;
    const transferredBalanceCostAmount = order.transferredBalanceCostAmount;
    const balanceCostAmount = order.appliedBalanceCostAmount.sub(transferredBalanceCostAmount);
    const appliedAccountCostAmount = order.appliedAccountCostAmount;
    const hasOriginalEvidence = receivedOriginalAmount.gt(0);
    const currency = hasOriginalEvidence ? order.receivedCurrency : ('CNY' as const);
    const receivedOriginal = hasOriginalEvidence ? receivedOriginalAmount : receivedAmount;
    const effectiveRate = hasOriginalEvidence ? rate : Rate8.one();
    const platformFeeOriginal =
      currency === 'CNY' ? platformFeeAmount : platformFeeAmount.div(effectiveRate);
    return this.financePostingService.post(tx, {
      journalType: 'order_completed',
      sourceType: 'order',
      sourceId: order.id,
      sourceReference: order.orderNo,
      occurredAt: completedAt,
      summary: `订单完成：${order.orderNo}`,
      idempotencyKey: `auto:order_completed:${order.id}`,
      operator,
      lines: [
        {
          accountCode: 'cash',
          direction: 'debit',
          currency,
          amountOriginal: receivedOriginal,
          fxRateToCny: effectiveRate,
          amountCny: receivedAmount,
          financeAccountId: order.receivedFinanceAccountId,
          fxRateSnapshotId: order.receivedFxSnapshotId,
          memo: '订单收款'
        },
        {
          accountCode: 'sales_revenue',
          direction: 'credit',
          currency,
          amountOriginal: receivedOriginal,
          fxRateToCny: effectiveRate,
          amountCny: receivedAmount,
          fxRateSnapshotId: order.receivedFxSnapshotId,
          memo: '已完成订单收入'
        },
        {
          accountCode: 'platform_fee',
          direction: 'debit',
          currency,
          amountOriginal: platformFeeOriginal,
          fxRateToCny: effectiveRate,
          amountCny: platformFeeAmount,
          fxRateSnapshotId: order.receivedFxSnapshotId,
          memo: '订单平台手续费'
        },
        {
          accountCode: 'cash',
          direction: 'credit',
          currency,
          amountOriginal: platformFeeOriginal,
          fxRateToCny: effectiveRate,
          amountCny: platformFeeAmount,
          financeAccountId: order.receivedFinanceAccountId,
          fxRateSnapshotId: order.receivedFxSnapshotId,
          memo: '平台手续费扣款'
        },
        ...(balanceCostAmount.isZero()
          ? []
          : [
              {
                accountCode: 'gift_card_cost' as const,
                direction: 'debit' as const,
                currency: 'CNY' as const,
                amountOriginal: balanceCostAmount,
                fxRateToCny: 1,
                amountCny: balanceCostAmount,
                memo: '已消耗自有礼品卡余额成本'
              },
              {
                accountCode: 'gift_card_inventory' as const,
                direction: 'credit' as const,
                currency: 'CNY' as const,
                amountOriginal: balanceCostAmount,
                fxRateToCny: 1,
                amountCny: balanceCostAmount,
                memo: '结转自有礼品卡库存成本'
              }
            ]),
        ...(transferredBalanceCostAmount.isZero()
          ? []
          : [
              {
                accountCode: 'customer_owned_balance_cost' as const,
                direction: 'debit' as const,
                currency: 'CNY' as const,
                amountOriginal: transferredBalanceCostAmount,
                fxRateToCny: 1,
                amountCny: transferredBalanceCostAmount,
                memo: '售出 ID 剩余余额成本转为客户资产'
              },
              {
                accountCode: 'gift_card_inventory' as const,
                direction: 'credit' as const,
                currency: 'CNY' as const,
                amountOriginal: transferredBalanceCostAmount,
                fxRateToCny: 1,
                amountCny: transferredBalanceCostAmount,
                memo: '转出客户已购 ID 剩余余额成本'
              }
            ]),
        ...(appliedAccountCostAmount.isZero()
          ? []
          : [
              {
                accountCode: 'id_cost' as const,
                direction: 'debit' as const,
                currency: 'CNY' as const,
                amountOriginal: appliedAccountCostAmount,
                fxRateToCny: 1,
                amountCny: appliedAccountCostAmount,
                memo: '首次售出 ID 成本'
              },
              {
                accountCode: 'id_inventory' as const,
                direction: 'credit' as const,
                currency: 'CNY' as const,
                amountOriginal: appliedAccountCostAmount,
                fxRateToCny: 1,
                amountCny: appliedAccountCostAmount,
                memo: '结转 ID 库存成本'
              }
            ])
      ]
    });
  }

  private async lockOrder(tx: V2CommandTransaction, orderId: string) {
    if (!(await this.repository.lockOrderId(tx, orderId))) {
      throw new NotFoundException('订单不存在或已删除');
    }
    const order = await this.repository.findOrderInTransaction(tx, orderId);
    if (!order || order.deletedAt) {
      throw new NotFoundException('订单不存在或已删除');
    }
    return order;
  }

  private findLedger(
    tx: V2CommandTransaction,
    orderId: string,
    entryType: 'order_consumption' | 'order_consumption_reversal'
  ) {
    return this.repository.findLedgerByOrderAndType(tx, orderId, entryType);
  }

  private assertCompletionEvidence(
    order: IdBusinessV2OrderRecord,
    consumption: IdBusinessV2BalanceLedgerRecord | null,
    reversal: IdBusinessV2BalanceLedgerRecord | null
  ): asserts consumption is IdBusinessV2BalanceLedgerRecord {
    if (!order.accountId || !order.openedAt || order.profitAmount === null) {
      throw new ConflictException('订单缺少绑定 ID、开通时间或利润证据，不能确认完成');
    }
    if (!consumption) {
      throw new ConflictException('订单没有真实扣款流水，不能生成开通记录');
    }
    if (reversal) {
      throw new ConflictException('订单消费已经撤销，不能生成开通记录');
    }
    if (
      consumption.orderId !== order.id ||
      consumption.accountId !== order.accountId ||
      consumption.entryType !== 'order_consumption' ||
      consumption.direction !== 'debit' ||
      consumption.reversalOfEntryId !== null ||
      !consumption.balanceAmount.equals(order.balanceAmount) ||
      !consumption.costAmount.equals(order.balanceCostAmount)
    ) {
      throw new ConflictException('订单扣款流水与余额或成本快照不一致，请人工核对');
    }
  }

  private assertReplayEvidence(
    order: IdBusinessV2OrderRecord,
    activation: IdBusinessV2OrderActivationRecord
  ) {
    const dueAtMatches =
      activation.dueAt === null
        ? order.dueAt === null
        : order.dueAt !== null && activation.dueAt.getTime() === order.dueAt.getTime();
    if (
      order.status !== 'completed' ||
      activation.orderId !== order.id ||
      activation.customerId !== order.customerId ||
      activation.accountId !== order.accountId ||
      activation.serviceOptionId !== order.serviceOptionId ||
      activation.openedAt.getTime() !== order.openedAt!.getTime() ||
      !dueAtMatches
    ) {
      throw new ConflictException('订单与现有开通记录不一致，请人工核对');
    }
  }

  private normalizeRequiredUuid(value: unknown) {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value.trim())) {
      throw new BadRequestException('订单格式无效');
    }
    return value.trim();
  }

  private toActivationResponse(activation: IdBusinessV2OrderActivationRecord) {
    return {
      id: activation.id,
      orderId: activation.orderId,
      customerId: activation.customerId,
      accountId: activation.accountId,
      serviceOptionId: activation.serviceOptionId,
      openedAt: activation.openedAt,
      dueAt: activation.dueAt,
      status: activation.status,
      createdAt: activation.createdAt
    };
  }
}

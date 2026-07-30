import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { Prisma as PrismaNamespace } from '@prisma/client';
import type {
  IdBusinessV2Activation,
  IdBusinessV2BalanceLedger,
  IdBusinessV2Order,
  Prisma
} from '@prisma/client';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { roundV2Decimal } from '../decimal-policy';
import { IdBusinessV2FinancePostingService } from '../finance/public-api';
import { IdBusinessV2OrdersService } from './id-business-v2-orders.service';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

@Injectable()
export class IdBusinessV2OrderCompletionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly ordersService: IdBusinessV2OrdersService,
    private readonly financePostingService: IdBusinessV2FinancePostingService
  ) {}

  async complete(orderIdValue: string, operator?: AuthenticatedUser) {
    const orderId = this.normalizeRequiredUuid(orderIdValue);
    let result: {
      orderId: string;
      activation: IdBusinessV2Activation;
      consumptionLedgerId: string;
      idempotentReplay: boolean;
    };

    try {
      result = await this.prisma.$transaction(async (tx) => {
        const order = await this.lockOrder(tx, orderId);
        const [consumption, reversal, existingActivation] = await Promise.all([
          this.findLedger(tx, order.id, 'order_consumption'),
          this.findLedger(tx, order.id, 'order_consumption_reversal'),
          tx.idBusinessV2Activation.findUnique({
            where: {
              orderId: order.id
            }
          })
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

        const completedAt = new Date();
        const activation = await tx.idBusinessV2Activation.create({
          data: {
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
          }
        });

        await tx.idBusinessV2Order.update({
          where: {
            id: order.id
          },
          data: {
            status: 'completed',
            statusChangedAt: completedAt,
            updatedByUserId: operator?.id
          }
        });
        const releasedLocks = await tx.idBusinessV2AccountLock.updateMany({
          where: {
            orderId: order.id,
            status: 'active'
          },
          data: {
            status: 'released',
            endedAt: completedAt,
            endReason: '订单完成后释放'
          }
        });
        const financeJournal = await this.postCompletionJournal(tx, order, completedAt, operator);

        await tx.auditLog.create({
          data: {
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
              financeJournalId: financeJournal.id
            },
            remark: `V2 订单完成并生成开通记录：${order.orderNo}`
          }
        });

        return {
          orderId: order.id,
          activation,
          consumptionLedgerId: consumption.id,
          idempotentReplay: false
        };
      });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        throw new ConflictException('订单已生成开通记录，请刷新后核对');
      }
      throw error;
    }

    return {
      order: await this.ordersService.get(result.orderId),
      activation: this.toActivationResponse(result.activation),
      consumptionLedgerId: result.consumptionLedgerId,
      idempotentReplay: result.idempotentReplay
    };
  }

  private postCompletionJournal(
    tx: Prisma.TransactionClient,
    order: IdBusinessV2Order,
    completedAt: Date,
    operator?: AuthenticatedUser
  ) {
    const hasOriginalEvidence = order.receivedOriginalAmount.gt(0);
    const currency = hasOriginalEvidence ? order.receivedCurrency : ('CNY' as const);
    const receivedOriginal = hasOriginalEvidence
      ? order.receivedOriginalAmount
      : order.receivedAmount;
    const rate = hasOriginalEvidence ? order.receivedFxRateToCny : new PrismaNamespace.Decimal(1);
    const platformFeeOriginal =
      currency === 'CNY'
        ? order.platformFeeAmount
        : roundV2Decimal(order.platformFeeAmount.div(rate));
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
          fxRateToCny: rate,
          amountCny: order.receivedAmount,
          financeAccountId: order.receivedFinanceAccountId,
          fxRateSnapshotId: order.receivedFxSnapshotId,
          memo: '订单收款'
        },
        {
          accountCode: 'sales_revenue',
          direction: 'credit',
          currency,
          amountOriginal: receivedOriginal,
          fxRateToCny: rate,
          amountCny: order.receivedAmount,
          fxRateSnapshotId: order.receivedFxSnapshotId,
          memo: '已完成订单收入'
        },
        {
          accountCode: 'platform_fee',
          direction: 'debit',
          currency,
          amountOriginal: platformFeeOriginal,
          fxRateToCny: rate,
          amountCny: order.platformFeeAmount,
          fxRateSnapshotId: order.receivedFxSnapshotId,
          memo: '订单平台手续费'
        },
        {
          accountCode: 'cash',
          direction: 'credit',
          currency,
          amountOriginal: platformFeeOriginal,
          fxRateToCny: rate,
          amountCny: order.platformFeeAmount,
          financeAccountId: order.receivedFinanceAccountId,
          fxRateSnapshotId: order.receivedFxSnapshotId,
          memo: '平台手续费扣款'
        },
        {
          accountCode: 'gift_card_cost',
          direction: 'debit',
          currency: 'CNY',
          amountOriginal: order.balanceCostAmount,
          fxRateToCny: 1,
          amountCny: order.balanceCostAmount,
          memo: '已消耗礼品卡余额成本'
        },
        {
          accountCode: 'gift_card_inventory',
          direction: 'credit',
          currency: 'CNY',
          amountOriginal: order.balanceCostAmount,
          fxRateToCny: 1,
          amountCny: order.balanceCostAmount,
          memo: '结转礼品卡库存成本'
        },
        {
          accountCode: 'id_cost',
          direction: 'debit',
          currency: 'CNY',
          amountOriginal: order.accountCostAmount,
          fxRateToCny: 1,
          amountCny: order.accountCostAmount,
          memo: '已卖出 ID 成本'
        },
        {
          accountCode: 'id_inventory',
          direction: 'credit',
          currency: 'CNY',
          amountOriginal: order.accountCostAmount,
          fxRateToCny: 1,
          amountCny: order.accountCostAmount,
          memo: '结转 ID 库存成本'
        }
      ]
    });
  }

  private async lockOrder(tx: Prisma.TransactionClient, orderId: string) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>(PrismaNamespace.sql`
      SELECT "id"
      FROM "id_business_v2_orders"
      WHERE
        "id" = CAST(${orderId} AS UUID)
        AND "deleted_at" IS NULL
      FOR UPDATE
    `);
    if (!rows[0]) {
      throw new NotFoundException('订单不存在或已删除');
    }
    const order = await tx.idBusinessV2Order.findUnique({
      where: {
        id: orderId
      }
    });
    if (!order || order.deletedAt) {
      throw new NotFoundException('订单不存在或已删除');
    }
    return order;
  }

  private findLedger(
    tx: Prisma.TransactionClient,
    orderId: string,
    entryType: 'order_consumption' | 'order_consumption_reversal'
  ) {
    return tx.idBusinessV2BalanceLedger.findUnique({
      where: {
        orderId_entryType: {
          orderId,
          entryType
        }
      }
    });
  }

  private assertCompletionEvidence(
    order: IdBusinessV2Order,
    consumption: IdBusinessV2BalanceLedger | null,
    reversal: IdBusinessV2BalanceLedger | null
  ): asserts consumption is IdBusinessV2BalanceLedger {
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

  private assertReplayEvidence(order: IdBusinessV2Order, activation: IdBusinessV2Activation) {
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

  private toActivationResponse(activation: IdBusinessV2Activation) {
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

  private isUniqueConstraintError(error: unknown) {
    return (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      (error as { code?: unknown }).code === 'P2002'
    );
  }
}

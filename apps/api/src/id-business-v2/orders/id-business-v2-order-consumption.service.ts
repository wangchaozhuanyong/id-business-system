import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Prisma as PrismaNamespace } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { IdBusinessV2BalanceCalculatorService } from '../balances/public-api';
import type { ConsumeIdBusinessV2OrderDto } from './dto/consume-id-business-v2-order.dto';
import { IdBusinessV2OrderLockService } from './id-business-v2-order-lock.service';
import { IdBusinessV2OrdersService } from './id-business-v2-orders.service';

const MAX_SIGNED_AMOUNT = new PrismaNamespace.Decimal('99999999999999.9999');
const ROUNDING_MODE = PrismaNamespace.Decimal.ROUND_HALF_UP;

@Injectable()
export class IdBusinessV2OrderConsumptionService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly orderLockService: IdBusinessV2OrderLockService,
    private readonly balanceCalculator: IdBusinessV2BalanceCalculatorService,
    private readonly ordersService: IdBusinessV2OrdersService
  ) {}

  async consume(orderId: string, dto: ConsumeIdBusinessV2OrderDto, operator?: AuthenticatedUser) {
    let transactionResult: {
      orderId: string;
      ledgerEntry: {
        id: string;
        accountId: string;
        balanceAmount: PrismaNamespace.Decimal;
        costAmount: PrismaNamespace.Decimal;
        balanceBefore: PrismaNamespace.Decimal;
        balanceAfter: PrismaNamespace.Decimal;
        costBefore: PrismaNamespace.Decimal;
        costAfter: PrismaNamespace.Decimal;
        averageCostBefore: PrismaNamespace.Decimal;
        averageCostAfter: PrismaNamespace.Decimal;
        createdAt: Date;
      };
      idempotentReplay: boolean;
    };

    try {
      transactionResult = await this.prisma.$transaction(async (tx) => {
        const prepared = await this.orderLockService.prepareOrderConsumptionInTransaction(
          tx,
          {
            orderId,
            idempotencyKey: dto.idempotencyKey
          },
          operator
        );

        if (prepared.idempotentReplay && prepared.existingEntry) {
          this.assertReplayEvidence(
            prepared.order,
            prepared.existingEntry,
            prepared.existingReversal ?? null
          );
          return {
            orderId: prepared.order.id,
            ledgerEntry: prepared.existingEntry,
            idempotentReplay: true
          };
        }
        if (!prepared.account || !prepared.activeLock) {
          throw new ConflictException('订单扣款前置证据不完整，请刷新后重试');
        }

        const movement = this.balanceCalculator.calculateConsumption(
          {
            currentBalance: prepared.account.currentBalance,
            balanceCostAmount: prepared.account.balanceCostAmount
          },
          prepared.order.balanceAmount
        );
        const accountCostAmount = this.normalizeStoredAmount(
          prepared.account.purchaseCost,
          'ID 购买成本'
        );
        const refundCostAmount = prepared.order.refundCostAmount ?? new PrismaNamespace.Decimal(0);
        const profitAmount = prepared.order.receivedAmount
          .minus(prepared.order.platformFeeAmount)
          .minus(movement.costAmount)
          .minus(refundCostAmount)
          .toDecimalPlaces(4, ROUNDING_MODE);
        this.assertSignedAmountWithinRange(profitAmount, '订单利润');

        const ledgerEntry = await tx.idBusinessV2BalanceLedger.create({
          data: {
            accountId: prepared.account.id,
            giftCardId: null,
            orderId: prepared.order.id,
            entryType: 'order_consumption',
            direction: 'debit',
            balanceAmount: movement.balanceAmount,
            costAmount: movement.costAmount,
            balanceBefore: movement.balanceBefore,
            balanceAfter: movement.balanceAfter,
            costBefore: movement.costBefore,
            costAfter: movement.costAfter,
            averageCostBefore: movement.averageCostBefore,
            averageCostAfter: movement.averageCostAfter,
            reversalOfEntryId: null,
            idempotencyKey: prepared.idempotencyKey,
            remark: `订单余额扣减：${prepared.order.orderNo}`,
            createdByUserId: operator?.id
          }
        });

        await tx.idBusinessV2Account.update({
          where: {
            id: prepared.account.id
          },
          data: {
            currentBalance: movement.balanceAfter,
            balanceCostAmount: movement.costAfter,
            updatedByUserId: operator?.id
          }
        });

        const statusChangedAt = new Date();
        await tx.idBusinessV2Order.update({
          where: {
            id: prepared.order.id
          },
          data: {
            accountCostAmount,
            balanceCostAmount: movement.costAmount,
            profitAmount,
            status: 'processing',
            statusChangedAt,
            updatedByUserId: operator?.id
          }
        });

        await this.writeAuditLog(
          tx,
          {
            orderId: prepared.order.id,
            orderNo: prepared.order.orderNo,
            accountId: prepared.account.id,
            appleIdMasked: prepared.account.appleIdMasked,
            activeLockId: prepared.activeLock.id,
            previousStatus: prepared.order.status,
            accountCostAmount,
            platformFeeAmount: prepared.order.platformFeeAmount,
            refundCostAmount,
            profitAmount,
            movement,
            statusChangedAt
          },
          operator
        );

        return {
          orderId: prepared.order.id,
          ledgerEntry,
          idempotentReplay: false
        };
      });
    } catch (error) {
      if (this.isUniqueConstraintError(error)) {
        throw new ConflictException('订单余额已经扣减或请求已经处理，请刷新后核对');
      }
      throw error;
    }

    const order = await this.ordersService.get(transactionResult.orderId);
    return {
      order,
      ledgerEntry: this.toLedgerResponse(transactionResult.ledgerEntry),
      idempotentReplay: transactionResult.idempotentReplay,
      nextStep: this.resolveNextStep(order.status)
    };
  }

  private assertReplayEvidence(
    order: {
      id: string;
      accountId: string | null;
      balanceAmount: PrismaNamespace.Decimal;
      balanceCostAmount: PrismaNamespace.Decimal;
      profitAmount: PrismaNamespace.Decimal | null;
      status: string;
    },
    entry: {
      id: string;
      orderId: string | null;
      accountId: string;
      entryType: string;
      direction: string;
      balanceAmount: PrismaNamespace.Decimal;
      costAmount: PrismaNamespace.Decimal;
    },
    reversal: {
      orderId: string | null;
      accountId: string;
      entryType: string;
      direction: string;
      balanceAmount: PrismaNamespace.Decimal;
      costAmount: PrismaNamespace.Decimal;
      reversalOfEntryId: string | null;
    } | null
  ) {
    const reversedEvidenceIsValid =
      reversal !== null &&
      reversal.orderId === order.id &&
      reversal.accountId === entry.accountId &&
      reversal.entryType === 'order_consumption_reversal' &&
      reversal.direction === 'credit' &&
      reversal.reversalOfEntryId === entry.id;
    const reversalMatchesOriginal =
      reversedEvidenceIsValid &&
      reversal.balanceAmount.equals(entry.balanceAmount) &&
      reversal.costAmount.equals(entry.costAmount);
    if (
      reversal &&
      (!reversalMatchesOriginal ||
        (order.status !== 'cancelled' && order.status !== 'refunded') ||
        !order.balanceCostAmount.equals(0))
    ) {
      throw new ConflictException('订单已有消费撤销流水，但撤销证据不完整，请人工检查');
    }
    if (
      entry.orderId !== order.id ||
      !order.accountId ||
      entry.accountId !== order.accountId ||
      entry.entryType !== 'order_consumption' ||
      entry.direction !== 'debit' ||
      !entry.balanceAmount.equals(order.balanceAmount) ||
      (!reversal && !entry.costAmount.equals(order.balanceCostAmount)) ||
      order.profitAmount === null ||
      order.status === 'draft' ||
      order.status === 'pending'
    ) {
      throw new ConflictException('订单已有扣款流水，但成本或状态证据不完整，请人工检查');
    }
  }

  private normalizeStoredAmount(value: PrismaNamespace.Decimal.Value, label: string) {
    const amount = new PrismaNamespace.Decimal(value).toDecimalPlaces(4, ROUNDING_MODE);
    if (amount.isNegative() || amount.greaterThan(MAX_SIGNED_AMOUNT)) {
      throw new BadRequestException(`${label}数值超出数据库范围`);
    }
    return amount;
  }

  private assertSignedAmountWithinRange(value: PrismaNamespace.Decimal, label: string) {
    if (value.abs().greaterThan(MAX_SIGNED_AMOUNT)) {
      throw new BadRequestException(`${label}数值超出数据库范围`);
    }
  }

  private async writeAuditLog(
    tx: Prisma.TransactionClient,
    input: {
      orderId: string;
      orderNo: string;
      accountId: string;
      appleIdMasked: string;
      activeLockId: string;
      previousStatus: string;
      accountCostAmount: PrismaNamespace.Decimal;
      platformFeeAmount: PrismaNamespace.Decimal;
      refundCostAmount: PrismaNamespace.Decimal;
      profitAmount: PrismaNamespace.Decimal;
      movement: {
        balanceAmount: PrismaNamespace.Decimal;
        costAmount: PrismaNamespace.Decimal;
        balanceBefore: PrismaNamespace.Decimal;
        balanceAfter: PrismaNamespace.Decimal;
        costBefore: PrismaNamespace.Decimal;
        costAfter: PrismaNamespace.Decimal;
        averageCostBefore: PrismaNamespace.Decimal;
        averageCostAfter: PrismaNamespace.Decimal;
      };
      statusChangedAt: Date;
    },
    operator?: AuthenticatedUser
  ) {
    await tx.auditLog.create({
      data: {
        userId: operator?.id,
        module: 'id_business_v2',
        action: 'id_business_v2.order.consume_balance',
        objectType: 'id_business_v2_order',
        objectId: input.orderId,
        beforeData: {
          status: input.previousStatus,
          accountId: input.accountId,
          appleIdMasked: input.appleIdMasked,
          activeLockId: input.activeLockId,
          balance: input.movement.balanceBefore.toString(),
          balanceCostAmount: input.movement.costBefore.toString(),
          averageCost: input.movement.averageCostBefore.toString()
        },
        afterData: {
          status: 'processing',
          statusChangedAt: input.statusChangedAt,
          consumedBalance: input.movement.balanceAmount.toString(),
          balanceCostAmount: input.movement.costAmount.toString(),
          accountCostAmount: input.accountCostAmount.toString(),
          platformFeeAmount: input.platformFeeAmount.toString(),
          refundCostAmount: input.refundCostAmount.toString(),
          profitAmount: input.profitAmount.toString(),
          balance: input.movement.balanceAfter.toString(),
          remainingBalanceCostAmount: input.movement.costAfter.toString(),
          averageCost: input.movement.averageCostAfter.toString()
        },
        remark: `V2 订单真实扣减余额并计算利润：${input.orderNo}`
      }
    });
  }

  private toLedgerResponse(entry: {
    id: string;
    accountId: string;
    balanceAmount: PrismaNamespace.Decimal;
    costAmount: PrismaNamespace.Decimal;
    balanceBefore: PrismaNamespace.Decimal;
    balanceAfter: PrismaNamespace.Decimal;
    costBefore: PrismaNamespace.Decimal;
    costAfter: PrismaNamespace.Decimal;
    averageCostBefore: PrismaNamespace.Decimal;
    averageCostAfter: PrismaNamespace.Decimal;
    createdAt: Date;
  }) {
    return {
      id: entry.id,
      accountId: entry.accountId,
      balanceAmount: entry.balanceAmount.toString(),
      costAmount: entry.costAmount.toString(),
      balanceBefore: entry.balanceBefore.toString(),
      balanceAfter: entry.balanceAfter.toString(),
      costBefore: entry.costBefore.toString(),
      costAfter: entry.costAfter.toString(),
      averageCostBefore: entry.averageCostBefore.toString(),
      averageCostAfter: entry.averageCostAfter.toString(),
      createdAt: entry.createdAt
    };
  }

  private resolveNextStep(status: string) {
    if (status === 'processing') return 'waiting_activation_record' as const;
    if (status === 'completed') return 'completed' as const;
    if (status === 'refunded') return 'refunded' as const;
    if (status === 'cancelled') return 'cancelled' as const;
    return 'manual_review' as const;
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

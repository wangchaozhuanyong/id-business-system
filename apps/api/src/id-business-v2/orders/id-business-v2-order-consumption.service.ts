import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { IdBusinessV2BalanceCalculatorService } from '../balances/public-api';
import {
  Amount4,
  V2CommandTransactionManager,
  type V2CommandTransaction,
  type V2DecimalInput
} from '../runtime/public-api';
import type { ConsumeIdBusinessV2OrderDto } from './dto/consume-id-business-v2-order.dto';
import { IdBusinessV2OrderLockService } from './id-business-v2-order-lock.service';
import type { LockedOrderRow } from './id-business-v2-order-lock-support';
import { IdBusinessV2OrdersService } from './id-business-v2-orders.service';
import type { IdBusinessV2BalanceLedgerRecord } from './id-business-v2-order.types';
import { IdBusinessV2OrdersRepository } from './persistence/id-business-v2-orders.repository';

const MAX_SIGNED_AMOUNT = Amount4.from('99999999999999.9999');

@Injectable()
export class IdBusinessV2OrderConsumptionService {
  constructor(
    private readonly orderLockService: IdBusinessV2OrderLockService,
    private readonly balanceCalculator: IdBusinessV2BalanceCalculatorService,
    private readonly ordersService: IdBusinessV2OrdersService,
    private readonly repository: IdBusinessV2OrdersRepository,
    private readonly transactionManager: V2CommandTransactionManager
  ) {}

  async consume(orderId: string, dto: ConsumeIdBusinessV2OrderDto, operator?: AuthenticatedUser) {
    const prepare = (tx: V2CommandTransaction) =>
      this.orderLockService.prepareOrderConsumptionInTransaction(
        tx,
        {
          orderId,
          idempotencyKey: dto.idempotencyKey
        },
        operator
      );
    const buildReplay = (prepared: Awaited<ReturnType<typeof prepare>>) => {
      if (!prepared.idempotentReplay || !prepared.existingEntry) {
        throw new ConflictException('订单余额已经扣减或请求已经处理，请刷新后核对');
      }
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
    };
    const replay = async (tx: V2CommandTransaction) => buildReplay(await prepare(tx));
    const execute = async (tx: V2CommandTransaction) => {
      const prepared = await prepare(tx);

      if (prepared.idempotentReplay && prepared.existingEntry) {
        return buildReplay(prepared);
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
        prepared.order.accountCostAmount,
        'ID 购买成本快照'
      );
      if (
        prepared.order.accountDisposition === 'sold' &&
        prepared.account.soldByOrderId !== prepared.order.id
      ) {
        throw new ConflictException('订单标记为卖出 ID，但 ID 销售占用证据不一致');
      }
      const appliedAccountCostAmount =
        prepared.order.accountDisposition === 'sold' ? accountCostAmount : Amount4.zero();
      const receivedAmount = prepared.order.receivedAmount;
      const platformFeeAmount = prepared.order.platformFeeAmount;
      const refundCostAmount = prepared.order.refundCostAmount ?? Amount4.zero();
      const profitAmount = receivedAmount
        .sub(platformFeeAmount)
        .sub(appliedAccountCostAmount)
        .sub(movement.costAmount)
        .sub(refundCostAmount);
      this.assertSignedAmountWithinRange(profitAmount, '订单利润');

      const ledgerEntry = await this.repository.createBalanceLedger(tx, {
        accountId: prepared.account.id,
        giftCardId: null,
        orderId: prepared.order.id,
        entryType: 'order_consumption',
        direction: 'debit',
        balanceAmount: movement.balanceAmount.toString(),
        costAmount: movement.costAmount.toString(),
        balanceBefore: movement.balanceBefore.toString(),
        balanceAfter: movement.balanceAfter.toString(),
        costBefore: movement.costBefore.toString(),
        costAfter: movement.costAfter.toString(),
        averageCostBefore: movement.averageCostBefore.toString(),
        averageCostAfter: movement.averageCostAfter.toString(),
        reversalOfEntryId: null,
        idempotencyKey: prepared.idempotencyKey,
        remark: `订单余额扣减：${prepared.order.orderNo}`,
        createdByUserId: operator?.id
      });

      await this.repository.updateAccount(tx, prepared.account.id, {
        currentBalance: movement.balanceAfter.toString(),
        balanceCostAmount: movement.costAfter.toString(),
        updatedByUserId: operator?.id
      });

      const statusChangedAt = new Date();
      await this.repository.updateOrder(tx, prepared.order.id, {
        accountCostAmount: accountCostAmount.toString(),
        balanceCostAmount: movement.costAmount.toString(),
        profitAmount: profitAmount.toString(),
        status: 'processing',
        statusChangedAt,
        updatedByUserId: operator?.id
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
          accountDisposition: prepared.order.accountDisposition,
          accountCostAmount,
          appliedAccountCostAmount,
          platformFeeAmount,
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
    };
    const transactionResult = await this.transactionManager.execute(execute, {
      requestId: randomUUID(),
      operator,
      retryMode: 'fullReplay',
      idempotencyKey: `order_consumption:${orderId}:${dto.idempotencyKey}`,
      replay,
      uniqueConflictMessage: '订单余额已经扣减或请求已经处理，请刷新后核对'
    });

    const order = await this.ordersService.get(transactionResult.orderId);
    return {
      order,
      ledgerEntry: this.toLedgerResponse(transactionResult.ledgerEntry),
      idempotentReplay: transactionResult.idempotentReplay,
      nextStep: this.resolveNextStep(order.status)
    };
  }

  private assertReplayEvidence(
    order: LockedOrderRow,
    entry: IdBusinessV2BalanceLedgerRecord,
    reversal: IdBusinessV2BalanceLedgerRecord | null
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

  private normalizeStoredAmount(amount: Amount4, label: string) {
    if (amount.isNegative() || amount.gt(MAX_SIGNED_AMOUNT)) {
      throw new BadRequestException(`${label}数值超出数据库范围`);
    }
    return amount;
  }

  private assertSignedAmountWithinRange(value: Amount4, label: string) {
    if (value.abs().gt(MAX_SIGNED_AMOUNT)) {
      throw new BadRequestException(`${label}数值超出数据库范围`);
    }
  }

  private async writeAuditLog(
    tx: V2CommandTransaction,
    input: {
      orderId: string;
      orderNo: string;
      accountId: string;
      appleIdMasked: string;
      activeLockId: string;
      previousStatus: string;
      accountDisposition: string;
      accountCostAmount: Amount4;
      appliedAccountCostAmount: Amount4;
      platformFeeAmount: Amount4;
      refundCostAmount: Amount4;
      profitAmount: Amount4;
      movement: {
        balanceAmount: V2DecimalInput;
        costAmount: V2DecimalInput;
        balanceBefore: V2DecimalInput;
        balanceAfter: V2DecimalInput;
        costBefore: V2DecimalInput;
        costAfter: V2DecimalInput;
        averageCostBefore: V2DecimalInput;
        averageCostAfter: V2DecimalInput;
      };
      statusChangedAt: Date;
    },
    operator?: AuthenticatedUser
  ) {
    await this.repository.appendAudit(tx, {
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
        accountDisposition: input.accountDisposition,
        accountCostAmount: input.accountCostAmount.toString(),
        appliedAccountCostAmount: input.appliedAccountCostAmount.toString(),
        platformFeeAmount: input.platformFeeAmount.toString(),
        refundCostAmount: input.refundCostAmount.toString(),
        profitAmount: input.profitAmount.toString(),
        balance: input.movement.balanceAfter.toString(),
        remainingBalanceCostAmount: input.movement.costAfter.toString(),
        averageCost: input.movement.averageCostAfter.toString()
      },
      remark: `V2 订单真实扣减余额并计算利润：${input.orderNo}`
    });
  }

  private toLedgerResponse(entry: IdBusinessV2BalanceLedgerRecord) {
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
}

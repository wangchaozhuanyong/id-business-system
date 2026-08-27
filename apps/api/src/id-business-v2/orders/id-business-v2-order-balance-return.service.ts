import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { IdBusinessV2BalanceCalculatorService } from '../balances/public-api';
import { IdBusinessV2FinancePostingService } from '../finance/public-api';
import {
  Amount4,
  V2CommandTransactionManager,
  type V2CommandTransaction
} from '../runtime/public-api';
import type {
  PreviewUpgradeBalanceReturnIdBusinessV2OrderDto,
  RecordUpgradeBalanceReturnIdBusinessV2OrderDto,
  ReverseUpgradeBalanceReturnIdBusinessV2OrderDto
} from './dto/upgrade-balance-return-id-business-v2-order.dto';
import {
  assertOrderCanRecordUpgradeBalanceReturn,
  assertUpgradeBalanceReturnReplay,
  assertUpgradeBalanceReturnReversalReplay,
  appendUpgradeBalanceReturnActivationRemark,
  buildUpgradeBalanceReturnPreview,
  calculateOrderProfit,
  calculateUpgradeBalanceReturnCost,
  minAmount,
  normalizeUpgradeBalanceReturnAmount,
  removeUpgradeBalanceReturnActivationRemark,
  resolveOrderBalanceCurrencyCode,
  toUpgradeBalanceReturnResponse
} from './id-business-v2-order-balance-return-support';
import {
  normalizeIdempotencyKey,
  normalizeRequiredReason,
  normalizeUuid
} from './id-business-v2-order-lock-support';
import { IdBusinessV2OrdersService } from './id-business-v2-orders.service';
import { IdBusinessV2OrdersRepository } from './persistence/id-business-v2-orders.repository';

@Injectable()
export class IdBusinessV2OrderBalanceReturnService {
  constructor(
    private readonly balanceCalculator: IdBusinessV2BalanceCalculatorService,
    private readonly financePostingService: IdBusinessV2FinancePostingService,
    private readonly ordersService: IdBusinessV2OrdersService,
    private readonly repository: IdBusinessV2OrdersRepository,
    private readonly transactionManager: V2CommandTransactionManager
  ) {}

  async preview(orderIdValue: string, dto: PreviewUpgradeBalanceReturnIdBusinessV2OrderDto) {
    const orderId = normalizeUuid(orderIdValue, '订单');
    const returnedBalanceAmount = normalizeUpgradeBalanceReturnAmount(dto.returnedBalanceAmount);
    const order = await this.repository.findOrder(orderId);
    if (!order) throw new NotFoundException('订单不存在');
    assertOrderCanRecordUpgradeBalanceReturn(order);
    return buildUpgradeBalanceReturnPreview(order, returnedBalanceAmount);
  }

  async record(
    orderIdValue: string,
    dto: RecordUpgradeBalanceReturnIdBusinessV2OrderDto,
    operator?: AuthenticatedUser
  ) {
    const orderId = normalizeUuid(orderIdValue, '订单');
    const returnedBalanceAmount = normalizeUpgradeBalanceReturnAmount(dto.returnedBalanceAmount);
    const reason = normalizeRequiredReason(dto.reason, '升级退币原因');
    const requestIdempotencyKey = normalizeIdempotencyKey(dto.idempotencyKey);
    const idempotencyKey = `upgrade_return:${orderId}:${requestIdempotencyKey}`;

    const replay = async (tx: V2CommandTransaction) => {
      const saved = await this.repository.findBalanceReturnReplay(tx, idempotencyKey);
      if (!saved) throw new ConflictException('升级退币请求已处理，请刷新后核对');
      assertUpgradeBalanceReturnReplay(saved, orderId, returnedBalanceAmount, reason);
      return { orderId, balanceReturn: saved, idempotentReplay: true };
    };

    const result = await this.transactionManager.execute(
      async (tx, context) => {
        const existingReplay = await this.repository.findBalanceReturnReplay(tx, idempotencyKey);
        if (existingReplay) {
          assertUpgradeBalanceReturnReplay(existingReplay, orderId, returnedBalanceAmount, reason);
          return { orderId, balanceReturn: existingReplay, idempotentReplay: true };
        }

        const order = await this.repository.lockOrder(tx, orderId);
        if (!order) throw new NotFoundException('订单不存在或已删除');
        if (order.status !== 'completed') {
          throw new ConflictException('只有已完成订单可以登记升级退币');
        }
        if (!order.accountId) throw new ConflictException('订单没有绑定 ID，不能登记升级退币');
        if (order.profitAmount === null)
          throw new ConflictException('订单缺少利润快照，不能登记升级退币');
        if (await this.repository.findActiveBalanceReturn(tx, order.id)) {
          throw new ConflictException('订单已有生效中的升级退币记录，请先撤销原记录');
        }
        if (
          await this.repository.findLedgerByOrderAndType(tx, order.id, 'order_consumption_reversal')
        ) {
          throw new ConflictException('订单原消费已经撤销，不能登记升级退币');
        }

        const consumption = await this.repository.findLedgerByOrderAndType(
          tx,
          order.id,
          'order_consumption'
        );
        if (
          !consumption ||
          consumption.accountId !== order.accountId ||
          consumption.direction !== 'debit' ||
          consumption.reversalOfEntryId !== null
        ) {
          throw new ConflictException('订单缺少有效的原消费流水，不能登记升级退币');
        }
        if (returnedBalanceAmount.gt(consumption.balanceAmount)) {
          throw new BadRequestException('升级退回余额不能超过本单原消费余额');
        }

        const account = await this.repository.lockAccount(tx, order.accountId);
        if (!account) throw new NotFoundException('订单绑定的 ID 不存在或已停用');
        if (account.lossReportedAt) throw new ConflictException('已报损冻结 ID 不能登记升级退币');
        const activation = await this.repository.findActivationByOrder(tx, order.id);

        const currencyCode = resolveOrderBalanceCurrencyCode(
          order.balanceCurrencyCode,
          account.currencyCode
        );
        const restoredBalanceCostAmount = calculateUpgradeBalanceReturnCost(
          consumption.balanceAmount,
          consumption.costAmount,
          returnedBalanceAmount
        );
        if (restoredBalanceCostAmount.gt(order.balanceCostAmount)) {
          throw new ConflictException('退回成本超过订单当前余额成本，请先核对订单流水');
        }

        const costReturnsToCompany =
          order.accountSource === 'inventory' && account.ownershipTransferredAt === null;
        const restoredAppliedBalanceCostAmount = costReturnsToCompany
          ? minAmount(restoredBalanceCostAmount, order.appliedBalanceCostAmount)
          : Amount4.zero();
        const balanceCostAmount = order.balanceCostAmount.sub(restoredBalanceCostAmount);
        const appliedBalanceCostAmount = order.appliedBalanceCostAmount.sub(
          restoredAppliedBalanceCostAmount
        );
        const adjustedProfitAmount = calculateOrderProfit(
          order.receivedAmount,
          order.platformFeeAmount,
          order.appliedAccountCostAmount,
          appliedBalanceCostAmount,
          order.refundCostAmount
        );
        const movement = this.balanceCalculator.calculateReversalCredit(
          {
            currentBalance: account.currentBalance,
            balanceCostAmount: account.balanceCostAmount
          },
          returnedBalanceAmount,
          restoredBalanceCostAmount
        );
        const balanceLedger = await this.repository.createBalanceLedger(tx, {
          accountId: account.id,
          giftCardId: null,
          orderId: order.id,
          entryType: 'order_upgrade_balance_return',
          direction: 'credit',
          balanceAmount: movement.balanceAmount.toString(),
          costAmount: movement.costAmount.toString(),
          balanceBefore: movement.balanceBefore.toString(),
          balanceAfter: movement.balanceAfter.toString(),
          costBefore: movement.costBefore.toString(),
          costAfter: movement.costAfter.toString(),
          averageCostBefore: movement.averageCostBefore.toString(),
          averageCostAfter: movement.averageCostAfter.toString(),
          reversalOfEntryId: null,
          idempotencyKey: `ubr_ledger:${order.id}:${requestIdempotencyKey}`,
          remark: `升级退币恢复 ID 余额：${reason}`,
          createdByUserId: operator?.id
        });
        await this.repository.updateAccount(tx, account.id, {
          currentBalance: movement.balanceAfter.toString(),
          balanceCostAmount: movement.costAfter.toString(),
          updatedByUserId: operator?.id
        });
        await this.repository.updateOrder(tx, order.id, {
          balanceCostAmount: balanceCostAmount.toString(),
          appliedBalanceCostAmount: appliedBalanceCostAmount.toString(),
          profitAmount: adjustedProfitAmount.toString(),
          updatedByUserId: operator?.id
        });

        const financeJournal = restoredAppliedBalanceCostAmount.isZero()
          ? null
          : await this.financePostingService.post(tx, {
              journalType: 'order_upgrade_balance_return',
              sourceType: 'order',
              sourceId: order.id,
              sourceReference: order.orderNo,
              occurredAt: context.businessTime,
              summary: `订单升级退币：${order.orderNo}`,
              metadata: {
                reason,
                currencyCode,
                returnedBalanceAmount: returnedBalanceAmount.toString(),
                restoredBalanceCostAmount: restoredBalanceCostAmount.toString(),
                revenueChanged: false
              },
              idempotencyKey: `ubr_fin:${order.id}:${requestIdempotencyKey}`,
              operator,
              lines: [
                {
                  accountCode: 'gift_card_inventory',
                  direction: 'debit',
                  currency: 'CNY',
                  amountOriginal: restoredAppliedBalanceCostAmount,
                  fxRateToCny: 1,
                  amountCny: restoredAppliedBalanceCostAmount,
                  memo: '升级退币恢复礼品卡余额资产'
                },
                {
                  accountCode: 'gift_card_cost',
                  direction: 'credit',
                  currency: 'CNY',
                  amountOriginal: restoredAppliedBalanceCostAmount,
                  fxRateToCny: 1,
                  amountCny: restoredAppliedBalanceCostAmount,
                  memo: '升级退币冲回原订单余额成本'
                }
              ]
            });

        const balanceReturn = await this.repository.createBalanceReturn(tx, {
          orderId: order.id,
          accountId: account.id,
          activeKey: order.id,
          status: 'active',
          currencyCode,
          returnedBalanceAmount: returnedBalanceAmount.toString(),
          restoredBalanceCostAmount: restoredBalanceCostAmount.toString(),
          restoredAppliedBalanceCostAmount: restoredAppliedBalanceCostAmount.toString(),
          originalProfitAmount: order.profitAmount.toString(),
          adjustedProfitAmount: adjustedProfitAmount.toString(),
          balanceLedgerEntryId: balanceLedger.id,
          financeJournalId: financeJournal?.id ?? null,
          idempotencyKey,
          reason,
          createdByUserId: operator?.id
        });
        const activationCancelled = activation?.status === 'active';
        if (activationCancelled && activation) {
          const activationRemark = appendUpgradeBalanceReturnActivationRemark(
            activation.remark,
            balanceReturn.id,
            reason
          );
          await this.repository.updateActivation(tx, order.id, {
            status: 'cancelled',
            statusChangedAt: context.businessTime,
            remark: activationRemark,
            updatedByUserId: operator?.id
          });
          await this.repository.appendAudit(tx, {
            userId: operator?.id,
            module: 'id_business_v2',
            action: 'id_business_v2.activation.cancel_by_upgrade_balance_return',
            objectType: 'id_business_v2_activation',
            objectId: activation.id,
            beforeData: {
              orderId: order.id,
              status: activation.status,
              statusChangedAt: activation.statusChangedAt,
              remark: activation.remark
            },
            afterData: {
              orderId: order.id,
              balanceReturnId: balanceReturn.id,
              status: 'cancelled',
              statusChangedAt: context.businessTime,
              remark: activationRemark,
              reason
            },
            remark: `升级退币结束原开通：${order.orderNo}`
          });
        }
        await this.repository.appendAudit(tx, {
          userId: operator?.id,
          module: 'id_business_v2',
          action: 'id_business_v2.order.record_upgrade_balance_return',
          objectType: 'id_business_v2_order',
          objectId: order.id,
          beforeData: {
            balanceCostAmount: order.balanceCostAmount.toString(),
            appliedBalanceCostAmount: order.appliedBalanceCostAmount.toString(),
            profitAmount: order.profitAmount.toString(),
            accountBalance: movement.balanceBefore.toString(),
            accountBalanceCostAmount: movement.costBefore.toString(),
            activationId: activation?.id ?? null,
            activationStatus: activation?.status ?? null
          },
          afterData: {
            balanceReturnId: balanceReturn.id,
            currencyCode,
            returnedBalanceAmount: returnedBalanceAmount.toString(),
            restoredBalanceCostAmount: restoredBalanceCostAmount.toString(),
            restoredAppliedBalanceCostAmount: restoredAppliedBalanceCostAmount.toString(),
            balanceCostAmount: balanceCostAmount.toString(),
            appliedBalanceCostAmount: appliedBalanceCostAmount.toString(),
            profitAmount: adjustedProfitAmount.toString(),
            accountBalance: movement.balanceAfter.toString(),
            accountBalanceCostAmount: movement.costAfter.toString(),
            financeJournalId: financeJournal?.id ?? null,
            activationCancelled,
            activationId: activation?.id ?? null,
            revenueChanged: false,
            reason
          },
          remark: `登记升级退币：${order.orderNo}`
        });
        return { orderId, balanceReturn, idempotentReplay: false };
      },
      {
        requestId: randomUUID(),
        operator,
        retryMode: 'fullReplay',
        idempotencyKey,
        replay,
        uniqueConflictMessage: '订单升级退币已经登记或请求已经处理，请刷新后核对',
        writeConflictMessage: '订单或 ID 余额已被其他操作修改，请刷新后重试'
      }
    );

    return {
      order: await this.ordersService.get(result.orderId, operator),
      balanceReturn: toUpgradeBalanceReturnResponse(result.balanceReturn),
      idempotentReplay: result.idempotentReplay
    };
  }

  async reverse(
    orderIdValue: string,
    dto: ReverseUpgradeBalanceReturnIdBusinessV2OrderDto,
    operator?: AuthenticatedUser
  ) {
    const orderId = normalizeUuid(orderIdValue, '订单');
    const reason = normalizeRequiredReason(dto.reason, '撤销原因');
    const requestIdempotencyKey = normalizeIdempotencyKey(dto.idempotencyKey);
    const reversalIdempotencyKey = `upgrade_return_reverse:${orderId}:${requestIdempotencyKey}`;

    const replay = async (tx: V2CommandTransaction) => {
      const saved = await this.repository.findBalanceReturnReversalReplay(
        tx,
        reversalIdempotencyKey
      );
      if (!saved) throw new ConflictException('升级退币撤销请求已处理，请刷新后核对');
      assertUpgradeBalanceReturnReversalReplay(saved, orderId, reason);
      return { orderId, balanceReturn: saved, idempotentReplay: true };
    };

    const result = await this.transactionManager.execute(
      async (tx, context) => {
        const existingReplay = await this.repository.findBalanceReturnReversalReplay(
          tx,
          reversalIdempotencyKey
        );
        if (existingReplay) {
          assertUpgradeBalanceReturnReversalReplay(existingReplay, orderId, reason);
          return { orderId, balanceReturn: existingReplay, idempotentReplay: true };
        }

        const order = await this.repository.lockOrder(tx, orderId);
        if (!order) throw new NotFoundException('订单不存在或已删除');
        if (order.status !== 'completed') {
          throw new ConflictException('只有已完成订单可以撤销升级退币');
        }
        const balanceReturn = await this.repository.findActiveBalanceReturn(tx, order.id);
        if (!balanceReturn) throw new ConflictException('订单没有生效中的升级退币记录');
        if (!order.accountId || balanceReturn.accountId !== order.accountId) {
          throw new ConflictException('升级退币记录与订单绑定 ID 不一致');
        }
        if (
          order.profitAmount === null ||
          !order.profitAmount.equals(balanceReturn.adjustedProfitAmount)
        ) {
          throw new ConflictException('订单利润已变化，不能直接撤销升级退币');
        }

        const account = await this.repository.lockAccount(tx, balanceReturn.accountId);
        if (!account) throw new NotFoundException('订单绑定的 ID 不存在或已停用');
        if (account.lossReportedAt) throw new ConflictException('已报损冻结 ID 不能撤销升级退币');

        const activation = await this.repository.findActivationByOrder(tx, order.id);
        const activationCancellation = removeUpgradeBalanceReturnActivationRemark(
          activation?.remark ?? null,
          balanceReturn.id
        );
        const activationShouldRestore =
          activation?.status === 'cancelled' && activationCancellation.matched;
        const activationWillBeEffectiveAfterReversal =
          activationShouldRestore || activation?.status === 'active';
        if (activationWillBeEffectiveAfterReversal && activation) {
          const service = await this.repository.findServiceCategory(tx, activation.serviceOptionId);
          if (!service?.parentId) {
            throw new ConflictException('原开通业务分类不存在，不能安全撤销升级退币');
          }
          const [conflictingActivation, conflictingOrderLock] = await Promise.all([
            this.repository.findActiveCategoryActivationForAccount(tx, {
              accountId: activation.accountId,
              categoryOptionId: service.parentId,
              evaluatedAt: context.businessTime,
              editingOrderId: order.id
            }),
            this.repository.findActiveCategoryOrderLockForAccount(tx, {
              accountId: activation.accountId,
              categoryOptionId: service.parentId,
              evaluatedAt: context.businessTime,
              excludedOrderId: order.id
            })
          ]);
          if (conflictingActivation || conflictingOrderLock) {
            throw new ConflictException('该 ID 已有后续同类业务订单或开通，不能撤销升级退币');
          }
        }

        const movement = this.balanceCalculator.calculateExactReversalDebit(
          {
            currentBalance: account.currentBalance,
            balanceCostAmount: account.balanceCostAmount
          },
          balanceReturn.returnedBalanceAmount,
          balanceReturn.restoredBalanceCostAmount
        );
        const balanceCostAmount = order.balanceCostAmount.add(
          balanceReturn.restoredBalanceCostAmount
        );
        const appliedBalanceCostAmount = order.appliedBalanceCostAmount.add(
          balanceReturn.restoredAppliedBalanceCostAmount
        );
        const profitAmount = calculateOrderProfit(
          order.receivedAmount,
          order.platformFeeAmount,
          order.appliedAccountCostAmount,
          appliedBalanceCostAmount,
          order.refundCostAmount
        );
        if (!profitAmount.equals(balanceReturn.originalProfitAmount)) {
          throw new ConflictException('撤销后的利润与原始快照不一致，请先核对订单成本');
        }

        const reversalLedger = await this.repository.createBalanceLedger(tx, {
          accountId: account.id,
          giftCardId: null,
          orderId: order.id,
          entryType: 'order_upgrade_balance_return_reversal',
          direction: 'debit',
          balanceAmount: movement.balanceAmount.toString(),
          costAmount: movement.costAmount.toString(),
          balanceBefore: movement.balanceBefore.toString(),
          balanceAfter: movement.balanceAfter.toString(),
          costBefore: movement.costBefore.toString(),
          costAfter: movement.costAfter.toString(),
          averageCostBefore: movement.averageCostBefore.toString(),
          averageCostAfter: movement.averageCostAfter.toString(),
          reversalOfEntryId: balanceReturn.balanceLedgerEntryId,
          idempotencyKey: `ubr_reverse_ledger:${balanceReturn.id}`,
          remark: `撤销升级退币：${reason}`,
          createdByUserId: operator?.id
        });
        await this.repository.updateAccount(tx, account.id, {
          currentBalance: movement.balanceAfter.toString(),
          balanceCostAmount: movement.costAfter.toString(),
          updatedByUserId: operator?.id
        });
        await this.repository.updateOrder(tx, order.id, {
          balanceCostAmount: balanceCostAmount.toString(),
          appliedBalanceCostAmount: appliedBalanceCostAmount.toString(),
          profitAmount: profitAmount.toString(),
          updatedByUserId: operator?.id
        });

        const reversalFinanceJournal = balanceReturn.financeJournalId
          ? await this.financePostingService.reverse(
              tx,
              balanceReturn.financeJournalId,
              reason,
              `ubr_reverse_fin:${balanceReturn.id}`,
              operator
            )
          : null;
        const reversedAt = context.businessTime;
        const reversed = await this.repository.reverseBalanceReturn(tx, balanceReturn.id, {
          activeKey: null,
          status: 'reversed',
          reversalBalanceLedgerEntryId: reversalLedger.id,
          reversalFinanceJournalId: reversalFinanceJournal?.id ?? null,
          reversalIdempotencyKey,
          reversalReason: reason,
          reversedByUserId: operator?.id,
          reversedAt
        });
        if (activationShouldRestore && activation) {
          await this.repository.updateActivation(tx, order.id, {
            status: 'active',
            statusChangedAt: reversedAt,
            remark: activationCancellation.remark,
            updatedByUserId: operator?.id
          });
          await this.repository.appendAudit(tx, {
            userId: operator?.id,
            module: 'id_business_v2',
            action: 'id_business_v2.activation.restore_by_upgrade_balance_return_reversal',
            objectType: 'id_business_v2_activation',
            objectId: activation.id,
            beforeData: {
              orderId: order.id,
              balanceReturnId: balanceReturn.id,
              status: activation.status,
              statusChangedAt: activation.statusChangedAt,
              remark: activation.remark
            },
            afterData: {
              orderId: order.id,
              balanceReturnId: balanceReturn.id,
              status: 'active',
              statusChangedAt: reversedAt,
              remark: activationCancellation.remark,
              reason
            },
            remark: `撤销升级退币并恢复原开通：${order.orderNo}`
          });
        }
        await this.repository.appendAudit(tx, {
          userId: operator?.id,
          module: 'id_business_v2',
          action: 'id_business_v2.order.reverse_upgrade_balance_return',
          objectType: 'id_business_v2_order',
          objectId: order.id,
          beforeData: {
            balanceReturnId: balanceReturn.id,
            balanceCostAmount: order.balanceCostAmount.toString(),
            appliedBalanceCostAmount: order.appliedBalanceCostAmount.toString(),
            profitAmount: order.profitAmount.toString(),
            accountBalance: movement.balanceBefore.toString(),
            accountBalanceCostAmount: movement.costBefore.toString(),
            activationId: activation?.id ?? null,
            activationStatus: activation?.status ?? null
          },
          afterData: {
            balanceReturnId: balanceReturn.id,
            status: 'reversed',
            balanceCostAmount: balanceCostAmount.toString(),
            appliedBalanceCostAmount: appliedBalanceCostAmount.toString(),
            profitAmount: profitAmount.toString(),
            accountBalance: movement.balanceAfter.toString(),
            accountBalanceCostAmount: movement.costAfter.toString(),
            reversalLedgerId: reversalLedger.id,
            reversalFinanceJournalId: reversalFinanceJournal?.id ?? null,
            activationRestored: activationShouldRestore,
            activationId: activation?.id ?? null,
            revenueChanged: false,
            reason,
            reversedAt
          },
          remark: `撤销升级退币：${order.orderNo}`
        });
        return { orderId, balanceReturn: reversed, idempotentReplay: false };
      },
      {
        requestId: randomUUID(),
        operator,
        retryMode: 'fullReplay',
        idempotencyKey: reversalIdempotencyKey,
        replay,
        uniqueConflictMessage: '升级退币已经撤销或请求已经处理，请刷新后核对',
        writeConflictMessage: '订单或 ID 余额已被其他操作修改，请刷新后重试'
      }
    );

    return {
      order: await this.ordersService.get(result.orderId, operator),
      balanceReturn: toUpgradeBalanceReturnResponse(result.balanceReturn),
      idempotentReplay: result.idempotentReplay
    };
  }
}

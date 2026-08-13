import { ConflictException } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { IdBusinessV2FinancePostingService } from '../finance/public-api';
import { Amount4 } from '../runtime/public-api';
import type { CancelIdBusinessV2OrderDto } from './dto/cancel-id-business-v2-order.dto';
import { releaseSoldOrderAccount } from './id-business-v2-order-account-disposition';
import { buildOrderReversalIdempotencyKey } from './id-business-v2-order-lifecycle-input';
import type {
  IdBusinessV2OrderLifecycleSupport,
  LifecycleTransactionResult
} from './id-business-v2-order-lifecycle-support';
import type { IdBusinessV2OrderLockService } from './id-business-v2-order-lock.service';
import { restoreRecoveredCustomerOwnedSourceOrderCost } from './id-business-v2-order-refund';
import type {
  IdBusinessV2BalanceLedgerRecord,
  IdBusinessV2OrderStatus
} from './id-business-v2-order.types';
import type { IdBusinessV2OrdersRepository } from './persistence/id-business-v2-orders.repository';
import { assertSoldAccountCanRecover } from './id-business-v2-order-sold-account-recovery';

const CANCELLABLE_STATUSES = new Set<IdBusinessV2OrderStatus>([
  'draft',
  'pending',
  'processing',
  'failed'
]);

export async function cancelIdBusinessV2Order(
  support: IdBusinessV2OrderLifecycleSupport,
  orderLockService: IdBusinessV2OrderLockService,
  financePostingService: IdBusinessV2FinancePostingService,
  repository: IdBusinessV2OrdersRepository,
  orderIdValue: string,
  dto: CancelIdBusinessV2OrderDto,
  operator?: AuthenticatedUser
) {
  const orderId = support.normalizeUuid(orderIdValue, '订单');
  const reason = support.normalizeReason(dto.reason);
  const idempotencyKey = buildOrderReversalIdempotencyKey(
    orderId,
    support.normalizeIdempotencyKey(dto.idempotencyKey)
  );

  const result = await support.runLifecycleTransaction(
    async (tx): Promise<LifecycleTransactionResult> => {
      const order = await support.lockOrder(tx, orderId);
      const existingReversal = await support.findReversal(tx, order.id);
      if (order.status === 'cancelled') {
        support.assertReversalReplay(existingReversal, idempotencyKey);
        return {
          orderId: order.id,
          reversalLedger: existingReversal,
          balanceRestored: Boolean(existingReversal),
          lockReleased: false,
          idempotentReplay: true
        };
      }
      if (!CANCELLABLE_STATUSES.has(order.status)) {
        throw new ConflictException('只有草稿、待处理、处理中或失败订单可以取消');
      }
      if (await repository.hasActivationByOrder(tx, order.id)) {
        throw new ConflictException('订单已有开通记录，不能取消；请按真实结果执行退款');
      }

      const consumption = await support.findConsumption(tx, order.id);
      if (order.status === 'processing' && !consumption) {
        throw new ConflictException('处理中订单缺少消费流水，不能直接取消');
      }
      if (existingReversal) {
        throw new ConflictException('订单消费已经撤销，请刷新后核对订单状态');
      }

      const sourceOrderForRestoration =
        consumption && order.accountSource === 'customer_owned' && order.sourceSoldOrderId
          ? await support.lockOrder(tx, order.sourceSoldOrderId, true)
          : null;
      let reversalLedger: IdBusinessV2BalanceLedgerRecord | null = null;
      let balanceRestored = false;
      let profitAmount: Amount4 | null = null;
      let restoredCustomerOwnedBalanceCost = Amount4.zero();
      let restoredSourceOrderCost = Amount4.zero();
      let restoredSourceOrderId: string | null = null;

      if (consumption) {
        const restoration = await support.restoreConsumption(
          tx,
          order,
          consumption,
          idempotencyKey,
          `取消订单：${reason}`,
          operator
        );
        reversalLedger = restoration.ledger;
        balanceRestored = true;
        const restoredAppliedBalanceCost = restoration.ledger.costAmount.gt(
          order.appliedBalanceCostAmount
        )
          ? order.appliedBalanceCostAmount
          : restoration.ledger.costAmount;
        restoredCustomerOwnedBalanceCost =
          order.accountSource === 'customer_owned' && !restoration.account.ownershipTransferredAt
            ? restoration.ledger.costAmount.sub(restoredAppliedBalanceCost)
            : Amount4.zero();
        if (!restoredCustomerOwnedBalanceCost.isZero()) {
          const restoredSource = await restoreRecoveredCustomerOwnedSourceOrderCost(
            support,
            repository,
            tx,
            order,
            sourceOrderForRestoration,
            restoredCustomerOwnedBalanceCost,
            reason,
            operator
          );
          restoredSourceOrderId = restoredSource.id;
          restoredSourceOrderCost = restoredSource.costAmount;
        }
        profitAmount = support.calculateProfit(
          order.receivedAmount,
          order.platformFeeAmount,
          Amount4.zero(),
          Amount4.zero(),
          order.refundCostAmount
        );
      }

      const release = await orderLockService.releaseOrderLockInTransaction(
        tx,
        order.id,
        `订单取消：${reason}`,
        operator
      );
      const accountRecovered = order.accountDisposition === 'sold';
      if (accountRecovered) {
        if (!order.accountId) throw new ConflictException('已售订单缺少 ID 关联');
        const account = await repository.lockAccountForSale(tx, order.accountId);
        if (!account || account.soldByOrderId !== order.id) {
          throw new ConflictException('ID 售出归属已变更，请刷新后核对');
        }
        await assertSoldAccountCanRecover(repository, tx, account, order.id);
        await releaseSoldOrderAccount(tx, repository, order, operator);
      }

      const statusChangedAt = new Date();
      const financeJournal = restoredCustomerOwnedBalanceCost.isZero()
        ? null
        : await financePostingService.post(tx, {
            journalType: 'order_cancel',
            sourceType: 'order',
            sourceId: order.id,
            sourceReference: order.orderNo,
            occurredAt: statusChangedAt,
            summary: `订单取消并恢复已收回 ID 余额：${order.orderNo}`,
            metadata: {
              reason,
              restoredCustomerOwnedBalanceCostAmount: restoredCustomerOwnedBalanceCost.toString(),
              restoredSourceOrderId,
              restoredSourceOrderCostAmount: restoredSourceOrderCost.toString()
            },
            idempotencyKey: `auto:order_cancel:${order.id}`,
            operator,
            lines: [
              {
                accountCode: 'gift_card_inventory',
                direction: 'debit',
                currency: 'CNY',
                amountOriginal: restoredCustomerOwnedBalanceCost,
                fxRateToCny: 1,
                amountCny: restoredCustomerOwnedBalanceCost,
                memo: '取消订单恢复已收回 ID 余额资产'
              },
              {
                accountCode: 'customer_owned_balance_cost',
                direction: 'credit',
                currency: 'CNY',
                amountOriginal: restoredCustomerOwnedBalanceCost,
                fxRateToCny: 1,
                amountCny: restoredCustomerOwnedBalanceCost,
                memo: '冲回客户已购 ID 余额转移成本'
              }
            ]
          });

      await repository.updateOrder(tx, order.id, {
        status: 'cancelled',
        statusChangedAt,
        balanceCostAmount: balanceRestored ? '0' : order.balanceCostAmount.toString(),
        accountDisposition: accountRecovered ? 'recovered' : order.accountDisposition,
        appliedAccountCostAmount: accountRecovered
          ? '0'
          : order.appliedAccountCostAmount.toString(),
        appliedBalanceCostAmount: balanceRestored ? '0' : order.appliedBalanceCostAmount.toString(),
        profitAmount: profitAmount?.toString() ?? null,
        updatedByUserId: operator?.id
      });
      await support.writeLifecycleAudit(
        tx,
        'cancel',
        order,
        {
          status: 'cancelled',
          statusChangedAt,
          reason,
          balanceRestored,
          accountRecovered,
          accountDisposition: accountRecovered ? 'recovered' : order.accountDisposition,
          appliedAccountCostAmount: '0',
          restoredCustomerOwnedBalanceCostAmount: restoredCustomerOwnedBalanceCost.toString(),
          restoredSourceOrderId,
          restoredSourceOrderCostAmount: restoredSourceOrderCost.toString(),
          reversalLedgerId: reversalLedger?.id ?? null,
          financeJournalId: financeJournal?.id ?? null,
          profitAmount: profitAmount?.toString() ?? null,
          lockReleased: release.released
        },
        operator
      );
      return {
        orderId: order.id,
        reversalLedger,
        balanceRestored,
        lockReleased: release.released,
        idempotentReplay: false
      };
    },
    '订单已经取消或消费撤销正在并发处理，请刷新后核对',
    operator
  );
  return support.buildLifecycleResponse(result);
}

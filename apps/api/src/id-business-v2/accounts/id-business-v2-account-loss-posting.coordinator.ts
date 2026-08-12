import { Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { IdBusinessV2BalanceCalculatorService } from '../balances/public-api';
import { IdBusinessV2FinancePostingService } from '../finance/public-api';
import { Amount4, type V2CommandTransaction } from '../runtime/public-api';
import {
  IdBusinessV2AccountLossRepository,
  type LockedAccountLossRow
} from './id-business-v2-account-loss.repository';

interface PostAccountLossInput {
  accountId: string;
  account: LockedAccountLossRow;
  reason: string;
  idempotencyKey: string;
  now: Date;
  operator?: AuthenticatedUser;
}

@Injectable()
export class IdBusinessV2AccountLossPostingCoordinator {
  constructor(
    private readonly repository: IdBusinessV2AccountLossRepository,
    private readonly balanceCalculator: IdBusinessV2BalanceCalculatorService,
    private readonly financePostingService: IdBusinessV2FinancePostingService
  ) {}

  async post(tx: V2CommandTransaction, input: PostAccountLossInput) {
    const { account, accountId, reason, idempotencyKey, now, operator } = input;
    const averageCostBefore = this.balanceCalculator
      .calculateAverageCost(account.currentBalance.toString(), account.balanceCostAmount.toString())
      .toString();
    const ledgerEntry = await this.repository.createBalanceLedger(tx, {
      accountId,
      giftCardId: null,
      orderId: null,
      entryType: 'account_loss',
      direction: 'debit',
      balanceAmount: '0',
      costAmount: '0',
      balanceBefore: account.currentBalance.toString(),
      balanceAfter: account.currentBalance.toString(),
      costBefore: account.balanceCostAmount.toString(),
      costAfter: account.balanceCostAmount.toString(),
      averageCostBefore,
      averageCostAfter: averageCostBefore,
      reversalOfEntryId: null,
      idempotencyKey,
      remark: reason,
      createdByUserId: operator?.id,
      createdAt: now
    });

    const idPurchaseCostLossAmount = account.soldByOrderId ? Amount4.zero() : account.purchaseCost;
    const lossRecord = await this.repository.createLossRecord(tx, {
      accountId,
      ledgerEntryId: ledgerEntry.id,
      appleIdMasked: account.appleIdMasked,
      countryOptionId: account.countryOptionId,
      countryName: account.countryName,
      currencyCode: account.currencyCode,
      supplierOptionId: account.supplierOptionId,
      supplierName: account.supplierName,
      saleState: account.soldByOrderId ? 'sold' : 'available',
      soldOrderId: account.soldByOrderId,
      soldOrderNo: account.soldOrderNo,
      lossBalance: account.currentBalance.toString(),
      lossCostAmount: account.balanceCostAmount.toString(),
      idPurchaseCostLossAmount: idPurchaseCostLossAmount.toString(),
      reason,
      idempotencyKey,
      reportedByUserId: operator?.id,
      reportedByName: operator?.username,
      reportedAt: now,
      status: 'active',
      previousStatusOptionId: account.statusOptionId,
      previousStatusName: account.statusName,
      previousRecordStatus: account.recordStatus
    });

    const financeJournal = await this.financePostingService.post(tx, {
      journalType: 'account_loss',
      sourceType: 'account_loss',
      sourceId: lossRecord.id,
      sourceReference: account.appleIdMasked,
      occurredAt: now,
      summary: `ID 报损：${account.appleIdMasked}`,
      metadata: {
        accountId,
        saleState: account.soldByOrderId ? 'sold' : 'available',
        reason
      },
      idempotencyKey: `auto:account_loss:${lossRecord.id}`,
      operator,
      lines: [
        {
          accountCode: 'balance_loss',
          direction: 'debit',
          currency: 'CNY',
          amountOriginal: account.balanceCostAmount.toString(),
          fxRateToCny: '1',
          amountCny: account.balanceCostAmount.toString(),
          memo: 'ID 剩余余额成本报损'
        },
        {
          accountCode: 'gift_card_inventory',
          direction: 'credit',
          currency: 'CNY',
          amountOriginal: account.balanceCostAmount.toString(),
          fxRateToCny: '1',
          amountCny: account.balanceCostAmount.toString(),
          memo: '冲减礼品卡余额资产'
        },
        ...(idPurchaseCostLossAmount.isZero()
          ? []
          : [
              {
                accountCode: 'id_purchase_loss' as const,
                direction: 'debit' as const,
                currency: 'CNY' as const,
                amountOriginal: idPurchaseCostLossAmount.toString(),
                fxRateToCny: '1',
                amountCny: idPurchaseCostLossAmount.toString(),
                memo: '未售 ID 采购成本报损'
              },
              {
                accountCode: 'id_inventory' as const,
                direction: 'credit' as const,
                currency: 'CNY' as const,
                amountOriginal: idPurchaseCostLossAmount.toString(),
                fxRateToCny: '1',
                amountCny: idPurchaseCostLossAmount.toString(),
                memo: '冲减未售 ID 库存'
              }
            ])
      ]
    });

    const lossRecordWithJournal = await this.repository.attachFinanceJournalToLoss(tx, {
      lossRecordId: lossRecord.id,
      financeJournalId: financeJournal.id
    });

    return {
      ledgerEntry,
      lossRecord: lossRecordWithJournal,
      financeJournal,
      idPurchaseCostLossAmount
    };
  }
}

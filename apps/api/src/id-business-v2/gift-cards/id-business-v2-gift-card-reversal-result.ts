import { ConflictException } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { IdBusinessV2AccountLossesService } from '../accounts/public-api';
import type { V2CommandTransaction } from '../runtime/public-api';
import type { IdBusinessV2GiftCardReversalAction } from './dto/reverse-id-business-v2-gift-card.dto';
import type {
  GiftCardCreditAccountRecord,
  GiftCardCreditLedgerRecord,
  GiftCardCreditRecord
} from './id-business-v2-gift-card-credit.types';
import type { IdBusinessV2GiftCardsRepository } from './persistence/id-business-v2-gift-cards.repository';

export interface IdBusinessV2GiftCardReversalResponse {
  action: IdBusinessV2GiftCardReversalAction;
  giftCard: {
    id: string;
    codeMasked: string;
    codeTail: string;
    faceValue: string;
    exchangeRate: string;
    originalCostAmount: string;
    status: string;
    statusChangedAt: Date;
  };
  ledgerEntry: {
    id: string;
    entryType: string;
    balanceAmount: string;
    costAmount: string;
    balanceBefore: string;
    balanceAfter: string;
    costBefore: string;
    costAfter: string;
    averageCostBefore: string;
    averageCostAfter: string;
    reversalOfEntryId: string;
    createdAt: Date;
  };
  account: {
    id: string;
    appleIdMasked: string;
    currentBalance: string;
    balanceCostAmount: string;
  };
  accountLoss: Awaited<
    ReturnType<IdBusinessV2AccountLossesService['reportLossInTransaction']>
  > | null;
  supplierFunding: {
    ledgerEntryId: string;
    amountCny: string;
    balanceBeforeCny: string;
    balanceAfterCny: string;
    isNegative: boolean;
  } | null;
  idempotentReplay: boolean;
}

export function buildGiftCardReversalResponse(
  action: IdBusinessV2GiftCardReversalAction,
  account: GiftCardCreditAccountRecord,
  giftCard: GiftCardCreditRecord,
  ledgerEntry: GiftCardCreditLedgerRecord,
  idempotentReplay: boolean,
  accountLoss: IdBusinessV2GiftCardReversalResponse['accountLoss'],
  supplierFunding: IdBusinessV2GiftCardReversalResponse['supplierFunding'] = null
): IdBusinessV2GiftCardReversalResponse {
  if (!ledgerEntry.reversalOfEntryId) {
    throw new ConflictException('反向流水缺少原入账流水引用');
  }
  return {
    action,
    giftCard: {
      id: giftCard.id,
      codeMasked: giftCard.codeMasked,
      codeTail: giftCard.codeTail,
      faceValue: giftCard.faceValue.toString(),
      exchangeRate: giftCard.exchangeRate.toString(),
      originalCostAmount: giftCard.costAmount.toString(),
      status: giftCard.status,
      statusChangedAt: giftCard.statusChangedAt
    },
    ledgerEntry: {
      id: ledgerEntry.id,
      entryType: ledgerEntry.entryType,
      balanceAmount: ledgerEntry.balanceAmount.toString(),
      costAmount: ledgerEntry.costAmount.toString(),
      balanceBefore: ledgerEntry.balanceBefore.toString(),
      balanceAfter: ledgerEntry.balanceAfter.toString(),
      costBefore: ledgerEntry.costBefore.toString(),
      costAfter: ledgerEntry.costAfter.toString(),
      averageCostBefore: ledgerEntry.averageCostBefore.toString(),
      averageCostAfter: ledgerEntry.averageCostAfter.toString(),
      reversalOfEntryId: ledgerEntry.reversalOfEntryId,
      createdAt: ledgerEntry.createdAt
    },
    account: {
      id: account.id,
      appleIdMasked: account.appleIdMasked,
      currentBalance: accountLoss?.account.currentBalance ?? account.currentBalance.toString(),
      balanceCostAmount:
        accountLoss?.account.balanceCostAmount ?? account.balanceCostAmount.toString()
    },
    accountLoss,
    supplierFunding,
    idempotentReplay
  };
}

export async function writeGiftCardReversalAuditLog(
  tx: V2CommandTransaction,
  repository: IdBusinessV2GiftCardsRepository,
  result: IdBusinessV2GiftCardReversalResponse,
  reason: string,
  operator?: AuthenticatedUser
) {
  const actionLabel = result.action === 'redeemed' ? '标记被赎回' : '撤回';
  await repository.appendAudit(tx, {
    userId: operator?.id,
    module: 'id_business_v2',
    action: `id_business_v2.gift_card.${result.action}`,
    objectType: 'id_business_v2_gift_card',
    objectId: result.giftCard.id,
    beforeData: {
      status: 'credited',
      balance: result.ledgerEntry.balanceBefore,
      balanceCostAmount: result.ledgerEntry.costBefore
    },
    afterData: {
      status: result.giftCard.status,
      codeMasked: result.giftCard.codeMasked,
      balanceAmount: result.ledgerEntry.balanceAmount,
      costAmount: result.ledgerEntry.costAmount,
      balance: result.ledgerEntry.balanceAfter,
      balanceCostAmount: result.ledgerEntry.costAfter,
      reversalOfEntryId: result.ledgerEntry.reversalOfEntryId,
      accountLossRecordId: result.accountLoss?.lossRecord.id ?? null,
      accountLossLedgerEntryId: result.accountLoss?.lossRecord.ledgerEntryId ?? null,
      supplierFundingLedgerEntryId: result.supplierFunding?.ledgerEntryId ?? null,
      supplierBalanceBeforeCny: result.supplierFunding?.balanceBeforeCny ?? null,
      supplierBalanceAfterCny: result.supplierFunding?.balanceAfterCny ?? null,
      reason
    },
    remark: `V2 礼品卡${actionLabel}：${result.giftCard.codeMasked}`
  });
}

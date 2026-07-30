import { ConflictException } from '@nestjs/common';
import { Prisma as PrismaNamespace } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../../auth/auth.types';
import type { IdBusinessV2AccountLossesService } from '../accounts/public-api';
import { toV2DecimalString } from '../decimal-policy';
import type { IdBusinessV2GiftCardReversalAction } from './dto/reverse-id-business-v2-gift-card.dto';

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
  account: {
    id: string;
    appleIdMasked: string;
    currentBalance: PrismaNamespace.Decimal;
    balanceCostAmount: PrismaNamespace.Decimal;
  },
  giftCard: {
    id: string;
    codeMasked: string;
    codeTail: string;
    faceValue: PrismaNamespace.Decimal;
    exchangeRate: PrismaNamespace.Decimal;
    costAmount: PrismaNamespace.Decimal;
    status: string;
    statusChangedAt: Date;
  },
  ledgerEntry: {
    id: string;
    entryType: string;
    balanceAmount: PrismaNamespace.Decimal;
    costAmount: PrismaNamespace.Decimal;
    balanceBefore: PrismaNamespace.Decimal;
    balanceAfter: PrismaNamespace.Decimal;
    costBefore: PrismaNamespace.Decimal;
    costAfter: PrismaNamespace.Decimal;
    averageCostBefore: PrismaNamespace.Decimal;
    averageCostAfter: PrismaNamespace.Decimal;
    reversalOfEntryId: string | null;
    createdAt: Date;
  },
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
      faceValue: toV2DecimalString(giftCard.faceValue),
      exchangeRate: toV2DecimalString(giftCard.exchangeRate),
      originalCostAmount: toV2DecimalString(giftCard.costAmount),
      status: giftCard.status,
      statusChangedAt: giftCard.statusChangedAt
    },
    ledgerEntry: {
      id: ledgerEntry.id,
      entryType: ledgerEntry.entryType,
      balanceAmount: toV2DecimalString(ledgerEntry.balanceAmount),
      costAmount: toV2DecimalString(ledgerEntry.costAmount),
      balanceBefore: toV2DecimalString(ledgerEntry.balanceBefore),
      balanceAfter: toV2DecimalString(ledgerEntry.balanceAfter),
      costBefore: toV2DecimalString(ledgerEntry.costBefore),
      costAfter: toV2DecimalString(ledgerEntry.costAfter),
      averageCostBefore: toV2DecimalString(ledgerEntry.averageCostBefore),
      averageCostAfter: toV2DecimalString(ledgerEntry.averageCostAfter),
      reversalOfEntryId: ledgerEntry.reversalOfEntryId,
      createdAt: ledgerEntry.createdAt
    },
    account: {
      id: account.id,
      appleIdMasked: account.appleIdMasked,
      currentBalance:
        accountLoss?.account.currentBalance ?? toV2DecimalString(account.currentBalance),
      balanceCostAmount:
        accountLoss?.account.balanceCostAmount ?? toV2DecimalString(account.balanceCostAmount)
    },
    accountLoss,
    supplierFunding,
    idempotentReplay
  };
}

export async function writeGiftCardReversalAuditLog(
  tx: Prisma.TransactionClient,
  result: IdBusinessV2GiftCardReversalResponse,
  reason: string,
  operator?: AuthenticatedUser
) {
  const actionLabel = result.action === 'redeemed' ? '标记被赎回' : '撤回';
  await tx.auditLog.create({
    data: {
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
    }
  });
}

import { BadRequestException, ConflictException } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { IdBusinessV2BalanceCalculatorService } from '../balances/public-api';
import { Amount4, Rate8, type V2CommandTransaction } from '../runtime/public-api';
import type {
  CreditAuditContext,
  CreditResponse,
  GiftCardCreditAccountRecord,
  GiftCardCreditLedgerRecord,
  GiftCardCreditRecord
} from './id-business-v2-gift-card-credit.types';
import type { IdBusinessV2GiftCardsRepository } from './persistence/id-business-v2-gift-cards.repository';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const CODE_PATTERN = /^[A-Z0-9]{10,64}$/;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/;

export function assertGiftCardCreditReplayMatches(
  balanceCalculator: IdBusinessV2BalanceCalculatorService,
  giftCard: GiftCardCreditRecord,
  input: {
    accountId: string;
    cardNameOptionId?: string;
    countryOptionId?: string;
    creditedAt?: Date;
    codeHash: string;
    faceValue: Amount4;
    exchangeRate: Rate8;
    exchangeRateAudit: {
      exchangeRateSource: string;
      exchangeRateSnapshotId: string | null;
      exchangeRatePrefilledValue: Rate8 | null;
      exchangeRateWasOverridden: boolean;
    };
    supplierOptionId: string;
    remark: string | null;
  }
) {
  const snapshot = balanceCalculator.calculateGiftCardCredit(
    { currentBalance: '0', balanceCostAmount: '0' },
    input.faceValue,
    input.exchangeRate
  );
  if (
    giftCard.accountId !== input.accountId ||
    (input.cardNameOptionId !== undefined &&
      giftCard.cardNameOptionId !== input.cardNameOptionId) ||
    (input.countryOptionId !== undefined && giftCard.countryOptionId !== input.countryOptionId) ||
    giftCard.creditedAt === null ||
    (input.creditedAt !== undefined &&
      giftCard.creditedAt.getTime() !== input.creditedAt.getTime()) ||
    giftCard.codeHash !== input.codeHash ||
    !giftCard.faceValue.equals(snapshot.balanceAmount) ||
    !giftCard.exchangeRate.equals(snapshot.exchangeRate) ||
    giftCard.exchangeRateSource !== input.exchangeRateAudit.exchangeRateSource ||
    giftCard.exchangeRateSnapshotId !== input.exchangeRateAudit.exchangeRateSnapshotId ||
    !nullableDecimalEquals(
      giftCard.exchangeRatePrefilledValue,
      input.exchangeRateAudit.exchangeRatePrefilledValue
    ) ||
    giftCard.exchangeRateWasOverridden !== input.exchangeRateAudit.exchangeRateWasOverridden ||
    giftCard.supplierOptionId !== input.supplierOptionId ||
    giftCard.remark !== input.remark
  ) {
    throw new ConflictException('幂等键已用于其他入账内容，请刷新后重新提交');
  }
}

export function toGiftCardCreditResponse(
  account: GiftCardCreditAccountRecord,
  giftCard: GiftCardCreditRecord,
  ledgerEntry: GiftCardCreditLedgerRecord,
  supplierFunding: CreditResponse['supplierFunding'],
  idempotentReplay: boolean
): CreditResponse {
  if (!giftCard.creditedAt) {
    throw new ConflictException('礼品卡入账记录缺少入账时间，请人工核对');
  }
  return {
    giftCard: {
      id: giftCard.id,
      cardNameOptionId: giftCard.cardNameOptionId,
      cardName: giftCard.cardNameSnapshot,
      countryOptionId: giftCard.countryOptionId,
      codeMasked: giftCard.codeMasked,
      codeTail: giftCard.codeTail,
      faceValue: giftCard.faceValue.toString(),
      exchangeRate: giftCard.exchangeRate.toString(),
      exchangeRateSource: giftCard.exchangeRateSource,
      exchangeRateSnapshotId: giftCard.exchangeRateSnapshotId,
      exchangeRatePrefilledValue:
        giftCard.exchangeRatePrefilledValue == null
          ? null
          : giftCard.exchangeRatePrefilledValue.toString(),
      exchangeRateWasOverridden: giftCard.exchangeRateWasOverridden,
      costAmount: giftCard.costAmount.toString(),
      purchaseOriginalAmount: giftCard.purchaseOriginalAmount.toString(),
      purchaseCurrency: giftCard.purchaseCurrency,
      purchaseFxRateToCny: giftCard.purchaseFxRateToCny.toString(),
      purchaseFxSnapshotId: giftCard.purchaseFxSnapshotId ?? null,
      purchaseFinanceAccountId: giftCard.purchaseFinanceAccountId ?? null,
      purchaseSupplierAccountId: giftCard.purchaseSupplierAccountId ?? null,
      paidAt: giftCard.paidAt ?? null,
      creditedAt: giftCard.creditedAt,
      status: giftCard.status,
      supplierOptionId: giftCard.supplierOptionId,
      sourceAttachmentId: giftCard.sourceAttachmentId,
      createdAt: giftCard.createdAt
    },
    ledgerEntry: {
      id: ledgerEntry.id,
      balanceBefore: ledgerEntry.balanceBefore.toString(),
      balanceAfter: ledgerEntry.balanceAfter.toString(),
      costBefore: ledgerEntry.costBefore.toString(),
      costAfter: ledgerEntry.costAfter.toString(),
      averageCostBefore: ledgerEntry.averageCostBefore.toString(),
      averageCostAfter: ledgerEntry.averageCostAfter.toString(),
      createdAt: ledgerEntry.createdAt
    },
    account: {
      id: account.id,
      appleIdMasked: account.appleIdMasked,
      currentBalance: account.currentBalance.toString(),
      balanceCostAmount: account.balanceCostAmount.toString()
    },
    supplierFunding,
    idempotentReplay
  };
}

export function writeGiftCardCreditAuditLogs(
  tx: V2CommandTransaction,
  repository: IdBusinessV2GiftCardsRepository,
  result: CreditResponse,
  operator?: AuthenticatedUser,
  auditContext?: CreditAuditContext
) {
  return repository.appendAudit(tx, {
    userId: operator?.id,
    module: 'id_business_v2',
    action: 'id_business_v2.gift_card.credit',
    objectType: 'id_business_v2_gift_card',
    objectId: result.giftCard.id,
    afterData: {
      accountId: result.account.id,
      cardNameOptionId: result.giftCard.cardNameOptionId,
      cardName: result.giftCard.cardName,
      countryOptionId: result.giftCard.countryOptionId,
      creditedAt: result.giftCard.creditedAt,
      codeMasked: result.giftCard.codeMasked,
      codeTail: result.giftCard.codeTail,
      faceValue: result.giftCard.faceValue,
      exchangeRate: result.giftCard.exchangeRate,
      exchangeRateSource: result.giftCard.exchangeRateSource,
      exchangeRateSnapshotId: result.giftCard.exchangeRateSnapshotId,
      exchangeRatePrefilledValue: result.giftCard.exchangeRatePrefilledValue,
      exchangeRateWasOverridden: result.giftCard.exchangeRateWasOverridden,
      costAmount: result.giftCard.costAmount,
      purchaseOriginalAmount: result.giftCard.purchaseOriginalAmount,
      purchaseCurrency: result.giftCard.purchaseCurrency,
      purchaseFxRateToCny: result.giftCard.purchaseFxRateToCny,
      purchaseFxSnapshotId: result.giftCard.purchaseFxSnapshotId,
      purchaseFinanceAccountId: result.giftCard.purchaseFinanceAccountId,
      purchaseSupplierAccountId: result.giftCard.purchaseSupplierAccountId,
      paidAt: result.giftCard.paidAt,
      supplierOptionId: result.giftCard.supplierOptionId,
      sourceAttachmentId: result.giftCard.sourceAttachmentId,
      balanceBefore: result.ledgerEntry.balanceBefore,
      balanceAfter: result.ledgerEntry.balanceAfter,
      costBefore: result.ledgerEntry.costBefore,
      costAfter: result.ledgerEntry.costAfter,
      supplierBalanceBeforeCny: result.supplierFunding?.balanceBeforeCny ?? null,
      supplierBalanceAfterCny: result.supplierFunding?.balanceAfterCny ?? null,
      supplierBalanceNegative: result.supplierFunding?.isNegative ?? false,
      ...(auditContext
        ? {
            sourceContext: {
              source: auditContext.source,
              activationId: auditContext.activationId,
              orderId: auditContext.orderId,
              orderNo: auditContext.orderNo
            }
          }
        : {})
    },
    remark: auditContext
      ? `V2 续费工作台礼品卡确认入账：${result.giftCard.codeMasked}`
      : `V2 礼品卡确认入账：${result.giftCard.codeMasked}`
  });
}

export function normalizeGiftCardCreditUuid(value: unknown, label: string) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!UUID_PATTERN.test(normalized)) throw new BadRequestException(`${label}格式无效`);
  return normalized;
}

export function normalizeGiftCardCode(value: unknown) {
  const normalized = typeof value === 'string' ? value.toUpperCase().replace(/[^A-Z0-9]/g, '') : '';
  if (!CODE_PATTERN.test(normalized) || !/[A-Z]/.test(normalized) || !/\d/.test(normalized)) {
    throw new BadRequestException('礼品卡号必须是 10 至 64 位且同时包含字母和数字');
  }
  return normalized;
}

export function normalizeGiftCardCreditIdempotencyKey(value: unknown) {
  const normalized = typeof value === 'string' ? value.trim() : '';
  if (!IDEMPOTENCY_KEY_PATTERN.test(normalized)) {
    throw new BadRequestException('幂等键必须是 8 至 100 位字母、数字或 ._:-');
  }
  return normalized;
}

export function buildGiftCardCreditIdempotencyKey(accountId: string, value: string) {
  return `gift_card_credit:${accountId}:${value}`;
}

export function normalizeGiftCardCreditRemark(value: unknown) {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string') throw new BadRequestException('备注格式无效');
  const normalized = value.trim();
  if (normalized.length > 2000) throw new BadRequestException('备注不能超过 2000 个字符');
  return normalized || null;
}

export function maskGiftCardCode(code: string) {
  return `${code.slice(0, 4)}****${giftCardCodeTail(code)}`;
}

export function giftCardCodeTail(code: string) {
  return code.slice(-4);
}

function nullableDecimalEquals(left: Rate8 | null, right: Rate8 | null) {
  if (left === null || right === null) return left === right;
  return left.equals(right);
}

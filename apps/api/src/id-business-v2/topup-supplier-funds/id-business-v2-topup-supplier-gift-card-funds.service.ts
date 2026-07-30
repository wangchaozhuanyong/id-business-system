import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { Prisma as PrismaNamespace } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { roundV2Decimal } from '../decimal-policy';
import { IdBusinessV2TopupSupplierFundsSupport } from './id-business-v2-topup-supplier-funds-support';

interface GiftCardFundInput {
  supplierOptionId: string;
  supplierAccountId?: string;
  giftCardId: string;
  currency?: 'CNY' | 'MYR' | 'USDT';
  amountOriginal?: PrismaNamespace.Decimal.Value;
  amountCny: PrismaNamespace.Decimal.Value;
  operator?: AuthenticatedUser;
}

@Injectable()
export class IdBusinessV2TopupSupplierGiftCardFundsService extends IdBusinessV2TopupSupplierFundsSupport {
  constructor(prisma: PrismaService) {
    super(prisma);
  }

  async debitGiftCard(tx: Prisma.TransactionClient, input: GiftCardFundInput) {
    const supplierOptionId = this.normalizeUuid(input.supplierOptionId, '加卡供应商');
    const giftCardId = this.normalizeUuid(input.giftCardId, '礼品卡');
    const currency = input.currency ?? 'CNY';
    const amountOriginal = roundV2Decimal(input.amountOriginal ?? input.amountCny);
    const amountCny = roundV2Decimal(input.amountCny);
    if (amountOriginal.lte(0) || amountCny.lte(0)) {
      throw new BadRequestException('礼品卡原币金额和人民币成本必须大于 0');
    }
    const idempotencyKey = `supplier_gift_card_debit:${giftCardId}:${supplierOptionId}`;
    const replay = await tx.idBusinessV2TopupSupplierLedger.findUnique({
      where: { idempotencyKey }
    });
    if (replay) {
      if (
        replay.currency !== currency ||
        !replay.amount.eq(amountOriginal) ||
        !replay.amountCny.eq(amountCny)
      ) {
        throw new ConflictException('礼品卡供应商扣款请求与已入账内容不一致');
      }
      return this.toSupplierSnapshot(replay, true);
    }

    const account = input.supplierAccountId
      ? await this.lockSupplierAccountById(
          tx,
          this.normalizeUuid(input.supplierAccountId, '供应商钱包')
        )
      : await this.lockSupplierAccount(tx, supplierOptionId);
    this.assertInitialized(account);
    const accountCurrency = account.currency ?? 'CNY';
    const currentBalance = account.currentBalance ?? account.currentBalanceCny;
    if (account.supplierOptionId !== supplierOptionId || accountCurrency !== currency) {
      throw new BadRequestException('供应商钱包与加卡供应商或付款币种不一致');
    }
    const balanceAfter = roundV2Decimal(currentBalance.sub(amountOriginal));
    const balanceAfterCny = roundV2Decimal(account.currentBalanceCny.sub(amountCny));
    const entry = await tx.idBusinessV2TopupSupplierLedger.create({
      data: {
        supplierAccountId: account.id,
        giftCardId,
        entryType: 'gift_card_debit',
        direction: 'debit',
        currency,
        amount: amountOriginal,
        balanceBefore: currentBalance,
        balanceAfter,
        amountCny,
        balanceBeforeCny: account.currentBalanceCny,
        balanceAfterCny,
        supplierNameSnapshot: account.supplierName,
        idempotencyKey,
        reason: '礼品卡入账扣减供应商人民币余额',
        createdByUserId: input.operator?.id
      }
    });
    await tx.idBusinessV2TopupSupplierAccount.update({
      where: { id: account.id },
      data: {
        currentBalance: balanceAfter,
        currentBalanceCny: balanceAfterCny,
        updatedByUserId: input.operator?.id
      }
    });
    return this.toSupplierSnapshot(entry, false);
  }

  async reverseGiftCardDebit(
    tx: Prisma.TransactionClient,
    input: {
      giftCardId: string;
      reason: string;
      operator?: AuthenticatedUser;
    }
  ) {
    const giftCardId = this.normalizeUuid(input.giftCardId, '礼品卡');
    const idempotencyKey = `supplier_gift_card_withdrawal:${giftCardId}`;
    const replay = await tx.idBusinessV2TopupSupplierLedger.findUnique({
      where: { idempotencyKey }
    });
    if (replay) return this.toSupplierSnapshot(replay, true);

    const debitEntry = await tx.idBusinessV2TopupSupplierLedger.findFirst({
      where: {
        giftCardId,
        entryType: 'gift_card_debit',
        reversedBy: null
      },
      orderBy: { createdAt: 'desc' }
    });
    if (!debitEntry) return null;

    const account = await this.lockSupplierAccountById(tx, debitEntry.supplierAccountId);
    const debitAmount = debitEntry.amount ?? debitEntry.amountCny;
    const balanceBefore = account.currentBalance ?? account.currentBalanceCny;
    const balanceAfter = roundV2Decimal(balanceBefore.add(debitAmount));
    const balanceAfterCny = roundV2Decimal(account.currentBalanceCny.add(debitEntry.amountCny));
    const entry = await tx.idBusinessV2TopupSupplierLedger.create({
      data: {
        supplierAccountId: account.id,
        giftCardId,
        entryType: 'gift_card_withdrawal_reversal',
        direction: 'credit',
        currency: debitEntry.currency ?? 'CNY',
        amount: debitAmount,
        balanceBefore,
        balanceAfter,
        amountCny: debitEntry.amountCny,
        balanceBeforeCny: account.currentBalanceCny,
        balanceAfterCny,
        supplierNameSnapshot: account.supplierName,
        reversalOfEntryId: debitEntry.id,
        idempotencyKey,
        reason: input.reason,
        createdByUserId: input.operator?.id
      }
    });
    await tx.idBusinessV2TopupSupplierAccount.update({
      where: { id: account.id },
      data: {
        currentBalance: balanceAfter,
        currentBalanceCny: balanceAfterCny,
        updatedByUserId: input.operator?.id
      }
    });
    return this.toSupplierSnapshot(entry, false);
  }
}

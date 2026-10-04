import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  Amount4,
  V2TransactionalAuditService,
  type V2CommandTransaction,
  type V2DecimalInput
} from '../runtime/public-api';
import { IdBusinessV2TopupSupplierFundsSupport } from './id-business-v2-topup-supplier-funds-support';
import { IdBusinessV2TopupSupplierCommandRepository } from './persistence/id-business-v2-topup-supplier-command.repository';

interface GiftCardFundInput {
  supplierOptionId: string;
  supplierAccountId?: string;
  giftCardId: string;
  currency?: 'CNY' | 'MYR' | 'USD' | 'USDT';
  amountOriginal?: V2DecimalInput;
  amountCny: V2DecimalInput;
  operator?: AuthenticatedUser;
}

export interface GiftCardWithdrawalFunding {
  source: 'supplier_wallet' | 'cash' | 'legacy_unverified';
  sourceLedgerId: string | null;
  supplierAccountId: string | null;
  financeAccountId: string | null;
  currency: string;
  amountOriginal: Amount4;
  amountCny: Amount4;
}

@Injectable()
export class IdBusinessV2TopupSupplierGiftCardFundsService extends IdBusinessV2TopupSupplierFundsSupport {
  constructor(
    repository: IdBusinessV2TopupSupplierCommandRepository,
    transactionalAudit: V2TransactionalAuditService
  ) {
    super(repository, transactionalAudit);
  }

  async resolveWithdrawalFunding(
    tx: V2CommandTransaction,
    giftCardId: string
  ): Promise<GiftCardWithdrawalFunding> {
    if (await this.repository.findPrematureGiftCardWithdrawal(tx, giftCardId)) {
      throw new ConflictException('该礼品卡存在旧版提前返还供应商余额流水，请先核对历史账务');
    }
    const debit = await this.repository.findActiveGiftCardDebit(tx, giftCardId);
    if (debit) {
      if (
        debit.amount.lte(0) ||
        debit.amountCny.lte(0) ||
        (debit.currency === 'CNY' && !debit.amount.equals(debit.amountCny))
      ) {
        throw new ConflictException('礼品卡原付款金额或账面成本不一致，请先核对');
      }
      return {
        source: 'supplier_wallet',
        sourceLedgerId: debit.id,
        supplierAccountId: debit.supplierAccountId,
        financeAccountId: null,
        currency: debit.currency,
        amountOriginal: debit.amount,
        amountCny: debit.amountCny
      };
    }
    const card = await this.repository.findGiftCard(tx, giftCardId);
    if (!card) throw new ConflictException('礼品卡原采购证据不存在，请先核对');
    const cost = card.costAmount;
    return {
      source: card.purchaseFinanceAccountId ? 'cash' : 'legacy_unverified',
      sourceLedgerId: null,
      supplierAccountId: null,
      financeAccountId: card.purchaseFinanceAccountId,
      currency: card.purchaseCurrency,
      amountOriginal: card.purchaseOriginalAmount ? card.purchaseOriginalAmount : cost,
      amountCny: cost
    };
  }

  async debitGiftCard(tx: V2CommandTransaction, input: GiftCardFundInput) {
    const supplierOptionId = this.normalizeUuid(input.supplierOptionId, '加卡供应商');
    const giftCardId = this.normalizeUuid(input.giftCardId, '礼品卡');
    const currency = input.currency ?? 'CNY';
    const amountOriginal = Amount4.from(input.amountOriginal ?? input.amountCny);
    const amountCny = Amount4.from(input.amountCny);
    if (amountOriginal.lte(0) || amountCny.lte(0)) {
      throw new BadRequestException('礼品卡原币金额和人民币成本必须大于 0');
    }
    const idempotencyKey = `supplier_gift_card_debit:${giftCardId}:${supplierOptionId}`;
    const replay = await this.repository.findLedgerReplayWithoutSupplier(tx, idempotencyKey);
    if (replay) {
      if (
        replay.currency !== currency ||
        !replay.amount.equals(amountOriginal) ||
        !replay.amountCny.equals(amountCny)
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
    const balanceAfter = currentBalance.sub(amountOriginal);
    const balanceAfterCny = account.currentBalanceCny.sub(amountCny);
    const entry = await this.repository.createLedger(tx, {
      supplierAccountId: account.id,
      giftCardId,
      entryType: 'gift_card_debit',
      direction: 'debit',
      currency,
      amount: amountOriginal.toString(),
      balanceBefore: currentBalance.toString(),
      balanceAfter: balanceAfter.toString(),
      amountCny: amountCny.toString(),
      balanceBeforeCny: account.currentBalanceCny.toString(),
      balanceAfterCny: balanceAfterCny.toString(),
      supplierNameSnapshot: account.supplierName,
      idempotencyKey,
      reason: '礼品卡入账扣减供应商人民币余额',
      createdByUserId: input.operator?.id
    });
    await this.repository.updateSupplierAccountBalances(tx, {
      accountId: account.id,
      currentBalance: balanceAfter.toString(),
      currentBalanceCny: balanceAfterCny.toString(),
      operatorId: input.operator?.id
    });
    return this.toSupplierSnapshot(entry, false);
  }

  async reverseGiftCardDebit(
    tx: V2CommandTransaction,
    input: {
      giftCardId: string;
      reason: string;
      operator?: AuthenticatedUser;
    }
  ) {
    const giftCardId = this.normalizeUuid(input.giftCardId, '礼品卡');
    const idempotencyKey = `supplier_gift_card_withdrawal:${giftCardId}`;
    const replay = await this.repository.findLedgerReplayWithoutSupplier(tx, idempotencyKey);
    if (replay) return this.toSupplierSnapshot(replay, true);

    const debitEntry = await this.repository.findActiveGiftCardDebit(tx, giftCardId);
    if (!debitEntry) return null;

    const account = await this.lockSupplierAccountById(tx, debitEntry.supplierAccountId);
    const debitAmount = debitEntry.amount;
    const debitAmountCny = debitEntry.amountCny;
    const balanceBefore = account.currentBalance ?? account.currentBalanceCny;
    const balanceAfter = balanceBefore.add(debitAmount);
    const balanceAfterCny = account.currentBalanceCny.add(debitAmountCny);
    const entry = await this.repository.createLedger(tx, {
      supplierAccountId: account.id,
      giftCardId,
      entryType: 'gift_card_withdrawal_reversal',
      direction: 'credit',
      currency: debitEntry.currency ?? 'CNY',
      amount: debitAmount.toString(),
      balanceBefore: balanceBefore.toString(),
      balanceAfter: balanceAfter.toString(),
      amountCny: debitAmountCny.toString(),
      balanceBeforeCny: account.currentBalanceCny.toString(),
      balanceAfterCny: balanceAfterCny.toString(),
      supplierNameSnapshot: account.supplierName,
      reversalOfEntryId: debitEntry.id,
      idempotencyKey,
      reason: input.reason,
      createdByUserId: input.operator?.id
    });
    await this.repository.updateSupplierAccountBalances(tx, {
      accountId: account.id,
      currentBalance: balanceAfter.toString(),
      currentBalanceCny: balanceAfterCny.toString(),
      operatorId: input.operator?.id
    });
    return this.toSupplierSnapshot(entry, false);
  }
}

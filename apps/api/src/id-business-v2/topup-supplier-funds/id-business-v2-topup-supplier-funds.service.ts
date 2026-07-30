import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { roundV2Decimal, toV2DecimalString } from '../decimal-policy';
import { IdBusinessV2FinancePostingService } from '../finance/public-api';
import type {
  AdjustIdBusinessV2TopupSupplierFundDto,
  CreateIdBusinessV2TopupSupplierPaymentDto,
  InitializeIdBusinessV2TopupSupplierFundDto,
  ReverseIdBusinessV2TopupSupplierPaymentDto
} from './dto/topup-supplier-fund.dto';
import { IdBusinessV2TopupSupplierFundsSupport } from './id-business-v2-topup-supplier-funds-support';

@Injectable()
export class IdBusinessV2TopupSupplierFundsService extends IdBusinessV2TopupSupplierFundsSupport {
  constructor(
    prisma: PrismaService,
    private readonly financePostingService: IdBusinessV2FinancePostingService
  ) {
    super(prisma);
  }

  async initialize(
    supplierOptionIdValue: string,
    dto: InitializeIdBusinessV2TopupSupplierFundDto,
    operator?: AuthenticatedUser
  ) {
    const supplierOptionId = this.normalizeUuid(supplierOptionIdValue, '加卡供应商');
    const targetBalance = this.normalizeSignedAmount(dto.targetBalanceCny, '期初余额');
    const reason = this.normalizeReason(dto.reason);
    const idempotencyKey = this.buildIdempotencyKey(
      'supplier_opening',
      supplierOptionId,
      dto.idempotencyKey
    );

    return this.prisma.$transaction(async (tx) => {
      const replay = await tx.idBusinessV2TopupSupplierLedger.findUnique({
        where: { idempotencyKey },
        include: { supplierAccount: { include: { supplierOption: true } } }
      });
      if (replay) {
        this.assertLedgerReplay(replay, {
          entryType: 'opening_balance',
          balanceAfter: targetBalance,
          reason
        });
        return this.toFundMutationResponse(replay, true);
      }

      const supplier = await this.requireSupplierOption(tx, supplierOptionId);
      const existing = await tx.idBusinessV2TopupSupplierAccount.findUnique({
        where: {
          supplierOptionId_currency: {
            supplierOptionId,
            currency: 'CNY'
          }
        }
      });
      if (existing?.initializedAt) {
        throw new ConflictException('该加卡供应商已经初始化，后续请使用余额调整');
      }

      const now = new Date();
      const account = existing
        ? await tx.idBusinessV2TopupSupplierAccount.update({
            where: { id: existing.id },
            data: {
              openingBalance: targetBalance,
              currentBalance: targetBalance,
              openingBalanceCny: targetBalance,
              currentBalanceCny: targetBalance,
              initializedAt: now,
              initializedByUserId: operator?.id,
              updatedByUserId: operator?.id
            }
          })
        : await tx.idBusinessV2TopupSupplierAccount.create({
            data: {
              id: randomUUID(),
              supplierOptionId,
              currency: 'CNY',
              openingBalance: targetBalance,
              currentBalance: targetBalance,
              openingBalanceCny: targetBalance,
              currentBalanceCny: targetBalance,
              initializedAt: now,
              initializedByUserId: operator?.id,
              updatedByUserId: operator?.id
            }
          });

      const entry = await tx.idBusinessV2TopupSupplierLedger.create({
        data: {
          supplierAccountId: account.id,
          entryType: 'opening_balance',
          direction: 'adjustment',
          ...this.cnyLedgerAmounts(targetBalance.abs(), 0, targetBalance),
          supplierNameSnapshot: supplier.name,
          idempotencyKey,
          reason,
          createdByUserId: operator?.id
        },
        include: { supplierAccount: { include: { supplierOption: true } } }
      });
      await this.financePostingService.post(tx, {
        journalType: 'opening_balance',
        sourceType: 'opening_balance',
        sourceId: account.id,
        sourceReference: supplier.name,
        occurredAt: now,
        summary: `卡商期初余额：${supplier.name}`,
        metadata: { excludedFromProfit: true, reason },
        idempotencyKey: `auto:${idempotencyKey}:finance`,
        operator,
        lines: [
          {
            accountCode: 'supplier_prepayment',
            direction: 'debit',
            currency: 'CNY',
            amountOriginal: targetBalance,
            fxRateToCny: 1,
            amountCny: targetBalance,
            supplierAccountId: account.id
          },
          {
            accountCode: 'opening_equity',
            direction: 'credit',
            currency: 'CNY',
            amountOriginal: targetBalance,
            fxRateToCny: 1,
            amountCny: targetBalance
          }
        ]
      });
      await this.writeAudit(tx, {
        operator,
        action: 'id_business_v2.topup_supplier_fund.initialize',
        objectType: 'id_business_v2_topup_supplier_account',
        objectId: account.id,
        afterData: {
          supplierOptionId,
          targetBalanceCny: toV2DecimalString(targetBalance),
          reason
        },
        remark: `初始化加卡供应商资金：${supplier.name}`
      });
      return this.toFundMutationResponse(entry, false);
    });
  }

  async createPayment(
    supplierOptionIdValue: string,
    dto: CreateIdBusinessV2TopupSupplierPaymentDto,
    operator?: AuthenticatedUser
  ) {
    const supplierOptionId = this.normalizeUuid(supplierOptionIdValue, '加卡供应商');
    const receivedUsdt = this.normalizeUnsignedAmount(dto.receivedUsdt, '到账 USDT', false);
    const networkFeeUsdt = this.normalizeUnsignedAmount(
      dto.networkFeeUsdt ?? 0,
      '网络手续费',
      true
    );
    const settlementRate = this.normalizeRate(dto.settlementRateCnyUsdt);
    const creditedCny = roundV2Decimal(receivedUsdt.mul(settlementRate));
    if (creditedCny.lte(0)) {
      throw new BadRequestException('折算人民币必须大于 0');
    }
    const paidAt = this.normalizeDate(dto.paidAt, '实际付款时间');
    const network = this.normalizeOptionalText(dto.network, '网络', 40);
    const transactionHash = this.normalizeOptionalText(dto.transactionHash, '交易哈希', 180);
    const remark = this.normalizeOptionalText(dto.remark, '备注', 2000);
    const idempotencyKey = this.buildIdempotencyKey(
      'supplier_payment',
      supplierOptionId,
      dto.idempotencyKey
    );

    return this.prisma.$transaction(async (tx) => {
      const replay = await tx.idBusinessV2TopupSupplierPayment.findUnique({
        where: { idempotencyKey },
        include: {
          supplierAccount: { include: { supplierOption: true } },
          ledgerEntries: { where: { entryType: 'payment_credit' }, take: 1 }
        }
      });
      if (replay) {
        this.assertPaymentReplay(replay, {
          receivedUsdt,
          networkFeeUsdt,
          settlementRate,
          paidAt,
          network,
          transactionHash,
          remark
        });
        return this.toPaymentMutationResponse(replay, true);
      }

      const account = await this.lockSupplierAccount(tx, supplierOptionId);
      this.assertInitialized(account);
      const balanceAfter = roundV2Decimal(account.currentBalanceCny.add(creditedCny));
      const payment = await tx.idBusinessV2TopupSupplierPayment.create({
        data: {
          supplierAccountId: account.id,
          supplierNameSnapshot: account.supplierName,
          paidCurrency: 'USDT',
          paidAmount: receivedUsdt,
          networkFeeAmount: networkFeeUsdt,
          fxRateToCny: settlementRate,
          creditedAmount: receivedUsdt,
          receivedUsdt,
          networkFeeUsdt,
          settlementRateCnyUsdt: settlementRate,
          creditedCny,
          network,
          transactionHash,
          paidAt,
          remark,
          idempotencyKey,
          createdByUserId: operator?.id
        }
      });
      const ledgerEntry = await tx.idBusinessV2TopupSupplierLedger.create({
        data: {
          supplierAccountId: account.id,
          paymentId: payment.id,
          entryType: 'payment_credit',
          direction: 'credit',
          ...this.cnyLedgerAmounts(creditedCny, account.currentBalanceCny, balanceAfter),
          supplierNameSnapshot: account.supplierName,
          idempotencyKey: `${idempotencyKey}:ledger`,
          reason: remark,
          createdByUserId: operator?.id
        }
      });
      await tx.idBusinessV2TopupSupplierAccount.update({
        where: { id: account.id },
        data: {
          currentBalance: balanceAfter,
          currentBalanceCny: balanceAfter,
          updatedByUserId: operator?.id
        }
      });
      const feeCny = roundV2Decimal(networkFeeUsdt.mul(settlementRate));
      await this.financePostingService.post(tx, {
        journalType: 'supplier_deposit',
        sourceType: 'supplier_payment',
        sourceId: payment.id,
        sourceReference: account.supplierName,
        occurredAt: paidAt,
        summary: `卡商充值：${account.supplierName}`,
        idempotencyKey: `auto:${idempotencyKey}:finance`,
        operator,
        lines: [
          {
            accountCode: 'supplier_prepayment',
            direction: 'debit',
            currency: 'CNY',
            amountOriginal: creditedCny,
            fxRateToCny: 1,
            amountCny: creditedCny,
            supplierAccountId: account.id
          },
          {
            accountCode: 'platform_fee',
            direction: 'debit',
            currency: 'USDT',
            amountOriginal: networkFeeUsdt,
            fxRateToCny: settlementRate,
            amountCny: feeCny
          },
          {
            accountCode: 'cash',
            direction: 'credit',
            currency: 'USDT',
            amountOriginal: receivedUsdt.add(networkFeeUsdt),
            fxRateToCny: settlementRate,
            amountCny: creditedCny.add(feeCny)
          }
        ]
      });
      await this.writeAudit(tx, {
        operator,
        action: 'id_business_v2.topup_supplier_payment.create',
        objectType: 'id_business_v2_topup_supplier_payment',
        objectId: payment.id,
        afterData: {
          supplierOptionId,
          receivedUsdt: toV2DecimalString(receivedUsdt),
          networkFeeUsdt: toV2DecimalString(networkFeeUsdt),
          settlementRateCnyUsdt: settlementRate.toString(),
          creditedCny: toV2DecimalString(creditedCny),
          balanceBeforeCny: toV2DecimalString(account.currentBalanceCny),
          balanceAfterCny: toV2DecimalString(balanceAfter),
          paidAt: paidAt.toISOString()
        },
        remark: `记录加卡供应商付款：${account.supplierName}`
      });
      return this.toPaymentMutationResponse(
        {
          ...payment,
          supplierAccount: {
            supplierOption: {
              id: account.supplierOptionId,
              name: account.supplierName
            }
          },
          ledgerEntries: [ledgerEntry]
        },
        false
      );
    });
  }

  async adjust(
    supplierOptionIdValue: string,
    dto: AdjustIdBusinessV2TopupSupplierFundDto,
    operator?: AuthenticatedUser
  ) {
    const supplierOptionId = this.normalizeUuid(supplierOptionIdValue, '加卡供应商');
    const targetBalance = this.normalizeSignedAmount(dto.targetBalanceCny, '目标余额');
    if (targetBalance.lt(0)) throw new BadRequestException('卡商余额不能调整为负数');
    const reason = this.normalizeReason(dto.reason);
    const idempotencyKey = this.buildIdempotencyKey(
      'supplier_adjustment',
      supplierOptionId,
      dto.idempotencyKey
    );

    return this.prisma.$transaction(async (tx) => {
      const replay = await tx.idBusinessV2TopupSupplierLedger.findUnique({
        where: { idempotencyKey },
        include: { supplierAccount: { include: { supplierOption: true } } }
      });
      if (replay) {
        this.assertLedgerReplay(replay, {
          entryType: 'manual_adjustment',
          balanceAfter: targetBalance,
          reason
        });
        return this.toFundMutationResponse(replay, true);
      }

      const account = await this.lockSupplierAccount(tx, supplierOptionId);
      this.assertInitialized(account);
      if (account.currentBalanceCny.eq(targetBalance)) {
        throw new BadRequestException('目标余额与当前余额相同，无需调整');
      }
      const entry = await tx.idBusinessV2TopupSupplierLedger.create({
        data: {
          supplierAccountId: account.id,
          entryType: 'manual_adjustment',
          direction: 'adjustment',
          ...this.cnyLedgerAmounts(
            targetBalance.sub(account.currentBalanceCny).abs(),
            account.currentBalanceCny,
            targetBalance
          ),
          supplierNameSnapshot: account.supplierName,
          idempotencyKey,
          reason,
          createdByUserId: operator?.id
        },
        include: { supplierAccount: { include: { supplierOption: true } } }
      });
      await tx.idBusinessV2TopupSupplierAccount.update({
        where: { id: account.id },
        data: {
          currentBalance: targetBalance,
          currentBalanceCny: targetBalance,
          updatedByUserId: operator?.id
        }
      });
      const adjustment = targetBalance.sub(account.currentBalanceCny);
      await this.financePostingService.post(tx, {
        journalType: 'supplier_adjustment',
        sourceType: 'supplier_wallet',
        sourceId: account.id,
        sourceReference: account.supplierName,
        occurredAt: new Date(),
        summary: `卡商余额调整：${account.supplierName}`,
        metadata: { reason },
        idempotencyKey: `auto:${idempotencyKey}:finance`,
        operator,
        lines: [
          {
            accountCode: 'supplier_prepayment',
            direction: adjustment.gt(0) ? 'debit' : 'credit',
            currency: 'CNY',
            amountOriginal: adjustment.abs(),
            fxRateToCny: 1,
            amountCny: adjustment.abs(),
            supplierAccountId: account.id
          },
          {
            accountCode: 'manual_adjustment',
            direction: adjustment.gt(0) ? 'credit' : 'debit',
            currency: 'CNY',
            amountOriginal: adjustment.abs(),
            fxRateToCny: 1,
            amountCny: adjustment.abs()
          }
        ]
      });
      await this.writeAudit(tx, {
        operator,
        action: 'id_business_v2.topup_supplier_fund.adjust',
        objectType: 'id_business_v2_topup_supplier_account',
        objectId: account.id,
        beforeData: { currentBalanceCny: toV2DecimalString(account.currentBalanceCny) },
        afterData: {
          currentBalanceCny: toV2DecimalString(targetBalance),
          reason
        },
        remark: `调整加卡供应商余额：${account.supplierName}`
      });
      return this.toFundMutationResponse(entry, false);
    });
  }

  async reversePayment(
    paymentIdValue: string,
    dto: ReverseIdBusinessV2TopupSupplierPaymentDto,
    operator?: AuthenticatedUser
  ) {
    const paymentId = this.normalizeUuid(paymentIdValue, '付款记录');
    const reason = this.normalizeReason(dto.reason);
    const requestKey = this.normalizeIdempotencyKey(dto.idempotencyKey);
    const idempotencyKey = `supplier_payment_reversal:${paymentId}:${requestKey}`;

    return this.prisma.$transaction(async (tx) => {
      const replay = await tx.idBusinessV2TopupSupplierLedger.findUnique({
        where: { idempotencyKey },
        include: { supplierAccount: { include: { supplierOption: true } } }
      });
      if (replay) {
        this.assertLedgerReplay(replay, {
          entryType: 'payment_reversal',
          reason
        });
        return this.toFundMutationResponse(replay, true);
      }

      const payment = await tx.idBusinessV2TopupSupplierPayment.findUnique({
        where: { id: paymentId },
        include: {
          supplierAccount: true,
          ledgerEntries: {
            include: { reversedBy: true }
          }
        }
      });
      if (!payment) {
        throw new NotFoundException('付款记录不存在');
      }
      const creditEntry = payment.ledgerEntries.find(
        (entry) => entry.entryType === 'payment_credit'
      );
      if (!creditEntry) {
        throw new ConflictException('付款记录缺少资金入账流水');
      }
      if (creditEntry.reversedBy) {
        throw new ConflictException('该付款已经撤销，不能重复处理');
      }

      const account = await this.lockSupplierAccountById(tx, payment.supplierAccountId);
      const creditedCny = roundV2Decimal(payment.creditedCny);
      const balanceAfter = roundV2Decimal(account.currentBalanceCny.sub(creditedCny));
      const entry = await tx.idBusinessV2TopupSupplierLedger.create({
        data: {
          supplierAccountId: account.id,
          paymentId: payment.id,
          entryType: 'payment_reversal',
          direction: 'debit',
          ...this.cnyLedgerAmounts(creditedCny, account.currentBalanceCny, balanceAfter),
          supplierNameSnapshot: account.supplierName,
          reversalOfEntryId: creditEntry.id,
          idempotencyKey,
          reason,
          createdByUserId: operator?.id
        },
        include: { supplierAccount: { include: { supplierOption: true } } }
      });
      await tx.idBusinessV2TopupSupplierAccount.update({
        where: { id: account.id },
        data: {
          currentBalance: balanceAfter,
          currentBalanceCny: balanceAfter,
          updatedByUserId: operator?.id
        }
      });
      const originalFinanceJournal = await tx.idBusinessV2FinanceJournal.findFirst({
        where: {
          journalType: 'supplier_deposit',
          sourceType: 'supplier_payment',
          sourceId: payment.id
        },
        orderBy: { createdAt: 'desc' }
      });
      if (originalFinanceJournal) {
        await this.financePostingService.reverse(
          tx,
          originalFinanceJournal.id,
          reason,
          `auto:${idempotencyKey}:finance`,
          operator
        );
      }
      await this.writeAudit(tx, {
        operator,
        action: 'id_business_v2.topup_supplier_payment.reverse',
        objectType: 'id_business_v2_topup_supplier_payment',
        objectId: payment.id,
        beforeData: {
          creditedCny: toV2DecimalString(payment.creditedCny),
          balanceCny: toV2DecimalString(account.currentBalanceCny)
        },
        afterData: {
          reversed: true,
          balanceCny: toV2DecimalString(balanceAfter),
          reason
        },
        remark: `撤销加卡供应商付款：${account.supplierName}`
      });
      return this.toFundMutationResponse(entry, false);
    });
  }
}

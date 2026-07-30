import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { Prisma as PrismaNamespace } from '@prisma/client';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { getPagination, type PaginationQuery } from '../../common/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import { roundV2Decimal, toV2DecimalString } from '../decimal-policy';
import type {
  AdjustIdBusinessV2SupplierWalletDto,
  CreateIdBusinessV2SupplierDepositDto,
  CreateIdBusinessV2SupplierRefundDto,
  CreateIdBusinessV2SupplierWalletDto
} from './dto/id-business-v2-finance.dto';
import { IdBusinessV2FinanceFxService } from './id-business-v2-finance-fx.service';
import {
  normalizeFinanceCurrency,
  normalizeFinanceDate,
  normalizeFinanceIdempotencyKey,
  normalizeFinanceMoney,
  normalizeFinanceRate,
  normalizeFinanceText,
  normalizeFinanceUuid
} from './id-business-v2-finance-input';
import {
  IdBusinessV2FinancePostingService,
  type FinancePostingLineInput
} from './id-business-v2-finance-posting.service';
import {
  lockFinanceSupplierWallet,
  toFinanceSupplierPaymentResponse,
  toFinanceSupplierWalletResponse,
  writeFinanceSupplierWalletAudit
} from './id-business-v2-finance-supplier-wallet-support';

@Injectable()
export class IdBusinessV2FinanceSupplierWalletsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly fxService: IdBusinessV2FinanceFxService,
    private readonly postingService: IdBusinessV2FinancePostingService
  ) {}

  async list(currency?: string, supplierOptionId?: string) {
    const normalizedCurrency = currency ? normalizeFinanceCurrency(currency) : undefined;
    const normalizedSupplierId = supplierOptionId
      ? normalizeFinanceUuid(supplierOptionId, '供应商')
      : undefined;
    const items = await this.prisma.idBusinessV2TopupSupplierAccount.findMany({
      where: { currency: normalizedCurrency, supplierOptionId: normalizedSupplierId },
      include: { supplierOption: true },
      orderBy: [{ supplierOption: { name: 'asc' } }, { currency: 'asc' }]
    });
    return { items: items.map(toFinanceSupplierWalletResponse) };
  }

  async create(dto: CreateIdBusinessV2SupplierWalletDto, operator?: AuthenticatedUser) {
    const supplierOptionId = normalizeFinanceUuid(dto.supplierOptionId, '供应商');
    const currency = normalizeFinanceCurrency(dto.currency);
    const openingBalance = normalizeFinanceMoney(dto.openingBalance ?? 0, '期初余额', true);
    const reason = normalizeFinanceText(dto.reason, '原因', 500, true)!;
    const manualRate =
      dto.fxRateToCny === undefined ? null : normalizeFinanceRate(dto.fxRateToCny, currency);
    const now = new Date();
    const rate = await this.fxService.resolve({
      currency,
      occurredAt: now,
      fxRateSnapshotId: dto.fxRateSnapshotId,
      manualRate,
      manualReason: dto.manualRateReason,
      operator
    });
    const openingBalanceCny = roundV2Decimal(openingBalance.mul(rate.rateToCny));
    const idempotencyKey = normalizeFinanceIdempotencyKey(dto.idempotencyKey, 'supplier_wallet');
    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.idBusinessV2TopupSupplierAccount.findUnique({
        where: { supplierOptionId_currency: { supplierOptionId, currency } },
        include: { supplierOption: true }
      });
      if (existing) return toFinanceSupplierWalletResponse(existing);
      const supplier = await tx.idBusinessV2Option.findFirst({
        where: {
          id: supplierOptionId,
          type: { in: ['topup_supplier', 'id_supplier'] },
          status: 'active',
          deletedAt: null
        }
      });
      if (!supplier) throw new BadRequestException('供应商不存在或已停用');
      const wallet = await tx.idBusinessV2TopupSupplierAccount.create({
        data: {
          id: randomUUID(),
          supplierOptionId,
          currency,
          openingBalance,
          currentBalance: openingBalance,
          openingBalanceCny,
          currentBalanceCny: openingBalanceCny,
          initializedAt: now,
          initializedByUserId: operator?.id,
          updatedByUserId: operator?.id
        },
        include: { supplierOption: true }
      });
      await tx.idBusinessV2TopupSupplierLedger.create({
        data: {
          id: randomUUID(),
          supplierAccountId: wallet.id,
          entryType: 'opening_balance',
          direction: 'adjustment',
          currency,
          amount: openingBalance,
          balanceBefore: 0,
          balanceAfter: openingBalance,
          amountCny: openingBalanceCny,
          balanceBeforeCny: 0,
          balanceAfterCny: openingBalanceCny,
          supplierNameSnapshot: supplier.name,
          idempotencyKey: `${idempotencyKey}:ledger`,
          reason,
          createdByUserId: operator?.id
        }
      });
      await this.postingService.post(tx, {
        journalType: 'opening_balance',
        sourceType: 'opening_balance',
        sourceId: wallet.id,
        sourceReference: supplier.name,
        occurredAt: now,
        summary: `供应商钱包期初余额：${supplier.name}`,
        metadata: { excludedFromProfit: true, reason },
        idempotencyKey: `${idempotencyKey}:journal`,
        operator,
        lines: [
          {
            accountCode: 'supplier_prepayment',
            direction: 'debit',
            currency,
            amountOriginal: openingBalance,
            fxRateToCny: rate.rateToCny,
            amountCny: openingBalanceCny,
            supplierAccountId: wallet.id,
            fxRateSnapshotId: rate.id
          },
          {
            accountCode: 'opening_equity',
            direction: 'credit',
            currency,
            amountOriginal: openingBalance,
            fxRateToCny: rate.rateToCny,
            amountCny: openingBalanceCny,
            fxRateSnapshotId: rate.id
          }
        ]
      });
      await writeFinanceSupplierWalletAudit(tx, operator, 'create', wallet.id, {
        supplierOptionId,
        currency,
        openingBalance: toV2DecimalString(openingBalance),
        reason
      });
      return toFinanceSupplierWalletResponse(wallet);
    });
  }

  async deposit(
    walletIdValue: string,
    dto: CreateIdBusinessV2SupplierDepositDto,
    operator?: AuthenticatedUser
  ) {
    const walletId = normalizeFinanceUuid(walletIdValue, '供应商钱包');
    const financeAccountId = normalizeFinanceUuid(dto.financeAccountId, '资金账户');
    const paidAmount = normalizeFinanceMoney(dto.paidAmount, '付款金额');
    const networkFee = normalizeFinanceMoney(dto.networkFeeAmount ?? 0, '网络手续费', true);
    const creditedAmount = normalizeFinanceMoney(dto.creditedAmount ?? dto.paidAmount, '到账金额');
    const paidAt = normalizeFinanceDate(dto.paidAt, '付款时间');
    const idempotencyKey = normalizeFinanceIdempotencyKey(dto.idempotencyKey, 'supplier_deposit');
    const [wallet, financeAccount] = await Promise.all([
      this.prisma.idBusinessV2TopupSupplierAccount.findUnique({
        where: { id: walletId },
        include: { supplierOption: true }
      }),
      this.prisma.idBusinessV2FinanceAccount.findUnique({ where: { id: financeAccountId } })
    ]);
    if (!wallet || wallet.status !== 'active')
      throw new BadRequestException('供应商钱包不存在或已停用');
    if (!financeAccount || financeAccount.status !== 'active') {
      throw new BadRequestException('资金账户不存在或已停用');
    }
    const manualRate =
      dto.fxRateToCny === undefined
        ? null
        : normalizeFinanceRate(dto.fxRateToCny, financeAccount.currency);
    const paidRate = await this.fxService.resolve({
      currency: financeAccount.currency,
      occurredAt: paidAt,
      fxRateSnapshotId: dto.fxRateSnapshotId,
      manualRate,
      manualReason: dto.manualRateReason,
      operator
    });
    const walletRate =
      wallet.currency === financeAccount.currency
        ? paidRate
        : await this.fxService.resolve({ currency: wallet.currency, occurredAt: paidAt, operator });
    const creditedCny = roundV2Decimal(creditedAmount.mul(walletRate.rateToCny));
    const paidCny = roundV2Decimal(paidAmount.mul(paidRate.rateToCny));
    const feeCny = roundV2Decimal(networkFee.mul(paidRate.rateToCny));
    const cashOutCny = paidCny.add(feeCny);
    const remark = normalizeFinanceText(dto.remark, '备注', 2000);

    return this.prisma.$transaction(async (tx) => {
      const replay = await tx.idBusinessV2TopupSupplierPayment.findUnique({
        where: { idempotencyKey },
        include: { supplierAccount: { include: { supplierOption: true } } }
      });
      if (replay) return toFinanceSupplierPaymentResponse(replay);
      const locked = await lockFinanceSupplierWallet(tx, walletId);
      const nextBalance = roundV2Decimal(locked.currentBalance.add(creditedAmount));
      const nextBalanceCny = roundV2Decimal(locked.currentBalanceCny.add(creditedCny));
      const payment = await tx.idBusinessV2TopupSupplierPayment.create({
        data: {
          id: randomUUID(),
          supplierAccountId: walletId,
          financeAccountId,
          fxRateSnapshotId: paidRate.id,
          supplierNameSnapshot: locked.supplierName,
          paidCurrency: financeAccount.currency,
          paidAmount,
          networkFeeAmount: networkFee,
          fxRateToCny: paidRate.rateToCny,
          creditedAmount,
          creditedCny,
          receivedUsdt: financeAccount.currency === 'USDT' ? paidAmount : null,
          networkFeeUsdt: financeAccount.currency === 'USDT' ? networkFee : null,
          settlementRateCnyUsdt: financeAccount.currency === 'USDT' ? paidRate.rateToCny : null,
          network: normalizeFinanceText(dto.network, '网络', 40),
          transactionHash: normalizeFinanceText(dto.transactionHash, '交易哈希', 180),
          paidAt,
          remark,
          idempotencyKey,
          createdByUserId: operator?.id
        },
        include: { supplierAccount: { include: { supplierOption: true } } }
      });
      await tx.idBusinessV2TopupSupplierLedger.create({
        data: {
          id: randomUUID(),
          supplierAccountId: walletId,
          paymentId: payment.id,
          entryType: 'payment_credit',
          direction: 'credit',
          currency: wallet.currency,
          amount: creditedAmount,
          balanceBefore: locked.currentBalance,
          balanceAfter: nextBalance,
          amountCny: creditedCny,
          balanceBeforeCny: locked.currentBalanceCny,
          balanceAfterCny: nextBalanceCny,
          supplierNameSnapshot: locked.supplierName,
          idempotencyKey: `${idempotencyKey}:ledger`,
          reason: remark,
          createdByUserId: operator?.id
        }
      });
      const lines: FinancePostingLineInput[] = [
        {
          accountCode: 'supplier_prepayment',
          direction: 'debit',
          currency: wallet.currency,
          amountOriginal: creditedAmount,
          fxRateToCny: walletRate.rateToCny,
          amountCny: creditedCny,
          supplierAccountId: walletId,
          fxRateSnapshotId: walletRate.id
        },
        ...(networkFee.gt(0)
          ? [
              {
                accountCode: 'platform_fee' as const,
                direction: 'debit' as const,
                currency: financeAccount.currency,
                amountOriginal: networkFee,
                fxRateToCny: paidRate.rateToCny,
                amountCny: feeCny,
                fxRateSnapshotId: paidRate.id
              }
            ]
          : []),
        {
          accountCode: 'cash',
          direction: 'credit',
          currency: financeAccount.currency,
          amountOriginal: paidAmount.add(networkFee),
          fxRateToCny: paidRate.rateToCny,
          amountCny: cashOutCny,
          financeAccountId,
          fxRateSnapshotId: paidRate.id
        }
      ];
      const difference = cashOutCny.sub(creditedCny).sub(feeCny);
      if (!difference.equals(0)) {
        lines.splice(lines.length - 1, 0, {
          accountCode: 'realized_fx_gain_loss',
          direction: difference.gt(0) ? 'debit' : 'credit',
          currency: 'CNY',
          amountOriginal: difference.abs(),
          fxRateToCny: 1,
          amountCny: difference.abs(),
          memo: '供应商充值已实现汇兑差额'
        });
      }
      await this.postingService.post(tx, {
        journalType: 'supplier_deposit',
        sourceType: 'supplier_payment',
        sourceId: payment.id,
        sourceReference: locked.supplierName,
        occurredAt: paidAt,
        summary: `供应商充值：${locked.supplierName}`,
        idempotencyKey: `${idempotencyKey}:journal`,
        operator,
        lines
      });
      await tx.idBusinessV2TopupSupplierAccount.update({
        where: { id: walletId },
        data: {
          currentBalance: nextBalance,
          currentBalanceCny: nextBalanceCny,
          updatedByUserId: operator?.id
        }
      });
      await writeFinanceSupplierWalletAudit(tx, operator, 'deposit', payment.id, {
        walletId,
        paidAmount: toV2DecimalString(paidAmount),
        creditedAmount: toV2DecimalString(creditedAmount),
        creditedCny: toV2DecimalString(creditedCny)
      });
      return toFinanceSupplierPaymentResponse(payment);
    });
  }

  async refund(
    walletIdValue: string,
    dto: CreateIdBusinessV2SupplierRefundDto,
    operator?: AuthenticatedUser
  ) {
    const walletId = normalizeFinanceUuid(walletIdValue, '供应商钱包');
    const financeAccountId = normalizeFinanceUuid(dto.financeAccountId, '资金账户');
    const amount = normalizeFinanceMoney(dto.amount, '退款金额');
    const receivedAt = normalizeFinanceDate(dto.receivedAt, '退款时间');
    const reason = normalizeFinanceText(dto.reason, '退款原因', 500, true)!;
    const idempotencyKey = normalizeFinanceIdempotencyKey(dto.idempotencyKey, 'supplier_refund');
    const [wallet, financeAccount] = await Promise.all([
      this.prisma.idBusinessV2TopupSupplierAccount.findUnique({
        where: { id: walletId },
        include: { supplierOption: true }
      }),
      this.prisma.idBusinessV2FinanceAccount.findUnique({ where: { id: financeAccountId } })
    ]);
    if (!wallet || wallet.status !== 'active')
      throw new BadRequestException('供应商钱包不存在或已停用');
    if (!financeAccount || financeAccount.status !== 'active') {
      throw new BadRequestException('资金账户不存在或已停用');
    }
    if (wallet.currency !== financeAccount.currency) {
      throw new BadRequestException('第一版供应商退款要求钱包币种与收款账户币种一致');
    }
    const manualRate =
      dto.fxRateToCny === undefined ? null : normalizeFinanceRate(dto.fxRateToCny, wallet.currency);
    const rate = await this.fxService.resolve({
      currency: wallet.currency,
      occurredAt: receivedAt,
      fxRateSnapshotId: dto.fxRateSnapshotId,
      manualRate,
      manualReason: dto.manualRateReason,
      operator
    });
    const amountCny = roundV2Decimal(amount.mul(rate.rateToCny));
    return this.prisma.$transaction(async (tx) => {
      const replay = await tx.idBusinessV2TopupSupplierLedger.findUnique({
        where: { idempotencyKey }
      });
      if (replay) return replay;
      const locked = await lockFinanceSupplierWallet(tx, walletId);
      if (locked.currentBalance.lt(amount)) throw new ConflictException('供应商钱包余额不足');
      const nextBalance = locked.currentBalance.sub(amount);
      const nextBalanceCny = PrismaNamespace.Decimal.max(
        0,
        locked.currentBalanceCny.sub(amountCny)
      );
      const ledger = await tx.idBusinessV2TopupSupplierLedger.create({
        data: {
          id: randomUUID(),
          supplierAccountId: walletId,
          entryType: 'supplier_refund',
          direction: 'debit',
          currency: wallet.currency,
          amount,
          balanceBefore: locked.currentBalance,
          balanceAfter: nextBalance,
          amountCny,
          balanceBeforeCny: locked.currentBalanceCny,
          balanceAfterCny: nextBalanceCny,
          supplierNameSnapshot: locked.supplierName,
          idempotencyKey,
          reason,
          createdByUserId: operator?.id
        }
      });
      await this.postingService.post(tx, {
        journalType: 'supplier_refund',
        sourceType: 'supplier_wallet',
        sourceId: walletId,
        sourceReference: locked.supplierName,
        occurredAt: receivedAt,
        summary: `供应商退款：${locked.supplierName}`,
        idempotencyKey: `${idempotencyKey}:journal`,
        operator,
        lines: [
          {
            accountCode: 'cash',
            direction: 'debit',
            currency: wallet.currency,
            amountOriginal: amount,
            fxRateToCny: rate.rateToCny,
            amountCny,
            financeAccountId,
            fxRateSnapshotId: rate.id
          },
          {
            accountCode: 'supplier_prepayment',
            direction: 'credit',
            currency: wallet.currency,
            amountOriginal: amount,
            fxRateToCny: rate.rateToCny,
            amountCny,
            supplierAccountId: walletId,
            fxRateSnapshotId: rate.id
          }
        ]
      });
      await tx.idBusinessV2TopupSupplierAccount.update({
        where: { id: walletId },
        data: {
          currentBalance: nextBalance,
          currentBalanceCny: nextBalanceCny,
          updatedByUserId: operator?.id
        }
      });
      await writeFinanceSupplierWalletAudit(tx, operator, 'refund', ledger.id, {
        walletId,
        amount: toV2DecimalString(amount),
        amountCny: toV2DecimalString(amountCny),
        reason
      });
      return ledger;
    });
  }

  async adjust(
    walletIdValue: string,
    dto: AdjustIdBusinessV2SupplierWalletDto,
    operator?: AuthenticatedUser
  ) {
    const walletId = normalizeFinanceUuid(walletIdValue, '供应商钱包');
    const target = normalizeFinanceMoney(dto.targetBalance, '目标余额', true);
    const reason = normalizeFinanceText(dto.reason, '调整原因', 500, true)!;
    const idempotencyKey = normalizeFinanceIdempotencyKey(dto.idempotencyKey, 'supplier_adjust');
    const wallet = await this.prisma.idBusinessV2TopupSupplierAccount.findUnique({
      where: { id: walletId },
      include: { supplierOption: true }
    });
    if (!wallet) throw new NotFoundException('供应商钱包不存在');
    const manualRate =
      dto.fxRateToCny === undefined ? null : normalizeFinanceRate(dto.fxRateToCny, wallet.currency);
    const now = new Date();
    const rate = await this.fxService.resolve({
      currency: wallet.currency,
      occurredAt: now,
      fxRateSnapshotId: dto.fxRateSnapshotId,
      manualRate,
      manualReason: dto.manualRateReason,
      operator
    });
    return this.prisma.$transaction(async (tx) => {
      const replay = await tx.idBusinessV2TopupSupplierLedger.findUnique({
        where: { idempotencyKey }
      });
      if (replay) return replay;
      const locked = await lockFinanceSupplierWallet(tx, walletId);
      const difference = roundV2Decimal(target.sub(locked.currentBalance));
      if (difference.equals(0)) throw new BadRequestException('目标余额与当前余额相同');
      const amount = difference.abs();
      const amountCny = roundV2Decimal(amount.mul(rate.rateToCny));
      const targetCny = roundV2Decimal(target.mul(rate.rateToCny));
      const increase = difference.gt(0);
      const ledger = await tx.idBusinessV2TopupSupplierLedger.create({
        data: {
          id: randomUUID(),
          supplierAccountId: walletId,
          entryType: 'manual_adjustment',
          direction: 'adjustment',
          currency: wallet.currency,
          amount,
          balanceBefore: locked.currentBalance,
          balanceAfter: target,
          amountCny,
          balanceBeforeCny: locked.currentBalanceCny,
          balanceAfterCny: targetCny,
          supplierNameSnapshot: locked.supplierName,
          idempotencyKey,
          reason,
          createdByUserId: operator?.id
        }
      });
      await this.postingService.post(tx, {
        journalType: 'supplier_adjustment',
        sourceType: 'supplier_wallet',
        sourceId: walletId,
        sourceReference: locked.supplierName,
        occurredAt: now,
        summary: `供应商余额调整：${locked.supplierName}`,
        metadata: { reason },
        idempotencyKey: `${idempotencyKey}:journal`,
        operator,
        lines: [
          {
            accountCode: 'supplier_prepayment',
            direction: increase ? 'debit' : 'credit',
            currency: wallet.currency,
            amountOriginal: amount,
            fxRateToCny: rate.rateToCny,
            amountCny,
            supplierAccountId: walletId,
            fxRateSnapshotId: rate.id
          },
          {
            accountCode: 'manual_adjustment',
            direction: increase ? 'credit' : 'debit',
            currency: wallet.currency,
            amountOriginal: amount,
            fxRateToCny: rate.rateToCny,
            amountCny,
            fxRateSnapshotId: rate.id
          }
        ]
      });
      await tx.idBusinessV2TopupSupplierAccount.update({
        where: { id: walletId },
        data: {
          currentBalance: target,
          currentBalanceCny: targetCny,
          updatedByUserId: operator?.id
        }
      });
      await writeFinanceSupplierWalletAudit(tx, operator, 'adjust', ledger.id, {
        walletId,
        before: toV2DecimalString(locked.currentBalance),
        after: toV2DecimalString(target),
        reason
      });
      return ledger;
    });
  }

  async ledger(walletIdValue: string, query: PaginationQuery) {
    const walletId = normalizeFinanceUuid(walletIdValue, '供应商钱包');
    const pagination = getPagination(query);
    const [items, total] = await this.prisma.$transaction([
      this.prisma.idBusinessV2TopupSupplierLedger.findMany({
        where: { supplierAccountId: walletId },
        skip: pagination.skip,
        take: pagination.take,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }]
      }),
      this.prisma.idBusinessV2TopupSupplierLedger.count({
        where: { supplierAccountId: walletId }
      })
    ]);
    return {
      items: items.map((item) => ({
        ...item,
        amount: toV2DecimalString(item.amount),
        balanceBefore: toV2DecimalString(item.balanceBefore),
        balanceAfter: toV2DecimalString(item.balanceAfter),
        amountCny: toV2DecimalString(item.amountCny),
        balanceBeforeCny: toV2DecimalString(item.balanceBeforeCny),
        balanceAfterCny: toV2DecimalString(item.balanceAfterCny)
      })),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize
    };
  }
}

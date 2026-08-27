import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { getPagination, type PaginationQuery } from '../../common/pagination';
import {
  Amount4,
  Rate8,
  V2CommandTransactionManager,
  V2TransactionalAuditService
} from '../runtime/public-api';
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
import { IdBusinessV2FinanceSupplierWalletRepository } from './persistence/id-business-v2-finance-supplier-wallet.repository';

@Injectable()
export class IdBusinessV2FinanceSupplierWalletsService {
  constructor(
    private readonly commandTransactions: V2CommandTransactionManager,
    private readonly repository: IdBusinessV2FinanceSupplierWalletRepository,
    private readonly audit: V2TransactionalAuditService,
    private readonly fxService: IdBusinessV2FinanceFxService,
    private readonly postingService: IdBusinessV2FinancePostingService
  ) {}

  async list(currency?: string, supplierOptionId?: string) {
    const normalizedCurrency = currency ? normalizeFinanceCurrency(currency) : undefined;
    const normalizedSupplierId = supplierOptionId
      ? normalizeFinanceUuid(supplierOptionId, '供应商')
      : undefined;
    const items = await this.repository.list(normalizedCurrency, normalizedSupplierId);
    return { items };
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
    const rateToCny = Rate8.from(rate.rateToCny);
    const openingBalanceCny = rateToCny.apply(openingBalance);
    const idempotencyKey = normalizeFinanceIdempotencyKey(dto.idempotencyKey, 'supplier_wallet');
    return this.commandTransactions.execute(async (tx) => {
      const existing = await this.repository.findWalletBySupplierCurrency(
        tx,
        supplierOptionId,
        currency
      );
      if (existing) return existing;
      const supplier = await this.repository.findActiveSupplier(tx, supplierOptionId);
      if (!supplier) throw new BadRequestException('供应商不存在或已停用');
      const wallet = await this.repository.createWallet(tx, {
        id: randomUUID(),
        supplierOptionId,
        currency,
        openingBalance: openingBalance.toString(),
        currentBalance: openingBalance.toString(),
        openingBalanceCny: openingBalanceCny.toString(),
        currentBalanceCny: openingBalanceCny.toString(),
        initializedAt: now,
        initializedByUserId: operator?.id,
        updatedByUserId: operator?.id
      });
      await this.repository.createLedger(tx, {
        id: randomUUID(),
        supplierAccountId: wallet.id,
        entryType: 'opening_balance',
        direction: 'adjustment',
        currency,
        amount: openingBalance.toString(),
        balanceBefore: '0',
        balanceAfter: openingBalance.toString(),
        amountCny: openingBalanceCny.toString(),
        balanceBeforeCny: '0',
        balanceAfterCny: openingBalanceCny.toString(),
        supplierNameSnapshot: supplier.name,
        idempotencyKey: `${idempotencyKey}:ledger`,
        reason,
        createdByUserId: operator?.id
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
            fxRateToCny: rateToCny,
            amountCny: openingBalanceCny,
            supplierAccountId: wallet.id,
            fxRateSnapshotId: rate.id
          },
          {
            accountCode: 'opening_equity',
            direction: 'credit',
            currency,
            amountOriginal: openingBalance,
            fxRateToCny: rateToCny,
            amountCny: openingBalanceCny,
            fxRateSnapshotId: rate.id
          }
        ]
      });
      await this.writeAudit(tx, operator, 'create', wallet.id, {
        supplierOptionId,
        currency,
        openingBalance: openingBalance.toString(),
        reason
      });
      return wallet;
    }, this.commandOptions(operator));
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
    const { wallet, financeAccount } = await this.repository.findWalletAndFinanceAccount(
      walletId,
      financeAccountId
    );
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
    const walletRateToCny = Rate8.from(walletRate.rateToCny);
    const paidRateToCny = Rate8.from(paidRate.rateToCny);
    const creditedCny = walletRateToCny.apply(creditedAmount);
    const paidCny = paidRateToCny.apply(paidAmount);
    const feeCny = paidRateToCny.apply(networkFee);
    const cashOutCny = paidCny.add(feeCny);
    const remark = normalizeFinanceText(dto.remark, '备注', 2000);

    return this.commandTransactions.execute(async (tx) => {
      const replay = await this.repository.findPaymentReplay(tx, idempotencyKey);
      if (replay) return replay;
      const locked = await this.repository.lock(tx, walletId);
      const nextBalance = locked.currentBalance.add(creditedAmount);
      const nextBalanceCny = locked.currentBalanceCny.add(creditedCny);
      const payment = await this.repository.createPayment(tx, {
        id: randomUUID(),
        supplierAccountId: walletId,
        financeAccountId,
        fxRateSnapshotId: paidRate.id,
        supplierNameSnapshot: locked.supplierName,
        paidCurrency: financeAccount.currency,
        paidAmount: paidAmount.toString(),
        networkFeeAmount: networkFee.toString(),
        fxRateToCny: paidRateToCny.toString(),
        creditedAmount: creditedAmount.toString(),
        creditedCny: creditedCny.toString(),
        receivedUsdt: financeAccount.currency === 'USDT' ? paidAmount.toString() : null,
        networkFeeUsdt: financeAccount.currency === 'USDT' ? networkFee.toString() : null,
        settlementRateCnyUsdt: financeAccount.currency === 'USDT' ? paidRateToCny.toString() : null,
        network: normalizeFinanceText(dto.network, '网络', 40),
        transactionHash: normalizeFinanceText(dto.transactionHash, '交易哈希', 180),
        paidAt,
        remark,
        idempotencyKey,
        createdByUserId: operator?.id
      });
      await this.repository.createLedger(tx, {
        id: randomUUID(),
        supplierAccountId: walletId,
        paymentId: payment.id,
        entryType: 'payment_credit',
        direction: 'credit',
        currency: wallet.currency,
        amount: creditedAmount.toString(),
        balanceBefore: locked.currentBalance.toString(),
        balanceAfter: nextBalance.toString(),
        amountCny: creditedCny.toString(),
        balanceBeforeCny: locked.currentBalanceCny.toString(),
        balanceAfterCny: nextBalanceCny.toString(),
        supplierNameSnapshot: locked.supplierName,
        idempotencyKey: `${idempotencyKey}:ledger`,
        reason: remark,
        createdByUserId: operator?.id
      });
      const lines: FinancePostingLineInput[] = [
        {
          accountCode: 'supplier_prepayment',
          direction: 'debit',
          currency: wallet.currency,
          amountOriginal: creditedAmount,
          fxRateToCny: walletRateToCny,
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
                fxRateToCny: paidRateToCny,
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
          fxRateToCny: paidRateToCny,
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
      await this.repository.updateBalances(
        tx,
        walletId,
        nextBalance.toString(),
        nextBalanceCny.toString(),
        operator?.id
      );
      await this.writeAudit(tx, operator, 'deposit', payment.id, {
        walletId,
        paidAmount: paidAmount.toString(),
        creditedAmount: creditedAmount.toString(),
        creditedCny: creditedCny.toString()
      });
      return payment;
    }, this.commandOptions(operator));
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
    const { wallet, financeAccount } = await this.repository.findWalletAndFinanceAccount(
      walletId,
      financeAccountId
    );
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
    const rateToCny = Rate8.from(rate.rateToCny);
    const amountCny = rateToCny.apply(amount);
    return this.commandTransactions.execute(async (tx) => {
      const replay = await this.repository.findLedgerReplay(tx, idempotencyKey);
      if (replay) return replay;
      const locked = await this.repository.lock(tx, walletId);
      if (locked.currentBalance.lt(amount)) throw new ConflictException('供应商钱包余额不足');
      const nextBalance = locked.currentBalance.sub(amount);
      const rawNextBalanceCny = locked.currentBalanceCny.sub(amountCny);
      const nextBalanceCny = rawNextBalanceCny.isNegative() ? Amount4.zero() : rawNextBalanceCny;
      const ledger = await this.repository.createLedger(tx, {
        id: randomUUID(),
        supplierAccountId: walletId,
        entryType: 'supplier_refund',
        direction: 'debit',
        currency: wallet.currency,
        amount: amount.toString(),
        balanceBefore: locked.currentBalance.toString(),
        balanceAfter: nextBalance.toString(),
        amountCny: amountCny.toString(),
        balanceBeforeCny: locked.currentBalanceCny.toString(),
        balanceAfterCny: nextBalanceCny.toString(),
        supplierNameSnapshot: locked.supplierName,
        idempotencyKey,
        reason,
        createdByUserId: operator?.id
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
            fxRateToCny: rateToCny,
            amountCny,
            financeAccountId,
            fxRateSnapshotId: rate.id
          },
          {
            accountCode: 'supplier_prepayment',
            direction: 'credit',
            currency: wallet.currency,
            amountOriginal: amount,
            fxRateToCny: rateToCny,
            amountCny,
            supplierAccountId: walletId,
            fxRateSnapshotId: rate.id
          }
        ]
      });
      await this.repository.updateBalances(
        tx,
        walletId,
        nextBalance.toString(),
        nextBalanceCny.toString(),
        operator?.id
      );
      await this.writeAudit(tx, operator, 'refund', ledger.id, {
        walletId,
        amount: amount.toString(),
        amountCny: amountCny.toString(),
        reason
      });
      return ledger;
    }, this.commandOptions(operator));
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
    const wallet = await this.repository.findWallet(walletId);
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
    return this.commandTransactions.execute(async (tx) => {
      const replay = await this.repository.findLedgerReplay(tx, idempotencyKey);
      if (replay) return replay;
      const locked = await this.repository.lock(tx, walletId);
      const difference = target.sub(locked.currentBalance);
      if (difference.equals(0)) throw new BadRequestException('目标余额与当前余额相同');
      const amount = difference.abs();
      const rateToCny = Rate8.from(rate.rateToCny);
      const amountCny = rateToCny.apply(amount);
      const targetCny = rateToCny.apply(target);
      const increase = difference.gt(0);
      const ledger = await this.repository.createLedger(tx, {
        id: randomUUID(),
        supplierAccountId: walletId,
        entryType: 'manual_adjustment',
        direction: 'adjustment',
        currency: wallet.currency,
        amount: amount.toString(),
        balanceBefore: locked.currentBalance.toString(),
        balanceAfter: target.toString(),
        amountCny: amountCny.toString(),
        balanceBeforeCny: locked.currentBalanceCny.toString(),
        balanceAfterCny: targetCny.toString(),
        supplierNameSnapshot: locked.supplierName,
        idempotencyKey,
        reason,
        createdByUserId: operator?.id
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
            fxRateToCny: rateToCny,
            amountCny,
            supplierAccountId: walletId,
            fxRateSnapshotId: rate.id
          },
          {
            accountCode: 'manual_adjustment',
            direction: increase ? 'credit' : 'debit',
            currency: wallet.currency,
            amountOriginal: amount,
            fxRateToCny: rateToCny,
            amountCny,
            fxRateSnapshotId: rate.id
          }
        ]
      });
      await this.repository.updateBalances(
        tx,
        walletId,
        target.toString(),
        targetCny.toString(),
        operator?.id
      );
      await this.writeAudit(tx, operator, 'adjust', ledger.id, {
        walletId,
        before: locked.currentBalance.toString(),
        after: target.toString(),
        reason
      });
      return ledger;
    }, this.commandOptions(operator));
  }

  async ledger(walletIdValue: string, query: PaginationQuery) {
    const walletId = normalizeFinanceUuid(walletIdValue, '供应商钱包');
    const pagination = getPagination(query);
    const { items, total } = await this.repository.listLedger(
      walletId,
      pagination.skip,
      pagination.take
    );
    return { items, total, page: pagination.page, pageSize: pagination.pageSize };
  }

  private writeAudit(
    tx: Parameters<V2TransactionalAuditService['append']>[0],
    operator: AuthenticatedUser | undefined,
    action: string,
    objectId: string,
    afterData: Parameters<V2TransactionalAuditService['append']>[1]['afterData']
  ) {
    return this.audit.append(tx, {
      userId: operator?.id,
      module: 'id_business_v2_finance',
      action: `id_business_v2.finance_supplier_wallet.${action}`,
      objectType: 'id_business_v2_topup_supplier_account',
      objectId,
      afterData,
      remark: '供应商资金账务变更'
    });
  }

  private commandOptions(operator?: AuthenticatedUser) {
    return { changedScopes: ['supplier-funds'], requestId: randomUUID(), operator } as const;
  }
}

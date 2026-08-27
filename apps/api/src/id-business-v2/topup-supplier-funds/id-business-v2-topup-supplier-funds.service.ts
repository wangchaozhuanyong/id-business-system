import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { IdBusinessV2FinancePostingService } from '../finance/public-api';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import type {
  AdjustIdBusinessV2TopupSupplierFundDto,
  CreateIdBusinessV2TopupSupplierPaymentDto,
  InitializeIdBusinessV2TopupSupplierFundDto,
  ReverseIdBusinessV2TopupSupplierPaymentDto
} from './dto/topup-supplier-fund.dto';
import { IdBusinessV2TopupSupplierFundsSupport } from './id-business-v2-topup-supplier-funds-support';
import { IdBusinessV2TopupSupplierCommandRepository } from './persistence/id-business-v2-topup-supplier-command.repository';

@Injectable()
export class IdBusinessV2TopupSupplierFundsService extends IdBusinessV2TopupSupplierFundsSupport {
  constructor(
    repository: IdBusinessV2TopupSupplierCommandRepository,
    private readonly commandTransactions: V2CommandTransactionManager,
    transactionalAudit: V2TransactionalAuditService,
    private readonly financePostingService: IdBusinessV2FinancePostingService
  ) {
    super(repository, transactionalAudit);
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

    return this.commandTransactions.execute(async (tx) => {
      const replay = await this.repository.findLedgerReplay(tx, idempotencyKey);
      if (replay) {
        this.assertLedgerReplay(replay, {
          entryType: 'opening_balance',
          balanceAfter: targetBalance,
          reason
        });
        return this.toFundMutationResponse(replay, true);
      }

      const supplier = await this.requireSupplierOption(tx, supplierOptionId);
      const existing = await this.repository.findSupplierAccountRecord(tx, supplierOptionId);
      if (existing?.initializedAt) {
        throw new ConflictException('该加卡供应商已经初始化，后续请使用余额调整');
      }

      const now = new Date();
      const account = await this.repository.initializeSupplierAccount(tx, {
        id: randomUUID(),
        existingId: existing?.id,
        supplierOptionId,
        balance: targetBalance.toString(),
        initializedAt: now,
        operatorId: operator?.id
      });

      const entry = await this.repository.createLedgerWithSupplier(tx, {
        supplierAccountId: account.id,
        entryType: 'opening_balance',
        direction: 'adjustment',
        ...this.cnyLedgerAmounts(targetBalance.abs(), 0, targetBalance),
        supplierNameSnapshot: supplier.name,
        idempotencyKey,
        reason,
        createdByUserId: operator?.id
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
          targetBalanceCny: targetBalance.toString(),
          reason
        },
        remark: `初始化加卡供应商资金：${supplier.name}`
      });
      return this.toFundMutationResponse(entry, false);
    }, commandOptions(operator));
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
    const creditedCny = receivedUsdt.mul(settlementRate);
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

    return this.commandTransactions.execute(async (tx) => {
      const replay = await this.repository.findPaymentReplay(tx, idempotencyKey);
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
      const balanceAfter = account.currentBalanceCny.add(creditedCny);
      const payment = await this.repository.createPayment(tx, {
        supplierAccountId: account.id,
        supplierNameSnapshot: account.supplierName,
        paidCurrency: 'USDT',
        paidAmount: receivedUsdt.toString(),
        networkFeeAmount: networkFeeUsdt.toString(),
        fxRateToCny: settlementRate.toString(),
        creditedAmount: receivedUsdt.toString(),
        receivedUsdt: receivedUsdt.toString(),
        networkFeeUsdt: networkFeeUsdt.toString(),
        settlementRateCnyUsdt: settlementRate.toString(),
        creditedCny: creditedCny.toString(),
        network,
        transactionHash,
        paidAt,
        remark,
        idempotencyKey,
        createdByUserId: operator?.id
      });
      const ledgerEntry = await this.repository.createLedger(tx, {
        supplierAccountId: account.id,
        paymentId: payment.id,
        entryType: 'payment_credit',
        direction: 'credit',
        ...this.cnyLedgerAmounts(creditedCny, account.currentBalanceCny, balanceAfter),
        supplierNameSnapshot: account.supplierName,
        idempotencyKey: `${idempotencyKey}:ledger`,
        reason: remark,
        createdByUserId: operator?.id
      });
      await this.repository.updateSupplierAccountBalances(tx, {
        accountId: account.id,
        currentBalance: balanceAfter.toString(),
        currentBalanceCny: balanceAfter.toString(),
        operatorId: operator?.id
      });
      const feeCny = networkFeeUsdt.mul(settlementRate);
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
          receivedUsdt: receivedUsdt.toString(),
          networkFeeUsdt: networkFeeUsdt.toString(),
          settlementRateCnyUsdt: settlementRate.toString(),
          creditedCny: creditedCny.toString(),
          balanceBeforeCny: account.currentBalanceCny.toString(),
          balanceAfterCny: balanceAfter.toString(),
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
    }, commandOptions(operator));
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

    return this.commandTransactions.execute(async (tx) => {
      const replay = await this.repository.findLedgerReplay(tx, idempotencyKey);
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
      if (account.currentBalanceCny.equals(targetBalance)) {
        throw new BadRequestException('目标余额与当前余额相同，无需调整');
      }
      const entry = await this.repository.createLedgerWithSupplier(tx, {
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
      });
      await this.repository.updateSupplierAccountBalances(tx, {
        accountId: account.id,
        currentBalance: targetBalance.toString(),
        currentBalanceCny: targetBalance.toString(),
        operatorId: operator?.id
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
        beforeData: { currentBalanceCny: account.currentBalanceCny.toString() },
        afterData: {
          currentBalanceCny: targetBalance.toString(),
          reason
        },
        remark: `调整加卡供应商余额：${account.supplierName}`
      });
      return this.toFundMutationResponse(entry, false);
    }, commandOptions(operator));
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

    return this.commandTransactions.execute(async (tx) => {
      const replay = await this.repository.findLedgerReplay(tx, idempotencyKey);
      if (replay) {
        this.assertLedgerReplay(replay, {
          entryType: 'payment_reversal',
          reason
        });
        return this.toFundMutationResponse(replay, true);
      }

      const payment = await this.repository.findPaymentForReversal(tx, paymentId);
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
      const creditedCny = payment.creditedCny;
      const balanceAfter = account.currentBalanceCny.sub(creditedCny);
      const entry = await this.repository.createLedgerWithSupplier(tx, {
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
      });
      await this.repository.updateSupplierAccountBalances(tx, {
        accountId: account.id,
        currentBalance: balanceAfter.toString(),
        currentBalanceCny: balanceAfter.toString(),
        operatorId: operator?.id
      });
      const originalFinanceJournalId = await this.repository.findFinanceJournalIdForPayment(
        tx,
        payment.id
      );
      if (originalFinanceJournalId) {
        await this.financePostingService.reverse(
          tx,
          originalFinanceJournalId,
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
          creditedCny: payment.creditedCny.toString(),
          balanceCny: account.currentBalanceCny.toString()
        },
        afterData: {
          reversed: true,
          balanceCny: balanceAfter.toString(),
          reason
        },
        remark: `撤销加卡供应商付款：${account.supplierName}`
      });
      return this.toFundMutationResponse(entry, false);
    }, commandOptions(operator));
  }
}

function commandOptions(operator?: AuthenticatedUser) {
  return { changedScopes: ['supplier-funds'], requestId: randomUUID(), operator } as const;
}

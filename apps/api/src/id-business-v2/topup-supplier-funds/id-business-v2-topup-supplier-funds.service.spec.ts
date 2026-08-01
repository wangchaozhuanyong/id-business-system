import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { Prisma as CloudflarePrisma } from '../../generated/prisma-cloudflare/client';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2TopupSupplierFundsService } from './id-business-v2-topup-supplier-funds.service';
import { IdBusinessV2TopupSupplierGiftCardFundsService } from './id-business-v2-topup-supplier-gift-card-funds.service';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import { IdBusinessV2TopupSupplierAccountRepository } from './persistence/id-business-v2-topup-supplier-account.repository';
import { IdBusinessV2TopupSupplierCommandRepository } from './persistence/id-business-v2-topup-supplier-command.repository';

const supplierOptionId = '11111111-1111-4111-8111-111111111111';
const supplierAccountId = '22222222-2222-4222-8222-222222222222';
const giftCardId = '33333333-3333-4333-8333-333333333333';
const paymentId = '44444444-4444-4444-8444-444444444444';
const ledgerId = '55555555-5555-4555-8555-555555555555';
const operator = {
  id: '66666666-6666-4666-8666-666666666666',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: ['apple.topup_supplier_fund.manage']
};
const createdAt = new Date('2026-07-29T12:00:00.000Z');

function cloudflareDecimal(value: Prisma.Decimal.Value) {
  return new CloudflarePrisma.Decimal(String(value));
}

function lockedAccount(balance: Prisma.Decimal.Value) {
  return {
    id: supplierAccountId,
    supplierOptionId,
    supplierName: '供应商 A',
    currency: 'CNY',
    currentBalance: cloudflareDecimal(balance),
    currentBalanceCny: cloudflareDecimal(balance),
    initializedAt: createdAt
  };
}

describe('IdBusinessV2TopupSupplierFundsService', () => {
  const tx = {
    $queryRaw: vi.fn(),
    idBusinessV2Option: {
      findFirst: vi.fn()
    },
    idBusinessV2TopupSupplierAccount: {
      update: vi.fn()
    },
    idBusinessV2TopupSupplierPayment: {
      findUnique: vi.fn(),
      create: vi.fn()
    },
    idBusinessV2TopupSupplierLedger: {
      findUnique: vi.fn(),
      findFirst: vi.fn(),
      create: vi.fn()
    },
    idBusinessV2FinanceJournal: {
      findFirst: vi.fn()
    },
    auditLog: {
      create: vi.fn()
    }
  };
  const prisma = {
    $transaction: vi.fn()
  };
  const financePostingService = {
    post: vi.fn(),
    reverse: vi.fn()
  };
  const repository = new IdBusinessV2TopupSupplierCommandRepository(
    new IdBusinessV2TopupSupplierAccountRepository()
  );
  const transactionalAudit = new V2TransactionalAuditService();
  const service = new IdBusinessV2TopupSupplierFundsService(
    repository,
    new V2CommandTransactionManager(prisma as never),
    transactionalAudit,
    financePostingService as never
  );
  const giftCardFundsService = new IdBusinessV2TopupSupplierGiftCardFundsService(
    repository,
    transactionalAudit
  );

  beforeEach(() => {
    vi.clearAllMocks();
    financePostingService.post.mockResolvedValue({ id: 'finance-journal-1' });
    financePostingService.reverse.mockResolvedValue({ id: 'finance-reversal-1' });
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));
    tx.idBusinessV2Option.findFirst.mockResolvedValue({
      id: supplierOptionId,
      code: 'supplier_a',
      name: '供应商 A'
    });
    tx.idBusinessV2TopupSupplierPayment.findUnique.mockResolvedValue(null);
    tx.idBusinessV2TopupSupplierLedger.findUnique.mockResolvedValue(null);
    tx.idBusinessV2TopupSupplierLedger.findFirst.mockResolvedValue(null);
    tx.idBusinessV2FinanceJournal.findFirst.mockResolvedValue(null);
    tx.idBusinessV2TopupSupplierAccount.update.mockImplementation(async ({ data }) => ({
      id: supplierAccountId,
      ...data
    }));
    tx.auditLog.create.mockResolvedValue({ id: 'audit-1' });
  });

  it('credits 1000 USDT at 6.8 as CNY 6800 and excludes the network fee', async () => {
    tx.$queryRaw.mockResolvedValue([lockedAccount('0')]);
    tx.idBusinessV2TopupSupplierPayment.create.mockImplementation(async ({ data }) => ({
      id: paymentId,
      ...data,
      createdAt
    }));
    tx.idBusinessV2TopupSupplierLedger.create.mockImplementation(async ({ data }) => ({
      id: ledgerId,
      ...data,
      createdAt
    }));

    const result = await service.createPayment(
      supplierOptionId,
      {
        receivedUsdt: '1000',
        networkFeeUsdt: '1.5',
        settlementRateCnyUsdt: '6.8',
        paidAt: createdAt.toISOString(),
        idempotencyKey: 'payment-request-0001'
      },
      operator
    );

    expect(tx.idBusinessV2TopupSupplierPayment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        paidCurrency: 'USDT',
        paidAmount: '1000',
        networkFeeAmount: '1.5',
        fxRateToCny: '6.8',
        creditedCny: '6800',
        creditedAmount: '1000'
      })
    });
    expect(tx.idBusinessV2TopupSupplierLedger.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        entryType: 'payment_credit',
        amountCny: '6800',
        balanceBeforeCny: '0',
        balanceAfterCny: '6800',
        currency: 'CNY'
      })
    });
    expect(tx.idBusinessV2TopupSupplierAccount.update).toHaveBeenCalledWith({
      where: { id: supplierAccountId },
      data: expect.objectContaining({
        currentBalance: '6800',
        currentBalanceCny: '6800'
      })
    });
    expect(financePostingService.post).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        lines: expect.arrayContaining([
          expect.objectContaining({
            accountCode: 'platform_fee',
            currency: 'USDT'
          })
        ])
      })
    );
    const feeLine = financePostingService.post.mock.calls[0]?.[1].lines.find(
      (line: { accountCode: string }) => line.accountCode === 'platform_fee'
    );
    expect(feeLine?.amountOriginal.toString()).toBe('1.5');
    expect(feeLine?.fxRateToCny.toString()).toBe('6.8');
    expect(feeLine?.amountCny.toString()).toBe('10.2');
    expect(result).toMatchObject({
      payment: {
        receivedUsdt: '1000',
        networkFeeUsdt: '1.5',
        settlementRateCnyUsdt: '6.8',
        creditedCny: '6800'
      },
      ledgerEntry: {
        balanceBeforeCny: '0',
        balanceAfterCny: '6800'
      }
    });
  });

  it('records an omitted network fee as zero USDT without changing the supplier credit', async () => {
    tx.$queryRaw.mockResolvedValue([lockedAccount('1000')]);
    tx.idBusinessV2TopupSupplierPayment.create.mockImplementation(async ({ data }) => ({
      id: paymentId,
      ...data,
      createdAt
    }));
    tx.idBusinessV2TopupSupplierLedger.create.mockImplementation(async ({ data }) => ({
      id: ledgerId,
      ...data,
      createdAt
    }));

    const result = await service.createPayment(
      supplierOptionId,
      {
        receivedUsdt: '100',
        settlementRateCnyUsdt: '6.8',
        paidAt: createdAt.toISOString(),
        idempotencyKey: 'payment-request-zero-fee'
      },
      operator
    );

    expect(tx.idBusinessV2TopupSupplierPayment.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        paidCurrency: 'USDT',
        paidAmount: '100',
        networkFeeAmount: '0',
        networkFeeUsdt: '0',
        creditedCny: '680'
      })
    });
    expect(financePostingService.post).toHaveBeenCalledWith(
      tx,
      expect.objectContaining({
        lines: expect.arrayContaining([
          expect.objectContaining({
            accountCode: 'platform_fee',
            currency: 'USDT'
          })
        ])
      })
    );
    const feeLine = financePostingService.post.mock.calls[0]?.[1].lines.find(
      (line: { accountCode: string }) => line.accountCode === 'platform_fee'
    );
    expect(feeLine?.amountOriginal.toString()).toBe('0');
    expect(feeLine?.amountCny.toString()).toBe('0');
    expect(result).toMatchObject({
      payment: {
        receivedUsdt: '100',
        networkFeeUsdt: '0',
        creditedCny: '680'
      },
      ledgerEntry: {
        balanceBeforeCny: '1000',
        balanceAfterCny: '1680'
      }
    });
  });

  it('replays a matching Cloudflare Decimal payment without creating duplicate entries', async () => {
    tx.idBusinessV2TopupSupplierPayment.findUnique.mockResolvedValue({
      id: paymentId,
      supplierAccountId,
      supplierNameSnapshot: '供应商 A',
      receivedUsdt: cloudflareDecimal('1000'),
      networkFeeUsdt: cloudflareDecimal('1.5'),
      settlementRateCnyUsdt: cloudflareDecimal('6.8'),
      paidAmount: cloudflareDecimal('1000'),
      networkFeeAmount: cloudflareDecimal('1.5'),
      fxRateToCny: cloudflareDecimal('6.8'),
      creditedAmount: cloudflareDecimal('1000'),
      creditedCny: cloudflareDecimal('6800'),
      paidAt: createdAt,
      createdAt,
      network: null,
      transactionHash: null,
      remark: null,
      supplierAccount: {
        supplierOption: {
          id: supplierOptionId,
          name: '供应商 A'
        }
      },
      ledgerEntries: [
        {
          id: ledgerId,
          amount: cloudflareDecimal('6800'),
          balanceBefore: cloudflareDecimal('0'),
          balanceAfter: cloudflareDecimal('6800'),
          amountCny: cloudflareDecimal('6800'),
          balanceBeforeCny: cloudflareDecimal('0'),
          balanceAfterCny: cloudflareDecimal('6800'),
          createdAt
        }
      ]
    });

    const result = await service.createPayment(
      supplierOptionId,
      {
        receivedUsdt: '1000',
        networkFeeUsdt: '1.5',
        settlementRateCnyUsdt: '6.8',
        paidAt: createdAt.toISOString(),
        idempotencyKey: 'payment-request-replay'
      },
      operator
    );

    expect(result).toMatchObject({
      payment: {
        receivedUsdt: '1000',
        networkFeeUsdt: '1.5',
        settlementRateCnyUsdt: '6.8',
        creditedCny: '6800'
      },
      ledgerEntry: {
        balanceBeforeCny: '0',
        balanceAfterCny: '6800'
      },
      idempotentReplay: true
    });
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.idBusinessV2TopupSupplierPayment.create).not.toHaveBeenCalled();
    expect(tx.idBusinessV2TopupSupplierLedger.create).not.toHaveBeenCalled();
    expect(financePostingService.post).not.toHaveBeenCalled();
  });

  it('deducts the frozen gift-card cost and keeps an exact balance snapshot', async () => {
    tx.$queryRaw.mockResolvedValue([lockedAccount('6800')]);
    tx.idBusinessV2TopupSupplierLedger.create.mockImplementation(async ({ data }) => ({
      id: ledgerId,
      ...data,
      createdAt
    }));

    const result = await giftCardFundsService.debitGiftCard(tx as never, {
      supplierOptionId,
      giftCardId,
      amountCny: '570',
      operator
    });

    expect(result).toMatchObject({
      amountCny: '570',
      balanceBeforeCny: '6800',
      balanceAfterCny: '6230',
      isNegative: false,
      shortfallCny: '0'
    });
    expect(tx.idBusinessV2TopupSupplierAccount.update).toHaveBeenCalledWith({
      where: { id: supplierAccountId },
      data: expect.objectContaining({
        currentBalance: '6230',
        currentBalanceCny: '6230'
      })
    });
  });

  it('allows a gift-card debit to create an explicit negative supplier balance', async () => {
    tx.$queryRaw.mockResolvedValue([lockedAccount('100')]);
    tx.idBusinessV2TopupSupplierLedger.create.mockImplementation(async ({ data }) => ({
      id: ledgerId,
      ...data,
      createdAt
    }));

    const result = await giftCardFundsService.debitGiftCard(tx as never, {
      supplierOptionId,
      giftCardId,
      amountCny: '570',
      operator
    });

    expect(result).toMatchObject({
      balanceBeforeCny: '100',
      balanceAfterCny: '-470',
      isNegative: true,
      shortfallCny: '470'
    });
    expect(tx.idBusinessV2TopupSupplierAccount.update).toHaveBeenCalledWith({
      where: { id: supplierAccountId },
      data: expect.objectContaining({
        currentBalance: '-470',
        currentBalanceCny: '-470'
      })
    });
  });

  it('rejects gift-card debit when the supplier prepaid account is not initialized', async () => {
    tx.$queryRaw.mockResolvedValue([
      {
        ...lockedAccount('100'),
        initializedAt: null
      }
    ]);

    await expect(
      giftCardFundsService.debitGiftCard(tx as never, {
        supplierOptionId,
        giftCardId,
        amountCny: '570',
        operator
      })
    ).rejects.toBeInstanceOf(ConflictException);
    expect(tx.idBusinessV2TopupSupplierLedger.create).not.toHaveBeenCalled();
    expect(tx.idBusinessV2TopupSupplierAccount.update).not.toHaveBeenCalled();
  });

  it('restores the original debit amount on withdrawal without recalculating a rate', async () => {
    tx.idBusinessV2TopupSupplierLedger.findFirst.mockResolvedValue({
      id: ledgerId,
      supplierAccountId,
      giftCardId,
      entryType: 'gift_card_debit',
      amount: cloudflareDecimal('570'),
      balanceBefore: cloudflareDecimal('6800'),
      balanceAfter: cloudflareDecimal('6230'),
      balanceBeforeCny: cloudflareDecimal('6800'),
      balanceAfterCny: cloudflareDecimal('6230'),
      amountCny: cloudflareDecimal('570')
    });
    tx.$queryRaw.mockResolvedValue([lockedAccount('6230')]);
    tx.idBusinessV2TopupSupplierLedger.create.mockImplementation(async ({ data }) => ({
      id: '77777777-7777-4777-8777-777777777777',
      ...data,
      createdAt
    }));

    const result = await giftCardFundsService.reverseGiftCardDebit(tx as never, {
      giftCardId,
      reason: '撤回原卡',
      operator
    });

    expect(result).toMatchObject({
      amountCny: '570',
      balanceBeforeCny: '6230',
      balanceAfterCny: '6800'
    });
    expect(tx.idBusinessV2TopupSupplierLedger.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        reversalOfEntryId: ledgerId,
        amountCny: '570'
      })
    });
  });

  it('reverses a Cloudflare Decimal payment against the normalized supplier balance', async () => {
    tx.idBusinessV2TopupSupplierPayment.findUnique.mockResolvedValue({
      id: paymentId,
      supplierAccountId,
      paidAmount: cloudflareDecimal('1000'),
      networkFeeAmount: cloudflareDecimal('1.5'),
      fxRateToCny: cloudflareDecimal('6.8'),
      creditedAmount: cloudflareDecimal('1000'),
      receivedUsdt: cloudflareDecimal('1000'),
      networkFeeUsdt: cloudflareDecimal('1.5'),
      settlementRateCnyUsdt: cloudflareDecimal('6.8'),
      creditedCny: cloudflareDecimal('6800'),
      paidAt: createdAt,
      createdAt,
      supplierAccount: {
        id: supplierAccountId
      },
      ledgerEntries: [
        {
          id: ledgerId,
          entryType: 'payment_credit',
          amount: cloudflareDecimal('6800'),
          balanceBefore: cloudflareDecimal('0'),
          balanceAfter: cloudflareDecimal('6800'),
          amountCny: cloudflareDecimal('6800'),
          balanceBeforeCny: cloudflareDecimal('0'),
          balanceAfterCny: cloudflareDecimal('6800'),
          reversedBy: null
        }
      ]
    });
    tx.$queryRaw.mockResolvedValue([lockedAccount('7000')]);
    tx.idBusinessV2TopupSupplierLedger.create.mockImplementation(async ({ data }) => ({
      id: '88888888-8888-4888-8888-888888888888',
      ...data,
      createdAt,
      supplierAccount: {
        supplierOptionId,
        supplierOption: {
          id: supplierOptionId,
          name: '供应商 A'
        }
      }
    }));

    const result = await service.reversePayment(
      paymentId,
      {
        reason: '撤销错误付款',
        idempotencyKey: 'payment-reversal-0001'
      },
      operator
    );

    expect(result).toMatchObject({
      ledgerEntry: {
        entryType: 'payment_reversal',
        amountCny: '6800',
        balanceBeforeCny: '7000',
        balanceAfterCny: '200'
      },
      idempotentReplay: false
    });
    expect(tx.idBusinessV2TopupSupplierAccount.update).toHaveBeenCalledWith({
      where: { id: supplierAccountId },
      data: expect.objectContaining({
        currentBalance: '200',
        currentBalanceCny: '200'
      })
    });
  });

  it('does not invent a supplier balance entry for a pre-cutover gift card', async () => {
    const result = await giftCardFundsService.reverseGiftCardDebit(tx as never, {
      giftCardId,
      reason: '切账前历史卡撤回',
      operator
    });

    expect(result).toBeNull();
    expect(tx.$queryRaw).not.toHaveBeenCalled();
    expect(tx.idBusinessV2TopupSupplierLedger.create).not.toHaveBeenCalled();
  });
});

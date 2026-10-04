import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { PrismaService } from '../../common/prisma/prisma.service';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import { IdBusinessV2TopupSupplierFundsService } from '../topup-supplier-funds/id-business-v2-topup-supplier-funds.service';
import { IdBusinessV2TopupSupplierAccountRepository } from '../topup-supplier-funds/persistence/id-business-v2-topup-supplier-account.repository';
import { IdBusinessV2TopupSupplierCommandRepository } from '../topup-supplier-funds/persistence/id-business-v2-topup-supplier-command.repository';
import { IdBusinessV2FinanceAccountsService } from './id-business-v2-finance-accounts.service';
import { IdBusinessV2FinanceFxService } from './id-business-v2-finance-fx.service';
import { IdBusinessV2FinanceExpensesService } from './id-business-v2-finance-expenses.service';
import { IdBusinessV2FinanceExchangesService } from './id-business-v2-finance-exchanges.service';
import { IdBusinessV2FinanceExchangeRepository } from './persistence/id-business-v2-finance-exchange.repository';
import {
  IdBusinessV2FinancePostingService,
  type FinancePostingInput
} from './id-business-v2-finance-posting.service';
import { IdBusinessV2FinanceSupplierWalletsService } from './id-business-v2-finance-supplier-wallets.service';
import { IdBusinessV2FinanceCommandRepository } from './persistence/id-business-v2-finance-command.repository';
import { IdBusinessV2FinanceQueryRepository } from './persistence/id-business-v2-finance-query.repository';
import { IdBusinessV2FinanceReportRepository } from './persistence/id-business-v2-finance-report.repository';
import { IdBusinessV2FinanceSupplierWalletRepository } from './persistence/id-business-v2-finance-supplier-wallet.repository';

const databaseUrl = process.env.V2_FINANCIAL_INTEGRITY_DATABASE_URL;
const suite =
  databaseUrl &&
  /\/id_business_v2_(?:rollback|financial)_integrity_\d+$/.test(new URL(databaseUrl).pathname)
    ? describe
    : describe.skip;
const key = () => randomUUID();
const operator: AuthenticatedUser = {
  id: randomUUID(),
  username: `supplier-closure-${key()}`,
  displayName: '供应商闭环隔离验收',
  roles: ['admin'],
  permissions: []
};

suite('supplier costs, cash attribution and reports real MySQL closure', () => {
  let prisma: PrismaService;
  let transactions: V2CommandTransactionManager;
  let audit: V2TransactionalAuditService;
  let posting: IdBusinessV2FinancePostingService;
  let accounts: IdBusinessV2FinanceAccountsService;
  let wallets: IdBusinessV2FinanceSupplierWalletsService;
  let funds: IdBusinessV2TopupSupplierFundsService;
  let reports: IdBusinessV2FinanceReportRepository;
  let expenses: IdBusinessV2FinanceExpensesService;
  let exchanges: IdBusinessV2FinanceExchangesService;
  let expenseCategoryId: string;

  beforeAll(async () => {
    const target = new URL(databaseUrl!);
    expect(target.hostname).toBe('127.0.0.1');
    expect(target.pathname).toMatch(/^\/id_business_v2_(?:rollback|financial)_integrity_\d+$/);
    prisma = new PrismaService({ datasourceUrl: databaseUrl });
    await prisma.$connect();
    await prisma.user.create({
      data: {
        id: operator.id,
        username: operator.username,
        displayName: operator.displayName,
        passwordHash: 'synthetic-test-only'
      }
    });
    transactions = new V2CommandTransactionManager(prisma);
    audit = new V2TransactionalAuditService();
    const command = new IdBusinessV2FinanceCommandRepository();
    const query = new IdBusinessV2FinanceQueryRepository(prisma);
    posting = new IdBusinessV2FinancePostingService(command);
    const fx = new IdBusinessV2FinanceFxService(transactions, command, query, audit, {} as never);
    accounts = new IdBusinessV2FinanceAccountsService(
      transactions,
      command,
      query,
      audit,
      fx,
      posting
    );
    expenses = new IdBusinessV2FinanceExpensesService(
      transactions,
      command,
      query,
      audit,
      fx,
      posting
    );
    exchanges = new IdBusinessV2FinanceExchangesService(
      new IdBusinessV2FinanceExchangeRepository(prisma),
      transactions,
      fx,
      posting,
      audit
    );
    expenseCategoryId = (
      await prisma.idBusinessV2Option.create({
        data: {
          type: 'expense_category',
          code: key(),
          uniqueKey: key(),
          name: '现金成本隔离开支分类'
        }
      })
    ).id;
    wallets = new IdBusinessV2FinanceSupplierWalletsService(
      transactions,
      new IdBusinessV2FinanceSupplierWalletRepository(prisma),
      audit,
      fx,
      posting
    );
    funds = new IdBusinessV2TopupSupplierFundsService(
      new IdBusinessV2TopupSupplierCommandRepository(
        new IdBusinessV2TopupSupplierAccountRepository()
      ),
      transactions,
      audit,
      posting
    );
    reports = new IdBusinessV2FinanceReportRepository(prisma);
  }, 60000);
  afterAll(async () => {
    await prisma?.$disconnect();
  });

  async function supplier() {
    return prisma.idBusinessV2Option.create({
      data: { type: 'topup_supplier', code: key(), uniqueKey: key(), name: `供应商 ${key()}` }
    });
  }
  async function cash(
    currency: 'CNY' | 'USD' | 'USDT',
    openingBalance = '1000',
    openingRate = '7'
  ) {
    return accounts.create(
      {
        name: `闭环账户 ${key()}`,
        currency,
        accountType: 'bank',
        openingBalance,
        fxRateToCny: currency === 'CNY' ? '1' : openingRate,
        manualRateReason: '隔离验收固定交易汇率',
        idempotencyKey: key()
      },
      operator
    );
  }
  async function wallet(quantity = '100', rate = '7') {
    const option = await supplier();
    return wallets.create(
      {
        supplierOptionId: option.id,
        currency: 'USD',
        openingBalance: quantity,
        fxRateToCny: rate,
        manualRateReason: '隔离验收历史成本',
        reason: '隔离验收期初',
        idempotencyKey: key()
      },
      operator
    );
  }
  async function walletBalance(id: string) {
    const row = await prisma.idBusinessV2TopupSupplierAccount.findUniqueOrThrow({ where: { id } });
    return [row.currentBalance.toString(), row.currentBalanceCny.toString()];
  }
  async function cashBalance(id: string) {
    const row = await prisma.idBusinessV2FinanceAccount.findUniqueOrThrow({ where: { id } });
    return [row.currentBalance.toString(), row.currentBalanceCny.toString()];
  }

  it.each(['ReadCommitted', 'RepeatableRead', 'Serializable'] as const)(
    'replays contending cash requests with a current read and reverses exact costs atomically under %s',
    async (isolationLevel) => {
      const source = await cash('USD', '100');
      const repository = new IdBusinessV2FinanceCommandRepository();
      const service = new IdBusinessV2FinancePostingService(repository);
      const input: FinancePostingInput = {
        journalType: 'manual_adjustment',
        sourceType: 'manual',
        sourceId: key(),
        occurredAt: new Date(),
        summary: '隔离验收共享现金同键并发',
        idempotencyKey: key(),
        operator,
        lines: [
          {
            accountCode: 'operating_expense',
            direction: 'debit',
            currency: 'USD',
            amountOriginal: '100',
            fxRateToCny: '8',
            amountCny: '800'
          },
          {
            accountCode: 'cash',
            direction: 'credit',
            currency: 'USD',
            amountOriginal: '100',
            fxRateToCny: '8',
            amountCny: '800',
            financeAccountId: source.id
          }
        ]
      };
      let arrivals = 0;
      let release!: () => void;
      const ready = new Promise<void>((resolve) => {
        release = resolve;
      });
      const readReplay = repository.findJournalReplay.bind(repository);
      const barrier = vi
        .spyOn(repository, 'findJournalReplay')
        .mockImplementation(async (tx, id) => {
          const result = await readReplay(tx, id);
          if (id === input.idempotencyKey && arrivals < 2) {
            arrivals += 1;
            if (arrivals === 2) release();
            await ready;
          }
          return result;
        });
      const submit = () =>
        transactions.execute((tx) => service.post(tx, input), {
          changedScopes: ['finance-ledger'],
          requestId: key(),
          isolationLevel,
          retryMode: 'stableIdempotency',
          idempotencyKey: input.idempotencyKey,
          replay: (tx) => service.post(tx, input)
        });
      const journals = await (async () => {
        try {
          return await Promise.all([submit(), submit()]);
        } finally {
          barrier.mockRestore();
        }
      })();
      expect(journals[0].id).toBe(journals[1].id);
      expect(await cashBalance(source.id)).toEqual(['0', '0']);
      expect(
        await prisma.idBusinessV2FinanceJournal.count({
          where: { idempotencyKey: input.idempotencyKey }
        })
      ).toBe(1);
      const failure = vi
        .spyOn(audit, 'append')
        .mockRejectedValueOnce(new Error('cash-reversal-audit-failure'));
      try {
        await expect(
          transactions.execute(
            async (tx) => {
              const result = await service.reverse(
                tx,
                journals[0].id,
                '隔离验收失败冲销',
                key(),
                operator
              );
              await audit.append(tx, {
                module: 'id_business_v2_finance',
                action: 'synthetic.cash.reverse',
                objectType: 'id_business_v2_finance_journal',
                objectId: result.id,
                userId: operator.id
              });
              return result;
            },
            { changedScopes: ['finance-ledger'], requestId: key() }
          )
        ).rejects.toThrow('cash-reversal-audit-failure');
      } finally {
        failure.mockRestore();
      }
      expect(await cashBalance(source.id)).toEqual(['0', '0']);
      expect(
        (
          await prisma.idBusinessV2FinanceJournal.findUniqueOrThrow({
            where: { id: journals[0].id }
          })
        ).status
      ).toBe('posted');
      const reversals = await Promise.allSettled(
        [0, 1].map(() =>
          transactions.execute(
            (tx) => service.reverse(tx, journals[0].id, '隔离验收并发精确冲销', key(), operator),
            { changedScopes: ['finance-ledger'], requestId: key() }
          )
        )
      );
      expect(reversals.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
      expect(await cashBalance(source.id)).toEqual(['100', '700']);
      const reversal = await prisma.idBusinessV2FinanceJournal.findFirstOrThrow({
        where: { reversalOfJournalId: journals[0].id },
        include: { lines: true }
      });
      expect(reversal.lines.find((line) => line.accountCode === 'cash')?.amountCny.toString()).toBe(
        '700'
      );
      expect(
        reversal.lines.find((line) => line.accountCode === 'realized_fx_gain_loss')?.direction
      ).toBe('debit');
    }
  );

  it('clears full USDT cash at historical cost, preserves supplier transaction value and precisely reverses after another receipt', async () => {
    const source = await cash('USDT', '100');
    const option = await supplier();
    await funds.initialize(
      option.id,
      { targetBalanceCny: '0', reason: '隔离验收期初', idempotencyKey: key() },
      operator
    );
    const dto = {
      financeAccountId: source.id,
      receivedUsdt: '100',
      settlementRateCnyUsdt: '8',
      paidAt: new Date().toISOString(),
      idempotencyKey: key()
    };
    const payment = await funds.createPayment(option.id, dto, operator);
    await funds.createPayment(option.id, dto, operator);
    expect(await cashBalance(source.id)).toEqual(['0', '0']);
    const original = await prisma.idBusinessV2FinanceJournal.findFirstOrThrow({
      where: { sourceId: payment.payment.id, journalType: 'supplier_deposit' },
      include: { lines: true }
    });
    expect(original.lines.find((line) => line.accountCode === 'cash')?.amountCny.toString()).toBe(
      '700'
    );
    expect(
      original.lines
        .find((line) => line.accountCode === 'supplier_prepayment')
        ?.amountCny.toString()
    ).toBe('800');
    expect(
      original.lines
        .find((line) => line.accountCode === 'realized_fx_gain_loss')
        ?.amountCny.toString()
    ).toBe('100');
    await transactions.execute(
      (tx) =>
        posting.post(tx, {
          journalType: 'capital_contribution',
          sourceType: 'inflow',
          sourceId: key(),
          occurredAt: new Date(),
          summary: '隔离验收另一笔资金',
          idempotencyKey: key(),
          lines: [
            {
              accountCode: 'cash',
              direction: 'debit',
              currency: 'USDT',
              amountOriginal: '10',
              amountCny: '90',
              fxRateToCny: '9',
              financeAccountId: source.id
            },
            {
              accountCode: 'contributed_capital',
              direction: 'credit',
              currency: 'USDT',
              amountOriginal: '10',
              amountCny: '90',
              fxRateToCny: '9'
            }
          ]
        }),
      { changedScopes: ['finance-accounts'], requestId: key(), operator }
    );
    await funds.reversePayment(
      payment.payment.id,
      { reason: '隔离验收精确冲回原交易', idempotencyKey: key() },
      operator
    );
    expect(await cashBalance(source.id)).toEqual(['110', '790']);
    const reversal = await prisma.idBusinessV2FinanceJournal.findFirstOrThrow({
      where: { reversalOfJournalId: original.id },
      include: { lines: true }
    });
    expect(reversal.lines.find((line) => line.accountCode === 'cash')?.amountCny.toString()).toBe(
      '700'
    );
    expect(
      reversal.lines.find((line) => line.accountCode === 'realized_fx_gain_loss')?.direction
    ).toBe('debit');
  });

  it('clears every cash expense tail and rolls back concurrent insufficient payments and audit failures', async () => {
    const source = await cash('USD', '3', '3.33333333');
    const dto = {
      categoryOptionId: expenseCategoryId,
      financeAccountId: source.id,
      currency: 'USD' as const,
      amount: '1',
      fxRateToCny: '4',
      manualRateReason: '隔离验收费用交易汇率',
      occurredAt: new Date().toISOString(),
      idempotencyKey: key()
    };
    const costs: string[] = [];
    for (let index = 0; index < 3; index++) {
      const expense = await expenses.create({ ...dto, idempotencyKey: key() }, operator);
      const journal = await prisma.idBusinessV2FinanceJournal.findUniqueOrThrow({
        where: { id: expense.journalId },
        include: { lines: true }
      });
      costs.push(journal.lines.find((line) => line.accountCode === 'cash')!.amountCny.toString());
    }
    expect(costs).toEqual(['3.3333', '3.3334', '3.3333']);
    expect(await cashBalance(source.id)).toEqual(['0', '0']);
    const concurrentCash = await cash('USD', '100');
    const concurrentDto = {
      ...dto,
      financeAccountId: concurrentCash.id,
      amount: '60',
      fxRateToCny: '8'
    };
    const outcomes = await Promise.allSettled([
      expenses.create({ ...concurrentDto, idempotencyKey: key() }, operator),
      expenses.create({ ...concurrentDto, idempotencyKey: key() }, operator)
    ]);
    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(await cashBalance(concurrentCash.id)).toEqual(['40', '280']);
    const snapshot = await prisma.idBusinessV2FinanceFxRateSnapshot.findFirstOrThrow({
      where: { currency: 'USD', rateToCny: '8' }
    });
    const failure = vi
      .spyOn(audit, 'append')
      .mockRejectedValueOnce(new Error('synthetic-cash-audit-failure'));
    await expect(
      expenses.create(
        {
          ...concurrentDto,
          amount: '40',
          fxRateToCny: undefined,
          fxRateSnapshotId: snapshot.id,
          idempotencyKey: key()
        },
        operator
      )
    ).rejects.toThrow('synthetic-cash-audit-failure');
    failure.mockRestore();
    expect(await cashBalance(concurrentCash.id)).toEqual(['40', '280']);
    await expenses.create({ ...concurrentDto, amount: '40', idempotencyKey: key() }, operator);
    expect(await cashBalance(concurrentCash.id)).toEqual(['0', '0']);
  });

  it('combines exchange market difference with historical cash disposal FX exactly once', async () => {
    const source = await cash('USDT', '100');
    const target = await cash('CNY', '0');
    const dto = {
      sourceAccountId: source.id,
      targetAccountId: target.id,
      sourceCurrency: 'USDT' as const,
      targetCurrency: 'CNY' as const,
      sourceAmount: '98',
      targetAmount: '784',
      feeAmount: '2',
      feeMode: 'source_extra' as const,
      sourceFxRateToCny: '8',
      targetFxRateToCny: '1',
      manualRateReason: '隔离验收实际换汇汇率',
      occurredAt: new Date().toISOString(),
      idempotencyKey: key()
    };
    const exchange = await exchanges.create(dto, operator);
    await exchanges.create(dto, operator);
    expect(exchange.feeAmountCny).toBe('16');
    expect(exchange.fxGainLossCny).toBe('100');
    expect(await cashBalance(source.id)).toEqual(['0', '0']);
    expect(await cashBalance(target.id)).toEqual(['784', '784']);
    const journal = await prisma.idBusinessV2FinanceJournal.findUniqueOrThrow({
      where: { id: exchange.journalId },
      include: { lines: true }
    });
    expect(
      journal.lines.filter((line) => line.accountCode === 'realized_fx_gain_loss')
    ).toHaveLength(1);
    expect(
      journal.lines
        .filter((line) => line.accountCode === 'cash' && line.direction === 'credit')
        .map((line) => line.amountCny.toString())
        .sort()
    ).toEqual(['14', '686']);
    const reverse = { reason: '隔离验收原样冲销换汇', idempotencyKey: key() };
    await exchanges.reverse(exchange.id, reverse, operator);
    await exchanges.reverse(exchange.id, reverse, operator);
    expect(await cashBalance(source.id)).toEqual(['100', '700']);
    expect(await cashBalance(target.id)).toEqual(['0', '0']);
  });

  it('binds legacy supplier payment to cash, replays once and reverses into the original account', async () => {
    const source = await cash('USDT');
    const option = await supplier();
    await funds.initialize(
      option.id,
      { targetBalanceCny: '0', reason: '隔离验收期初', idempotencyKey: key() },
      operator
    );
    const initialized = await prisma.idBusinessV2TopupSupplierAccount.findUniqueOrThrow({
      where: { supplierOptionId_currency: { supplierOptionId: option.id, currency: 'CNY' } }
    });
    const dto = {
      financeAccountId: source.id,
      receivedUsdt: '100',
      networkFeeUsdt: '2',
      settlementRateCnyUsdt: '7',
      paidAt: new Date().toISOString(),
      idempotencyKey: key()
    };
    const payment = await funds.createPayment(option.id, dto, operator);
    await funds.createPayment(option.id, dto, operator);
    expect(await cashBalance(source.id)).toEqual(['898', '6286']);
    expect(await walletBalance(initialized.id)).toEqual(['700', '700']);
    const journal = await prisma.idBusinessV2FinanceJournal.findFirstOrThrow({
      where: { sourceId: payment.payment.id, journalType: 'supplier_deposit' },
      include: { lines: true }
    });
    expect(journal.lines.find((line) => line.accountCode === 'cash')?.financeAccountId).toBe(
      source.id
    );
    expect(
      journal.lines.find((line) => line.accountCode === 'platform_fee')?.amountCny.toString()
    ).toBe('14');
    const reversal = { reason: '隔离验收付款撤销', idempotencyKey: key() };
    await funds.reversePayment(payment.payment.id, reversal, operator);
    await funds.reversePayment(payment.payment.id, reversal, operator);
    expect(await cashBalance(source.id)).toEqual(['1000', '7000']);
    expect(await walletBalance(initialized.id)).toEqual(['0', '0']);
  });

  it('rejects wrong/disabled accounts and atomically rolls back insufficient, failed and concurrent payments', async () => {
    const source = await cash('USDT', '150');
    const wrong = await cash('CNY');
    const option = await supplier();
    await funds.initialize(
      option.id,
      { targetBalanceCny: '0', reason: '隔离验收期初', idempotencyKey: key() },
      operator
    );
    const initialized = await prisma.idBusinessV2TopupSupplierAccount.findUniqueOrThrow({
      where: { supplierOptionId_currency: { supplierOptionId: option.id, currency: 'CNY' } }
    });
    const dto = {
      financeAccountId: source.id,
      receivedUsdt: '100',
      settlementRateCnyUsdt: '7',
      paidAt: new Date().toISOString(),
      idempotencyKey: key()
    };
    await expect(
      funds.createPayment(option.id, { ...dto, financeAccountId: wrong.id }, operator)
    ).rejects.toThrow('启用的 USDT');
    await prisma.idBusinessV2FinanceAccount.update({
      where: { id: source.id },
      data: { status: 'disabled' }
    });
    await expect(funds.createPayment(option.id, dto, operator)).rejects.toThrow('启用的 USDT');
    await prisma.idBusinessV2FinanceAccount.update({
      where: { id: source.id },
      data: { status: 'active' }
    });
    await expect(
      funds.createPayment(option.id, { ...dto, receivedUsdt: '151' }, operator)
    ).rejects.toThrow('余额不足');
    expect(await walletBalance(initialized.id)).toEqual(['0', '0']);
    const failure = vi
      .spyOn(audit, 'append')
      .mockRejectedValueOnce(new Error('synthetic-audit-failure'));
    await expect(funds.createPayment(option.id, dto, operator)).rejects.toThrow(
      'synthetic-audit-failure'
    );
    failure.mockRestore();
    expect(await cashBalance(source.id)).toEqual(['150', '1050']);
    expect(await walletBalance(initialized.id)).toEqual(['0', '0']);
    const concurrent = await Promise.allSettled([
      funds.createPayment(option.id, dto, operator),
      funds.createPayment(option.id, { ...dto, idempotencyKey: key() }, operator)
    ]);
    expect(concurrent.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(await cashBalance(source.id)).toEqual(['50', '350']);
    expect(await walletBalance(initialized.id)).toEqual(['700', '700']);
    expect(
      await prisma.idBusinessV2TopupSupplierPayment.count({
        where: { supplierAccountId: initialized.id }
      })
    ).toBe(1);
  });

  it('refunds historical cost, separately recognizes gain/loss, replays and clears final rounding remainder', async () => {
    const source = await cash('USD');
    const full = await wallet();
    const dto = {
      financeAccountId: source.id,
      amount: '100',
      receivedAt: new Date().toISOString(),
      fxRateToCny: '8',
      manualRateReason: '隔离验收实际到账汇率',
      reason: '隔离验收全额退款',
      idempotencyKey: key()
    };
    await wallets.refund(full.id, dto, operator);
    await wallets.refund(full.id, dto, operator);
    expect(await walletBalance(full.id)).toEqual(['0', '0']);
    expect(await cashBalance(source.id)).toEqual(['1100', '7800']);
    const journal = await prisma.idBusinessV2FinanceJournal.findFirstOrThrow({
      where: { sourceId: full.id, journalType: 'supplier_refund' },
      include: { lines: true }
    });
    expect(
      journal.lines.find((line) => line.accountCode === 'supplier_prepayment')?.amountCny.toString()
    ).toBe('700');
    expect(
      journal.lines.find((line) => line.accountCode === 'supplier_prepayment')?.fxRateSnapshotId
    ).toBeNull();
    expect(
      journal.lines.find((line) => line.accountCode === 'realized_fx_gain_loss')
    ).toMatchObject({ direction: 'credit', currency: 'CNY' });
    expect(
      journal.lines
        .find((line) => line.accountCode === 'realized_fx_gain_loss')
        ?.amountCny.toString()
    ).toBe('100');
    const partial = await wallet('3', '3.33333333');
    const costs: string[] = [];
    for (let index = 0; index < 3; index++) {
      const ledger = await wallets.refund(
        partial.id,
        { ...dto, amount: '1', fxRateToCny: '2', idempotencyKey: key() },
        operator
      );
      costs.push(ledger.amountCny.toString());
    }
    expect(costs).toEqual(['3.3333', '3.3334', '3.3333']);
    expect(await walletBalance(partial.id)).toEqual(['0', '0']);
    const failureWallet = await wallet();
    const before = await cashBalance(source.id);
    const failure = vi
      .spyOn(audit, 'append')
      .mockRejectedValueOnce(new Error('synthetic-refund-audit-failure'));
    // Reuse an existing snapshot so the injected failure is at the command audit.
    await expect(
      wallets.refund(
        failureWallet.id,
        {
          ...dto,
          fxRateSnapshotId: journal.lines.find((line) => line.accountCode === 'cash')!
            .fxRateSnapshotId!,
          fxRateToCny: undefined,
          idempotencyKey: key()
        },
        operator
      )
    ).rejects.toThrow('synthetic-refund-audit-failure');
    failure.mockRestore();
    expect(await walletBalance(failureWallet.id)).toEqual(['100', '700']);
    expect(await cashBalance(source.id)).toEqual(before);
  });

  it('adjusts only quantity cost, preserves previous cost and clears full residual', async () => {
    const increased = await wallet();
    const dto = {
      targetBalance: '110',
      fxRateToCny: '8',
      manualRateReason: '隔离验收新增数量汇率',
      reason: '隔离验收数量调整',
      idempotencyKey: key()
    };
    await wallets.adjust(increased.id, dto, operator);
    await wallets.adjust(increased.id, dto, operator);
    expect(await walletBalance(increased.id)).toEqual(['110', '780']);
    const reduced = await wallet();
    await wallets.adjust(
      reduced.id,
      { ...dto, targetBalance: '90', idempotencyKey: key() },
      operator
    );
    expect(await walletBalance(reduced.id)).toEqual(['90', '630']);
    await wallets.adjust(
      reduced.id,
      { ...dto, targetBalance: '0', idempotencyKey: key() },
      operator
    );
    expect(await walletBalance(reduced.id)).toEqual(['0', '0']);
    const lines = await prisma.idBusinessV2FinanceJournalLine.findMany({
      where: { supplierAccountId: reduced.id, accountCode: 'supplier_prepayment' }
    });
    expect(
      lines
        .filter((line) => line.direction === 'credit')
        .map((line) => line.amountCny.toString())
        .sort()
    ).toEqual(['630', '70']);
    await prisma.idBusinessV2TopupSupplierAccount.update({
      where: { id: reduced.id },
      data: { currentBalanceCny: '1' }
    });
    try {
      await expect(
        wallets.adjust(reduced.id, { ...dto, targetBalance: '1', idempotencyKey: key() }, operator)
      ).rejects.toThrow('历史成本异常');
      expect(await walletBalance(reduced.id)).toEqual(['0', '1']);
    } finally {
      await prisma.idBusinessV2TopupSupplierAccount.update({
        where: { id: reduced.id },
        data: { currentBalanceCny: '0' }
      });
    }
  });

  it('keeps disabled assets and selects full profit journals while cash remains account-specific', async () => {
    const source = await cash('CNY');
    const second = await cash('CNY');
    const supplierWallet = await wallet();
    const before = await reports.loadAssets();
    await prisma.idBusinessV2FinanceAccount.update({
      where: { id: source.id },
      data: { status: 'disabled' }
    });
    await prisma.idBusinessV2TopupSupplierAccount.update({
      where: { id: supplierWallet.id },
      data: { status: 'disabled' }
    });
    const after = await reports.loadAssets();
    expect(after.financeAccounts.map((row) => row.currentBalanceCny.toString())).toEqual(
      before.financeAccounts.map((row) => row.currentBalanceCny.toString())
    );
    expect(after.supplierWallets.map((row) => row.currentBalanceCny.toString())).toEqual(
      before.supplierWallets.map((row) => row.currentBalanceCny.toString())
    );
    expect((await wallets.list()).items.some((row) => row.id === supplierWallet.id)).toBe(false);
    expect(
      (await wallets.list(undefined, undefined, true)).items.some(
        (row) => row.id === supplierWallet.id
      )
    ).toBe(true);
    await prisma.idBusinessV2FinanceAccount.update({
      where: { id: source.id },
      data: { status: 'active' }
    });
    await transactions.execute(
      (tx) =>
        posting.post(tx, {
          journalType: 'expense',
          sourceType: 'expense',
          sourceId: key(),
          occurredAt: new Date(),
          summary: '隔离验收多账户开支',
          idempotencyKey: key(),
          lines: [
            {
              accountCode: 'cash',
              direction: 'credit',
              currency: 'CNY',
              amountOriginal: '60',
              fxRateToCny: '1',
              amountCny: '60',
              financeAccountId: source.id
            },
            {
              accountCode: 'cash',
              direction: 'credit',
              currency: 'CNY',
              amountOriginal: '40',
              fxRateToCny: '1',
              amountCny: '40',
              financeAccountId: second.id
            },
            {
              accountCode: 'operating_expense',
              direction: 'debit',
              currency: 'CNY',
              amountOriginal: '100',
              fxRateToCny: '1',
              amountCny: '100'
            }
          ]
        }),
      { changedScopes: ['finance-accounts'], requestId: key(), operator }
    );
    for (const financeAccountId of [source.id, second.id]) {
      const profit = await reports.groupProfitLoss({ financeAccountId, journalType: 'expense' });
      expect(
        profit.find((row) => row.accountCode === 'operating_expense')?.amountCny.toString()
      ).toBe('100');
    }
    const ownCash = await reports.groupCashFlow({
      financeAccountId: source.id,
      journalType: 'expense'
    });
    expect(ownCash.find((row) => row.direction === 'credit')?.amountOriginal.toString()).toBe('60');
  });
});

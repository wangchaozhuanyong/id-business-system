import { randomUUID } from 'node:crypto';
import { beforeAll, afterAll, describe, expect, it } from 'vitest';
import {
  V2_FINANCE_CURRENCIES,
  type V2FinanceCurrency,
  type V2FinanceExchangeWrite
} from '@apple-business/shared';
import { PrismaService } from '../../common/prisma/prisma.service';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import {
  Amount4,
  V2CommandTransactionManager,
  V2TransactionalAuditService
} from '../runtime/public-api';
import { IdBusinessV2FinanceCommandRepository } from './persistence/id-business-v2-finance-command.repository';
import { IdBusinessV2FinanceQueryRepository } from './persistence/id-business-v2-finance-query.repository';
import { IdBusinessV2FinanceExchangeRepository } from './persistence/id-business-v2-finance-exchange.repository';
import { IdBusinessV2FinanceReportRepository } from './persistence/id-business-v2-finance-report.repository';
import { IdBusinessV2FinancePostingService } from './id-business-v2-finance-posting.service';
import { IdBusinessV2FinanceFxService } from './id-business-v2-finance-fx.service';
import { IdBusinessV2FinanceAccountsService } from './id-business-v2-finance-accounts.service';
import { IdBusinessV2FinanceExchangesService } from './id-business-v2-finance-exchanges.service';
import { IdBusinessV2FinanceReportsService } from './id-business-v2-finance-reports.service';
import { BankRechargeRepository } from '../auto-recharge/persistence/bank-recharge.repository';
import { BankRechargeAccountService } from '../auto-recharge/bank-recharge-account.service';
import { BankRechargeOrderService } from '../auto-recharge/bank-recharge-order.service';
import { BankRechargeFeesService } from '../auto-recharge/bank-recharge-fees.service';
import { BankRechargeFinanceService } from '../auto-recharge/bank-recharge-finance.service';
import { BankRechargeCorrectionService } from '../auto-recharge/bank-recharge-correction.service';
const url = process.env.V2_EXCHANGE_COST_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('换汇与订阅成本隔离 MySQL', () => {
  let prisma: PrismaService,
    exchange: IdBusinessV2FinanceExchangesService,
    accounts: IdBusinessV2FinanceAccountsService,
    orders: BankRechargeOrderService,
    finance: BankRechargeFinanceService,
    corrections: BankRechargeCorrectionService,
    reports: IdBusinessV2FinanceReportsService,
    bankAccounts: BankRechargeAccountService;
  const operator = {
    id: randomUUID(),
    username: 'fx-cost-test',
    displayName: '换汇成本验收',
    roles: ['admin'],
    permissions: []
  };
  const currencies = new Map<V2FinanceCurrency, string>();
  beforeAll(async () => {
    const parsed = new URL(url!);
    const isolatedDatabase =
      /^\/bank_recharge_(?:fx_cost|legacy)_\d+$/.test(parsed.pathname) ||
      /^\/id_business_v2_financial_integrity_\d+$/.test(parsed.pathname);
    if (parsed.hostname !== '127.0.0.1' || !isolatedDatabase)
      throw new Error('仅允许隔离本机验收库');
    prisma = new PrismaService({ datasourceUrl: url });
    await prisma.$connect();
    await prisma.user.create({
      data: {
        id: operator.id,
        username: operator.username,
        displayName: operator.displayName,
        passwordHash: 'synthetic-test-only'
      }
    });
    const tx = new V2CommandTransactionManager(prisma),
      audit = new V2TransactionalAuditService(),
      command = new IdBusinessV2FinanceCommandRepository(),
      query = new IdBusinessV2FinanceQueryRepository(prisma),
      posting = new IdBusinessV2FinancePostingService(command);
    const fx = new IdBusinessV2FinanceFxService(tx, command, query, audit, {} as never);
    exchange = new IdBusinessV2FinanceExchangesService(
      new IdBusinessV2FinanceExchangeRepository(prisma),
      tx,
      fx,
      posting,
      audit
    );
    accounts = new IdBusinessV2FinanceAccountsService(tx, command, query, audit, fx, posting);
    reports = new IdBusinessV2FinanceReportsService(
      tx,
      new IdBusinessV2FinanceReportRepository(prisma)
    );
    const bank = new BankRechargeRepository(prisma),
      fees = new BankRechargeFeesService(bank, audit);
    bankAccounts = new BankRechargeAccountService(
      bank,
      tx,
      audit,
      new FieldEncryptionService({ get: () => 'isolated-fx-test-key' } as never)
    );
    orders = new BankRechargeOrderService(
      tx,
      audit,
      bankAccounts,
      bank,
      fees,
      new FieldEncryptionService({ get: () => 'isolated-fx-test-key' } as never)
    );
    finance = new BankRechargeFinanceService(bank, tx, audit, posting, fees);
    corrections = new BankRechargeCorrectionService(bank, tx, audit, posting, orders, finance);
    for (const currency of V2_FINANCE_CURRENCIES) {
      const account = await accounts.create(
        {
          name: `换汇验收 ${currency}`,
          currency,
          accountType: 'bank',
          openingBalance: '10000',
          fxRateToCny: '1',
          manualRateReason: '隔离验收固定估值',
          idempotencyKey: randomUUID()
        },
        operator
      );
      currencies.set(currency, account.id);
    }
  }, 60000);
  afterAll(async () => {
    await prisma?.$disconnect();
  });
  function input(
    source: V2FinanceCurrency = 'CNY',
    target: V2FinanceCurrency = 'MYR',
    extra: Partial<V2FinanceExchangeWrite> = {}
  ): V2FinanceExchangeWrite {
    return {
      sourceAccountId: currencies.get(source)!,
      targetAccountId: currencies.get(target)!,
      sourceCurrency: source,
      targetCurrency: target,
      sourceAmount: '10',
      targetAmount: '9',
      feeAmount: '1',
      feeMode: 'target_deducted',
      sourceFxRateToCny: '1',
      targetFxRateToCny: '1',
      manualRateReason: '隔离验收固定估值',
      occurredAt: '2088-02-15T00:00:00.000Z',
      idempotencyKey: randomUUID(),
      ...extra
    };
  }
  async function balance(id: string) {
    return (
      await prisma.idBusinessV2FinanceAccount.findUniqueOrThrow({ where: { id } })
    ).currentBalance.toString();
  }
  async function assertBankProfit(orderId: string, expected: string) {
    const journals = await prisma.idBusinessV2FinanceJournal.findMany({
      where: { sourceType: 'bank_recharge', sourceId: orderId },
      include: { lines: { orderBy: { lineNo: 'asc' } } }
    });
    const profitCodes = new Set([
      'bank_recharge_revenue',
      'bank_recharge_service_fee',
      'bank_recharge_cost',
      'bank_recharge_bank_fee',
      'bank_recharge_usdt_fee',
      'bank_recharge_shopping_fee',
      'realized_fx_gain_loss'
    ]);
    let profit = Amount4.zero(),
      fx = Amount4.zero();
    for (const journal of journals)
      for (const line of journal.lines) {
        const amount = Amount4.from(line.amountCny.toString());
        const signed = line.direction === 'credit' ? amount : Amount4.zero().sub(amount);
        if (profitCodes.has(line.accountCode)) profit = profit.add(signed);
        if (line.accountCode === 'realized_fx_gain_loss') fx = fx.add(signed);
      }
    expect(profit.toString()).toBe(expected);
    expect(fx.toString()).toBe('2.5');
    expect(
      (
        await prisma.idBusinessV2BankRechargeOrder.findUniqueOrThrow({ where: { id: orderId } })
      ).profitAmountCny?.toString()
    ).toBe(expected);
  }
  async function assertUsdtFeeEvidence(orderId: string) {
    const journal = await prisma.idBusinessV2FinanceJournal.findFirstOrThrow({
      where: {
        sourceType: 'bank_recharge',
        sourceId: orderId,
        journalType: 'bank_recharge_completed',
        status: 'posted'
      },
      include: { lines: { orderBy: { lineNo: 'asc' } } }
    });
    const cash = journal.lines.find(
      (line) =>
        line.accountCode === 'cash' &&
        line.direction === 'credit' &&
        line.financeAccountId === currencies.get('USDT')
    )!;
    expect([
      cash.amountOriginal.toString(),
      cash.amountCny.toString(),
      cash.fxRateToCny.toString()
    ]).toEqual(['0.5', '0.5', '1']);
    const fee = journal.lines.find((line) => line.accountCode === 'bank_recharge_usdt_fee')!;
    expect([
      fee.amountOriginal.toString(),
      fee.amountCny.toString(),
      fee.fxRateToCny.toString()
    ]).toEqual(['0.5', '3', '6']);
    const fx = journal.lines.find(
      (line) =>
        line.accountCode === 'realized_fx_gain_loss' &&
        line.financeAccountId === currencies.get('USDT')
    )!;
    expect([fx.direction, fx.amountCny.toString()]).toEqual(['credit', '2.5']);
    expect(journal.metadata).toMatchObject({
      cashHistoricalCost: {
        version: 1,
        accounts: [
          {
            financeAccountId: currencies.get('USDT'),
            currency: 'USDT',
            balanceBefore: '10000',
            balanceBeforeCny: '10000',
            incomingOriginal: '0',
            incomingCny: '0',
            creditOriginal: '0.5',
            transactionCreditCny: '3',
            carryingCreditCny: '0.5',
            realizedFxCny: '2.5',
            lineAllocations: [
              {
                lineNo: cash.lineNo,
                transactionAmountCny: '3',
                transactionFxRateToCny: '6',
                bookCostCny: '0.5'
              }
            ]
          }
        ]
      }
    });
    return journal;
  }
  it('26 币种账户、常用方向、两种扣费及分币种统计', async () => {
    for (const source of ['CNY', 'MYR', 'USD'] as const)
      for (const target of ['PHP', 'IDR', 'CLP', 'JPY', 'KRW', 'TWD'] as const) {
        const row = await exchange.create(input(source, target), operator);
        expect(row.feePercent).toBe('10');
        expect(row.exchangeRate).toBe('1');
        expect(row.effectiveRate).toBe('0.9');
      }
    const row = await exchange.create(
      input('MYR', 'USD', { feeMode: 'source_extra', channel: '验收渠道' }),
      operator
    );
    expect(row.totalDebit).toBe('11');
    expect(row.feeAmountCny).toBe('1');
    expect(row.fxGainLossCny).toBe('-1');
    const list = await exchange.list({
      currency: 'USD',
      keyword: '验收渠道',
      page: '1',
      pageSize: '1'
    });
    expect(list.total).toBe(1);
    expect(list.summary.feeAmountCny).toBe('1');
    const reportQuery = { dateFrom: '2088-02-15', dateTo: '2088-02-15' };
    const profitLoss = await reports.profitLoss(reportQuery);
    expect(profitLoss.exchangeFeeCny).toBe('19');
    expect(profitLoss.salesRevenueCny).toBe('0');
    expect(
      (await reports.currencyBreakdown(reportQuery)).map((row) => row.currency).sort()
    ).toEqual([...V2_FINANCE_CURRENCIES].sort());
  });
  it('重复提交和冲销重放只扣一次，异内容幂等键拒绝', async () => {
    const dto = input();
    const [a, b] = await Promise.all([
      exchange.create(dto, operator),
      exchange.create(dto, operator)
    ]);
    expect(a.id).toBe(b.id);
    await expect(exchange.create({ ...dto, targetAmount: '8' }, operator)).rejects.toThrow(
      '幂等键'
    );
    const reverse = { idempotencyKey: randomUUID(), reason: '重复验收冲销' };
    await exchange.reverse(a.id, reverse, operator);
    await exchange.reverse(a.id, reverse, operator);
    expect((await exchange.detail(a.id)).status).toBe('reversed');
    expect(
      await prisma.auditLog.count({
        where: { objectId: a.id, action: 'id_business_v2.finance_exchange.reverse' }
      })
    ).toBe(1);
  });
  it('并发余额不足和更正失败全部回滚，更正成功保留原记录', async () => {
    const cash = await accounts.create(
      {
        name: '并发余额验收',
        currency: 'CNY',
        accountType: 'bank',
        openingBalance: '100',
        idempotencyKey: randomUUID()
      },
      operator
    );
    const first = input('CNY', 'MYR', {
      sourceAccountId: cash.id,
      sourceAmount: '80',
      feeMode: 'source_extra',
      feeAmount: '0'
    });
    const results = await Promise.allSettled([
      exchange.create(first, operator),
      exchange.create({ ...first, idempotencyKey: randomUUID() }, operator)
    ]);
    expect(results.filter((x) => x.status === 'fulfilled')).toHaveLength(1);
    expect(await balance(cash.id)).toBe('20');
    const winner = results.find((x) => x.status === 'fulfilled');
    if (!winner || winner.status !== 'fulfilled') throw new Error('并发未产生成功记录');
    await expect(
      exchange.correct(
        winner.value.id,
        { ...first, sourceAmount: '101', idempotencyKey: randomUUID(), reason: '不足余额更正' },
        operator
      )
    ).rejects.toThrow('余额不足');
    expect((await exchange.detail(winner.value.id)).status).toBe('posted');
    expect(await balance(cash.id)).toBe('20');
    const corrected = await exchange.correct(
      winner.value.id,
      { ...first, sourceAmount: '70', idempotencyKey: randomUUID(), reason: '正确本金更正' },
      operator
    );
    expect(corrected.correctionOfId).toBe(winner.value.id);
    expect(await balance(cash.id)).toBe('30');
    expect((await exchange.detail(winner.value.id)).status).toBe('reversed');
  });
  it('关账禁止新录入和原月份更正；账户币种校验', async () => {
    const occurredAt = '2001-01-15T00:00:00.000Z';
    const row = await exchange.create(input('CNY', 'MYR', { occurredAt }), operator);
    await prisma.idBusinessV2FinancePeriod.create({
      data: { month: '2001-01', status: 'closed', closedAt: new Date() }
    });
    await expect(
      exchange.reverse(row.id, { idempotencyKey: randomUUID(), reason: '关账冲销验收' }, operator)
    ).rejects.toThrow('关账');
    await expect(exchange.create(input('CNY', 'MYR', { occurredAt }), operator)).rejects.toThrow(
      '关账'
    );
    await expect(
      exchange.create(input('CNY', 'MYR', { targetAccountId: currencies.get('USD')! }), operator)
    ).rejects.toThrow('币种不一致');
  });
  async function subscription() {
    const account = await bankAccounts.createAccount(
      { email: `${randomUUID()}@example.invalid` },
      operator
    );
    const customer = await prisma.idBusinessV2Customer.create({ data: { name: '订阅费用验收' } });
    const card = await bankAccounts.createCard(
      { label: '费用验收卡', last4: '5678', currencyCode: 'PHP' },
      operator
    );
    const created = await orders.createManual(
      {
        plan: 'plus',
        chargeCurrencyCode: 'PHP',
        chargeAmount: '1000',
        manualEvidenceRef: randomUUID(),
        accountId: account.id,
        customerId: customer.id
      },
      operator
    );
    return orders.update(
      created.id,
      {
        expectedUpdatedAt: created.updatedAt.toISOString(),
        cardId: card.id,
        openedAt: new Date().toISOString(),
        dueAt: new Date(Date.now() + 86400000).toISOString(),
        receivedAmount: '150',
        receivedCurrencyCode: 'CNY',
        chargeFxRateToCny: '0.1',
        receivedFinanceAccountId: currencies.get('CNY'),
        fundingFinanceAccountId: currencies.get('CNY')
      },
      operator
    );
  }
  it('未知费用阻止入账，多币种现金历史成本和FX贯穿完成、更正与分次回款', async () => {
    let row = await subscription();
    expect(row.accountingVersion).toBe('subscription_cost_v2');
    expect(row.usdtFeeAmount).toBeNull();
    await expect(
      finance.complete(row.id, { expectedUpdatedAt: row.updatedAt.toISOString() }, operator)
    ).rejects.toThrow('请核对');
    const suiteExchanges = { where: { createdByUserId: operator.id } };
    const fxCount = await prisma.idBusinessV2FinanceExchange.count(suiteExchanges);
    row = await orders.update(
      row.id,
      {
        expectedUpdatedAt: row.updatedAt.toISOString(),
        usdtFeeAmount: '0.5',
        usdtFeeCurrencyCode: 'USDT',
        usdtFeeFinanceAccountId: currencies.get('USDT'),
        usdtFeeFxRateToCny: '6',
        usdtFeeManualRateReason: '实际 USDT 扣费',
        shoppingFeeAmount: '2',
        shoppingFeeCurrencyCode: 'CNY',
        shoppingFeeFinanceAccountId: currencies.get('CNY')
      },
      operator
    );
    row = await finance.complete(
      row.id,
      { expectedUpdatedAt: row.updatedAt.toISOString() },
      operator
    );
    // Revenue 150 - principal 100 - transaction fee 3 - shopping fee 2 + historical FX 2.5.
    const originalJournal = await assertUsdtFeeEvidence(row.id);
    await assertBankProfit(row.id, '47.5');
    const spentCash = await prisma.idBusinessV2FinanceAccount.findUniqueOrThrow({
      where: { id: currencies.get('USDT') }
    });
    expect([spentCash.currentBalance.toString(), spentCash.currentBalanceCny.toString()]).toEqual([
      '9999.5',
      '9999.5'
    ]);
    expect(await prisma.idBusinessV2FinanceExchange.count(suiteExchanges)).toBe(fxCount);
    const corrected = await corrections.correct(
      row.id,
      {
        expectedUpdatedAt: row.updatedAt.toISOString(),
        reason: '购物费核对',
        shoppingFeeAmount: '3'
      },
      operator
    );
    await assertBankProfit(row.id, '46.5');
    await assertUsdtFeeEvidence(row.id);
    const preservedOriginal = await prisma.idBusinessV2FinanceJournal.findUniqueOrThrow({
      where: { id: originalJournal.id },
      include: { lines: { orderBy: { lineNo: 'asc' } } }
    });
    expect(preservedOriginal.status).toBe('reversed');
    expect(preservedOriginal.lines).toEqual(originalJournal.lines);
    expect(preservedOriginal.metadata).toEqual(originalJournal.metadata);
    const reversal = await prisma.idBusinessV2FinanceJournal.findUniqueOrThrow({
      where: { reversalOfJournalId: originalJournal.id },
      include: { lines: true }
    });
    const reversedCash = reversal.lines.find(
      (line) => line.accountCode === 'cash' && line.financeAccountId === currencies.get('USDT')
    )!;
    const reversedFx = reversal.lines.find((line) => line.accountCode === 'realized_fx_gain_loss')!;
    expect([
      reversedCash.direction,
      reversedCash.amountOriginal.toString(),
      reversedCash.amountCny.toString(),
      reversedFx.direction,
      reversedFx.amountCny.toString()
    ]).toEqual(['debit', '0.5', '0.5', 'debit', '2.5']);
    const refunded = await finance.refund(
      row.id,
      {
        expectedUpdatedAt: corrected.updatedAt.toISOString(),
        reason: '客户退款验收',
        refundReference: randomUUID(),
        customerRefundAmount: '150'
      },
      operator
    );
    await assertBankProfit(row.id, '-103.5');
    expect(refunded.financeStatus).toBe('partial');
    await expect(
      corrections.correct(
        row.id,
        { expectedUpdatedAt: refunded.updatedAt.toISOString(), reason: '退款后禁止更正' },
        operator
      )
    ).rejects.toThrow('未发生退款');
    const part = await finance.refund(
      row.id,
      {
        expectedUpdatedAt: refunded.updatedAt.toISOString(),
        reason: '第一笔费用回款',
        refundReference: randomUUID(),
        upstreamRefundReference: randomUUID(),
        customerRefundAmount: '0',
        usdtFeeRecoveryAmount: '0.2',
        shoppingFeeRecoveryAmount: '1'
      },
      operator
    );
    await assertBankProfit(row.id, '-101.3');
    await expect(
      finance.refund(
        row.id,
        {
          expectedUpdatedAt: part.updatedAt.toISOString(),
          reason: '超额',
          refundReference: randomUUID(),
          customerRefundAmount: '0',
          usdtFeeRecoveryAmount: '0.31',
          upstreamRefundReference: randomUUID()
        },
        operator
      )
    ).rejects.toThrow('超过');
    const last = await finance.refund(
      row.id,
      {
        expectedUpdatedAt: part.updatedAt.toISOString(),
        reason: '剩余实际回款',
        refundReference: randomUUID(),
        upstreamRefundReference: randomUUID(),
        customerRefundAmount: '0',
        chargeRecoveryAmountCny: '100',
        usdtFeeRecoveryAmount: '0.3',
        shoppingFeeRecoveryAmount: '2'
      },
      operator
    );
    // Full quantity recovery retains the realized gain; incoming 0.5 USDT is acquired at rate 6.
    await assertBankProfit(row.id, '2.5');
    const recoveredCash = await prisma.idBusinessV2FinanceAccount.findUniqueOrThrow({
      where: { id: currencies.get('USDT') }
    });
    expect([
      recoveredCash.currentBalance.toString(),
      recoveredCash.currentBalanceCny.toString()
    ]).toEqual(['10000', '10002.5']);
    expect(last.financeStatus).toBe('reversed');
  });
  it('同账户费用资金不足时订单、余额、状态和审计均回滚', async () => {
    const cash = await accounts.create(
      {
        name: '双费用不足验收',
        currency: 'CNY',
        accountType: 'bank',
        openingBalance: '50',
        idempotencyKey: randomUUID()
      },
      operator
    );
    let row = await subscription();
    row = await orders.update(
      row.id,
      {
        expectedUpdatedAt: row.updatedAt.toISOString(),
        fundingFinanceAccountId: cash.id,
        receivedFinanceAccountId: currencies.get('CNY'),
        usdtFeeAmount: '30',
        usdtFeeCurrencyCode: 'CNY',
        usdtFeeFinanceAccountId: cash.id,
        shoppingFeeAmount: '25',
        shoppingFeeCurrencyCode: 'CNY',
        shoppingFeeFinanceAccountId: cash.id
      },
      operator
    );
    await expect(
      finance.complete(row.id, { expectedUpdatedAt: row.updatedAt.toISOString() }, operator)
    ).rejects.toThrow('余额不足');
    expect(await balance(cash.id)).toBe('50');
    expect(
      (await prisma.idBusinessV2BankRechargeOrder.findUniqueOrThrow({ where: { id: row.id } }))
        .status
    ).toBe('pending_details');
    expect(await prisma.idBusinessV2FinanceJournal.count({ where: { sourceId: row.id } })).toBe(0);
  });
  it('旧口径转换必须明确核对两费；待入账转换和已完成冲销重记均保留原费用', async () => {
    await prisma.idBusinessV2BankRechargeCurrency.upsert({
      where: { code: 'CNY' },
      update: {},
      create: { code: 'CNY', name: '人民币', minorUnits: 2 }
    });
    for (const completed of [false, true]) {
      const created = await subscription();
      let row = await prisma.idBusinessV2BankRechargeOrder.update({
        where: { id: created.id },
        data: {
          accountingVersion: 'legacy',
          customerFeeAmount: '5',
          customerFeeOverridden: true,
          bankFeeAmount: '3',
          bankFeeCurrencyCode: 'CNY',
          bankFeeFxRateToCny: '1'
        }
      });
      if (completed)
        row = await finance.complete(
          row.id,
          {
            expectedUpdatedAt: row.updatedAt.toISOString()
          },
          operator
        );
      const originalJournal = completed
        ? await prisma.idBusinessV2FinanceJournal.findFirst({
            where: { sourceId: row.id, journalType: 'bank_recharge_completed', status: 'posted' }
          })
        : null;
      if (!completed) {
        await expect(
          orders.update(
            row.id,
            {
              expectedUpdatedAt: row.updatedAt.toISOString(),
              usdtFeeAmount: '0',
              shoppingFeeAmount: '2'
            },
            operator
          )
        ).rejects.toThrow('明确确认转换');
        await expect(
          orders.update(
            row.id,
            {
              expectedUpdatedAt: row.updatedAt.toISOString(),
              confirmFeeConversion: true,
              usdtFeeAmount: '0'
            },
            operator
          )
        ).rejects.toThrow('重新核对两项');
      }
      const values = {
        expectedUpdatedAt: row.updatedAt.toISOString(),
        confirmFeeConversion: true,
        usdtFeeAmount: '0',
        shoppingFeeAmount: '2',
        shoppingFeeCurrencyCode: 'CNY',
        shoppingFeeFinanceAccountId: currencies.get('CNY')
      };
      row = completed
        ? await corrections.correct(row.id, { ...values, reason: '重新核对真实两费' }, operator)
        : await orders.update(row.id, values, operator);
      if (!completed)
        row = await finance.complete(
          row.id,
          {
            expectedUpdatedAt: row.updatedAt.toISOString()
          },
          operator
        );
      expect(row.accountingVersion).toBe('subscription_cost_v2');
      expect(row.customerFeeAmount.toString()).toBe('5');
      expect(row.bankFeeAmount?.toString()).toBe('3');
      expect(row.profitAmountCny?.toString()).toBe('48');
      if (originalJournal)
        expect(
          (
            await prisma.idBusinessV2FinanceJournal.findUniqueOrThrow({
              where: { id: originalJournal.id }
            })
          ).status
        ).toBe('reversed');
    }
  });
});

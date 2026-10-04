import { BankRechargeFeesService } from './bank-recharge-fees.service';
import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { PrismaService } from '../../common/prisma/prisma.service';
import { IdBusinessV2FinanceCommandRepository } from '../finance/persistence/id-business-v2-finance-command.repository';
import { IdBusinessV2FinanceReportRepository } from '../finance/persistence/id-business-v2-finance-report.repository';
import { IdBusinessV2FinancePostingService } from '../finance/public-api';
import { IdBusinessV2FinanceReportsService } from '../finance/id-business-v2-finance-reports.service';
import {
  Amount4,
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  toV2JsonDocument
} from '../runtime/public-api';
import { BankRechargeAccountService } from './bank-recharge-account.service';
import { BankRechargeCorrectionService } from './bank-recharge-correction.service';
import { BankRechargeFinanceService } from './bank-recharge-finance.service';
import { BankRechargeOrderService } from './bank-recharge-order.service';
import { BankRechargeQueryRepository } from './persistence/bank-recharge-query.repository';
import { BankRechargeRepository } from './persistence/bank-recharge.repository';
import { bindSavedChatgptAccount, recordVerifiedBankRecharge } from './recharge-bank-callback';
import { safeDocument } from './recharge-validation';

const url = process.env.V2_BANK_RECHARGE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;
const seededCurrencyCodes = [
  'PHP',
  'IDR',
  'CLP',
  'USD',
  'MYR',
  'EUR',
  'GBP',
  'AUD',
  'CAD',
  'JPY',
  'KRW',
  'SGD',
  'INR',
  'THB',
  'VND',
  'TWD',
  'HKD',
  'BRL',
  'MXN',
  'AED',
  'SAR',
  'ZAR',
  'NZD',
  'CHF',
  'SEK',
  'NOK',
  'DKK',
  'PLN',
  'TRY'
];

suite('bank recharge real MySQL lifecycle', () => {
  let prisma: PrismaService;
  let accounts: BankRechargeAccountService;
  let orders: BankRechargeOrderService;
  let finance: BankRechargeFinanceService;
  let queries: BankRechargeQueryRepository;
  const operatorId = randomUUID();
  const operator = {
    id: operatorId,
    username: 'bank-recharge-fixture',
    displayName: '银充隔离验收',
    roles: ['admin'],
    permissions: []
  };

  beforeAll(async () => {
    const parsed = new URL(url!);
    const isolatedDatabase =
      parsed.pathname.includes('bank_recharge_') ||
      /^\/id_business_v2_financial_integrity_\d+$/.test(parsed.pathname);
    if (parsed.hostname !== '127.0.0.1' || !isolatedDatabase) {
      throw new Error('银充集成测试仅允许连接本机隔离库');
    }
    prisma = new PrismaService({ datasourceUrl: url });
    await prisma.$connect();
    await prisma.idBusinessV2BankRechargeCurrency.upsert({
      where: { code: 'CNY' },
      create: { code: 'CNY', name: '人民币', minorUnits: 2, active: true },
      update: {}
    });
    await prisma.user.create({
      data: {
        id: operatorId,
        username: `bank-recharge-${operatorId}`,
        displayName: '银充隔离验收',
        passwordHash: 'test-only-not-valid-password'
      }
    });
    const repository = new BankRechargeRepository(prisma);
    const transactions = new V2CommandTransactionManager(prisma);
    const audit = new V2TransactionalAuditService();
    const encryption = new FieldEncryptionService({
      get: (key: string) =>
        key === 'FIELD_ENCRYPTION_KEY' ? 'isolated-bank-recharge-test-key' : 'isolated-bank-hash'
    } as never);
    accounts = new BankRechargeAccountService(repository, transactions, audit, encryption);
    orders = new BankRechargeOrderService(
      transactions,
      audit,
      accounts,
      repository,
      new BankRechargeFeesService(repository, audit),
      encryption
    );
    finance = new BankRechargeFinanceService(
      repository,
      transactions,
      audit,
      new IdBusinessV2FinancePostingService(new IdBusinessV2FinanceCommandRepository()),
      new BankRechargeFeesService(repository, audit)
    );
    queries = new BankRechargeQueryRepository(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('persists account, manual order, fee, active subscription, prepaid debit and refund', async () => {
    const seededCurrencies = await prisma.idBusinessV2BankRechargeCurrency.findMany({
      where: { code: { in: seededCurrencyCodes } }
    });
    expect(seededCurrencies.map((currency) => currency.code).sort()).toEqual(
      [...seededCurrencyCodes].sort()
    );
    for (const currency of seededCurrencies) {
      expect(currency.name.trim().length).toBeGreaterThan(0);
      expect(currency.active).toBe(true);
      expect(currency.minorUnits).toBe(
        ['CLP', 'JPY', 'KRW', 'VND'].includes(currency.code) ? 0 : 2
      );
    }
    expect(seededCurrencies).toContainEqual(
      expect.objectContaining({ code: 'USD', minorUnits: 2 })
    );
    expect(seededCurrencies).toContainEqual(
      expect.objectContaining({ code: 'CLP', minorUnits: 0 })
    );
    expect(
      await prisma.idBusinessV2BankRechargeCurrency.findUnique({ where: { code: 'CNY' } })
    ).toEqual(expect.objectContaining({ code: 'CNY', minorUnits: 2, active: true }));
    const customer = await prisma.idBusinessV2Customer.create({
      data: { name: '银充集成测试客户', createdByUserId: operatorId }
    });
    const cash = await prisma.idBusinessV2FinanceAccount.create({
      data: {
        name: '银充隔离测试人民币账户',
        accountType: 'bank',
        currency: 'CNY',
        openingBalance: '1000',
        currentBalance: '1000',
        openingBalanceCny: '1000',
        currentBalanceCny: '1000',
        createdByUserId: operatorId
      }
    });
    const saved = await accounts.createAccount(
      {
        email: `bank-fixture-${randomUUID()}@example.invalid`,
        password: ' synthetic bank password ',
        totpSecret: 'JBSWY3DPEHPK3PXP',
        remark: ''
      },
      operator
    );
    const storedAccount = await prisma.idBusinessV2ChatgptAccount.findUniqueOrThrow({
      where: { id: saved.id }
    });
    expect(storedAccount.emailMasked).toBe('ba***@example.invalid');
    expect(storedAccount.passwordEncrypted).not.toContain('synthetic bank password');
    const card = await accounts.createCard(
      { label: '集成测试预存 Visa 卡', last4: '1234', currencyCode: 'PHP' },
      operator
    );
    const openedAt = new Date('2026-10-01T00:00:00Z');
    const dueAt = new Date(openedAt.getTime() + 2 * 24 * 60 * 60 * 1000);
    const created = await orders.createManual(
      {
        plan: 'plus',
        chargeCurrencyCode: 'PHP',
        chargeAmount: '1000.00',
        manualEvidenceRef: `bank-fixture-${randomUUID()}`,
        accountId: saved.id,
        customerId: customer.id
      },
      operator
    );
    await prisma.idBusinessV2BankRechargeOrder.update({
      where: { id: created.id },
      data: { accountingVersion: 'legacy' }
    });
    const legacy = await prisma.idBusinessV2BankRechargeOrder.findUniqueOrThrow({
      where: { id: created.id }
    });
    const updated = await orders.update(
      created.id,
      {
        expectedUpdatedAt: legacy.updatedAt.toISOString(),
        cardId: card.id,
        customerFeeRate: '2.5',
        bankFeeAmount: '3.50',
        bankFeeCurrencyCode: 'PHP',
        receivedAmount: '200.00',
        receivedCurrencyCode: 'CNY',
        chargeFxRateToCny: '0.13',
        fundingFinanceAccountId: cash.id,
        receivedFinanceAccountId: cash.id,
        openedAt: openedAt.toISOString(),
        dueAt: dueAt.toISOString()
      },
      operator
    );
    expect(updated.customerFeeAmount.toString()).toBe('25');
    const listed = await queries.list({ page: 1, pageSize: 20, keyword: created.orderNo });
    expect(listed.items[0]?.activeSubscription?.status).toBe('active');
    const warnings = await queries.renewalWarnings(openedAt);
    expect(warnings.totalCount).toBe(warnings.upcomingCount + warnings.expiredCount);
    expect(warnings.items.filter((item) => item.orderId === created.id)).toEqual([
      expect.objectContaining({ orderId: created.id, warningState: 'upcoming', dueAt })
    ]);
    const paused = await orders.update(
      created.id,
      {
        expectedUpdatedAt: updated.updatedAt.toISOString(),
        openedAt: null,
        dueAt: null
      },
      operator
    );
    expect(
      (await queries.renewalWarnings(openedAt)).items.filter((item) => item.orderId === created.id)
    ).toEqual([]);
    const restored = await orders.update(
      created.id,
      {
        expectedUpdatedAt: paused.updatedAt.toISOString(),
        openedAt: openedAt.toISOString(),
        dueAt: dueAt.toISOString()
      },
      operator
    );
    expect(
      (await queries.renewalWarnings(openedAt)).items.filter((item) => item.orderId === created.id)
    ).toEqual([expect.objectContaining({ orderId: created.id, warningState: 'upcoming', dueAt })]);

    let completed = await finance.complete(
      created.id,
      { expectedUpdatedAt: restored.updatedAt.toISOString() },
      operator
    );
    expect(completed.status).toBe('completed');
    expect(completed.profitAmountCny?.toString()).toBe('69.545');
    const journal = await prisma.idBusinessV2FinanceJournal.findUniqueOrThrow({
      where: { idempotencyKey: `bank_recharge_completed:${created.id}` },
      include: { lines: true }
    });
    expect(
      journal.lines
        .filter(
          (line) =>
            line.accountCode === 'cash' &&
            line.direction === 'credit' &&
            line.financeAccountId === cash.id
        )
        .reduce((total, line) => total.add(line.amountCny), Amount4.zero())
        .toString()
    ).toBe('130.455');
    expect(
      journal.lines
        .filter((line) => line.accountCode === 'bank_recharge_service_fee')[0]
        ?.amountCny.toString()
    ).toBe('3.25');
    const reports = new IdBusinessV2FinanceReportsService(
      new V2CommandTransactionManager(prisma),
      new IdBusinessV2FinanceReportRepository(prisma)
    );
    const profitLoss = await reports.profitLoss({ financeAccountId: cash.id });
    expect(profitLoss.bankRechargeRevenueCny).toBe('196.75');
    expect(profitLoss.bankRechargeServiceFeeCny).toBe('3.25');
    expect(profitLoss.bankRechargeCostCny).toBe('130');
    expect(profitLoss.bankRechargeBankFeeCny).toBe('0.455');
    expect(profitLoss.netProfitCny).toBe('69.545');
    const balanceAfterPayment = await prisma.idBusinessV2FinanceAccount.findUniqueOrThrow({
      where: { id: cash.id }
    });
    expect(balanceAfterPayment.currentBalanceCny.toString()).toBe('1069.545');

    const correctionPosting = new IdBusinessV2FinancePostingService(
      new IdBusinessV2FinanceCommandRepository()
    );
    const corrections = new BankRechargeCorrectionService(
      new BankRechargeRepository(prisma),
      new V2CommandTransactionManager(prisma),
      new V2TransactionalAuditService(),
      correctionPosting,
      orders,
      finance
    );
    const correctedDue = new Date(dueAt.getTime() + 86400000);
    completed = await corrections.correct(
      created.id,
      {
        expectedUpdatedAt: completed.updatedAt.toISOString(),
        reason: '修正到期日期',
        dueAt: correctedDue.toISOString()
      },
      operator
    );
    expect(completed.status).toBe('completed');
    expect(completed.dueAt?.toISOString()).toBe(correctedDue.toISOString());
    expect(
      (
        await prisma.idBusinessV2FinanceAccount.findUniqueOrThrow({ where: { id: cash.id } })
      ).currentBalanceCny.toString()
    ).toBe('1069.545');
    const activeJournal = await new BankRechargeRepository(prisma).findCompletionJournal(
      prisma,
      created.id
    );
    expect(activeJournal?.id).not.toBe(journal.id);
    await expect(
      corrections.correct(
        created.id,
        {
          expectedUpdatedAt: completed.updatedAt.toISOString(),
          reason: '无效收款币种',
          receivedCurrencyCode: 'PHP'
        },
        operator
      )
    ).rejects.toThrow();
    expect(
      (await prisma.idBusinessV2BankRechargeOrder.findUniqueOrThrow({ where: { id: created.id } }))
        .status
    ).toBe('completed');
    expect(
      (await new BankRechargeRepository(prisma).findCompletionJournal(prisma, created.id))?.id
    ).toBe(activeJournal?.id);
    expect(
      (
        await prisma.idBusinessV2FinanceAccount.findUniqueOrThrow({ where: { id: cash.id } })
      ).currentBalanceCny.toString()
    ).toBe('1069.545');

    const partialReference = `partial-refund-${randomUUID()}`;
    const partial = await finance.refund(
      created.id,
      {
        expectedUpdatedAt: completed.updatedAt.toISOString(),
        reason: '客户部分退款',
        refundReference: partialReference,
        customerRefundAmount: '50'
      },
      operator
    );
    expect(partial.status).toBe('completed');
    expect(partial.financeStatus).toBe('partial');
    expect(partial.profitAmountCny?.toString()).toBe('19.545');
    await expect(
      finance.refund(
        created.id,
        {
          expectedUpdatedAt: partial.updatedAt.toISOString(),
          reason: '重复凭据',
          refundReference: partialReference,
          customerRefundAmount: '50'
        },
        operator
      )
    ).rejects.toThrow('凭据已登记');
    const refunded = await finance.refund(
      created.id,
      {
        expectedUpdatedAt: partial.updatedAt.toISOString(),
        reason: '隔离测试真实退款模拟',
        refundReference: `bank-refund-${randomUUID()}`
      },
      operator
    );
    expect(refunded.status).toBe('refunded');
    expect(
      (await queries.renewalWarnings(openedAt)).items.filter((item) => item.orderId === created.id)
    ).toEqual([]);
    const finalBalance = await prisma.idBusinessV2FinanceAccount.findUniqueOrThrow({
      where: { id: cash.id }
    });
    expect(finalBalance.currentBalanceCny.toString()).toBe('869.545');
    expect((await reports.profitLoss({ financeAccountId: cash.id })).netProfitCny).toBe('-130.455');
    await finance.refund(
      created.id,
      {
        expectedUpdatedAt: refunded.updatedAt.toISOString(),
        reason: '上游实际回款',
        refundReference: `upstream-${randomUUID()}`,
        customerRefundAmount: '0',
        chargeRecoveryAmountCny: '130',
        bankFeeRecoveryAmountCny: '0.455',
        upstreamRefundReference: `upstream-proof-${randomUUID()}`
      },
      operator
    );
    expect(
      (
        await prisma.idBusinessV2FinanceAccount.findUniqueOrThrow({ where: { id: cash.id } })
      ).currentBalanceCny.toString()
    ).toBe('1000');
    expect((await reports.profitLoss({ financeAccountId: cash.id })).netProfitCny).toBe('0');

    const newerSubscriptionOrder = await orders.createManual(
      {
        accountId: saved.id,
        plan: 'plus',
        chargeCurrencyCode: 'PHP',
        chargeAmount: '123.45',
        manualEvidenceRef: `current-${randomUUID()}`,
        openedAt: '2026-10-03T00:00:00Z',
        dueAt: '2026-11-01T00:00:00Z'
      },
      operator
    );

    const accountKey = `${randomUUID()}${randomUUID()}`.replace(/-/g, '');
    const job = await prisma.idBusinessV2RechargeJob.create({
      data: {
        id: randomUUID(),
        ownerId: operatorId,
        accountKey,
        chatgptAccountId: saved.id,
        plan: 'plus',
        action: 'bitbrowser',
        state: 'completed',
        result: {},
        leaseUntil: new Date()
      }
    });
    const verifiedResult = {
      status: 'subscription_activated',
      payment_status: 'paid',
      payment_outcome: 'subscription_activated',
      account_matched: true,
      quote_authority: 'official_checkout_response',
      payment_requests_sent: 1,
      checkout_identifier: `cs_fixture_${randomUUID().replace(/-/g, '')}`,
      payment_evidence: {
        kind: 'payment_intent',
        identifier: `pi_fixture${randomUUID().replace(/-/g, '')}`,
        amount_minor: 12345,
        currency: 'PHP'
      },
      quote: {
        plan: 'plus',
        today: { amount: '123.45', amount_minor: 12345, currency: 'PHP' },
        tax: { amount: '0.00', amount_minor: 0, currency: 'PHP' },
        tax_status: 'displayed',
        renewal: { amount: '123.45', amount_minor: 12345, currency: 'PHP' },
        renewal_interval: 'monthly'
      },
      card_last4: '1234'
    };
    const sanitizedResult = safeDocument(verifiedResult);
    expect(sanitizedResult.payment_evidence).toEqual(verifiedResult.payment_evidence);
    const automatic = await prisma.$transaction(async (tx) => {
      await bindSavedChatgptAccount(tx, job, sanitizedResult, accounts);
      await recordVerifiedBankRecharge(tx, job, sanitizedResult, orders);
      return tx.idBusinessV2BankRechargeOrder.findUniqueOrThrow({
        where: { rechargeJobId: job.id }
      });
    });
    expect(automatic.source).toBe('automatic');
    expect(automatic.accountId).toBe(saved.id);
    expect(automatic.checkoutIdentifier).toBe(verifiedResult.checkout_identifier);
    expect(automatic.paymentEvidenceId).toBe(verifiedResult.payment_evidence.identifier);
    expect(
      (await prisma.idBusinessV2ChatgptAccount.findUniqueOrThrow({ where: { id: saved.id } }))
        .officialAccountKey
    ).toBe(accountKey);
    expect(automatic.chargeAmount.toString()).toBe('123.45');
    await prisma.$transaction(async (tx) => {
      await bindSavedChatgptAccount(tx, job, sanitizedResult, accounts);
      await recordVerifiedBankRecharge(tx, job, sanitizedResult, orders);
    });
    expect(
      await prisma.idBusinessV2BankRechargeOrder.count({ where: { rechargeJobId: job.id } })
    ).toBe(1);
    const active = await prisma.idBusinessV2BankRechargeSubscription.findUniqueOrThrow({
      where: { accountId: saved.id }
    });
    expect(automatic.openedAt).toBeNull();
    expect(automatic.dueAt).toBeNull();
    expect(automatic.renewedFromOrderId).toBeNull();
    expect(active.currentOrderId).toBe(newerSubscriptionOrder.id);
    expect(active.status).toBe('active');

    const sourceResult = {
      ...sanitizedResult,
      checkout_identifier: `cs_recheck_${randomUUID().replace(/-/g, '')}`,
      status: 'subscription_pending',
      payment_outcome: 'subscription_pending',
      payment_evidence: null
    };
    const sourceJob = await prisma.idBusinessV2RechargeJob.create({
      data: {
        id: randomUUID(),
        ownerId: operatorId,
        accountKey,
        chatgptAccountId: saved.id,
        plan: 'plus',
        action: 'bitbrowser',
        state: 'finished',
        leaseUntil: new Date(),
        result: toV2JsonDocument(sourceResult)
      }
    });
    const recheckJob = await prisma.idBusinessV2RechargeJob.create({
      data: {
        id: randomUUID(),
        ownerId: operatorId,
        accountKey,
        chatgptAccountId: saved.id,
        plan: 'plus',
        action: 'bitbrowser',
        state: 'finished',
        leaseUntil: new Date(),
        result: { recheck_only: true, source_job_id: sourceJob.id }
      }
    });
    const recheckResult = safeDocument({
      ...verifiedResult,
      recheck_only: true,
      payment_requests_sent: 0,
      checkout_identifier: sourceResult.checkout_identifier,
      payment_evidence: {
        ...verifiedResult.payment_evidence,
        identifier: `pi_recheck${randomUUID().replace(/-/g, '')}`
      }
    });
    for (let replay = 0; replay < 2; replay += 1) {
      await prisma.$transaction(async (tx) =>
        recordVerifiedBankRecharge(tx, recheckJob, recheckResult, orders)
      );
    }
    expect(
      await prisma.idBusinessV2BankRechargeOrder.count({ where: { rechargeJobId: sourceJob.id } })
    ).toBe(1);
    expect(
      await prisma.idBusinessV2BankRechargeOrder.count({ where: { rechargeJobId: recheckJob.id } })
    ).toBe(0);
    const recoveredOrder = await prisma.idBusinessV2BankRechargeOrder.findUniqueOrThrow({
      where: { rechargeJobId: sourceJob.id }
    });
    expect(recoveredOrder.accountId).toBe(saved.id);
    expect(recoveredOrder.checkoutIdentifier).toBe(sourceResult.checkout_identifier);
    expect(recoveredOrder.paymentEvidenceId).toBe(
      (recheckResult.payment_evidence as { identifier: string }).identifier
    );
    expect(
      (
        await prisma.idBusinessV2BankRechargeSubscription.findUniqueOrThrow({
          where: { accountId: saved.id }
        })
      ).currentOrderId
    ).toBe(newerSubscriptionOrder.id);
    expect(recoveredOrder.openedAt).toBeNull();
    expect(recoveredOrder.dueAt).toBeNull();
    expect(recoveredOrder.renewedFromOrderId).toBeNull();
    const retainedSubscription =
      await prisma.idBusinessV2BankRechargeSubscription.findUniqueOrThrow({
        where: { accountId: saved.id }
      });
    expect(retainedSubscription.openedAt.toISOString()).toBe('2026-10-03T00:00:00.000Z');
    expect(retainedSubscription.dueAt?.toISOString()).toBe('2026-11-01T00:00:00.000Z');

    const audits = await prisma.auditLog.findMany({ where: { userId: operatorId } });
    expect(audits.length).toBeGreaterThanOrEqual(6);
    expect(JSON.stringify(audits)).not.toContain('synthetic bank password');
    expect(JSON.stringify(audits)).not.toContain('JBSWY3DPEHPK3PXP');
  });
});

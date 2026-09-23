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
  V2TransactionalAuditService
} from '../runtime/public-api';
import { BankRechargeAccountService } from './bank-recharge-account.service';
import { BankRechargeFinanceService } from './bank-recharge-finance.service';
import { BankRechargeOrderService } from './bank-recharge-order.service';
import { BankRechargeQueryRepository } from './persistence/bank-recharge-query.repository';
import { BankRechargeRepository } from './persistence/bank-recharge.repository';
import { bindSavedChatgptAccount, recordVerifiedBankRecharge } from './recharge-bank-callback';
import { safeDocument } from './recharge-validation';

const url = process.env.V2_BANK_RECHARGE_TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

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
    if (parsed.hostname !== '127.0.0.1' || !parsed.pathname.includes('bank_recharge_')) {
      throw new Error('银充集成测试仅允许连接本机隔离库');
    }
    prisma = new PrismaService({ datasourceUrl: url });
    await prisma.$connect();
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
    orders = new BankRechargeOrderService(transactions, audit, accounts, repository);
    finance = new BankRechargeFinanceService(
      repository,
      transactions,
      audit,
      new IdBusinessV2FinancePostingService(new IdBusinessV2FinanceCommandRepository())
    );
    queries = new BankRechargeQueryRepository(prisma);
  });

  afterAll(async () => {
    await prisma?.$disconnect();
  });

  it('persists account, manual order, fee, active subscription, prepaid debit and refund', async () => {
    const seededCurrencies = await prisma.idBusinessV2BankRechargeCurrency.findMany();
    expect(seededCurrencies).toHaveLength(29);
    expect(seededCurrencies).toContainEqual(
      expect.objectContaining({ code: 'USD', minorUnits: 2 })
    );
    expect(seededCurrencies).toContainEqual(
      expect.objectContaining({ code: 'CLP', minorUnits: 0 })
    );
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
        email: 'bank-fixture@example.invalid',
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
    const openedAt = new Date();
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
    const updated = await orders.update(
      created.id,
      {
        expectedUpdatedAt: created.updatedAt.toISOString(),
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
    expect(warnings.totalCount).toBe(1);
    expect(warnings.items[0]?.orderId).toBe(created.id);
    const paused = await orders.update(
      created.id,
      {
        expectedUpdatedAt: updated.updatedAt.toISOString(),
        openedAt: null,
        dueAt: null
      },
      operator
    );
    expect((await queries.renewalWarnings(openedAt)).totalCount).toBe(0);
    const restored = await orders.update(
      created.id,
      {
        expectedUpdatedAt: paused.updatedAt.toISOString(),
        openedAt: openedAt.toISOString(),
        dueAt: dueAt.toISOString()
      },
      operator
    );
    expect((await queries.renewalWarnings(openedAt)).totalCount).toBe(1);

    const completed = await finance.complete(
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
    const profitLoss = await reports.profitLoss({});
    expect(profitLoss.bankRechargeRevenueCny).toBe('196.75');
    expect(profitLoss.bankRechargeServiceFeeCny).toBe('3.25');
    expect(profitLoss.bankRechargeCostCny).toBe('130');
    expect(profitLoss.bankRechargeBankFeeCny).toBe('0.455');
    expect(profitLoss.netProfitCny).toBe('69.545');
    const balanceAfterPayment = await prisma.idBusinessV2FinanceAccount.findUniqueOrThrow({
      where: { id: cash.id }
    });
    expect(balanceAfterPayment.currentBalanceCny.toString()).toBe('1069.545');

    const refunded = await finance.refund(
      created.id,
      {
        expectedUpdatedAt: completed.updatedAt.toISOString(),
        reason: '隔离测试真实退款模拟',
        refundReference: `bank-refund-${randomUUID()}`
      },
      operator
    );
    expect(refunded.status).toBe('refunded');
    expect((await queries.renewalWarnings(openedAt)).totalCount).toBe(0);
    const finalBalance = await prisma.idBusinessV2FinanceAccount.findUniqueOrThrow({
      where: { id: cash.id }
    });
    expect(finalBalance.currentBalanceCny.toString()).toBe('1000');
    expect((await reports.profitLoss({})).netProfitCny).toBe('0');

    const accountKey = 'a'.repeat(64);
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
      checkout_identifier: `cs_fixture_${randomUUID()}`,
      payment_evidence: {
        kind: 'payment_intent',
        identifier: `pi_fixture_${randomUUID().replace(/-/g, '')}`,
        amount_minor: 12345,
        currency: 'PHP'
      },
      quote: { today: { amount: '123.45', amount_minor: 12345, currency: 'PHP' } },
      card_last4: '1234'
    };
    const sanitizedResult = safeDocument(verifiedResult);
    const automatic = await prisma.$transaction(async (tx) => {
      await bindSavedChatgptAccount(tx, job, sanitizedResult, accounts);
      await recordVerifiedBankRecharge(tx, job, sanitizedResult, orders);
      return tx.idBusinessV2BankRechargeOrder.findUniqueOrThrow({
        where: { rechargeJobId: job.id }
      });
    });
    expect(automatic.source).toBe('automatic');
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
    expect(active.currentOrderId).toBe(automatic.id);
    expect(active.status).toBe('active');

    const audits = await prisma.auditLog.findMany({ where: { userId: operatorId } });
    expect(audits.length).toBeGreaterThanOrEqual(6);
    expect(JSON.stringify(audits)).not.toContain('synthetic bank password');
    expect(JSON.stringify(audits)).not.toContain('JBSWY3DPEHPK3PXP');
  });
});

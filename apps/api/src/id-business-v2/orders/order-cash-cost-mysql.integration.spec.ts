import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { PrismaService } from '../../common/prisma/prisma.service';
import { IdBusinessV2BalanceCalculatorService } from '../balances/public-api';
import { IdBusinessV2FinancePostingService } from '../finance/public-api';
import { IdBusinessV2FinanceCommandRepository } from '../finance/persistence/id-business-v2-finance-command.repository';
import { V2CommandTransactionManager } from '../runtime/public-api';
import { IdBusinessV2OrderCompletionService } from './id-business-v2-order-completion.service';
import { IdBusinessV2OrderLifecycleService } from './id-business-v2-order-lifecycle.service';
import { IdBusinessV2OrdersRepository } from './persistence/id-business-v2-orders.repository';

const url = process.env.V2_FINANCIAL_INTEGRITY_DATABASE_URL;
const suite = url ? describe : describe.skip;
suite('order cash historical cost real MySQL closure', () => {
  let prisma: PrismaService;
  beforeAll(async () => {
    const target = new URL(url!);
    if (
      target.hostname !== '127.0.0.1' ||
      !/^\/id_business_v2_financial_integrity_\d+$/.test(target.pathname)
    )
      throw new Error('只允许本机隔离财务库');
    prisma = new PrismaService({ datasourceUrl: url });
    await prisma.$connect();
  });
  afterAll(async () => {
    await prisma?.$disconnect();
  });
  it('preserves completion and refund FX in order profit and keeps ordinary edits unchanged', async () => {
    const operator = await prisma.user.create({
      data: {
        username: `order-cash-${randomUUID()}`,
        displayName: '合成财务验收',
        passwordHash: 'synthetic-only'
      }
    });
    const auth = {
      id: operator.id,
      username: operator.username,
      displayName: operator.displayName,
      roles: ['admin'],
      permissions: []
    };
    const customer = await prisma.idBusinessV2Customer.create({ data: { name: '合成订单客户' } });
    const country = await prisma.idBusinessV2Option.create({
      data: {
        type: 'country',
        code: randomUUID(),
        uniqueKey: randomUUID(),
        name: '合成国家',
        currencyCode: 'USD'
      }
    });
    const category = await prisma.idBusinessV2Option.create({
      data: {
        type: 'business_category',
        code: randomUUID(),
        uniqueKey: randomUUID(),
        name: '合成业务分类'
      }
    });
    const service = await prisma.idBusinessV2Option.create({
      data: {
        type: 'service',
        code: randomUUID(),
        uniqueKey: randomUUID(),
        name: '合成订单服务',
        parentId: category.id,
        countryOptionId: country.id
      }
    });
    const status = await prisma.idBusinessV2Option.create({
      data: { type: 'id_status', code: randomUUID(), uniqueKey: randomUUID(), name: '合成可用状态' }
    });
    const account = await prisma.idBusinessV2Account.create({
      data: {
        appleIdEncrypted: 'synthetic-encrypted',
        appleIdHash: randomUUID(),
        appleIdMasked: '合成ID',
        countryOptionId: country.id,
        statusOptionId: status.id
      }
    });
    const cash = await prisma.idBusinessV2FinanceAccount.create({
      data: {
        name: '合成订单USDT资金',
        currency: 'USDT',
        accountType: 'bank',
        openingBalance: '10',
        currentBalance: '10',
        openingBalanceCny: '60',
        currentBalanceCny: '60'
      }
    });
    const now = new Date();
    const rate = await prisma.idBusinessV2FinanceFxRateSnapshot.create({
      data: {
        currency: 'USDT',
        rateToCny: '7',
        source: 'manual',
        businessDate: now,
        manualReason: '合成订单汇率'
      }
    });
    const order = await prisma.idBusinessV2Order.create({
      data: {
        id: randomUUID(),
        orderNo: `CASH-${randomUUID().slice(0, 20)}`,
        customerId: customer.id,
        serviceOptionId: service.id,
        accountId: account.id,
        receivedAmount: '70',
        receivedOriginalAmount: '10',
        receivedCurrency: 'USDT',
        receivedFxRateToCny: '7',
        receivedFxSnapshotId: rate.id,
        receivedFinanceAccountId: cash.id,
        receivedAt: now,
        platformFeeAmount: '14',
        balanceAmount: '1',
        balanceCurrencyCode: 'USD',
        balanceCostAmount: '0',
        appliedBalanceCostAmount: '0',
        profitAmount: '56',
        status: 'processing',
        openedAt: now,
        dueAt: new Date(now.getTime() + 30 * 86400000),
        idempotencyKey: randomUUID()
      }
    });
    await prisma.idBusinessV2BalanceLedger.create({
      data: {
        accountId: account.id,
        orderId: order.id,
        entryType: 'order_consumption',
        direction: 'debit',
        balanceAmount: '1',
        costAmount: '0',
        balanceBefore: '1',
        balanceAfter: '0',
        costBefore: '0',
        costAfter: '0',
        averageCostBefore: '0',
        averageCostAfter: '0',
        idempotencyKey: randomUUID()
      }
    });
    const transactions = new V2CommandTransactionManager(prisma);
    const repository = new IdBusinessV2OrdersRepository(prisma);
    const posting = new IdBusinessV2FinancePostingService(
      new IdBusinessV2FinanceCommandRepository()
    );
    const orderReads = {
      get: (id: string) => prisma.idBusinessV2Order.findUniqueOrThrow({ where: { id } })
    };
    const completion = new IdBusinessV2OrderCompletionService(
      orderReads as never,
      posting,
      repository,
      transactions
    );
    const lifecycle = new IdBusinessV2OrderLifecycleService(
      {} as never,
      new IdBusinessV2BalanceCalculatorService(),
      { releaseOrderLockInTransaction: async () => ({ released: false }) } as never,
      orderReads as never,
      posting,
      transactions,
      repository
    );
    await prisma.idBusinessV2CustomerService.create({
      data: { customerId: customer.id, optionId: service.id, source: 'manual_legacy' }
    });
    await completion.complete(order.id, auth);
    await completion.complete(order.id, auth);
    const completed = await orderReads.get(order.id);
    expect(completed.profitAmount?.toString()).toBe('57');
    const history = await prisma.idBusinessV2CustomerService.findUniqueOrThrow({
      where: { customerId_optionId: { customerId: customer.id, optionId: service.id } }
    });
    expect(history.source).toBe('activation');
    expect(history.activationCount).toBe(1);
    expect(history.firstOpenedAt?.toISOString()).toBe(now.toISOString());
    expect(history.lastOpenedAt?.toISOString()).toBe(now.toISOString());
    expect(
      (
        await prisma.idBusinessV2FinanceAccount.findUniqueOrThrow({ where: { id: cash.id } })
      ).currentBalanceCny.toString()
    ).toBe('117');
    await lifecycle.update(
      order.id,
      { expectedUpdatedAt: completed.updatedAt.toISOString(), remark: '已确认后仅更改备注' },
      auth
    );
    expect((await orderReads.get(order.id)).profitAmount?.toString()).toBe('57');
    const refundDto = {
      refundCostAmount: '0',
      balanceRefundMode: 'none' as const,
      reason: '合成订单退回实收',
      idempotencyKey: randomUUID()
    };
    await lifecycle.refund(order.id, refundDto, auth);
    const refunded = await orderReads.get(order.id);
    expect(refunded.profitAmount?.toString()).toBe('-8');
    const finalCash = await prisma.idBusinessV2FinanceAccount.findUniqueOrThrow({
      where: { id: cash.id }
    });
    expect(finalCash.currentBalance.toString()).toBe('8');
    expect(finalCash.currentBalanceCny.toString()).toBe('52');
    await lifecycle.refund(order.id, refundDto, auth);
    expect(
      await prisma.idBusinessV2FinanceJournal.count({
        where: { sourceType: 'order', sourceId: order.id, journalType: 'order_refund' }
      })
    ).toBe(1);
    expect((await orderReads.get(order.id)).profitAmount?.toString()).toBe('-8');
  });
});

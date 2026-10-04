import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { IdBusinessV2FinanceFxService } from '../finance/public-api';
import { IdBusinessV2FinanceQueryRepository } from '../finance/persistence/id-business-v2-finance-query.repository';
import { IdBusinessV2OrderEntryService } from './id-business-v2-order-entry.service';
import { IdBusinessV2OrderLockService } from './id-business-v2-order-lock.service';
import { IdBusinessV2OrderConsumptionService } from './id-business-v2-order-consumption.service';
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
  it.each([
    {
      currency: 'CNY' as const,
      received: '100',
      fixedFee: '2',
      openingCny: '1000',
      completedProfit: '78',
      completedBalance: '1088',
      refundCost: '3',
      refundedProfit: '-25',
      finalBalance: '985',
      finalCny: '985',
      cashOriginalAmounts: ['100', '100', '12', '3']
    },
    {
      currency: 'USDT' as const,
      received: '0',
      fixedFee: '7',
      openingCny: '7000',
      completedProfit: '-17',
      completedBalance: '999',
      refundCost: '7',
      refundedProfit: '-24',
      finalBalance: '998',
      finalCny: '6986',
      cashOriginalAmounts: ['1', '1']
    }
  ])(
    'creates through the public $currency receipt DTO, freezes posted accounts and refunds the same real account',
    async (sample) => {
      const customer = await prisma.idBusinessV2Customer.create({
        data: { name: '合成收款账户录入客户' }
      });
      const option = (
        type: 'country' | 'business_category' | 'service' | 'id_status' | 'settlement_platform',
        extra: Record<string, unknown> = {}
      ) =>
        prisma.idBusinessV2Option.create({
          data: {
            type,
            code: randomUUID(),
            uniqueKey: randomUUID(),
            name: '合成账户录入选项',
            ...extra
          }
        });
      const country = await option('country', { currencyCode: 'USD' });
      const category = await option('business_category');
      const service = await option('service', {
        parentId: category.id,
        countryOptionId: country.id,
        businessAmount: '10'
      });
      const status =
        (await prisma.idBusinessV2Option.findUnique({
          where: { type_code: { type: 'id_status', code: 'normal' } }
        })) ?? (await option('id_status', { code: 'normal' }));
      const platform = await option('settlement_platform', {
        fixedFee: sample.fixedFee,
        percentageFee: '10'
      });
      const id = await prisma.idBusinessV2Account.create({
        data: {
          appleIdEncrypted: 'synthetic-encrypted',
          appleIdHash: randomUUID(),
          appleIdMasked: '合成收款验收ID',
          countryOptionId: country.id,
          statusOptionId: status.id,
          currentBalance: '100',
          balanceCostAmount: '100'
        }
      });
      const cash = await prisma.idBusinessV2FinanceAccount.create({
        data: {
          name: '合成普通录入真实账户',
          currency: sample.currency,
          accountType: 'bank',
          openingBalance: '1000',
          currentBalance: '1000',
          openingBalanceCny: sample.openingCny,
          currentBalanceCny: sample.openingCny
        }
      });
      const otherCash = await prisma.idBusinessV2FinanceAccount.create({
        data: {
          name: '合成不同收款账户',
          currency: sample.currency,
          accountType: 'bank'
        }
      });
      const crossCash = await prisma.idBusinessV2FinanceAccount.create({
        data: {
          name: '合成跨币账户',
          currency: sample.currency === 'CNY' ? 'USDT' : 'CNY',
          accountType: 'usdt_wallet'
        }
      });
      const disabledCash = await prisma.idBusinessV2FinanceAccount.create({
        data: {
          name: '合成停用账户',
          currency: sample.currency,
          accountType: 'bank',
          status: 'disabled'
        }
      });
      const transactions = new V2CommandTransactionManager(prisma);
      const repository = new IdBusinessV2OrdersRepository(prisma);
      const command = new IdBusinessV2FinanceCommandRepository();
      const posting = new IdBusinessV2FinancePostingService(command);
      const encryption = new FieldEncryptionService({ get: () => undefined } as never);
      const reads = {
        get: (orderId: string) =>
          prisma.idBusinessV2Order.findUniqueOrThrow({ where: { id: orderId } })
      };
      const locks = new IdBusinessV2OrderLockService(repository, transactions);
      const entry = new IdBusinessV2OrderEntryService(
        repository,
        encryption,
        reads as never,
        locks,
        new IdBusinessV2FinanceFxService(
          transactions,
          command,
          new IdBusinessV2FinanceQueryRepository(prisma),
          {} as never,
          {} as never
        ),
        transactions,
        {} as never
      );
      const consumption = new IdBusinessV2OrderConsumptionService(
        locks,
        new IdBusinessV2BalanceCalculatorService(),
        reads as never,
        repository,
        transactions
      );
      const completion = new IdBusinessV2OrderCompletionService(
        reads as never,
        posting,
        repository,
        transactions
      );
      const lifecycle = new IdBusinessV2OrderLifecycleService(
        encryption,
        new IdBusinessV2BalanceCalculatorService(),
        locks,
        reads as never,
        posting,
        transactions,
        repository
      );
      const now = new Date();
      const rate =
        sample.currency === 'CNY'
          ? null
          : await prisma.idBusinessV2FinanceFxRateSnapshot.create({
              data: {
                currency: 'USDT',
                rateToCny: '7',
                source: 'manual',
                businessDate: now,
                manualReason: '合成零实收手续费汇率'
              }
            });
      const dto = {
        customerId: customer.id,
        serviceOptionId: service.id,
        accountId: id.id,
        settlementPlatformOptionId: platform.id,
        receivedFinanceAccountId: cash.id,
        receivedAmount: sample.received,
        receivedOriginalAmount: sample.received,
        receivedCurrency: sample.currency,
        receivedFxSnapshotId: rate?.id,
        balanceAmount: '10',
        openedAt: now.toISOString(),
        dueAt: new Date(now.getTime() + 30 * 86400000).toISOString(),
        accountDisposition: 'retained',
        idempotencyKey: randomUUID()
      };
      const beforeOrders = await prisma.idBusinessV2Order.count();
      for (const receivedFinanceAccountId of [null, randomUUID(), crossCash.id, disabledCash.id]) {
        await expect(entry.create({ ...dto, receivedFinanceAccountId })).rejects.toThrow(
          /收款账户/
        );
      }
      expect(await prisma.idBusinessV2Order.count()).toBe(beforeOrders);
      expect(await prisma.idBusinessV2AccountLock.count({ where: { accountId: id.id } })).toBe(0);
      const created = await entry.create(dto);
      const orderId = created.order.id;
      expect((await reads.get(orderId)).receivedFinanceAccountId).toBe(cash.id);
      expect((await entry.create(dto)).idempotentReplay).toBe(true);
      await expect(
        entry.create({ ...dto, receivedFinanceAccountId: otherCash.id })
      ).rejects.toThrow('幂等键');
      expect(await prisma.idBusinessV2Order.count()).toBe(beforeOrders + 1);
      await consumption.consume(orderId, { idempotencyKey: randomUUID() });
      // An ordinary confirmed/processing order can repair an explicitly chosen account before posting.
      const confirmed = await reads.get(orderId);
      await lifecycle.update(orderId, {
        expectedUpdatedAt: confirmed.updatedAt.toISOString(),
        receivedFinanceAccountId: otherCash.id
      });
      const repaired = await reads.get(orderId);
      await expect(
        lifecycle.update(orderId, {
          expectedUpdatedAt: confirmed.updatedAt.toISOString(),
          receivedFinanceAccountId: cash.id
        })
      ).rejects.toThrow('已被其他操作修改');
      await lifecycle.update(orderId, {
        expectedUpdatedAt: repaired.updatedAt.toISOString(),
        receivedFinanceAccountId: cash.id
      });
      await prisma.idBusinessV2FinanceAccount.update({
        where: { id: cash.id },
        data: { status: 'disabled' }
      });
      await expect(completion.complete(orderId)).rejects.toThrow('已停用');
      expect(await prisma.idBusinessV2Activation.count({ where: { orderId } })).toBe(0);
      expect((await reads.get(orderId)).status).toBe('processing');
      await prisma.idBusinessV2FinanceAccount.update({
        where: { id: cash.id },
        data: { status: 'active', currency: sample.currency === 'CNY' ? 'USDT' : 'CNY' }
      });
      await expect(completion.complete(orderId)).rejects.toThrow('币种');
      expect(
        await prisma.idBusinessV2FinanceJournal.count({
          where: { sourceType: 'order', sourceId: orderId }
        })
      ).toBe(0);
      await prisma.idBusinessV2FinanceAccount.update({
        where: { id: cash.id },
        data: { currency: sample.currency }
      });
      await completion.complete(orderId);
      const completed = await reads.get(orderId);
      expect(completed.profitAmount?.toString()).toBe(sample.completedProfit);
      expect(
        (
          await prisma.idBusinessV2FinanceAccount.findUniqueOrThrow({ where: { id: cash.id } })
        ).currentBalance.toString()
      ).toBe(sample.completedBalance);
      await expect(
        lifecycle.update(orderId, {
          expectedUpdatedAt: completed.updatedAt.toISOString(),
          receivedFinanceAccountId: otherCash.id
        })
      ).rejects.toThrow('已有财务凭证');
      await lifecycle.update(orderId, {
        expectedUpdatedAt: completed.updatedAt.toISOString(),
        remark: '仅编辑非财务备注'
      });
      expect((await reads.get(orderId)).receivedFinanceAccountId).toBe(cash.id);
      const refundDto = {
        refundCostAmount: sample.refundCost,
        balanceRefundMode: 'none' as const,
        reason: '合成验收退款',
        idempotencyKey: randomUUID()
      };
      await lifecycle.refund(orderId, refundDto);
      await lifecycle.refund(orderId, refundDto);
      expect((await reads.get(orderId)).profitAmount?.toString()).toBe(sample.refundedProfit);
      const finalCash = await prisma.idBusinessV2FinanceAccount.findUniqueOrThrow({
        where: { id: cash.id }
      });
      expect(finalCash.currentBalance.toString()).toBe(sample.finalBalance);
      expect(finalCash.currentBalanceCny.toString()).toBe(sample.finalCny);
      const cashLines = await prisma.idBusinessV2FinanceJournalLine.findMany({
        where: {
          accountCode: 'cash',
          journal: { sourceType: 'order', sourceId: orderId }
        },
        orderBy: [{ journalId: 'asc' }, { lineNo: 'asc' }]
      });
      expect(cashLines).toHaveLength(sample.cashOriginalAmounts.length);
      expect(cashLines.every((line) => line.currency === sample.currency)).toBe(true);
      expect(cashLines.every((line) => line.financeAccountId === cash.id)).toBe(true);
      expect(cashLines.map((line) => line.amountOriginal.toString()).sort()).toEqual(
        sample.cashOriginalAmounts.sort()
      );
    }
  );
});

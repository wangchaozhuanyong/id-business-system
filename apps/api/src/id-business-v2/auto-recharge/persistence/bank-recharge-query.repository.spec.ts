import { describe, expect, it, vi } from 'vitest';
import { BankRechargeQueryRepository } from './bank-recharge-query.repository';

const now = new Date('2026-09-23T12:00:00.000Z');

function subscription(dueAt: string) {
  return {
    id: dueAt,
    dueAt: new Date(dueAt),
    plan: 'plus',
    account: { emailMasked: 'te***@example.com' },
    customer: { name: '测试客户' },
    currentOrder: { id: 'order-1', orderNo: 'BC123' }
  };
}

describe('BankRechargeQueryRepository renewal warnings', () => {
  it('比特来源筛选保持列表和总数一致，缺省保留旧全来源查询', async () => {
    const orders = {
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0)
    };
    const repository = new BankRechargeQueryRepository({
      idBusinessV2BankRechargeOrder: orders
    } as never);
    await repository.list({ executionSource: 'bitbrowser', page: 2, pageSize: 20 });
    const where = orders.findMany.mock.calls[0][0].where;
    expect(where).toEqual({
      deletedAt: null,
      source: 'automatic',
      rechargeJob: { is: { action: 'bitbrowser' } }
    });
    expect(orders.count).toHaveBeenCalledWith({ where });
    expect(orders.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 20, take: 20 }));

    await repository.list({});
    expect(orders.findMany.mock.calls[1][0].where).toEqual({ deletedAt: null });
    expect(orders.count.mock.calls[1][0].where).toEqual({ deletedAt: null });
  });

  it.each(['server', 'manual', 'all', '', null, ['bitbrowser'], { action: 'bitbrowser' }])(
    '拒绝无效执行来源 %j，不能静默扩大来源范围',
    async (executionSource) => {
      const orders = { findMany: vi.fn(), count: vi.fn() };
      const repository = new BankRechargeQueryRepository({
        idBusinessV2BankRechargeOrder: orders
      } as never);
      await expect(repository.list({ executionSource })).rejects.toThrow('执行来源筛选无效');
      expect(orders.findMany).not.toHaveBeenCalled();
      expect(orders.count).not.toHaveBeenCalled();
    }
  );

  it('仅返回自动订单已核实出口国家，不泄露任务结果或按菲律宾币猜国家', async () => {
    const result = {
      account_matched: true,
      network: { country: 'PH', ip: '203.0.113.1' },
      quote: { today: { amount: '699.75', currency: 'PHP' } },
      unrelated_internal_data: 'synthetic-private-metadata'
    };
    const orders = {
      findMany: vi.fn().mockResolvedValue([
        {
          id: 'verified',
          source: 'automatic',
          chargeAmount: '699.75',
          chargeCurrencyCode: 'PHP',
          rechargeJob: { result }
        },
        {
          id: 'missing-network',
          source: 'automatic',
          chargeCurrencyCode: 'PHP',
          rechargeJob: null
        },
        { id: 'manual', source: 'manual', rechargeJob: { result } },
        {
          id: 'unverified-account',
          source: 'automatic',
          rechargeJob: { result: { ...result, account_matched: false } }
        },
        {
          id: 'invalid-country',
          source: 'automatic',
          rechargeJob: { result: { ...result, network: { country: 'php' } } }
        },
        { id: 'legacy-json', source: 'automatic', rechargeJob: { result: [] } }
      ]),
      count: vi.fn().mockResolvedValue(6)
    };
    const response = await new BankRechargeQueryRepository({
      idBusinessV2BankRechargeOrder: orders
    } as never).list({});
    expect(response.items).toEqual([
      {
        id: 'verified',
        source: 'automatic',
        chargeAmount: '699.75',
        chargeCurrencyCode: 'PHP',
        chargeCountryCode: 'PH'
      },
      {
        id: 'missing-network',
        source: 'automatic',
        chargeCurrencyCode: 'PHP',
        chargeCountryCode: null
      },
      { id: 'manual', source: 'manual', chargeCountryCode: null },
      { id: 'unverified-account', source: 'automatic', chargeCountryCode: null },
      { id: 'invalid-country', source: 'automatic', chargeCountryCode: null },
      { id: 'legacy-json', source: 'automatic', chargeCountryCode: null }
    ]);
    expect(JSON.stringify(response)).not.toContain('synthetic-private-metadata');
    expect(JSON.stringify(response)).not.toContain('203.0.113.1');
    expect(response.items.every((item) => !('rechargeJob' in item))).toBe(true);
  });

  it('已到期筛选使用服务器时间且列表、总数及分页应用同一条件', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    try {
      const orders = {
        findMany: vi.fn().mockResolvedValue([{ id: 'expired-order' }]),
        count: vi.fn().mockResolvedValue(21)
      };
      const result = await new BankRechargeQueryRepository({
        idBusinessV2BankRechargeOrder: orders
      } as never).list({ expiry: 'expired', page: 2, pageSize: 20, keyword: 'BC' });
      const where = orders.findMany.mock.calls[0][0].where;
      expect(where.dueAt).toEqual({ lte: now });
      expect(orders.count).toHaveBeenCalledWith({ where });
      expect(orders.findMany).toHaveBeenCalledWith(expect.objectContaining({ skip: 20, take: 20 }));
      expect(result).toMatchObject({
        total: 21,
        page: 2,
        pageSize: 20,
        items: [{ id: 'expired-order', chargeCountryCode: null }]
      });
      expect(result.revalidateAt).toEqual(new Date(now.getTime() + 60_000));
      await expect(
        new BankRechargeQueryRepository({} as never).list({ expiry: 'unexpected' })
      ).rejects.toThrow('到期筛选无效');
    } finally {
      vi.useRealTimers();
    }
  });

  it.each(['ZZ', 'XA', 'XB', 'QQ', 'PH ', 'ph', '', null, 123])(
    '占位、未知或无效国家 %j 返回待核验，不使列表失败或返回原始任务',
    async (country) => {
      const orders = {
        findMany: vi.fn().mockResolvedValue([
          {
            id: 'invalid-country',
            source: 'automatic',
            rechargeJob: {
              result: {
                account_matched: true,
                network: { country },
                unrelated_internal_data: 'fixture-private-country-report'
              }
            }
          }
        ]),
        count: vi.fn().mockResolvedValue(1)
      };
      const response = await new BankRechargeQueryRepository({
        idBusinessV2BankRechargeOrder: orders
      } as never).list({ executionSource: 'bitbrowser' });
      expect(response.items).toEqual([
        { id: 'invalid-country', source: 'automatic', chargeCountryCode: null }
      ]);
      expect(response.total).toBe(1);
      expect(JSON.stringify(response)).not.toContain('fixture-private-country-report');
    }
  );
  it('includes reviewed expired subscriptions and excludes cancelled or deleted projections', async () => {
    const prisma = {
      idBusinessV2RenewalWarningSetting: {
        findUnique: vi.fn().mockResolvedValue({ warningDays: 5 })
      },
      idBusinessV2BankRechargeSubscription: {
        count: vi.fn().mockResolvedValueOnce(1).mockResolvedValueOnce(1),
        findMany: vi
          .fn()
          .mockResolvedValue([
            subscription('2026-09-22T12:00:00.000Z'),
            subscription('2026-09-27T12:00:00.000Z')
          ]),
        findFirst: vi
          .fn()
          .mockResolvedValueOnce({ dueAt: new Date('2026-09-27T12:00:00.000Z') })
          .mockResolvedValueOnce(null)
      }
    };
    const result = await new BankRechargeQueryRepository(prisma as never).renewalWarnings(now);

    expect(prisma.idBusinessV2RenewalWarningSetting.findUnique).toHaveBeenCalledWith({
      where: { scope: 'global' }
    });
    expect(prisma.idBusinessV2BankRechargeSubscription.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          account: { deletedAt: null },
          currentOrder: { deletedAt: null },
          OR: [
            { status: 'active', dueAt: { gt: now, lte: new Date('2026-09-28T12:00:00.000Z') } },
            { status: { in: ['active', 'expired'] }, dueAt: { lte: now } }
          ]
        }
      })
    );
    expect(prisma.idBusinessV2BankRechargeSubscription.count.mock.calls).toEqual([
      [
        {
          where: {
            account: { deletedAt: null },
            currentOrder: { deletedAt: null },
            status: 'active',
            dueAt: { gt: now, lte: new Date('2026-09-28T12:00:00.000Z') }
          }
        }
      ],
      [
        {
          where: {
            account: { deletedAt: null },
            currentOrder: { deletedAt: null },
            status: { in: ['active', 'expired'] },
            dueAt: { lte: now }
          }
        }
      ]
    ]);
    for (const call of prisma.idBusinessV2BankRechargeSubscription.findFirst.mock.calls) {
      expect(call[0]).toMatchObject({
        where: { account: { deletedAt: null }, currentOrder: { deletedAt: null } }
      });
    }
    expect(result).toMatchObject({
      warningDays: 5,
      upcomingCount: 1,
      expiredCount: 1,
      totalCount: 2,
      revalidateAt: new Date('2026-09-23T13:00:00.000Z'),
      items: [
        { accountMasked: 'te***@example.com', warningState: 'expired' },
        { accountMasked: 'te***@example.com', warningState: 'upcoming' }
      ]
    });
  });

  it('refreshes at an imminent expiry or when the next subscription enters the warning window', async () => {
    const subscriptions = {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
      findFirst: vi
        .fn()
        .mockResolvedValueOnce({ dueAt: new Date('2026-09-23T12:10:00.000Z') })
        .mockResolvedValueOnce({ dueAt: new Date('2026-09-26T12:05:00.000Z') })
    };
    const prisma = {
      idBusinessV2RenewalWarningSetting: { findUnique: vi.fn().mockResolvedValue(null) },
      idBusinessV2BankRechargeSubscription: subscriptions
    };
    const result = await new BankRechargeQueryRepository(prisma as never).renewalWarnings(now);
    expect(result.revalidateAt).toEqual(new Date('2026-09-23T12:05:00.000Z'));
  });
});

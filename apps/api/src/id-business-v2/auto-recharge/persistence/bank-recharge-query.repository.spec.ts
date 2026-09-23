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
  it('uses the existing global warning days and returns active due subscriptions only', async () => {
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
          status: 'active',
          dueAt: { not: null, lte: new Date('2026-09-28T12:00:00.000Z') }
        }
      })
    );
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

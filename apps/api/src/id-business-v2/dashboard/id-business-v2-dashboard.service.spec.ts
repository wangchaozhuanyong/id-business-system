import { UnauthorizedException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { describe, expect, it, vi } from 'vitest';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { IdBusinessV2DashboardService } from './id-business-v2-dashboard.service';
import { IdBusinessV2DashboardRepository } from './persistence/id-business-v2-dashboard.repository';

function createPrismaMock() {
  return {
    idBusinessV2RenewalWarningSetting: { findUnique: vi.fn() },
    idBusinessV2Order: { count: vi.fn(), aggregate: vi.fn(), findMany: vi.fn() },
    idBusinessV2Activation: { count: vi.fn(), findMany: vi.fn() },
    idBusinessV2GiftCard: { aggregate: vi.fn() },
    idBusinessV2Account: { count: vi.fn(), aggregate: vi.fn() },
    idBusinessV2ExchangeRateRun: { count: vi.fn() },
    idBusinessV2FinanceSettings: { findUnique: vi.fn() },
    auditLog: { findMany: vi.fn() }
  };
}

function user(permissions: string[] = []): AuthenticatedUser {
  return {
    id: 'user-id',
    username: 'operator',
    displayName: '操作员',
    roles: ['operation'],
    permissions
  };
}

function createService(prisma: ReturnType<typeof createPrismaMock>) {
  return new IdBusinessV2DashboardService(
    new IdBusinessV2DashboardRepository(prisma as never),
    { decrypt: vi.fn() } as never,
    { resolveDisplayMode: vi.fn().mockResolvedValue('masked') } as never
  );
}

describe('IdBusinessV2DashboardService', () => {
  it('requires an authenticated user', async () => {
    const prisma = createPrismaMock();
    const service = createService(prisma);

    await expect(service.overview(undefined)).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('returns unavailable values without querying unauthorized domains', async () => {
    const prisma = createPrismaMock();
    const service = createService(prisma);

    const result = await service.overview(user(), new Date('2026-07-31T16:30:00.000Z'));

    expect(result.businessDate).toBe('2026-08-01');
    expect(result.business.todayOrders).toBeNull();
    expect(result.assets.inventoryBookValueCny).toBeNull();
    expect(result.recentOrders).toEqual([]);
    expect(prisma.idBusinessV2Order.count).not.toHaveBeenCalled();
    expect(prisma.idBusinessV2Account.aggregate).not.toHaveBeenCalled();
    expect(prisma.auditLog.findMany).not.toHaveBeenCalled();
  });

  it('uses the Kuala Lumpur business day and hides finance values from order-only users', async () => {
    const prisma = createPrismaMock();
    prisma.idBusinessV2Order.count
      .mockResolvedValueOnce(4)
      .mockResolvedValueOnce(2)
      .mockResolvedValueOnce(1);
    prisma.idBusinessV2Order.aggregate.mockResolvedValue({
      _count: { _all: 3 },
      _sum: {
        receivedAmount: new Prisma.Decimal('120.5000'),
        profitAmount: new Prisma.Decimal('30.2500')
      }
    });
    prisma.idBusinessV2Order.findMany.mockResolvedValue([
      {
        id: 'order-id',
        orderNo: 'ORD-001',
        status: 'completed',
        receivedAmount: new Prisma.Decimal('120.5000'),
        profitAmount: new Prisma.Decimal('30.2500'),
        createdAt: new Date('2026-07-31T16:20:00.000Z'),
        customer: { name: '客户' },
        serviceOption: { name: '业务' }
      }
    ]);
    const service = createService(prisma);

    const result = await service.overview(
      user(['apple.order.view']),
      new Date('2026-07-31T16:30:00.000Z')
    );

    expect(result.business.todayOrders).toBe(4);
    expect(result.business.todayCompletedOrders).toBe(3);
    expect(result.business.todayRevenueCny).toBeNull();
    expect(result.recentOrders[0]).toMatchObject({
      receivedAmount: '120.5',
      profitAmount: null,
      createdAt: '2026-07-31T16:20:00.000Z'
    });
    expect(prisma.idBusinessV2Order.count).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        where: expect.objectContaining({
          createdAt: {
            gte: new Date('2026-07-31T16:00:00.000Z'),
            lt: new Date('2026-08-01T16:00:00.000Z')
          }
        })
      })
    );
  });

  it('adds only CNY book values for finance-authorized inventory', async () => {
    const prisma = createPrismaMock();
    prisma.idBusinessV2Account.count.mockResolvedValueOnce(9).mockResolvedValueOnce(7);
    prisma.idBusinessV2Account.aggregate.mockResolvedValue({
      _sum: {
        balanceCostAmount: new Prisma.Decimal('100.1250'),
        purchaseCost: new Prisma.Decimal('20.3750')
      }
    });
    prisma.idBusinessV2FinanceSettings.findUnique.mockResolvedValue({
      historyStatus: 'incomplete'
    });
    prisma.idBusinessV2Order.aggregate.mockResolvedValue({
      _count: { _all: 2 },
      _sum: {
        receivedAmount: new Prisma.Decimal('50'),
        profitAmount: new Prisma.Decimal('12')
      }
    });
    const service = createService(prisma);

    const result = await service.overview(
      user(['apple.account.view', 'finance.view']),
      new Date('2026-07-31T00:00:00.000Z')
    );

    expect(result.assets).toEqual({
      totalAccounts: 9,
      availableAccounts: 7,
      inventoryBookValueCny: '120.5',
      financeHistoryStatus: 'incomplete'
    });
    expect(result.business.todayCompletedOrders).toBeNull();
    expect(result.business.todayRevenueCny).toBe('50');
  });

  it('excludes activation records that have already been renewed from renewal risks', async () => {
    const prisma = createPrismaMock();
    prisma.idBusinessV2RenewalWarningSetting.findUnique.mockResolvedValue({ warningDays: 7 });
    prisma.idBusinessV2Activation.count.mockResolvedValue(0);
    prisma.idBusinessV2Activation.findMany.mockResolvedValue([]);
    const service = createService(prisma);

    await service.overview(user(['apple.renewal_task.view']), new Date('2026-08-13T03:00:00.000Z'));

    expect(prisma.idBusinessV2Activation.count).toHaveBeenNthCalledWith(1, {
      where: {
        order: { is: { balanceReturns: { none: { status: 'active' } } } },
        renewedBy: { is: null },
        status: 'active',
        dueAt: { lt: new Date('2026-08-12T16:00:00.000Z') }
      }
    });
    expect(prisma.idBusinessV2Activation.count).toHaveBeenNthCalledWith(2, {
      where: {
        order: { is: { balanceReturns: { none: { status: 'active' } } } },
        renewedBy: { is: null },
        status: 'active',
        dueAt: {
          gte: new Date('2026-08-12T16:00:00.000Z'),
          lt: new Date('2026-08-20T16:00:00.000Z')
        }
      }
    });
    expect(prisma.idBusinessV2Activation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          order: { is: { balanceReturns: { none: { status: 'active' } } } },
          renewedBy: { is: null },
          status: 'active',
          dueAt: { lt: new Date('2026-08-20T16:00:00.000Z') }
        }
      })
    );
  });

  it('selects only audit summary fields for the team activity feed', async () => {
    const prisma = createPrismaMock();
    prisma.auditLog.findMany.mockResolvedValue([]);
    const service = createService(prisma);

    await service.overview(user(['audit_log.view']), new Date('2026-07-31T00:00:00.000Z'));

    expect(prisma.auditLog.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: {
          id: true,
          module: true,
          action: true,
          objectType: true,
          createdAt: true,
          user: { select: { username: true, displayName: true } }
        }
      })
    );
  });
});

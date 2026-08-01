import { describe, expect, it, vi } from 'vitest';
import { IdBusinessV2DataGovernanceService } from './id-business-v2-data-governance.service';
import { IdBusinessV2DataGovernanceQueryRepository } from './persistence/id-business-v2-data-governance-query.repository';

function createPrismaMock() {
  return {
    idBusinessV2Account: { count: vi.fn(), findMany: vi.fn() },
    idBusinessV2Customer: { count: vi.fn(), findMany: vi.fn() },
    idBusinessV2Option: { count: vi.fn(), findMany: vi.fn() },
    idBusinessV2Order: { count: vi.fn(), findMany: vi.fn() },
    auditLog: { findFirst: vi.fn() }
  };
}

describe('IdBusinessV2DataGovernanceService', () => {
  it('returns the recycle inventory and reports the guarded workflow as available', async () => {
    const prisma = createPrismaMock();
    prisma.idBusinessV2Account.count.mockResolvedValue(1);
    prisma.idBusinessV2Customer.count.mockResolvedValue(2);
    prisma.idBusinessV2Option.count.mockResolvedValue(3);
    prisma.idBusinessV2Order.count.mockResolvedValue(4);
    prisma.idBusinessV2Account.findMany.mockResolvedValue([
      {
        id: 'account-id',
        appleIdMasked: 'ab***@example.com',
        deletedAt: new Date('2026-07-31T09:00:00.000Z')
      }
    ]);
    prisma.idBusinessV2Customer.findMany.mockResolvedValue([
      {
        id: 'customer-id',
        name: '客户甲',
        deletedAt: new Date('2026-07-31T11:00:00.000Z')
      }
    ]);
    prisma.idBusinessV2Option.findMany.mockResolvedValue([]);
    prisma.idBusinessV2Order.findMany.mockResolvedValue([
      {
        id: 'order-id',
        orderNo: 'ORD-001',
        deletedAt: new Date('2026-07-31T10:00:00.000Z')
      }
    ]);
    prisma.auditLog.findFirst.mockResolvedValue({
      id: 'audit-id',
      createdAt: new Date('2026-07-30T12:00:00.000Z')
    });
    const service = new IdBusinessV2DataGovernanceService(
      new IdBusinessV2DataGovernanceQueryRepository(prisma as never)
    );

    const result = await service.overview(new Date('2026-07-31T12:00:00.000Z'));

    expect(result.recycleBin).toMatchObject({
      total: 10,
      byEntity: { account: 1, customer: 2, option: 3, order: 4 }
    });
    expect(result.recycleBin.recentItems.map((item) => item.id)).toEqual([
      'customer-id',
      'order-id',
      'account-id'
    ]);
    expect(
      result.recycleBin.recentItems.every((item) => item.restoreReadiness === 'review_required')
    ).toBe(true);
    expect(result.safety).toEqual({
      restoreEnabled: true,
      cleanupEnabled: true,
      generalHardDeleteEnabled: false,
      approvalWorkflowConfigured: true
    });
    expect(result.existingRetention).toEqual({
      scope: 'exchange_rate_history_only',
      configured: true,
      lastAuditedRunAt: '2026-07-30T12:00:00.000Z',
      evidenceStatus: 'observed'
    });
    expect(result.generatedAt).toBe('2026-07-31T12:00:00.000Z');
  });

  it('selects only safe labels from soft-deleted records', async () => {
    const prisma = createPrismaMock();
    for (const model of [
      prisma.idBusinessV2Account,
      prisma.idBusinessV2Customer,
      prisma.idBusinessV2Option,
      prisma.idBusinessV2Order
    ]) {
      model.count.mockResolvedValue(0);
      model.findMany.mockResolvedValue([]);
    }
    prisma.auditLog.findFirst.mockResolvedValue(null);
    const service = new IdBusinessV2DataGovernanceService(
      new IdBusinessV2DataGovernanceQueryRepository(prisma as never)
    );

    await service.overview();

    expect(prisma.idBusinessV2Account.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: { id: true, appleIdMasked: true, deletedAt: true }
      })
    );
    expect(JSON.stringify(prisma.idBusinessV2Account.findMany.mock.calls)).not.toContain(
      'appleIdEncrypted'
    );
    expect(JSON.stringify(prisma.idBusinessV2Customer.findMany.mock.calls)).not.toContain(
      'phoneEncrypted'
    );
    expect(JSON.stringify(prisma.idBusinessV2Order.findMany.mock.calls)).not.toContain(
      'websiteAccountEncrypted'
    );
  });
});

import { BadRequestException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { IdBusinessV2BusinessMonitoringService } from './id-business-v2-business-monitoring.service';
import { IdBusinessV2BusinessMonitoringRepository } from './persistence/id-business-v2-business-monitoring.repository';

function createPrismaMock() {
  return {
    idBusinessV2RenewalWarningSetting: {
      findUnique: vi.fn().mockResolvedValue({ warningDays: 7 })
    },
    $queryRaw: vi.fn()
  };
}

function createService(prisma: ReturnType<typeof createPrismaMock>) {
  return new IdBusinessV2BusinessMonitoringService(
    new IdBusinessV2BusinessMonitoringRepository(prisma as never)
  );
}

describe('IdBusinessV2BusinessMonitoringService', () => {
  it('rejects unsupported filters before executing monitoring SQL', async () => {
    const prisma = createPrismaMock();
    const service = createService(prisma);

    await expect(service.list({ severity: 'unknown' })).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.list({ category: 'customer' })).rejects.toBeInstanceOf(
      BadRequestException
    );
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('returns exact server pagination, summary and source-state resolution metadata', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw
      .mockResolvedValueOnce([
        {
          id: 'order:order-id:failed',
          ruleKey: 'order_failed',
          category: 'order',
          severity: 'critical',
          subject: 'ORD-001',
          description: '订单当前状态为失败，请复核并修正源订单。',
          detectedAt: new Date('2026-07-31T10:00:00.000Z'),
          sourceType: 'order',
          sourceId: 'order-id',
          route: '/v2/orders'
        }
      ])
      .mockResolvedValueOnce([{ count: 1n }])
      .mockResolvedValueOnce([
        { severity: 'critical', category: 'order', count: 1n },
        { severity: 'warning', category: 'renewal', count: 2n }
      ]);
    const service = createService(prisma);

    const result = await service.list(
      { page: '2', pageSize: '10', severity: 'critical', category: 'order' },
      new Date('2026-07-31T12:00:00.000Z')
    );

    expect(result.result).toMatchObject({
      total: 1,
      page: 2,
      pageSize: 10,
      items: [
        {
          id: 'order:order-id:failed',
          detectedAt: '2026-07-31T10:00:00.000Z',
          status: 'open',
          resolutionMode: 'source_state'
        }
      ]
    });
    expect(result.summary).toEqual({
      total: 3,
      critical: 1,
      warning: 2,
      info: 0,
      byCategory: { order: 1, balance: 0, renewal: 2, exchange_rate: 0, finance: 0 }
    });
    expect(result.rules).toHaveLength(9);
    expect(result.generatedAt).toBe('2026-07-31T12:00:00.000Z');
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(3);

    const listSql = prisma.$queryRaw.mock.calls[0]?.[0] as {
      strings?: readonly string[];
      values?: readonly unknown[];
    };
    const listSource = listSql.strings?.join(' ') ?? '';
    expect(listSource).toContain('LIMIT');
    expect(listSource).toContain('OFFSET');
    expect(listSource).toContain("NOT IN ('sold', 'recovered')");
    expect(listSource).toContain('account_disposition');
    expect(listSource.match(/replacement\."renewed_from_activation_id"/g)).toHaveLength(2);
    expect(listSource.match(/id_business_v2_order_balance_returns/g)).toHaveLength(4);
    expect(listSource.match(/CONCAT\('', [a-z]\."id"\)/g)).toHaveLength(11);
    expect(listSource).not.toContain('<=>');
    expect(listSource).toContain('customer_id" IS NULL');
    expect(listSource).toContain('sold_by_order_id" IS NULL');
    expect(listSource).not.toContain('apple_id_encrypted');
    expect(listSource).not.toContain('error_message');
    expect(listSource).not.toContain('token');
  });

  it('uses a safe default and caps the renewal warning window', async () => {
    const prisma = createPrismaMock();
    prisma.idBusinessV2RenewalWarningSetting.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ warningDays: 800 });
    prisma.$queryRaw.mockResolvedValue([]);
    const service = createService(prisma);

    await service.list({}, new Date('2026-07-31T00:00:00.000Z'));
    await service.list({}, new Date('2026-07-31T00:00:00.000Z'));

    const firstListSql = prisma.$queryRaw.mock.calls[0]?.[0] as { values?: readonly unknown[] };
    const secondListSql = prisma.$queryRaw.mock.calls[3]?.[0] as { values?: readonly unknown[] };
    expect(firstListSql.values).toContainEqual(new Date('2026-08-03T00:00:00.000Z'));
    expect(secondListSql.values).toContainEqual(new Date('2027-07-31T00:00:00.000Z'));
    expect(firstListSql.values).not.toContain(null);
    expect(secondListSql.values).not.toContain(null);
  });
});

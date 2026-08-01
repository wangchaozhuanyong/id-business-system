import { BadRequestException } from '@nestjs/common';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { V2CommandTransactionManager } from '../runtime/public-api';
import {
  ID_BUSINESS_V2_RENEWAL_WARNING_SCOPE,
  IdBusinessV2RenewalWarningService
} from './id-business-v2-renewal-warning.service';
import { IdBusinessV2RenewalsRepository } from './persistence/id-business-v2-renewals.repository';

const now = new Date('2026-07-29T12:00:00.000Z');
const operator = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: [
    'apple.renewal_task.view',
    'apple.renewal_task.update',
    'id_business_v2.renewal_warning.manage'
  ]
};

function summaryItem(overrides: Record<string, unknown> = {}) {
  return {
    id: '22222222-2222-4222-8222-222222222222',
    dueAt: new Date('2026-07-31T12:00:00.000Z'),
    status: 'active',
    customer: {
      id: '33333333-3333-4333-8333-333333333333',
      name: '测试客户'
    },
    account: {
      id: '44444444-4444-4444-8444-444444444444',
      appleIdMasked: 'us***@example.com'
    },
    serviceOption: {
      id: '55555555-5555-4555-8555-555555555555',
      name: 'ChatGPT Plus'
    },
    ...overrides
  };
}

describe('IdBusinessV2RenewalWarningService', () => {
  const tx = {
    idBusinessV2RenewalWarningSetting: {
      findUnique: vi.fn(),
      upsert: vi.fn()
    },
    auditLog: {
      create: vi.fn()
    }
  };
  const prisma = {
    idBusinessV2RenewalWarningSetting: {
      findUnique: vi.fn()
    },
    idBusinessV2Activation: {
      count: vi.fn(),
      findMany: vi.fn(),
      findFirst: vi.fn()
    },
    $transaction: vi.fn()
  };
  const service = new IdBusinessV2RenewalWarningService(
    new IdBusinessV2RenewalsRepository(prisma as never),
    new V2CommandTransactionManager(prisma as never)
  );

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.resetAllMocks();
    prisma.idBusinessV2RenewalWarningSetting.findUnique.mockResolvedValue(null);
    prisma.idBusinessV2Activation.count.mockResolvedValueOnce(2).mockResolvedValueOnce(1);
    prisma.idBusinessV2Activation.findMany
      .mockResolvedValueOnce([summaryItem()])
      .mockResolvedValueOnce([
        summaryItem({
          id: '66666666-6666-4666-8666-666666666666',
          dueAt: new Date('2026-07-29T10:00:00.000Z'),
          status: 'expired'
        })
      ]);
    prisma.idBusinessV2Activation.findFirst.mockResolvedValue(null);
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));
    tx.idBusinessV2RenewalWarningSetting.findUnique.mockResolvedValue(null);
    tx.idBusinessV2RenewalWarningSetting.upsert.mockResolvedValue({
      id: '77777777-7777-4777-8777-777777777777',
      updatedAt: now
    });
    tx.auditLog.create.mockResolvedValue({ id: 'audit-1' });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('uses three days by default and ignores malformed stored settings', async () => {
    await expect(service.getSettings()).resolves.toMatchObject({
      warningDays: 3,
      minWarningDays: 1,
      maxWarningDays: 365,
      updatedAt: null
    });

    prisma.idBusinessV2RenewalWarningSetting.findUnique.mockResolvedValueOnce({
      warningDays: 'invalid',
      updatedAt: now
    });
    await expect(service.getSettings()).resolves.toMatchObject({
      warningDays: 3,
      updatedAt: now
    });

    prisma.idBusinessV2RenewalWarningSetting.findUnique.mockResolvedValueOnce({
      warningDays: 30,
      updatedAt: now
    });
    await expect(service.getSettings()).resolves.toMatchObject({
      warningDays: 30,
      updatedAt: now
    });
  });

  it('saves a validated global warning rule and writes an audit record atomically', async () => {
    await expect(service.updateSettings({ warningDays: 5 }, operator)).resolves.toMatchObject({
      warningDays: 5,
      updatedAt: now
    });

    expect(tx.idBusinessV2RenewalWarningSetting.upsert).toHaveBeenCalledWith({
      where: {
        scope: ID_BUSINESS_V2_RENEWAL_WARNING_SCOPE
      },
      create: expect.objectContaining({
        scope: ID_BUSINESS_V2_RENEWAL_WARNING_SCOPE,
        warningDays: 5,
        updatedByUserId: operator.id
      }),
      update: expect.objectContaining({
        warningDays: 5,
        updatedByUserId: operator.id
      })
    });
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: operator.id,
        action: 'id_business_v2.renewal.warning_settings.update',
        beforeData: { warningDays: 3 },
        afterData: { warningDays: 5 }
      })
    });
  });

  it('rejects an unidentified operator and warning days outside the integer range', async () => {
    await expect(service.updateSettings({ warningDays: 0 }, operator)).rejects.toBeInstanceOf(
      BadRequestException
    );
    await expect(service.updateSettings({ warningDays: 3.5 }, operator)).rejects.toBeInstanceOf(
      BadRequestException
    );
    await expect(service.updateSettings({ warningDays: 366 }, operator)).rejects.toBeInstanceOf(
      BadRequestException
    );
    await expect(service.updateSettings({ warningDays: 3 }, undefined)).rejects.toBeInstanceOf(
      BadRequestException
    );
  });

  it('returns upcoming and expired counts plus masked bell items', async () => {
    const result = await service.getSummary(now);

    expect(result).toMatchObject({
      warningDays: 3,
      upcomingCount: 2,
      expiredCount: 1,
      totalCount: 3,
      evaluatedAt: now,
      items: [
        {
          account: {
            appleIdMasked: 'us***@example.com'
          },
          warningState: 'upcoming'
        },
        {
          warningState: 'expired'
        }
      ]
    });
    expect(JSON.stringify(result)).not.toContain('Encrypted');
    expect(JSON.stringify(result)).not.toContain('password');
  });
});

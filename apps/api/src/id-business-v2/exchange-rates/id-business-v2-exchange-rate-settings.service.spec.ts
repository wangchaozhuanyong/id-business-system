import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IdBusinessV2ExchangeRateSettingsService } from './id-business-v2-exchange-rate-settings.service';

const operator = {
  id: '11111111-1111-4111-8111-111111111111',
  username: 'admin',
  displayName: '管理员',
  roles: ['admin'],
  permissions: ['apple.exchange_rate.manage']
};
const now = new Date('2026-07-27T10:00:00.000Z');

function settingsRecord(overrides: Record<string, unknown> = {}) {
  return {
    id: 1,
    autoEnabled: true,
    intervalMinutes: 30,
    targetAmountRmb: new Prisma.Decimal('5000'),
    nextRunAt: now,
    updatedByUserId: null,
    createdAt: now,
    updatedAt: now,
    ...overrides
  };
}

describe('IdBusinessV2ExchangeRateSettingsService', () => {
  const tx = {
    idBusinessV2ExchangeRateSettings: { upsert: vi.fn() },
    auditLog: { create: vi.fn() }
  };
  const prisma = {
    idBusinessV2ExchangeRateSettings: { upsert: vi.fn() },
    $transaction: vi.fn(),
    $queryRaw: vi.fn()
  };
  const service = new IdBusinessV2ExchangeRateSettingsService(prisma as never);
  const originalEmergencySwitch = process.env.ID_BUSINESS_V2_EXCHANGE_RATE_AUTO_ENABLED;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(now);
    vi.clearAllMocks();
    delete process.env.ID_BUSINESS_V2_EXCHANGE_RATE_AUTO_ENABLED;
    prisma.idBusinessV2ExchangeRateSettings.upsert.mockResolvedValue(settingsRecord());
    prisma.$transaction.mockImplementation(async (callback) => callback(tx));
    tx.idBusinessV2ExchangeRateSettings.upsert.mockImplementation(async ({ update }) =>
      settingsRecord({
        ...update,
        updatedByUserId: operator.id
      })
    );
    tx.auditLog.create.mockResolvedValue({ id: 'audit-1' });
  });

  afterEach(() => {
    vi.useRealTimers();
    if (originalEmergencySwitch === undefined) {
      delete process.env.ID_BUSINESS_V2_EXCHANGE_RATE_AUTO_ENABLED;
    } else {
      process.env.ID_BUSINESS_V2_EXCHANGE_RATE_AUTO_ENABLED = originalEmergencySwitch;
    }
  });

  it('creates the singleton with automatic collection enabled every 30 minutes at 5000 RMB', async () => {
    await expect(service.get()).resolves.toMatchObject({
      autoEnabled: true,
      intervalMinutes: 30,
      targetAmountRmb: '5000',
      emergencyNetworkEnabled: true
    });
    expect(prisma.idBusinessV2ExchangeRateSettings.upsert).toHaveBeenCalledWith({
      where: { id: 1 },
      create: expect.objectContaining({
        id: 1,
        autoEnabled: true,
        intervalMinutes: 30,
        targetAmountRmb: new Prisma.Decimal('5000')
      }),
      update: {}
    });
  });

  it('saves an allowed interval and schedules an immediate collection with an audit record', async () => {
    await expect(
      service.update(
        { autoEnabled: true, intervalMinutes: 30, targetAmountRmb: '8000.126' },
        operator
      )
    ).resolves.toMatchObject({
      autoEnabled: true,
      intervalMinutes: 30,
      targetAmountRmb: '8000.13',
      nextRunAt: now
    });
    expect(tx.idBusinessV2ExchangeRateSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({
          autoEnabled: true,
          intervalMinutes: 30,
          targetAmountRmb: new Prisma.Decimal('8000.13'),
          nextRunAt: now,
          updatedByUserId: operator.id
        })
      })
    );
    expect(tx.auditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        userId: operator.id,
        action: 'id_business_v2.exchange_rate.settings.update'
      })
    });
  });

  it('closes scheduling by clearing nextRunAt and rejects unsupported settings', async () => {
    await service.update(
      { autoEnabled: false, intervalMinutes: 15, targetAmountRmb: '5000' },
      operator
    );
    expect(tx.idBusinessV2ExchangeRateSettings.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        update: expect.objectContaining({ autoEnabled: false, nextRunAt: null })
      })
    );

    await expect(
      service.update({ autoEnabled: true, intervalMinutes: 10, targetAmountRmb: '5000' }, operator)
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.update({ autoEnabled: true, intervalMinutes: 15, targetAmountRmb: '0' }, operator)
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      service.update({ autoEnabled: true, intervalMinutes: 15, targetAmountRmb: '5000' }, undefined)
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('atomically returns only the database schedule claim result', async () => {
    prisma.$queryRaw.mockResolvedValue([
      {
        targetAmountRmb: new Prisma.Decimal('5000'),
        intervalMinutes: 15,
        nextRunAt: new Date('2026-07-27T10:15:00.000Z')
      }
    ]);
    await expect(service.claimDueSchedule()).resolves.toMatchObject({
      targetAmountRmb: new Prisma.Decimal('5000'),
      intervalMinutes: 15
    });
    const query = prisma.$queryRaw.mock.calls[0]?.[0] as { strings?: string[] };
    expect(query.strings?.join('')).toContain('EXTRACT(EPOCH FROM clock_timestamp())');
    expect(query.strings?.join('')).toContain('FLOOR');

    prisma.$queryRaw.mockResolvedValue([]);
    await expect(service.claimDueSchedule()).resolves.toBeNull();
  });

  it('uses the environment variable only as an emergency network switch', () => {
    process.env.ID_BUSINESS_V2_EXCHANGE_RATE_AUTO_ENABLED = 'false';
    expect(service.isNetworkEnabled()).toBe(false);
    process.env.ID_BUSINESS_V2_EXCHANGE_RATE_AUTO_ENABLED = 'true';
    expect(service.isNetworkEnabled()).toBe(true);
  });
});

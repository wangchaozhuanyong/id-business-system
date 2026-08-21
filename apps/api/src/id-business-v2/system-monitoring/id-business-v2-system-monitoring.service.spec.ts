import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthAvailabilityMonitor } from '../../auth/auth-availability.monitor';
import { IdBusinessV2SystemMonitoringService } from './id-business-v2-system-monitoring.service';
import { IdBusinessV2SystemMonitoringRepository } from './persistence/id-business-v2-system-monitoring.repository';

const originalManualMode = process.env.ID_BUSINESS_V2_FREE_MANUAL_MODE;
const originalAutoMode = process.env.ID_BUSINESS_V2_EXCHANGE_RATE_AUTO_ENABLED;
const originalCurrencyApiKey = process.env.CURRENCY_API_KEY;

function createPrismaMock() {
  return {
    $queryRaw: vi.fn().mockResolvedValue([{ ok: 1 }]),
    idBusinessV2ScopeVersion: {
      aggregate: vi.fn().mockResolvedValue({
        _count: { _all: 4 },
        _max: { updatedAt: new Date('2026-07-31T11:00:00.000Z') }
      })
    },
    idBusinessV2ExchangeRateSettings: {
      findUnique: vi.fn().mockResolvedValue({
        autoEnabled: true,
        intervalMinutes: 30,
        nextRunAt: new Date('2026-07-31T12:30:00.000Z'),
        updatedAt: new Date('2026-07-31T10:00:00.000Z')
      })
    },
    idBusinessV2ExchangeRateRun: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'run-id',
        status: 'success',
        triggerType: 'scheduled',
        startedAt: new Date('2026-07-31T11:30:00.000Z'),
        finishedAt: new Date('2026-07-31T11:31:00.000Z'),
        errorCode: null
      })
    },
    idBusinessV2PurchaseRateSettings: {
      findUnique: vi.fn().mockResolvedValue({
        autoEnabled: true,
        staleMinutes: 120,
        abnormalChangeRate: { toString: () => '0.1' },
        nextRunAt: new Date('2026-07-31T12:05:00.000Z'),
        updatedAt: new Date('2026-07-31T10:00:00.000Z')
      })
    },
    idBusinessV2PurchaseRateFetchRun: {
      findFirst: vi.fn().mockResolvedValue({
        id: 'purchase-run-id',
        status: 'success',
        triggerType: 'scheduled',
        startedAt: new Date('2026-07-31T11:05:00.000Z'),
        finishedAt: new Date('2026-07-31T11:05:10.000Z'),
        errorCode: null,
        abnormalCurrencyCodes: []
      })
    },
    idBusinessV2PurchaseRateSnapshot: {
      findFirst: vi.fn().mockResolvedValue({
        marketRateCapturedAt: new Date('2026-07-31T11:00:00.000Z')
      })
    },
    loginLog: {
      count: vi.fn().mockResolvedValueOnce(8).mockResolvedValueOnce(2).mockResolvedValueOnce(1)
    },
    activeSession: { count: vi.fn().mockResolvedValue(3) }
  };
}

function createService(
  prisma: ReturnType<typeof createPrismaMock>,
  monitor = new AuthAvailabilityMonitor()
) {
  process.env.CURRENCY_API_KEY = 'test-currency-api-key';
  return new IdBusinessV2SystemMonitoringService(
    new IdBusinessV2SystemMonitoringRepository(prisma as never),
    monitor
  );
}

afterEach(() => {
  if (originalManualMode === undefined) delete process.env.ID_BUSINESS_V2_FREE_MANUAL_MODE;
  else process.env.ID_BUSINESS_V2_FREE_MANUAL_MODE = originalManualMode;
  if (originalAutoMode === undefined) delete process.env.ID_BUSINESS_V2_EXCHANGE_RATE_AUTO_ENABLED;
  else process.env.ID_BUSINESS_V2_EXCHANGE_RATE_AUTO_ENABLED = originalAutoMode;
  if (originalCurrencyApiKey === undefined) delete process.env.CURRENCY_API_KEY;
  else process.env.CURRENCY_API_KEY = originalCurrencyApiKey;
});

describe('IdBusinessV2SystemMonitoringService', () => {
  it('returns evidence-backed checks without exposing identity details', async () => {
    delete process.env.ID_BUSINESS_V2_FREE_MANUAL_MODE;
    delete process.env.ID_BUSINESS_V2_EXCHANGE_RATE_AUTO_ENABLED;
    const prisma = createPrismaMock();
    const service = createService(prisma);

    const result = await service.overview(new Date('2026-07-31T12:00:00.000Z'));

    expect(result.overallStatus).toBe('partial');
    expect(result.authentication).toEqual({
      attempts: 8,
      failed: 2,
      abnormal: 1,
      activeSessions: 3
    });
    expect(result.exchangeRate).toMatchObject({
      executionMode: 'automatic_capable',
      latestRun: {
        id: 'run-id',
        status: 'success',
        startedAt: '2026-07-31T11:30:00.000Z'
      }
    });
    expect(result.observabilityGaps).toHaveLength(4);
    expect(result.observabilityGaps.every((item) => item.status === 'unknown')).toBe(true);
    expect(JSON.stringify(result)).not.toContain('username');
    expect(JSON.stringify(result)).not.toContain('ip');
    expect(JSON.stringify(result)).not.toContain('userAgent');
  });

  it('marks failed probes as degraded without returning raw database errors', async () => {
    const prisma = createPrismaMock();
    prisma.$queryRaw.mockRejectedValue(new Error('postgresql://user:secret@db/internal'));
    prisma.idBusinessV2ScopeVersion.aggregate.mockRejectedValue(new Error('scope token=secret'));
    prisma.loginLog.count.mockReset().mockRejectedValue(new Error('login query failed'));
    const service = createService(prisma);

    const result = await service.overview(new Date('2026-07-31T12:00:00.000Z'));
    const serialized = JSON.stringify(result);

    expect(result.overallStatus).toBe('degraded');
    expect(result.checks).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ key: 'database', status: 'degraded' }),
        expect.objectContaining({ key: 'change_sync', status: 'degraded' }),
        expect.objectContaining({ key: 'authentication', status: 'degraded' })
      ])
    );
    expect(result.authentication).toEqual({
      attempts: null,
      failed: null,
      abnormal: null,
      activeSessions: null
    });
    expect(serialized).not.toContain('postgresql://');
    expect(serialized).not.toContain('secret');
  });

  it('reports automatic settings that conflict with manual-only runtime', async () => {
    process.env.ID_BUSINESS_V2_FREE_MANUAL_MODE = 'true';
    const prisma = createPrismaMock();
    const service = createService(prisma);

    const result = await service.overview(new Date('2026-07-31T12:00:00.000Z'));

    expect(result.checks).toContainEqual(
      expect.objectContaining({
        key: 'exchange_scheduler',
        status: 'degraded',
        value: '配置冲突'
      })
    );
    expect(result.exchangeRate?.executionMode).toBe('manual_only');
  });

  it('surfaces a local alert after three consecutive auth dependency failures', async () => {
    const prisma = createPrismaMock();
    const monitor = new AuthAvailabilityMonitor();
    monitor.recordUnavailable(new Date('2026-07-31T11:59:57.000Z').getTime());
    monitor.recordUnavailable(new Date('2026-07-31T11:59:58.000Z').getTime());
    monitor.recordUnavailable(new Date('2026-07-31T11:59:59.000Z').getTime());
    const service = createService(prisma, monitor);

    const result = await service.overview(new Date('2026-07-31T12:00:00.000Z'));

    expect(result.overallStatus).toBe('degraded');
    expect(result.authAvailability).toMatchObject({
      alert: true,
      consecutiveUnavailable: 3,
      unavailableChecks: 3
    });
    expect(result.checks).toContainEqual(
      expect.objectContaining({
        key: 'authentication_availability',
        status: 'degraded'
      })
    );
  });
});

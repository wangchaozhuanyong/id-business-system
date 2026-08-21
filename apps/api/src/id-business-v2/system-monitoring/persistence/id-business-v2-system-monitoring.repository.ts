import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';

export interface ChangeSyncProbeRow {
  _count: { _all: number };
  _max: { updatedAt: Date | null };
}

export interface ExchangeRateProbeRow {
  settings: {
    autoEnabled: boolean;
    intervalMinutes: number;
    nextRunAt: Date | null;
    updatedAt: Date;
  } | null;
  latestRun: {
    id: string;
    status: 'running' | 'success' | 'failed';
    triggerType: 'manual' | 'scheduled' | 'system';
    startedAt: Date;
    finishedAt: Date | null;
    errorCode: string | null;
  } | null;
  purchaseRate: {
    settings: {
      autoEnabled: boolean;
      staleMinutes: number;
      abnormalChangeRate: Prisma.Decimal;
      nextRunAt: Date | null;
      updatedAt: Date;
    } | null;
    latestRun: {
      id: string;
      status: 'running' | 'success' | 'failed' | 'pending_review' | 'rejected';
      triggerType: 'manual' | 'scheduled' | 'system';
      startedAt: Date;
      finishedAt: Date | null;
      errorCode: string | null;
      abnormalCurrencyCodes: string[];
    } | null;
    latestSnapshot: {
      marketRateCapturedAt: Date;
    } | null;
  };
}

export interface AuthenticationProbeRow {
  attempts: number;
  failed: number;
  abnormal: number;
  activeSessions: number;
}

@Injectable()
export class IdBusinessV2SystemMonitoringRepository {
  constructor(private readonly prisma: PrismaService) {}

  probeDatabase() {
    return this.prisma.$queryRaw<Array<{ ok: number }>>(Prisma.sql`SELECT 1 AS ok`);
  }

  loadChangeSync(): Promise<ChangeSyncProbeRow> {
    return this.prisma.idBusinessV2ScopeVersion.aggregate({
      _count: { _all: true },
      _max: { updatedAt: true }
    });
  }

  async loadExchangeRate(): Promise<ExchangeRateProbeRow> {
    const [settings, latestRun, purchaseSettings, purchaseRun, purchaseSnapshot] =
      await Promise.all([
        this.prisma.idBusinessV2ExchangeRateSettings.findUnique({
          where: { id: 1 },
          select: { autoEnabled: true, intervalMinutes: true, nextRunAt: true, updatedAt: true }
        }),
        this.prisma.idBusinessV2ExchangeRateRun.findFirst({
          select: {
            id: true,
            status: true,
            triggerType: true,
            startedAt: true,
            finishedAt: true,
            errorCode: true
          },
          orderBy: [{ startedAt: 'desc' }, { id: 'desc' }]
        }),
        this.prisma.idBusinessV2PurchaseRateSettings.findUnique({
          where: { id: 1 },
          select: {
            autoEnabled: true,
            staleMinutes: true,
            abnormalChangeRate: true,
            nextRunAt: true,
            updatedAt: true
          }
        }),
        this.prisma.idBusinessV2PurchaseRateFetchRun.findFirst({
          select: {
            id: true,
            status: true,
            triggerType: true,
            startedAt: true,
            finishedAt: true,
            errorCode: true,
            abnormalCurrencyCodes: true
          },
          orderBy: [{ startedAt: 'desc' }, { id: 'desc' }]
        }),
        this.prisma.idBusinessV2PurchaseRateSnapshot.findFirst({
          select: { marketRateCapturedAt: true },
          orderBy: [{ marketRateCapturedAt: 'desc' }, { id: 'desc' }]
        })
      ]);
    return {
      settings,
      latestRun,
      purchaseRate: {
        settings: purchaseSettings,
        latestRun: purchaseRun,
        latestSnapshot: purchaseSnapshot
      }
    };
  }

  async loadAuthentication(since: Date, now: Date): Promise<AuthenticationProbeRow> {
    const [attempts, failed, abnormal, activeSessions] = await Promise.all([
      this.prisma.loginLog.count({ where: { createdAt: { gte: since } } }),
      this.prisma.loginLog.count({
        where: { createdAt: { gte: since }, status: { in: ['failed', 'blocked'] } }
      }),
      this.prisma.loginLog.count({ where: { createdAt: { gte: since }, abnormal: true } }),
      this.prisma.activeSession.count({
        where: { revokedAt: null, expiresAt: { gt: now } }
      })
    ]);
    return { attempts, failed, abnormal, activeSessions };
  }
}

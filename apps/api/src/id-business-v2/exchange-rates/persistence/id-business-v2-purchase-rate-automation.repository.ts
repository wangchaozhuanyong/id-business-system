import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { isPrismaErrorCode, Rate8, type V2CommandTransaction } from '../../runtime/public-api';

const OPERATOR_SELECT = {
  id: true,
  username: true,
  displayName: true
} satisfies Prisma.UserSelect;

const RUN_INCLUDE = {
  triggeredBy: { select: OPERATOR_SELECT },
  reviewedBy: { select: OPERATOR_SELECT },
  _count: { select: { snapshots: true } }
} satisfies Prisma.IdBusinessV2PurchaseRateFetchRunInclude;

export type IdBusinessV2PurchaseRateRunRecord = Prisma.IdBusinessV2PurchaseRateFetchRunGetPayload<{
  include: typeof RUN_INCLUDE;
}>;

export type IdBusinessV2PurchaseRateSettingsRecord = {
  autoEnabled: boolean;
  intervalMinutes: number;
  staleMinutes: number;
  abnormalChangeRate: Rate8;
  nextRunAt: Date | null;
  updatedByUserId: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export class IdBusinessV2PurchaseRateRunLockedError extends Error {
  constructor() {
    super('已有收购汇率采集任务正在执行');
    this.name = 'IdBusinessV2PurchaseRateRunLockedError';
  }
}

@Injectable()
export class IdBusinessV2PurchaseRateAutomationRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findSettings() {
    const row = await this.prisma.idBusinessV2PurchaseRateSettings.findUnique({ where: { id: 1 } });
    return row ? this.mapSettings(row) : null;
  }

  async findSettingsInTransaction(tx: V2CommandTransaction) {
    const row = await tx.idBusinessV2PurchaseRateSettings.findUnique({ where: { id: 1 } });
    return row ? this.mapSettings(row) : null;
  }

  async claimDueSettings(tx: V2CommandTransaction) {
    const rows = await tx.$queryRaw<
      Array<{
        autoEnabled: boolean;
        intervalMinutes: number;
        staleMinutes: number;
        abnormalChangeRate: Prisma.Decimal;
        nextRunAt: Date;
        updatedByUserId: string | null;
        createdAt: Date;
        updatedAt: Date;
      }>
    >(Prisma.sql`
      SELECT
        "auto_enabled" AS "autoEnabled",
        "interval_minutes" AS "intervalMinutes",
        "stale_minutes" AS "staleMinutes",
        "abnormal_change_rate" AS "abnormalChangeRate",
        "next_run_at" AS "nextRunAt",
        "updated_by_user_id" AS "updatedByUserId",
        "created_at" AS "createdAt",
        "updated_at" AS "updatedAt"
      FROM "id_business_v2_purchase_rate_settings"
      WHERE "id" = 1
        AND "auto_enabled" = TRUE
        AND "next_run_at" IS NOT NULL
        AND "next_run_at" <= UTC_TIMESTAMP(6)
      FOR UPDATE
    `);
    const row = rows[0];
    if (!row) return null;

    const now = new Date();
    const nextRunAt = new Date(
      Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1, 1, 5)
    );
    const updated = await tx.idBusinessV2PurchaseRateSettings.update({
      where: { id: 1 },
      data: { nextRunAt }
    });
    return this.mapSettings(updated);
  }

  createDefaultSettings(tx: V2CommandTransaction, now: Date) {
    return tx.idBusinessV2PurchaseRateSettings.create({
      data: {
        id: 1,
        autoEnabled: true,
        intervalMinutes: 1440,
        staleMinutes: 1800,
        abnormalChangeRate: '0.1',
        nextRunAt: now
      }
    });
  }

  updateSettings(
    tx: V2CommandTransaction,
    data: Prisma.IdBusinessV2PurchaseRateSettingsUpdateInput
  ) {
    return tx.idBusinessV2PurchaseRateSettings.update({ where: { id: 1 }, data });
  }

  listEnabledCurrencies(tx: V2CommandTransaction) {
    return tx.idBusinessV2PurchaseCurrency.findMany({
      where: { enabled: true },
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }],
      include: {
        snapshots: {
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 1
        }
      }
    });
  }

  async createRun(
    tx: V2CommandTransaction,
    input: {
      id: string;
      triggerType: 'manual' | 'scheduled' | 'system';
      requestedCurrencyCodes: string[];
      startedAt: Date;
      triggeredByUserId?: string;
    }
  ) {
    try {
      return await tx.idBusinessV2PurchaseRateFetchRun.create({
        data: {
          id: input.id,
          status: 'running',
          triggerType: input.triggerType,
          provider: 'exchange_rate_api',
          baseCurrency: 'CNY',
          requestedCurrencyCodes: input.requestedCurrencyCodes,
          startedAt: input.startedAt,
          triggeredByUserId: input.triggerType === 'manual' ? input.triggeredByUserId : null
        },
        select: { id: true }
      });
    } catch (error) {
      if (isPrismaErrorCode(error, 'P2002')) {
        throw new IdBusinessV2PurchaseRateRunLockedError();
      }
      throw error;
    }
  }

  recoverStaleRuns(tx: V2CommandTransaction, staleBefore: Date, finishedAt: Date) {
    return tx.idBusinessV2PurchaseRateFetchRun.updateMany({
      where: { status: 'running', startedAt: { lte: staleBefore } },
      data: {
        status: 'failed',
        finishedAt,
        errorCode: 'purchase_rate_run_timeout_recovered',
        errorMessage: '收购汇率采集任务超时，系统已自动关闭运行锁',
        errorRetryable: true
      }
    });
  }

  markRunFailed(
    tx: V2CommandTransaction,
    runId: string,
    input: {
      finishedAt: Date;
      attemptCount: number;
      errorCode: string;
      errorMessage: string;
      errorRetryable: boolean;
    }
  ) {
    return tx.idBusinessV2PurchaseRateFetchRun.updateMany({
      where: { id: runId, status: 'running' },
      data: {
        status: 'failed',
        finishedAt: input.finishedAt,
        attemptCount: input.attemptCount,
        errorCode: input.errorCode,
        errorMessage: input.errorMessage,
        errorRetryable: input.errorRetryable
      }
    });
  }

  markRunPendingReview(
    tx: V2CommandTransaction,
    runId: string,
    input: {
      finishedAt: Date;
      attemptCount: number;
      providerUpdatedAt: Date;
      sourceContract: string;
      sourceReference: string;
      candidateQuotes: unknown;
      abnormalCurrencyCodes: string[];
      maximumChangeRate: string;
    }
  ) {
    return tx.idBusinessV2PurchaseRateFetchRun.updateMany({
      where: { id: runId, status: 'running' },
      data: {
        status: 'pending_review',
        finishedAt: input.finishedAt,
        attemptCount: input.attemptCount,
        providerUpdatedAt: input.providerUpdatedAt,
        sourceContract: input.sourceContract,
        sourceReference: input.sourceReference,
        candidateQuotes: input.candidateQuotes as Prisma.InputJsonValue,
        abnormalCurrencyCodes: input.abnormalCurrencyCodes,
        maximumChangeRate: input.maximumChangeRate
      }
    });
  }

  async publishRun(
    tx: V2CommandTransaction,
    runId: string,
    input: {
      finishedAt: Date;
      providerUpdatedAt: Date;
      attemptCount: number;
      sourceContract: string;
      sourceReference: string;
      maximumChangeRate: string | null;
      candidateQuotes: unknown;
      snapshots: Prisma.IdBusinessV2PurchaseRateSnapshotUncheckedCreateInput[];
      reviewedByUserId?: string;
      reviewedAt?: Date;
      reviewRemark?: string | null;
    }
  ) {
    await tx.idBusinessV2PurchaseRateSnapshot.createMany({ data: input.snapshots });
    return tx.idBusinessV2PurchaseRateFetchRun.update({
      where: { id: runId },
      data: {
        status: 'success',
        finishedAt: input.finishedAt,
        publishedAt: input.finishedAt,
        providerUpdatedAt: input.providerUpdatedAt,
        attemptCount: input.attemptCount,
        sourceContract: input.sourceContract,
        sourceReference: input.sourceReference,
        maximumChangeRate: input.maximumChangeRate,
        candidateQuotes: input.candidateQuotes as Prisma.InputJsonValue,
        reviewedByUserId: input.reviewedByUserId,
        reviewedAt: input.reviewedAt,
        reviewRemark: input.reviewRemark
      },
      include: RUN_INCLUDE
    });
  }

  rejectRun(
    tx: V2CommandTransaction,
    runId: string,
    input: { reviewedByUserId: string; reviewedAt: Date; reviewRemark: string | null }
  ) {
    return tx.idBusinessV2PurchaseRateFetchRun.updateMany({
      where: { id: runId, status: 'pending_review' },
      data: {
        status: 'rejected',
        reviewedByUserId: input.reviewedByUserId,
        reviewedAt: input.reviewedAt,
        reviewRemark: input.reviewRemark
      }
    });
  }

  claimPendingReview(
    tx: V2CommandTransaction,
    runId: string,
    input: { reviewedByUserId: string; reviewedAt: Date; reviewRemark: string | null }
  ) {
    return tx.idBusinessV2PurchaseRateFetchRun.updateMany({
      where: { id: runId, status: 'pending_review' },
      data: {
        status: 'success',
        reviewedByUserId: input.reviewedByUserId,
        reviewedAt: input.reviewedAt,
        reviewRemark: input.reviewRemark
      }
    });
  }

  claimRunningForPublish(tx: V2CommandTransaction, runId: string) {
    return tx.idBusinessV2PurchaseRateFetchRun.updateMany({
      where: { id: runId, status: 'running' },
      data: { status: 'success' }
    });
  }

  findRun(id: string) {
    return this.prisma.idBusinessV2PurchaseRateFetchRun.findUnique({
      where: { id },
      include: RUN_INCLUDE
    });
  }

  findRunInTransaction(tx: V2CommandTransaction, id: string) {
    return tx.idBusinessV2PurchaseRateFetchRun.findUnique({ where: { id } });
  }

  findLatestRun() {
    return this.prisma.idBusinessV2PurchaseRateFetchRun.findFirst({
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      include: RUN_INCLUDE
    });
  }

  findRunningRun() {
    return this.prisma.idBusinessV2PurchaseRateFetchRun.findFirst({
      where: { status: 'running' },
      orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
      include: RUN_INCLUDE
    });
  }

  async listRuns(input: {
    status?: 'running' | 'success' | 'failed' | 'pending_review' | 'rejected';
    skip: number;
    take: number;
  }) {
    const where: Prisma.IdBusinessV2PurchaseRateFetchRunWhereInput = { status: input.status };
    const [rows, total] = await Promise.all([
      this.prisma.idBusinessV2PurchaseRateFetchRun.findMany({
        where,
        skip: input.skip,
        take: input.take,
        orderBy: [{ startedAt: 'desc' }, { id: 'desc' }],
        include: RUN_INCLUDE
      }),
      this.prisma.idBusinessV2PurchaseRateFetchRun.count({ where })
    ]);
    return [rows, total] as const;
  }

  async listSnapshots(input: { currencyCode?: string; skip: number; take: number }) {
    const where: Prisma.IdBusinessV2PurchaseRateSnapshotWhereInput = {
      currencyCode: input.currencyCode
    };
    const [rows, total] = await Promise.all([
      this.prisma.idBusinessV2PurchaseRateSnapshot.findMany({
        where,
        skip: input.skip,
        take: input.take,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: {
          currency: { select: { nameCn: true, displayName: true } },
          createdBy: { select: OPERATOR_SELECT }
        }
      }),
      this.prisma.idBusinessV2PurchaseRateSnapshot.count({ where })
    ]);
    return [rows, total] as const;
  }

  private mapSettings(row: {
    autoEnabled: boolean;
    intervalMinutes: number;
    staleMinutes: number;
    abnormalChangeRate: Prisma.Decimal;
    nextRunAt: Date | null;
    updatedByUserId: string | null;
    createdAt: Date;
    updatedAt: Date;
  }): IdBusinessV2PurchaseRateSettingsRecord {
    return {
      ...row,
      abnormalChangeRate: Rate8.from(row.abnormalChangeRate.toString())
    };
  }
}

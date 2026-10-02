import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { V2CommandTransaction } from '../../runtime/public-api';
import {
  GOOGLE_SHEETS_CHANGE_DELAY_MS,
  GOOGLE_SHEETS_SOURCE_SCOPES
} from '../id-business-v2-google-sheets-sync-policy';
import type { GoogleSheetsReportRetention } from '../id-business-v2-google-sheets-retention';
import { loadGoogleSheetsReportSource } from './id-business-v2-google-sheets-report-source';
export type {
  IdBusinessV2GoogleSheetsOrderRow,
  IdBusinessV2GoogleSheetsGiftCardRow,
  IdBusinessV2GoogleSheetsRenewalRow,
  IdBusinessV2GoogleSheetsFinanceRow
} from './id-business-v2-google-sheets-detail.select';

type GoogleSheetsSyncPersistenceClient = Pick<V2CommandTransaction, 'idBusinessV2GoogleSheetsSync'>;

export interface GoogleSheetsRunGuard {
  leaseId: string;
  clientId?: string;
  clientSecretEncrypted?: string;
  refreshTokenEncrypted?: string;
}

@Injectable()
export class IdBusinessV2GoogleSheetsSyncRepository {
  constructor(private readonly prisma: PrismaService) {}

  getConfiguration(client: GoogleSheetsSyncPersistenceClient = this.prisma) {
    return client.idBusinessV2GoogleSheetsSync.findUnique({ where: { id: 1 } });
  }

  findConfigurationByStateHash(stateHash: string) {
    return this.prisma.idBusinessV2GoogleSheetsSync.findUnique({
      where: { oauthStateHash: stateHash }
    });
  }

  saveConfiguration(
    input: Prisma.IdBusinessV2GoogleSheetsSyncUncheckedCreateInput,
    client: GoogleSheetsSyncPersistenceClient = this.prisma
  ) {
    const data: Prisma.IdBusinessV2GoogleSheetsSyncUncheckedCreateInput = {
      ...input,
      id: undefined
    };
    return client.idBusinessV2GoogleSheetsSync.upsert({
      where: { id: 1 },
      create: { ...data, id: 1 },
      update: data
    });
  }

  updateConfiguration(
    input: Prisma.IdBusinessV2GoogleSheetsSyncUncheckedUpdateInput,
    client: GoogleSheetsSyncPersistenceClient = this.prisma
  ) {
    return client.idBusinessV2GoogleSheetsSync.update({ where: { id: 1 }, data: input });
  }

  async updateConfigurationIfCurrent(
    where: Prisma.IdBusinessV2GoogleSheetsSyncWhereInput,
    input: Prisma.IdBusinessV2GoogleSheetsSyncUncheckedUpdateInput,
    client: GoogleSheetsSyncPersistenceClient = this.prisma
  ) {
    const result = await client.idBusinessV2GoogleSheetsSync.updateMany({
      where: { ...where, id: 1 },
      data: input
    });
    return result.count === 1;
  }

  private currentRunWhere(guard: GoogleSheetsRunGuard) {
    return {
      id: 1,
      enabled: true,
      runLeaseId: guard.leaseId,
      runLeaseExpiresAt: { gt: new Date() },
      googleOAuthClientId: guard.clientId,
      clientSecretEncrypted: guard.clientSecretEncrypted,
      refreshTokenEncrypted: guard.refreshTokenEncrypted
    } satisfies Prisma.IdBusinessV2GoogleSheetsSyncWhereInput;
  }

  updateRunIfCurrent(
    guard: GoogleSheetsRunGuard,
    input: Prisma.IdBusinessV2GoogleSheetsSyncUncheckedUpdateInput
  ) {
    return this.updateConfigurationIfCurrent(this.currentRunWhere(guard), input);
  }

  async hasCurrentLease(guard: GoogleSheetsRunGuard) {
    return (
      (await this.prisma.idBusinessV2GoogleSheetsSync.count({
        where: this.currentRunWhere(guard)
      })) === 1
    );
  }

  async acquireLease(leaseId: string, now: Date, expiresAt: Date, force = false) {
    const result = await this.prisma.idBusinessV2GoogleSheetsSync.updateMany({
      where: {
        id: 1,
        enabled: true,
        refreshTokenEncrypted: { not: null },
        ...(!force
          ? {
              AND: [
                {
                  OR: [
                    { lastAttemptAt: null },
                    {
                      lastAttemptAt: {
                        lte: new Date(now.getTime() - GOOGLE_SHEETS_CHANGE_DELAY_MS)
                      }
                    }
                  ]
                }
              ]
            }
          : {}),
        OR: [{ runLeaseId: null }, { runLeaseExpiresAt: { lt: now } }]
      },
      data: { lastAttemptAt: now, runLeaseExpiresAt: expiresAt, runLeaseId: leaseId }
    });
    return result.count === 1;
  }

  releaseLease(leaseId: string) {
    return this.prisma.idBusinessV2GoogleSheetsSync.updateMany({
      where: { id: 1, runLeaseId: leaseId },
      data: { runLeaseExpiresAt: null, runLeaseId: null }
    });
  }

  async listSourceVersions() {
    const rows = await this.prisma.idBusinessV2ScopeVersion.findMany({
      where: { scope: { in: [...GOOGLE_SHEETS_SOURCE_SCOPES] } },
      orderBy: { scope: 'asc' },
      select: { scope: true, version: true }
    });
    return Object.fromEntries(rows.map((row) => [row.scope, row.version.toString()]));
  }

  loadReportSource(retention: GoogleSheetsReportRetention = { records: {} }) {
    return this.prisma.$transaction((tx) => loadGoogleSheetsReportSource(tx, retention), {
      isolationLevel: 'RepeatableRead',
      timeout: 60_000
    });
  }
}

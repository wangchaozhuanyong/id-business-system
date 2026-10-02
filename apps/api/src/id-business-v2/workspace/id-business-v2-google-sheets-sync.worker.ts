import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { V2_GOOGLE_SHEETS_REPORT_NAMES } from '@apple-business/shared';
import type { Subscription } from 'rxjs';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { V2ChangeEventPublisher } from '../../common/prisma/v2-change-event.publisher';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  toV2JsonDocument
} from '../runtime/public-api';
import { prepareIdBusinessV2GoogleSheetsReports } from './id-business-v2-google-sheets-report';
import {
  GOOGLE_SHEETS_RETENTION_KEY,
  readGoogleSheetsRetention,
  writeGoogleSheetsRetention
} from './id-business-v2-google-sheets-retention';
import { IdBusinessV2GoogleSheetsSyncService } from './id-business-v2-google-sheets-sync.service';
import {
  IdBusinessV2GoogleSheetsSyncRepository,
  type GoogleSheetsRunGuard
} from './persistence/id-business-v2-google-sheets-sync.repository';
import { IdBusinessV2GoogleApiError } from './providers/id-business-v2-google-api-http';
import { IdBusinessV2GoogleSheetsClient } from './providers/id-business-v2-google-sheets.client';
import { IdBusinessV2GoogleSheetsOAuthClient } from './providers/id-business-v2-google-sheets-oauth.client';
import {
  affectsGoogleSheetsReports,
  GOOGLE_SHEETS_CHANGE_DELAY_MS,
  GOOGLE_SHEETS_RECONCILE_MS,
  GOOGLE_SHEETS_REPORT_VERSION
} from './id-business-v2-google-sheets-sync-policy';

const LEASE_MS = 5 * 60_000;
const MAX_RETRY_MS = 15 * 60_000;

@Injectable()
export class IdBusinessV2GoogleSheetsSyncWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IdBusinessV2GoogleSheetsSyncWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private localRunning = false;
  private changeTimer: NodeJS.Timeout | null = null;
  private changeSubscription: Subscription | null = null;
  private pendingChange = false;
  private stopped = false;
  private nextAutomaticRunAt = 0;
  private consecutiveFailures = 0;

  constructor(
    private readonly repository: IdBusinessV2GoogleSheetsSyncRepository,
    private readonly service: IdBusinessV2GoogleSheetsSyncService,
    private readonly encryption: FieldEncryptionService,
    private readonly googleOAuth: IdBusinessV2GoogleSheetsOAuthClient,
    private readonly googleSheets: IdBusinessV2GoogleSheetsClient,
    private readonly transactionManager: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService,
    private readonly changePublisher: V2ChangeEventPublisher
  ) {}

  onModuleInit() {
    this.stopped = false;
    this.changeSubscription = this.changePublisher.events().subscribe((message) => {
      if (
        message.type === 'reconcile' ||
        message.event.scopes.some(({ scope }) => affectsGoogleSheetsReports(scope))
      ) {
        this.scheduleChange();
      }
    });
    this.timer = setInterval(() => {
      this.runAutomatic();
    }, GOOGLE_SHEETS_RECONCILE_MS);
    this.timer.unref?.();
    this.scheduleChange();
  }

  onModuleDestroy() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    if (this.changeTimer) clearTimeout(this.changeTimer);
    this.changeSubscription?.unsubscribe();
    this.changeSubscription = null;
    this.changeTimer = null;
    this.timer = null;
  }

  async runNow(force: boolean, operator?: AuthenticatedUser, requestId = 'google-sheets-sync-run') {
    if (operator) await this.service.getStatus(operator);
    if (this.localRunning) return { skipped: true, status: await this.service.getSystemStatus() };
    if (!force && Date.now() < this.nextAutomaticRunAt)
      return { skipped: true, status: await this.service.getSystemStatus() };
    const previous = await this.repository.getConfiguration();
    if (
      !previous?.enabled ||
      !previous.googleOAuthClientId ||
      !previous.clientSecretEncrypted ||
      !previous.refreshTokenEncrypted
    )
      return { skipped: true, status: await this.service.getSystemStatus() };
    const folderId = this.service.destinationFolderId();
    const versions = {
      ...(await this.repository.listSourceVersions()),
      'report-schema': GOOGLE_SHEETS_REPORT_VERSION,
      'drive-destination': createHash('sha256')
        .update(folderId ?? 'root')
        .digest('hex')
    };
    if (
      !force &&
      this.versionsEqual(previous.sourceVersions, versions) &&
      previous.spreadsheetIdEncrypted
    )
      return { skipped: true, status: await this.service.getSystemStatus() };
    const leaseId = randomUUID();
    const now = new Date();
    const acquired = await this.repository.acquireLease(
      leaseId,
      now,
      new Date(now.getTime() + LEASE_MS),
      force
    );
    if (!acquired) return { skipped: true, status: await this.service.getSystemStatus() };
    this.localRunning = true;
    this.nextAutomaticRunAt = Date.now() + GOOGLE_SHEETS_CHANGE_DELAY_MS;
    let succeeded = false;
    let runGuard: GoogleSheetsRunGuard = { leaseId };
    try {
      const record = await this.repository.getConfiguration();
      if (
        !record?.googleOAuthClientId ||
        !record.clientSecretEncrypted ||
        !record.refreshTokenEncrypted
      ) {
        return { skipped: true, status: await this.service.getSystemStatus() };
      }
      runGuard = {
        ...runGuard,
        clientId: record.googleOAuthClientId,
        clientSecretEncrypted: record.clientSecretEncrypted,
        refreshTokenEncrypted: record.refreshTokenEncrypted
      };
      if (
        !force &&
        this.versionsEqual(record.sourceVersions, versions) &&
        record.spreadsheetIdEncrypted
      ) {
        return { skipped: true, status: await this.service.getSystemStatus() };
      }
      const clientSecret = this.service.decryptSecret(
        record.clientSecretEncrypted,
        'Google OAuth 客户端密钥'
      );
      const refreshToken = this.service.decryptSecret(
        record.refreshTokenEncrypted,
        'Google OAuth 刷新令牌'
      );
      const token = await this.googleOAuth.refresh({
        clientId: record.googleOAuthClientId,
        clientSecret,
        refreshToken
      });
      if (!(await this.repository.hasCurrentLease(runGuard))) {
        return { skipped: true, status: await this.service.getSystemStatus() };
      }
      let spreadsheetId = record.spreadsheetIdEncrypted
        ? this.service.decryptSecret(record.spreadsheetIdEncrypted, 'Google 表格文件编号')
        : null;
      if (!spreadsheetId) {
        spreadsheetId = await this.googleSheets.createSpreadsheet(
          token.accessToken,
          V2_GOOGLE_SHEETS_REPORT_NAMES,
          folderId
        );
        const encryptedSpreadsheetId = this.encryption.encrypt(spreadsheetId);
        if (!encryptedSpreadsheetId) throw new Error('Google 表格文件编号加密失败');
        const saved = await this.repository.updateRunIfCurrent(runGuard, {
          spreadsheetIdEncrypted: encryptedSpreadsheetId
        });
        if (!saved) return { skipped: true, status: await this.service.getSystemStatus() };
      }
      if (folderId) {
        if (!(await this.repository.hasCurrentLease(runGuard)))
          return { skipped: true, status: await this.service.getSystemStatus() };
        await this.googleSheets.ensureSpreadsheetInFolder(
          token.accessToken,
          spreadsheetId,
          folderId
        );
      }
      if (!(await this.repository.hasCurrentLease(runGuard)))
        return { skipped: true, status: await this.service.getSystemStatus() };
      await this.googleSheets.ensureReportSheets(
        token.accessToken,
        spreadsheetId,
        V2_GOOGLE_SHEETS_REPORT_NAMES
      );
      const retention = readGoogleSheetsRetention(record.sourceVersions);
      const source = await this.repository.loadReportSource(retention);
      const prepared = prepareIdBusinessV2GoogleSheetsReports(source, source.retention);
      if (!(await this.repository.hasCurrentLease(runGuard))) {
        return { skipped: true, status: await this.service.getSystemStatus() };
      }
      await this.googleSheets.replaceReports(
        token.accessToken,
        spreadsheetId,
        prepared.reports,
        () => this.repository.hasCurrentLease(runGuard)
      );
      succeeded = await this.repository.updateRunIfCurrent(runGuard, {
        lastErrorCode: null,
        lastErrorMessage: null,
        lastSucceededAt: new Date(),
        sourceVersions: {
          ...versions,
          [GOOGLE_SHEETS_RETENTION_KEY]: writeGoogleSheetsRetention(prepared.retention)
        }
      });
      this.consecutiveFailures = 0;
      if (succeeded && operator?.id) await this.auditManualRun(operator, requestId);
    } catch (error) {
      this.recordFailure();
      const normalized = this.normalizeError(error);
      await this.repository.updateRunIfCurrent(runGuard, {
        ...(normalized.status === 404 && normalized.code !== 'GOOGLE_DRIVE_FOLDER_UNAVAILABLE'
          ? { spreadsheetIdEncrypted: null }
          : {}),
        lastErrorCode: normalized.code,
        lastErrorMessage: normalized.message
      });
      this.logger.warn(`Google 表格同步失败：${normalized.code}`);
    } finally {
      this.localRunning = false;
      await this.repository.releaseLease(leaseId);
      if (this.pendingChange && !this.stopped) this.scheduleChange();
    }
    return { skipped: false, status: await this.service.getSystemStatus(), succeeded };
  }

  private scheduleChange() {
    this.pendingChange = true;
    if (this.changeTimer || this.localRunning || this.stopped) return;
    const delay = Math.max(GOOGLE_SHEETS_CHANGE_DELAY_MS, this.nextAutomaticRunAt - Date.now());
    this.changeTimer = setTimeout(() => {
      this.changeTimer = null;
      if (this.localRunning) return;
      this.pendingChange = false;
      this.runAutomatic();
    }, delay);
    this.changeTimer.unref?.();
  }

  private runAutomatic() {
    if (this.stopped || this.localRunning || Date.now() < this.nextAutomaticRunAt) return;
    void this.runNow(false).catch(() => {
      this.recordFailure();
      this.logger.warn('Google 表格定时检查失败，将在下次检查时重试');
    });
  }

  private recordFailure() {
    this.consecutiveFailures += 1;
    this.nextAutomaticRunAt =
      Date.now() +
      Math.min(
        MAX_RETRY_MS,
        GOOGLE_SHEETS_RECONCILE_MS * 2 ** Math.min(this.consecutiveFailures - 1, 5)
      );
  }

  private versionsEqual(saved: unknown, current: Record<string, string>) {
    if (!saved || typeof saved !== 'object' || Array.isArray(saved)) return false;
    const record = saved as Record<string, unknown>;
    return Object.keys(current).every((key) => record[key] === current[key]);
  }

  private normalizeError(error: unknown) {
    if (error instanceof IdBusinessV2GoogleApiError) {
      return { code: error.code, message: error.message.slice(0, 500), status: error.status };
    }
    return {
      code: 'SYNC_FAILED',
      message: '同步暂时失败，系统会自动重试；如持续失败请重新授权。',
      status: undefined
    };
  }

  private auditManualRun(operator: AuthenticatedUser, requestId: string) {
    return this.transactionManager.execute(
      (tx) =>
        this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.google_sheets_sync.manual_run',
          objectType: 'id_business_v2_google_sheets_sync',
          objectId: '1',
          afterData: toV2JsonDocument({ succeeded: true }),
          remark: '已手动执行 Google 表格同步'
        }),
      { changedScopes: ['workspace'], operator, requestId, retryMode: 'none' }
    );
  }
}

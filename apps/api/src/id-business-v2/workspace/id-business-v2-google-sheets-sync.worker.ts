import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  toV2JsonDocument
} from '../runtime/public-api';
import { buildIdBusinessV2GoogleSheetsReports } from './id-business-v2-google-sheets-report';
import { IdBusinessV2GoogleSheetsSyncService } from './id-business-v2-google-sheets-sync.service';
import { IdBusinessV2GoogleSheetsSyncRepository } from './persistence/id-business-v2-google-sheets-sync.repository';
import { IdBusinessV2GoogleApiError } from './providers/id-business-v2-google-api-http';
import { IdBusinessV2GoogleSheetsClient } from './providers/id-business-v2-google-sheets.client';
import { IdBusinessV2GoogleSheetsOAuthClient } from './providers/id-business-v2-google-sheets-oauth.client';

const TICK_MS = 30_000;
const LEASE_MS = 5 * 60_000;

@Injectable()
export class IdBusinessV2GoogleSheetsSyncWorker implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(IdBusinessV2GoogleSheetsSyncWorker.name);
  private timer: NodeJS.Timeout | null = null;
  private localRunning = false;

  constructor(
    private readonly repository: IdBusinessV2GoogleSheetsSyncRepository,
    private readonly service: IdBusinessV2GoogleSheetsSyncService,
    private readonly encryption: FieldEncryptionService,
    private readonly googleOAuth: IdBusinessV2GoogleSheetsOAuthClient,
    private readonly googleSheets: IdBusinessV2GoogleSheetsClient,
    private readonly transactionManager: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService
  ) {}

  onModuleInit() {
    this.timer = setInterval(() => void this.runNow(false), TICK_MS);
    this.timer.unref?.();
  }

  onModuleDestroy() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  async runNow(force: boolean, operator?: AuthenticatedUser, requestId = 'google-sheets-sync-run') {
    if (operator) await this.service.getStatus(operator);
    if (this.localRunning) return { skipped: true, status: await this.service.getSystemStatus() };
    const leaseId = randomUUID();
    const now = new Date();
    const acquired = await this.repository.acquireLease(
      leaseId,
      now,
      new Date(now.getTime() + LEASE_MS)
    );
    if (!acquired) return { skipped: true, status: await this.service.getSystemStatus() };
    this.localRunning = true;
    let succeeded = false;
    try {
      const record = await this.repository.getConfiguration();
      if (
        !record?.googleOAuthClientId ||
        !record.clientSecretEncrypted ||
        !record.refreshTokenEncrypted
      ) {
        return { skipped: true, status: await this.service.getSystemStatus() };
      }
      const versions = await this.repository.listSourceVersions();
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
      let spreadsheetId = record.spreadsheetIdEncrypted
        ? this.service.decryptSecret(record.spreadsheetIdEncrypted, 'Google 表格文件编号')
        : null;
      if (!spreadsheetId) {
        spreadsheetId = await this.googleSheets.createSpreadsheet(token.accessToken, [
          '订单',
          '加卡',
          '续费',
          '财务汇总'
        ]);
        const encryptedSpreadsheetId = this.encryption.encrypt(spreadsheetId);
        if (!encryptedSpreadsheetId) throw new Error('Google 表格文件编号加密失败');
        await this.repository.updateConfiguration({
          spreadsheetIdEncrypted: encryptedSpreadsheetId
        });
      }
      const source = await this.repository.loadReportSource();
      const reports = buildIdBusinessV2GoogleSheetsReports(source);
      await this.googleSheets.replaceReports(token.accessToken, spreadsheetId, reports);
      await this.repository.updateConfiguration({
        lastErrorCode: null,
        lastErrorMessage: null,
        lastSucceededAt: new Date(),
        sourceVersions: versions
      });
      succeeded = true;
      if (operator?.id) await this.auditManualRun(operator, requestId);
    } catch (error) {
      const normalized = this.normalizeError(error);
      await this.repository.updateConfiguration({
        ...(normalized.status === 404 ? { spreadsheetIdEncrypted: null, sourceVersions: {} } : {}),
        lastErrorCode: normalized.code,
        lastErrorMessage: normalized.message
      });
      this.logger.warn(`Google 表格同步失败：${normalized.code}`);
    } finally {
      this.localRunning = false;
      await this.repository.releaseLease(leaseId);
    }
    return { skipped: false, status: await this.service.getSystemStatus(), succeeded };
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

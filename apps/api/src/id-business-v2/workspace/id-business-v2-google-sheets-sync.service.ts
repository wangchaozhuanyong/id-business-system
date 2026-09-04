import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  ServiceUnavailableException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  V2_GOOGLE_SHEETS_REPORT_NAMES,
  type StartV2GoogleSheetsAuthorizationResult,
  type V2GoogleSheetsSyncStatus
} from '@apple-business/shared';
import { randomBytes } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  toV2JsonDocument
} from '../runtime/public-api';
import type {
  SaveIdBusinessV2GoogleSheetsSyncConfigDto,
  UpdateIdBusinessV2GoogleSheetsSyncStateDto
} from './dto/id-business-v2-google-sheets-sync.dto';
import { IdBusinessV2GoogleSheetsSyncRepository } from './persistence/id-business-v2-google-sheets-sync.repository';
import { IdBusinessV2GoogleSheetsClient } from './providers/id-business-v2-google-sheets.client';
import { IdBusinessV2GoogleSheetsOAuthClient } from './providers/id-business-v2-google-sheets-oauth.client';

const GOOGLE_CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/;
const GOOGLE_STATE_TTL_MS = 15 * 60 * 1000;
const SYNC_INTERVAL_SECONDS = 30;
const EXCLUDED_DATA = [
  'ID 密码与密保',
  '邮箱授权信息与应用专用密码',
  '完整礼品卡号',
  '手机号与其他联系方式',
  '访问令牌、刷新令牌和审计敏感内容'
];

@Injectable()
export class IdBusinessV2GoogleSheetsSyncService {
  constructor(
    private readonly repository: IdBusinessV2GoogleSheetsSyncRepository,
    private readonly transactionManager: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService,
    private readonly encryption: FieldEncryptionService,
    private readonly config: ConfigService,
    private readonly googleOAuth: IdBusinessV2GoogleSheetsOAuthClient,
    private readonly googleSheets: IdBusinessV2GoogleSheetsClient
  ) {}

  async getStatus(operator?: AuthenticatedUser): Promise<V2GoogleSheetsSyncStatus> {
    this.requireAdmin(operator);
    return this.getSystemStatus();
  }

  async getSystemStatus(): Promise<V2GoogleSheetsSyncStatus> {
    const record = await this.repository.getConfiguration();
    const spreadsheetId = record?.spreadsheetIdEncrypted
      ? this.decrypt(record.spreadsheetIdEncrypted, 'Google 表格文件编号')
      : null;
    return {
      authorized: Boolean(record?.refreshTokenEncrypted),
      callbackUrl: this.callbackUrl(),
      clientId: record?.googleOAuthClientId ?? null,
      configured: Boolean(record?.googleOAuthClientId && record.clientSecretEncrypted),
      enabled: record?.enabled ?? false,
      excludedData: [...EXCLUDED_DATA],
      lastAttemptAt: record?.lastAttemptAt?.toISOString() ?? null,
      lastErrorMessage: record?.lastErrorMessage ?? null,
      lastSucceededAt: record?.lastSucceededAt?.toISOString() ?? null,
      reportNames: [...V2_GOOGLE_SHEETS_REPORT_NAMES],
      spreadsheetUrl: spreadsheetId ? this.googleSheets.spreadsheetUrl(spreadsheetId) : null,
      syncIntervalSeconds: SYNC_INTERVAL_SECONDS,
      syncing: Boolean(record?.runLeaseExpiresAt && record.runLeaseExpiresAt.getTime() > Date.now())
    };
  }

  async saveConfig(
    dto: SaveIdBusinessV2GoogleSheetsSyncConfigDto,
    operator?: AuthenticatedUser,
    requestId = 'google-sheets-sync-config-save'
  ) {
    const userId = this.requireAdmin(operator);
    const clientId = this.normalizeString(dto.clientId, '请输入 Google OAuth 客户端 ID', 255);
    if (!GOOGLE_CLIENT_ID_PATTERN.test(clientId)) {
      throw new BadRequestException('Google OAuth 客户端 ID 格式不正确');
    }
    const secretInput = this.normalizeOptionalSecret(dto.clientSecret);

    await this.transactionManager.execute(
      async (tx) => {
        const before = await this.repository.getConfiguration(tx);
        if (!secretInput && !before?.clientSecretEncrypted) {
          throw new BadRequestException('首次配置时请输入 Google OAuth 客户端密钥');
        }
        const changed = before?.googleOAuthClientId !== clientId || Boolean(secretInput);
        await this.repository.saveConfiguration(
          {
            id: 1,
            enabled: changed ? false : (before?.enabled ?? false),
            googleOAuthClientId: clientId,
            clientSecretEncrypted: secretInput
              ? this.encryption.encrypt(secretInput)
              : (before?.clientSecretEncrypted ?? null),
            ...(changed
              ? {
                  lastErrorCode: null,
                  lastErrorMessage: null,
                  oauthStateExpiresAt: null,
                  oauthStateHash: null,
                  oauthVerifierEncrypted: null,
                  refreshTokenEncrypted: null,
                  spreadsheetIdEncrypted: null,
                  sourceVersions: {}
                }
              : {})
          },
          tx
        );
        await this.audit.append(tx, {
          userId,
          module: 'id_business_v2',
          action: 'id_business_v2.google_sheets_sync.configure',
          objectType: 'id_business_v2_google_sheets_sync',
          objectId: '1',
          beforeData: toV2JsonDocument({ configured: Boolean(before?.googleOAuthClientId) }),
          afterData: toV2JsonDocument({ configured: true, authorizationCleared: changed }),
          remark: '已更新 Google 表格同步配置'
        });
      },
      { changedScopes: ['workspace'], operator, requestId, retryMode: 'none' }
    );
    return this.getStatus(operator);
  }

  async startAuthorization(
    operator?: AuthenticatedUser
  ): Promise<StartV2GoogleSheetsAuthorizationResult> {
    this.requireAdmin(operator);
    const record = await this.repository.getConfiguration();
    if (!record?.googleOAuthClientId || !record.clientSecretEncrypted) {
      throw new BadRequestException('请先保存 Google OAuth 客户端配置');
    }
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const stateHash = this.encryption.hash(state);
    const verifierEncrypted = this.encryption.encrypt(verifier);
    if (!stateHash || !verifierEncrypted) {
      throw new ServiceUnavailableException('Google 授权状态生成失败');
    }
    const expiresAt = new Date(Date.now() + GOOGLE_STATE_TTL_MS);
    await this.repository.updateConfiguration({
      oauthStateExpiresAt: expiresAt,
      oauthStateHash: stateHash,
      oauthVerifierEncrypted: verifierEncrypted
    });
    return {
      authorizationUrl: this.googleOAuth.createAuthorizationUrl({
        callbackUrl: this.callbackUrl(),
        challenge: this.googleOAuth.createCodeChallenge(verifier),
        clientId: record.googleOAuthClientId,
        state
      }),
      expiresAt: expiresAt.toISOString()
    };
  }

  async completeAuthorization(input: { code?: unknown; error?: unknown; state?: unknown }) {
    if (typeof input.state !== 'string' || input.state.length < 20 || input.state.length > 200) {
      return false;
    }
    const stateHash = this.encryption.hash(input.state);
    if (!stateHash) return false;
    const record = await this.repository.findConfigurationByStateHash(stateHash);
    if (
      !record?.googleOAuthClientId ||
      !record.clientSecretEncrypted ||
      !record.oauthVerifierEncrypted ||
      !record.oauthStateExpiresAt ||
      record.oauthStateExpiresAt.getTime() <= Date.now()
    ) {
      return false;
    }
    const verifier = this.decrypt(record.oauthVerifierEncrypted, 'Google 授权状态');
    const clientSecret = this.decrypt(record.clientSecretEncrypted, 'Google OAuth 客户端密钥');
    await this.repository.updateConfiguration({
      oauthStateExpiresAt: null,
      oauthStateHash: null,
      oauthVerifierEncrypted: null
    });
    if (typeof input.error === 'string' && input.error) return false;
    if (typeof input.code !== 'string' || input.code.length < 10 || input.code.length > 4096) {
      return false;
    }
    try {
      const token = await this.googleOAuth.exchangeCode({
        callbackUrl: this.callbackUrl(),
        clientId: record.googleOAuthClientId,
        clientSecret,
        code: input.code,
        verifier
      });
      if (!token.refreshToken) return false;
      const encryptedRefreshToken = this.encryption.encrypt(token.refreshToken);
      if (!encryptedRefreshToken) return false;
      await this.transactionManager.execute(
        async (tx) => {
          await this.repository.updateConfiguration(
            {
              enabled: true,
              lastErrorCode: null,
              lastErrorMessage: null,
              refreshTokenEncrypted: encryptedRefreshToken,
              sourceVersions: {},
              spreadsheetIdEncrypted: null
            },
            tx
          );
          await this.audit.append(tx, {
            module: 'id_business_v2',
            action: 'id_business_v2.google_sheets_sync.authorize',
            objectType: 'id_business_v2_google_sheets_sync',
            objectId: '1',
            afterData: toV2JsonDocument({ authorized: true, enabled: true }),
            remark: '已完成 Google 表格同步授权'
          });
        },
        {
          changedScopes: ['workspace'],
          requestId: 'google-sheets-sync-oauth-complete',
          retryMode: 'none'
        }
      );
      return true;
    } catch {
      return false;
    }
  }

  async updateState(
    dto: UpdateIdBusinessV2GoogleSheetsSyncStateDto,
    operator?: AuthenticatedUser,
    requestId = 'google-sheets-sync-state-update'
  ) {
    const userId = this.requireAdmin(operator);
    if (typeof dto.enabled !== 'boolean') throw new BadRequestException('同步状态格式不正确');
    const enabled = dto.enabled;
    const before = await this.repository.getConfiguration();
    if (!before?.refreshTokenEncrypted) throw new BadRequestException('请先完成 Google 授权');
    await this.transactionManager.execute(
      async (tx) => {
        await this.repository.updateConfiguration({ enabled }, tx);
        await this.audit.append(tx, {
          userId,
          module: 'id_business_v2',
          action: 'id_business_v2.google_sheets_sync.state_update',
          objectType: 'id_business_v2_google_sheets_sync',
          objectId: '1',
          beforeData: toV2JsonDocument({ enabled: before.enabled }),
          afterData: toV2JsonDocument({ enabled }),
          remark: enabled ? '已开启 Google 表格自动同步' : '已暂停 Google 表格自动同步'
        });
      },
      { changedScopes: ['workspace'], operator, requestId, retryMode: 'none' }
    );
    return this.getStatus(operator);
  }

  async disconnect(operator?: AuthenticatedUser, requestId = 'google-sheets-sync-disconnect') {
    const userId = this.requireAdmin(operator);
    const before = await this.repository.getConfiguration();
    if (!before) return this.getStatus(operator);
    await this.transactionManager.execute(
      async (tx) => {
        await this.repository.updateConfiguration(
          {
            enabled: false,
            lastErrorCode: null,
            lastErrorMessage: null,
            oauthStateExpiresAt: null,
            oauthStateHash: null,
            oauthVerifierEncrypted: null,
            refreshTokenEncrypted: null,
            runLeaseExpiresAt: null,
            runLeaseId: null,
            sourceVersions: {},
            spreadsheetIdEncrypted: null
          },
          tx
        );
        await this.audit.append(tx, {
          userId,
          module: 'id_business_v2',
          action: 'id_business_v2.google_sheets_sync.disconnect',
          objectType: 'id_business_v2_google_sheets_sync',
          objectId: '1',
          beforeData: toV2JsonDocument({ authorized: Boolean(before.refreshTokenEncrypted) }),
          afterData: toV2JsonDocument({ authorized: false, enabled: false }),
          remark: '已断开 Google 表格同步；Google 网盘中的既有报表未删除'
        });
      },
      { changedScopes: ['workspace'], operator, requestId, retryMode: 'none' }
    );
    return this.getStatus(operator);
  }

  decryptSecret(value: string, field: string) {
    return this.decrypt(value, field);
  }

  private callbackUrl() {
    const publicUrl = this.config.get<string>('APP_PUBLIC_URL');
    if (!publicUrl) throw new ServiceUnavailableException('系统公开地址尚未配置');
    return new URL('/api/public/google-sheets-sync/oauth/callback', publicUrl).toString();
  }

  private requireAdmin(operator?: AuthenticatedUser) {
    if (!operator?.id) throw new BadRequestException('无法识别当前操作人');
    if (!operator.roles.includes('admin')) {
      throw new ForbiddenException('只有管理员可以管理 Google 表格同步');
    }
    return operator.id;
  }

  private normalizeString(value: unknown, message: string, maxLength: number) {
    if (typeof value !== 'string') throw new BadRequestException(message);
    const normalized = value.trim();
    if (!normalized || normalized.length > maxLength) throw new BadRequestException(message);
    return normalized;
  }

  private normalizeOptionalSecret(value: unknown) {
    if (value === undefined || value === null || value === '') return undefined;
    if (typeof value !== 'string' || value.trim().length < 6 || value.length > 500) {
      throw new BadRequestException('Google OAuth 客户端密钥格式不正确');
    }
    return value.trim();
  }

  private decrypt(value: string, field: string) {
    try {
      const decrypted = this.encryption.decrypt(value);
      if (!decrypted) throw new Error('empty');
      return decrypted;
    } catch {
      throw new ServiceUnavailableException(`${field}暂时无法解密`);
    }
  }
}

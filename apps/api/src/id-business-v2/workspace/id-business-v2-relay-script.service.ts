import {
  BadRequestException,
  ForbiddenException,
  Injectable,
  Logger,
  ServiceUnavailableException
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  type LoginV2RelayCloudBridgeResult,
  type StartV2RelayGoogleAuthorizationResult,
  type V2RelayConnectionStatus,
  type V2RelayDeploymentOptions,
  type V2RelayJobList
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
  LoginIdBusinessV2RelayCloudBridgeDto,
  SaveIdBusinessV2RelayGoogleOAuthDto
} from './dto/id-business-v2-relay-script.dto';
import {
  idBusinessV2RelayOptionsError,
  toIdBusinessV2RelayJob
} from './id-business-v2-relay-script.support';
import { IdBusinessV2RelayScriptRepository } from './persistence/id-business-v2-relay-script.repository';
import {
  ID_BUSINESS_V2_CLOUDBRIDGE_ORIGIN,
  IdBusinessV2RelayCloudBridgeClient,
  type IdBusinessV2CloudBridgeSession
} from './providers/id-business-v2-relay-cloudbridge.client';
import { IdBusinessV2RelayGoogleCloudClient } from './providers/id-business-v2-relay-google-cloud.client';
import {
  IdBusinessV2RelayGoogleOAuthClient,
  type IdBusinessV2GoogleOAuthToken
} from './providers/id-business-v2-relay-google-oauth.client';
import { IdBusinessV2RelayRemoteError } from './providers/id-business-v2-relay-http';

const GOOGLE_CLIENT_ID_PATTERN = /^[A-Za-z0-9._-]+\.apps\.googleusercontent\.com$/;
const GOOGLE_STATE_TTL_MS = 15 * 60 * 1000;

@Injectable()
export class IdBusinessV2RelayScriptService {
  private readonly logger = new Logger(IdBusinessV2RelayScriptService.name);

  constructor(
    private readonly repository: IdBusinessV2RelayScriptRepository,
    private readonly transactionManager: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService,
    private readonly encryption: FieldEncryptionService,
    private readonly config: ConfigService,
    private readonly googleOAuth: IdBusinessV2RelayGoogleOAuthClient,
    private readonly googleCloud: IdBusinessV2RelayGoogleCloudClient,
    private readonly cloudBridge: IdBusinessV2RelayCloudBridgeClient
  ) {}

  async getConnectionStatus(operator?: AuthenticatedUser): Promise<V2RelayConnectionStatus> {
    const userId = this.requireAdmin(operator);
    const connection = await this.repository.findConnectionByUser(userId);
    return {
      callbackUrl: this.callbackUrl(),
      cloudBridgeConnected: Boolean(connection?.cloudBridgeSessionEncrypted),
      cloudBridgeEmail: connection?.cloudBridgeEmail ?? null,
      cloudBridgeOrigin: ID_BUSINESS_V2_CLOUDBRIDGE_ORIGIN,
      googleAuthorized: Boolean(connection?.googleOAuthTokenEncrypted),
      googleEmail: connection?.googleEmail ?? null,
      googleOAuthConfigured: Boolean(connection?.googleOAuthClientId)
    };
  }

  async saveGoogleOAuth(
    dto: SaveIdBusinessV2RelayGoogleOAuthDto,
    operator?: AuthenticatedUser,
    requestId = 'workspace-relay-google-oauth-save'
  ): Promise<V2RelayConnectionStatus> {
    const userId = this.requireAdmin(operator);
    const clientId = this.normalizeString(dto.clientId, '请输入 Google OAuth 客户端 ID', 255);
    if (!GOOGLE_CLIENT_ID_PATTERN.test(clientId)) {
      throw new BadRequestException('Google OAuth 客户端 ID 格式不正确');
    }
    const secretInput =
      dto.clientSecret === undefined
        ? undefined
        : this.normalizeOptionalString(dto.clientSecret, 'Google OAuth 客户端密钥', 500);

    await this.transactionManager.execute(
      async (tx) => {
        const before = await this.repository.findConnectionByUser(userId, tx);
        const changed = before?.googleOAuthClientId !== clientId || secretInput !== undefined;
        const encryptedSecret =
          secretInput === undefined
            ? (before?.googleOAuthClientSecretEncrypted ?? null)
            : this.encryption.encrypt(secretInput);
        await this.repository.upsertConnection(
          userId,
          {
            googleOAuthClientId: clientId,
            googleOAuthClientSecretEncrypted: encryptedSecret,
            ...(changed
              ? {
                  googleEmail: null,
                  googleOAuthStateExpiresAt: null,
                  googleOAuthStateHash: null,
                  googleOAuthTokenEncrypted: null,
                  googleOAuthVerifierEncrypted: null
                }
              : {})
          },
          tx
        );
        await this.audit.append(tx, {
          userId,
          module: 'id_business_v2',
          action: 'id_business_v2.workspace_relay.google_oauth_configure',
          objectType: 'id_business_v2_relay_connection',
          objectId: before?.id ?? userId,
          beforeData: toV2JsonDocument({ configured: Boolean(before?.googleOAuthClientId) }),
          afterData: toV2JsonDocument({ configured: true, authorizationCleared: changed }),
          remark: '已更新中转脚本 Google OAuth 配置'
        });
      },
      { changedScopes: ['workspace'], operator, requestId, retryMode: 'none' }
    );
    return this.getConnectionStatus(operator);
  }

  async startGoogleAuthorization(
    operator?: AuthenticatedUser
  ): Promise<StartV2RelayGoogleAuthorizationResult> {
    const userId = this.requireAdmin(operator);
    const connection = await this.repository.findConnectionByUser(userId);
    if (!connection?.googleOAuthClientId) {
      throw new BadRequestException('请先保存 Google OAuth 客户端配置');
    }
    const state = randomBytes(32).toString('base64url');
    const verifier = randomBytes(48).toString('base64url');
    const stateHash = this.encryption.hash(state);
    const verifierEncrypted = this.encryption.encrypt(verifier);
    if (!stateHash || !verifierEncrypted)
      throw new ServiceUnavailableException('Google 授权状态生成失败');
    const expiresAt = new Date(Date.now() + GOOGLE_STATE_TTL_MS);
    await this.repository.updateConnection(connection.id, {
      googleOAuthStateExpiresAt: expiresAt,
      googleOAuthStateHash: stateHash,
      googleOAuthVerifierEncrypted: verifierEncrypted
    });
    return {
      authorizationUrl: this.googleOAuth.createAuthorizationUrl({
        callbackUrl: this.callbackUrl(),
        challenge: this.googleOAuth.createCodeChallenge(verifier),
        clientId: connection.googleOAuthClientId,
        state
      }),
      expiresAt: expiresAt.toISOString()
    };
  }

  async completeGoogleAuthorization(input: { code?: unknown; error?: unknown; state?: unknown }) {
    if (typeof input.state !== 'string' || input.state.length < 20 || input.state.length > 200) {
      return false;
    }
    const stateHash = this.encryption.hash(input.state);
    if (!stateHash) return false;
    const connection = await this.repository.findConnectionByStateHash(stateHash);
    if (
      !connection?.googleOAuthClientId ||
      !connection.googleOAuthVerifierEncrypted ||
      !connection.googleOAuthStateExpiresAt ||
      connection.googleOAuthStateExpiresAt.getTime() <= Date.now()
    ) {
      return false;
    }
    const verifier = this.decrypt(connection.googleOAuthVerifierEncrypted, 'Google 授权状态');
    const clientSecret = connection.googleOAuthClientSecretEncrypted
      ? this.decrypt(connection.googleOAuthClientSecretEncrypted, 'Google OAuth 客户端密钥')
      : undefined;
    await this.repository.updateConnection(connection.id, {
      googleOAuthStateExpiresAt: null,
      googleOAuthStateHash: null,
      googleOAuthVerifierEncrypted: null
    });
    if (typeof input.error === 'string' && input.error) return false;
    if (typeof input.code !== 'string' || input.code.length < 10 || input.code.length > 4096)
      return false;
    try {
      let token = await this.googleOAuth.exchangeCode({
        callbackUrl: this.callbackUrl(),
        clientId: connection.googleOAuthClientId,
        clientSecret,
        code: input.code,
        verifier
      });
      const googleEmail = await this.googleOAuth.getEmail(token.access_token);
      if (!token.refresh_token && googleEmail && googleEmail === connection.googleEmail) {
        const previousToken = connection.googleOAuthTokenEncrypted
          ? (JSON.parse(
              this.decrypt(connection.googleOAuthTokenEncrypted, 'Google OAuth 会话')
            ) as IdBusinessV2GoogleOAuthToken)
          : null;
        if (previousToken?.refresh_token) {
          token = { ...token, refresh_token: previousToken.refresh_token };
        }
      }
      const encrypted = this.encryption.encrypt(JSON.stringify(token));
      if (!encrypted) return false;
      await this.transactionManager.execute(
        async (tx) => {
          await this.repository.updateConnection(
            connection.id,
            {
              googleEmail,
              googleOAuthTokenEncrypted: encrypted
            },
            tx
          );
          await this.audit.append(tx, {
            userId: connection.userId,
            module: 'id_business_v2',
            action: 'id_business_v2.workspace_relay.google_authorize',
            objectType: 'id_business_v2_relay_connection',
            objectId: connection.id,
            afterData: toV2JsonDocument({ googleEmail, authorized: true }),
            remark: '中转脚本已完成 Google Cloud 授权'
          });
        },
        {
          changedScopes: ['workspace'],
          requestId: 'workspace-relay-google-oauth-complete',
          retryMode: 'none'
        }
      );
      return true;
    } catch {
      return false;
    }
  }

  async loginCloudBridge(
    dto: LoginIdBusinessV2RelayCloudBridgeDto,
    operator?: AuthenticatedUser,
    requestId = 'workspace-relay-cloudbridge-login'
  ): Promise<LoginV2RelayCloudBridgeResult> {
    const userId = this.requireAdmin(operator);
    const email = this.normalizeEmail(dto.email);
    let session: IdBusinessV2CloudBridgeSession;
    if (dto.tempToken !== undefined || dto.totpCode !== undefined) {
      const tempToken = this.normalizeString(
        dto.tempToken,
        '中转站登录状态已失效，请重新登录',
        4096
      );
      const totpCode = this.normalizeString(dto.totpCode, '请输入 2FA 验证码', 12);
      if (!/^\d{6,8}$/.test(totpCode)) throw new BadRequestException('2FA 验证码格式不正确');
      session = await this.cloudBridge.login2FA(tempToken, totpCode);
    } else {
      const password = this.normalizeString(dto.password, '请输入中转站密码', 500);
      session = await this.cloudBridge.login(email, password);
      if (session.requires_2fa === true) {
        const tempToken = typeof session.temp_token === 'string' ? session.temp_token : '';
        if (!tempToken) throw new ServiceUnavailableException('中转站没有返回 2FA 登录状态');
        return { connected: false, email, tempToken, twoFactorRequired: true };
      }
    }
    const validated = this.cloudBridge.validateAdminSession(session);
    const encrypted = this.encryption.encrypt(JSON.stringify(validated));
    if (!encrypted) throw new ServiceUnavailableException('中转站会话加密失败');
    await this.transactionManager.execute(
      async (tx) => {
        const saved = await this.repository.upsertConnection(
          userId,
          {
            cloudBridgeConnectedAt: new Date(),
            cloudBridgeEmail: email,
            cloudBridgeSessionEncrypted: encrypted
          },
          tx
        );
        await this.audit.append(tx, {
          userId,
          module: 'id_business_v2',
          action: 'id_business_v2.workspace_relay.cloudbridge_connect',
          objectType: 'id_business_v2_relay_connection',
          objectId: saved.id,
          afterData: toV2JsonDocument({ cloudBridgeEmail: email, connected: true }),
          remark: '中转脚本已连接中转站管理员账号'
        });
      },
      { changedScopes: ['workspace'], operator, requestId, retryMode: 'none' }
    );
    return { connected: true, email, twoFactorRequired: false };
  }

  async getDeploymentOptions(
    operator?: AuthenticatedUser,
    requestId = 'workspace-relay-options'
  ): Promise<V2RelayDeploymentOptions> {
    const userId = this.requireAdmin(operator);
    const connection = await this.requireCloudBridgeConnection(userId);
    const billingAccounts = connection.googleOAuthTokenEncrypted
      ? await this.googleAccessToken(connection)
          .then((token) => this.googleCloud.listBillingAccounts(token))
          .catch(() => [])
      : [];
    return this.withCloudBridgeSession(connection, async (accessToken) => {
      const [geminiGroups, antigravityGroups, proxies, vertexReferences, subscriptionReferences] =
        await Promise.all([
          this.cloudBridge.listGroups(accessToken, 'gemini'),
          this.cloudBridge.listGroups(accessToken, 'antigravity'),
          this.cloudBridge.listProxies(accessToken),
          this.cloudBridge.listVertexReferences(accessToken),
          this.cloudBridge.listSubscriptionReferences(accessToken)
        ]);
      const toGroups = (groups: Array<Record<string, unknown>>) =>
        groups
          .filter((group) => group.status === 'active')
          .map((group) => ({
            id: Number(group.id),
            label: String(group.name || `分组 #${group.id}`)
          }));
      return {
        billingAccounts: billingAccounts
          .map((account) => ({
            id: String(account.name ?? ''),
            label: String(account.displayName || account.name || '未命名结算账号')
          }))
          .filter((account) => Boolean(account.id)),
        geminiGroups: toGroups(geminiGroups),
        antigravityGroups: toGroups(antigravityGroups),
        proxies: proxies
          .filter((proxy) => proxy.status === 'active')
          .map((proxy) => ({
            id: Number(proxy.id),
            label: String(proxy.name || `代理 #${proxy.id}`)
          })),
        vertexReferenceAccounts: vertexReferences.map((reference) => ({
          concurrency: reference.concurrency,
          id: reference.id,
          label: reference.label,
          loadFactor: reference.loadFactor,
          models: reference.models,
          priority: reference.priority,
          rateMultiplier: reference.rateMultiplier
        })),
        subscriptionReferenceAccounts: subscriptionReferences.map((reference) => ({
          allowOverages: reference.allowOverages,
          concurrency: reference.concurrency,
          id: reference.id,
          label: reference.label,
          loadFactor: reference.loadFactor,
          mixedScheduling: reference.mixedScheduling,
          models: reference.models,
          priority: reference.priority,
          rateMultiplier: reference.rateMultiplier
        }))
      };
    }).catch((error: unknown) => {
      if (!(error instanceof IdBusinessV2RelayRemoteError)) throw error;
      this.logger.warn({
        event: 'workspace_relay_options_failed',
        requestId,
        upstreamStatus: error.status ?? null,
        errorCode: /^[A-Z][A-Z0-9_]{1,31}$/.test(error.code) ? error.code : 'REMOTE_ERROR'
      });
      throw idBusinessV2RelayOptionsError(error);
    });
  }

  async listJobs(operator?: AuthenticatedUser): Promise<V2RelayJobList> {
    const userId = this.requireAdmin(operator);
    const rows = await this.repository.listJobsByUser(userId);
    return { items: rows.map(toIdBusinessV2RelayJob) };
  }

  async requireCloudBridgeConnection(userId: string) {
    const connection = await this.repository.findConnectionByUser(userId);
    if (!connection?.cloudBridgeSessionEncrypted)
      throw new BadRequestException('请先连接中转站管理员账号');
    return connection;
  }

  async requireVertexConnection(userId: string) {
    const connection = await this.requireCloudBridgeConnection(userId);
    if (!connection.googleOAuthTokenEncrypted)
      throw new BadRequestException('请先完成 Google Cloud 授权');
    return connection;
  }

  async googleAccessToken(
    connection: NonNullable<
      Awaited<ReturnType<IdBusinessV2RelayScriptRepository['findConnectionByUser']>>
    >
  ) {
    if (!connection.googleOAuthClientId || !connection.googleOAuthTokenEncrypted) {
      throw new BadRequestException('请先完成 Google Cloud 授权');
    }
    let token = JSON.parse(
      this.decrypt(connection.googleOAuthTokenEncrypted, 'Google OAuth 会话')
    ) as IdBusinessV2GoogleOAuthToken;
    if (token.expires_at > Date.now() + 60_000 && token.access_token) return token.access_token;
    if (!token.refresh_token) throw new BadRequestException('Google 授权已过期，请重新授权');
    const clientSecret = connection.googleOAuthClientSecretEncrypted
      ? this.decrypt(connection.googleOAuthClientSecretEncrypted, 'Google OAuth 客户端密钥')
      : undefined;
    token = await this.googleOAuth.refresh({
      clientId: connection.googleOAuthClientId,
      clientSecret,
      refreshToken: token.refresh_token,
      scope: token.scope
    });
    const encrypted = this.encryption.encrypt(JSON.stringify(token));
    if (!encrypted) throw new ServiceUnavailableException('Google OAuth 会话加密失败');
    await this.repository.updateConnection(connection.id, { googleOAuthTokenEncrypted: encrypted });
    connection.googleOAuthTokenEncrypted = encrypted;
    return token.access_token;
  }

  async withCloudBridgeSession<T>(
    connection: NonNullable<
      Awaited<ReturnType<IdBusinessV2RelayScriptRepository['findConnectionByUser']>>
    >,
    callback: (accessToken: string) => Promise<T>
  ) {
    if (!connection.cloudBridgeSessionEncrypted)
      throw new BadRequestException('请先连接中转站管理员账号');
    let session = JSON.parse(
      this.decrypt(connection.cloudBridgeSessionEncrypted, '中转站会话')
    ) as IdBusinessV2CloudBridgeSession;
    try {
      return await callback(session.access_token);
    } catch (error) {
      if (
        !(error instanceof IdBusinessV2RelayRemoteError) ||
        error.status !== 401 ||
        !session.refresh_token
      )
        throw error;
      const refreshed = await this.cloudBridge.refresh(session.refresh_token);
      session = this.cloudBridge.validateAdminSession({ ...session, ...refreshed });
      const encrypted = this.encryption.encrypt(JSON.stringify(session));
      if (!encrypted) throw new ServiceUnavailableException('中转站会话加密失败');
      await this.repository.updateConnection(connection.id, {
        cloudBridgeSessionEncrypted: encrypted
      });
      connection.cloudBridgeSessionEncrypted = encrypted;
      return callback(session.access_token);
    }
  }

  private callbackUrl() {
    const publicUrl = this.config.get<string>('APP_PUBLIC_URL');
    if (!publicUrl) throw new ServiceUnavailableException('系统公开地址尚未配置');
    return new URL('/api/public/workspace-relay/google-oauth/callback', publicUrl).toString();
  }

  private requireAdmin(operator?: AuthenticatedUser) {
    if (!operator?.id) throw new BadRequestException('无法识别当前操作人');
    if (!operator.roles.includes('admin'))
      throw new ForbiddenException('只有管理员可以使用中转脚本');
    return operator.id;
  }

  private normalizeString(value: unknown, message: string, maxLength: number) {
    if (typeof value !== 'string') throw new BadRequestException(message);
    const normalized = value.trim();
    if (!normalized || normalized.length > maxLength) throw new BadRequestException(message);
    return normalized;
  }

  private normalizeOptionalString(value: unknown, field: string, maxLength: number) {
    if (value === null || value === '') return '';
    if (typeof value !== 'string' || value.length > maxLength)
      throw new BadRequestException(`${field}格式不正确`);
    return value.trim();
  }

  private normalizeEmail(value: unknown) {
    const email = this.normalizeString(value, '请输入中转站管理员邮箱', 254).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
      throw new BadRequestException('中转站管理员邮箱格式不正确');
    return email;
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

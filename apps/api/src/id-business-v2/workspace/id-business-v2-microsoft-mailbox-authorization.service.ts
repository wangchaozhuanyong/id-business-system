import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException
} from '@nestjs/common';
import {
  V2_MAIL_VIEWER_LIMITS,
  type StartV2MicrosoftMailboxAuthorizationResult,
  type V2MicrosoftMailboxAuthorizationStatus
} from '@apple-business/shared';
import { randomBytes } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  type V2CommandTransaction,
  toV2JsonDocument
} from '../runtime/public-api';
import type { StartIdBusinessV2MicrosoftMailboxAuthorizationDto } from './dto/id-business-v2-managed-mailbox.dto';
import { IdBusinessV2ManagedMailboxRepository } from './persistence/id-business-v2-managed-mailbox.repository';
import {
  IdBusinessV2ImapMailProvider,
  MailProviderAuthenticationError,
  MailProviderUnavailableError
} from './providers/id-business-v2-imap-mail.provider';
import {
  IdBusinessV2MicrosoftMailOAuthClient,
  MicrosoftMailOAuthAuthenticationError,
  MicrosoftMailOAuthConfigurationError,
  MicrosoftMailOAuthUnavailableError
} from './providers/id-business-v2-microsoft-mail-oauth.client';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const QUERY_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const QUERY_CODE_LENGTH = 20;
const QUERY_CODE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const MICROSOFT_OAUTH_STATE_TTL_MS = 10 * 60 * 1000;

@Injectable()
export class IdBusinessV2MicrosoftMailboxAuthorizationService {
  constructor(
    private readonly repository: IdBusinessV2ManagedMailboxRepository,
    private readonly transactionManager: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService,
    private readonly encryption: FieldEncryptionService,
    private readonly mailProvider: IdBusinessV2ImapMailProvider,
    private readonly microsoftOAuth: IdBusinessV2MicrosoftMailOAuthClient
  ) {}

  async start(
    dto: StartIdBusinessV2MicrosoftMailboxAuthorizationDto,
    operator?: AuthenticatedUser
  ): Promise<StartV2MicrosoftMailboxAuthorizationResult> {
    const userId = this.requireAdmin(operator);
    const email = this.normalizeEmail(dto.email);
    const label = this.normalizeLabel(dto.label);
    const mailboxId =
      dto.mailboxId === undefined || dto.mailboxId === '' ? null : this.normalizeId(dto.mailboxId);
    const existing = await this.repository.findByEmail(email);
    if (mailboxId) {
      if (!existing || existing.id !== mailboxId || existing.provider !== 'microsoft') {
        throw new BadRequestException('Microsoft 邮箱重新授权信息不匹配');
      }
    } else if (existing) {
      throw new ConflictException('该邮箱已经加入邮箱池');
    }

    const state = randomBytes(32).toString('base64url');
    const stateHash = this.encryption.hash(state);
    if (!stateHash) throw new ServiceUnavailableException('Microsoft 授权状态生成失败');
    let authorizationUrl: string;
    try {
      authorizationUrl = this.microsoftOAuth.createAuthorizationUrl(state, email);
    } catch (error) {
      if (error instanceof MicrosoftMailOAuthConfigurationError) {
        throw new ServiceUnavailableException('Microsoft 邮箱 OAuth2 尚未配置');
      }
      throw error;
    }

    const expiresAt = new Date(Date.now() + MICROSOFT_OAUTH_STATE_TTL_MS);
    const authorization = await this.repository.createOAuthState({
      stateHash,
      email,
      label,
      mailboxId,
      createdByUserId: userId,
      expiresAt,
      status: 'pending'
    });
    return {
      authorizationId: authorization.id,
      authorizationUrl,
      expiresAt: expiresAt.toISOString()
    };
  }

  async getStatus(
    authorizationIdInput: unknown,
    operator?: AuthenticatedUser
  ): Promise<V2MicrosoftMailboxAuthorizationStatus> {
    const userId = this.requireAdmin(operator);
    const authorizationId = this.normalizeId(authorizationIdInput);
    const authorization = await this.repository.findOAuthStateById(authorizationId);
    if (!authorization || authorization.createdByUserId !== userId) {
      throw new NotFoundException('Microsoft 邮箱授权任务不存在');
    }
    if (authorization.status === 'pending' && authorization.expiresAt.getTime() <= Date.now()) {
      await this.repository.failOAuthState(authorization.id, 'expired');
      authorization.status = 'failed';
      authorization.failureCode = 'expired';
    }
    return {
      authorizationId: authorization.id,
      failureMessage: this.failureMessage(authorization.failureCode),
      mailboxId: authorization.mailboxId,
      status: authorization.status
    };
  }

  async complete(input: { code?: unknown; error?: unknown; state?: unknown }) {
    const authorization = await this.resolvePendingAuthorization(input.state);
    if (typeof input.error === 'string' && input.error) {
      await this.repository.failOAuthState(authorization.id, 'consent_denied');
      return { succeeded: false as const };
    }
    if (typeof input.code !== 'string' || input.code.length < 10 || input.code.length > 4096) {
      await this.repository.failOAuthState(authorization.id, 'authorization_failed');
      return { succeeded: false as const };
    }

    try {
      const tokens = await this.microsoftOAuth.exchangeAuthorizationCode(input.code);
      await this.mailProvider.verify({
        accessToken: tokens.accessToken,
        email: authorization.email,
        provider: 'microsoft'
      });
      const credentialEncrypted = this.encryption.encrypt(tokens.refreshToken);
      if (!credentialEncrypted) throw new ServiceUnavailableException('Microsoft 授权加密失败');
      await this.persistAuthorization(authorization.id, credentialEncrypted);
      return { succeeded: true as const };
    } catch (error) {
      await this.repository.failOAuthState(authorization.id, this.failureCode(error));
      return { succeeded: false as const };
    }
  }

  private async persistAuthorization(authorizationId: string, credentialEncrypted: string) {
    await this.transactionManager.execute(
      async (tx, context) => {
        const authorization = await this.repository.findOAuthStateById(authorizationId, tx);
        if (!authorization || authorization.status !== 'pending') {
          throw new ConflictException('Microsoft 授权任务已处理');
        }

        const mailbox = authorization.mailboxId
          ? await this.reauthorizeMailbox(
              tx,
              authorization,
              credentialEncrypted,
              context.businessTime
            )
          : await this.createMailbox(tx, authorization, credentialEncrypted, context.businessTime);
        await this.repository.completeOAuthState(tx, authorization.id, {
          mailboxId: mailbox.id,
          completedAt: context.businessTime
        });
      },
      {
        changedScopes: ['workspace'],
        requestId: 'managed-mailbox-microsoft-oauth-complete',
        retryMode: 'none'
      }
    );
  }

  private async reauthorizeMailbox(
    tx: V2CommandTransaction,
    authorization: {
      createdByUserId: string;
      mailboxId: string | null;
    },
    credentialEncrypted: string,
    verifiedAt: Date
  ) {
    if (!authorization.mailboxId) throw new NotFoundException('Microsoft 邮箱不存在');
    const before = await this.repository.findById(authorization.mailboxId, tx);
    if (!before || before.provider !== 'microsoft') {
      throw new NotFoundException('Microsoft 邮箱不存在');
    }
    const mailbox = await this.repository.updateCredential(tx, before.id, {
      providerCredentialEncrypted: credentialEncrypted,
      updatedByUserId: authorization.createdByUserId,
      verifiedAt
    });
    await this.audit.append(tx, {
      userId: authorization.createdByUserId,
      module: 'id_business_v2',
      action: 'id_business_v2.managed_mailbox.microsoft_reauthorize',
      objectType: 'id_business_v2_managed_mailbox',
      objectId: mailbox.id,
      beforeData: toV2JsonDocument(this.toAuditData(before)),
      afterData: toV2JsonDocument({ ...this.toAuditData(mailbox), credentialUpdated: true }),
      remark: `已重新授权 Microsoft 邮箱：${mailbox.email}`
    });
    return mailbox;
  }

  private async createMailbox(
    tx: V2CommandTransaction,
    authorization: {
      createdByUserId: string;
      email: string;
      label: string | null;
    },
    credentialEncrypted: string,
    issuedAt: Date
  ) {
    if (await this.repository.findByEmail(authorization.email, tx)) {
      throw new ConflictException('该邮箱已经加入邮箱池');
    }
    const queryCode = this.generateQueryCode();
    const queryCodeHash = this.encryption.hash(queryCode);
    const queryCodeEncrypted = this.encryption.encrypt(queryCode);
    if (!queryCodeHash || !queryCodeEncrypted) {
      throw new ServiceUnavailableException('查询码生成失败');
    }
    const mailbox = await this.repository.create(tx, {
      email: authorization.email,
      label: authorization.label,
      provider: 'microsoft',
      providerCredentialEncrypted: credentialEncrypted,
      queryCodeExpiresAt: new Date(issuedAt.getTime() + QUERY_CODE_TTL_MS),
      queryCodeEncrypted,
      queryCodeHash,
      queryCodeHint: queryCode.slice(-4),
      status: 'active',
      lastVerifiedAt: issuedAt,
      createdByUserId: authorization.createdByUserId,
      updatedByUserId: authorization.createdByUserId
    });
    await this.audit.append(tx, {
      userId: authorization.createdByUserId,
      module: 'id_business_v2',
      action: 'id_business_v2.managed_mailbox.microsoft_create',
      objectType: 'id_business_v2_managed_mailbox',
      objectId: mailbox.id,
      afterData: toV2JsonDocument(this.toAuditData(mailbox)),
      remark: `已添加 Microsoft 邮箱：${mailbox.email}`
    });
    return mailbox;
  }

  private async resolvePendingAuthorization(stateInput: unknown) {
    if (typeof stateInput !== 'string' || stateInput.length < 20 || stateInput.length > 200) {
      throw new BadRequestException('Microsoft 授权状态无效');
    }
    const stateHash = this.encryption.hash(stateInput);
    if (!stateHash) throw new BadRequestException('Microsoft 授权状态无效');
    const authorization = await this.repository.findOAuthStateByHash(stateHash);
    if (!authorization || authorization.status !== 'pending') {
      throw new BadRequestException('Microsoft 授权任务无效或已完成');
    }
    if (authorization.expiresAt.getTime() <= Date.now()) {
      await this.repository.failOAuthState(authorization.id, 'expired');
      throw new BadRequestException('Microsoft 授权已过期');
    }
    return authorization;
  }

  private normalizeEmail(value: unknown) {
    if (typeof value !== 'string') throw new BadRequestException('请输入邮箱');
    const email = value.trim().toLowerCase();
    if (!email || email.length > V2_MAIL_VIEWER_LIMITS.email || !EMAIL_PATTERN.test(email)) {
      throw new BadRequestException('请输入有效的邮箱地址');
    }
    return email;
  }

  private normalizeLabel(value: unknown) {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string') throw new BadRequestException('邮箱备注格式不正确');
    const label = value.trim().replace(/\s+/g, ' ');
    if (label.length > V2_MAIL_VIEWER_LIMITS.label) {
      throw new BadRequestException(`邮箱备注最多 ${V2_MAIL_VIEWER_LIMITS.label} 个字符`);
    }
    return label || null;
  }

  private normalizeId(value: unknown) {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw new BadRequestException('邮箱标识无效');
    }
    return value;
  }

  private requireAdmin(operator?: AuthenticatedUser) {
    if (!operator?.id) throw new BadRequestException('无法识别当前操作人');
    if (!operator.roles.includes('admin')) throw new ForbiddenException('只有管理员可以管理邮箱池');
    return operator.id;
  }

  private generateQueryCode() {
    const bytes = randomBytes(QUERY_CODE_LENGTH);
    return Array.from(bytes, (byte) => QUERY_CODE_ALPHABET[byte % QUERY_CODE_ALPHABET.length]).join(
      ''
    );
  }

  private failureCode(error: unknown) {
    if (error instanceof MicrosoftMailOAuthConfigurationError) return 'configuration_missing';
    if (error instanceof MicrosoftMailOAuthAuthenticationError) return 'authorization_failed';
    if (error instanceof MailProviderAuthenticationError) return 'mailbox_auth_failed';
    if (
      error instanceof MicrosoftMailOAuthUnavailableError ||
      error instanceof MailProviderUnavailableError
    ) {
      return 'provider_unavailable';
    }
    if (error instanceof ConflictException) return 'email_exists';
    return 'completion_failed';
  }

  private failureMessage(value: string | null) {
    if (!value) return null;
    if (value === 'expired') return '授权已过期，请重新发起';
    if (value === 'consent_denied') return '未完成 Microsoft 授权';
    if (value === 'configuration_missing') return '系统尚未配置 Microsoft OAuth2';
    if (value === 'mailbox_auth_failed') return '授权账号与邮箱地址不匹配或 IMAP 未开启';
    if (value === 'email_exists') return '该邮箱已经加入邮箱池';
    if (value === 'provider_unavailable') return 'Microsoft 服务暂时不可用，请稍后重试';
    return 'Microsoft 邮箱授权失败，请重新尝试';
  }

  private toAuditData(row: {
    email: string;
    provider: string;
    queryCodeExpiresAt: Date;
    status: string;
  }) {
    return {
      email: row.email,
      provider: row.provider,
      queryCodeExpiresAt: row.queryCodeExpiresAt.toISOString(),
      status: row.status
    };
  }
}

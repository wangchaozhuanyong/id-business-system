import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Optional,
  ServiceUnavailableException
} from '@nestjs/common';
import {
  V2_MAIL_VIEWER_LIMITS,
  V2_VENDURE_VIRTUAL_MAIL_LIMIT,
  type V2MailViewerQueryResult,
  type V2VendureMailboxPublicQueryResult
} from '@apple-business/shared';
import { timingSafeEqual } from 'node:crypto';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import type { QueryIdBusinessV2MailViewerDto } from './dto/id-business-v2-mail-viewer.dto';
import { IdBusinessV2MailboxTransientStateService } from './id-business-v2-mailbox-transient-state.service';
import { IdBusinessV2ManagedMailboxRepository } from './persistence/id-business-v2-managed-mailbox.repository';
import {
  IdBusinessV2ImapMailProvider,
  MailProviderAuthenticationError,
  MailProviderUnavailableError
} from './providers/id-business-v2-imap-mail.provider';
import { IdBusinessV2VendureMailboxClient } from './providers/id-business-v2-vendure-mailbox.client';
import {
  IdBusinessV2MicrosoftMailOAuthClient,
  MicrosoftMailOAuthAuthenticationError,
  MicrosoftMailOAuthConfigurationError,
  MicrosoftMailOAuthUnavailableError
} from './providers/id-business-v2-microsoft-mail-oauth.client';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CREDENTIAL_SEPARATOR = '----';
const RATE_WINDOW_MS = 5 * 60 * 1000;
const MAX_QUERY_CODE_ATTEMPTS = 15;
const MAX_IP_ATTEMPTS = 40;

@Injectable()
export class IdBusinessV2MailViewerService {
  constructor(
    private readonly repository: IdBusinessV2ManagedMailboxRepository,
    private readonly transientState: IdBusinessV2MailboxTransientStateService,
    private readonly encryption: FieldEncryptionService,
    private readonly mailProvider: IdBusinessV2ImapMailProvider,
    private readonly microsoftOAuth: IdBusinessV2MicrosoftMailOAuthClient,
    @Optional() private readonly vendureMailbox?: IdBusinessV2VendureMailboxClient
  ) {}

  async query(
    dto: QueryIdBusinessV2MailViewerDto,
    requestIp?: string | null
  ): Promise<V2MailViewerQueryResult> {
    const queryCode = this.normalizeQueryCode(dto.queryCode ?? dto.credential);
    const limit = this.normalizeLimit(dto.limit);
    if (/^(BUY|MSTR)-/i.test(queryCode) && this.vendureMailbox) {
      return this.queryVendure(queryCode, limit, requestIp);
    }
    const queryCodeHash = this.encryption.hash(queryCode);
    const ipHash = this.encryption.hash(this.normalizeIp(requestIp));
    if (!queryCodeHash) throw new ServiceUnavailableException('查询校验服务不可用');

    const allowed = this.transientState.reservePublicQuery({
      queryCodeHash,
      ipHash,
      windowMs: RATE_WINDOW_MS,
      maxQueryCodeAttempts: MAX_QUERY_CODE_ATTEMPTS,
      maxIpAttempts: MAX_IP_ATTEMPTS
    });
    if (!allowed) {
      throw new HttpException('查询过于频繁，请稍后重试', HttpStatus.TOO_MANY_REQUESTS);
    }

    const mailbox = await this.repository.findByQueryCodeHash(queryCodeHash);
    const valid =
      mailbox?.status === 'active' &&
      mailbox.queryCodeExpiresAt.getTime() > Date.now() &&
      this.matchesQueryCode(mailbox.queryCodeHash, queryCode);
    if (!valid) {
      throw new BadRequestException('邮件查询码不正确');
    }

    const providerCredential = this.encryption.decrypt(mailbox.providerCredentialEncrypted);
    if (!providerCredential) {
      throw new ServiceUnavailableException('邮箱授权数据不可用，请联系卖家');
    }

    try {
      const providerInput = await this.resolveProviderInput(mailbox, providerCredential);
      const items = await this.mailProvider.query(providerInput, limit);
      const queriedAt = new Date();
      await this.repository.updateQueryState(mailbox.id, {
        lastErrorCode: null,
        lastQueriedAt: queriedAt,
        lastVerifiedAt: queriedAt,
        status: 'active'
      });
      return {
        email: mailbox.email,
        items,
        provider: mailbox.provider,
        queriedAt: queriedAt.toISOString()
      };
    } catch (error) {
      if (
        error instanceof MailProviderAuthenticationError ||
        error instanceof MicrosoftMailOAuthAuthenticationError
      ) {
        await this.repository.updateQueryState(mailbox.id, {
          lastErrorCode: 'provider_auth_failed',
          status: 'auth_failed'
        });
        throw new ServiceUnavailableException('邮箱授权已失效，请联系卖家更新');
      }
      if (error instanceof MailProviderUnavailableError && error.code === 'edge_runtime') {
        throw new ServiceUnavailableException('邮件查询服务尚未配置，请联系卖家');
      }
      if (error instanceof MicrosoftMailOAuthConfigurationError) {
        throw new ServiceUnavailableException('Microsoft 邮箱查询服务尚未配置，请联系卖家');
      }
      if (error instanceof MicrosoftMailOAuthUnavailableError) {
        throw new ServiceUnavailableException('Microsoft 授权服务暂时不可用，请稍后重试');
      }
      throw new ServiceUnavailableException('暂时无法连接邮箱服务，请稍后重试');
    }
  }

  private async queryVendure(queryCode: string, limit: number, requestIp?: string | null) {
    const result = await this.vendureMailbox!.publicQuery(
      queryCode,
      this.normalizeIp(requestIp) ?? undefined
    );
    if (!result.success) {
      const message = result.message || '邮件查询码不正确';
      if (message.includes('频繁')) throw new HttpException(message, HttpStatus.TOO_MANY_REQUESTS);
      throw new BadRequestException(message);
    }
    const targetType = this.vendureTargetType(queryCode, result);
    const resultLimit = targetType === 'VIRTUAL' ? V2_VENDURE_VIRTUAL_MAIL_LIMIT : limit;
    const items = this.scopeVendureQueryItems(queryCode, result)
      .sort((left, right) => right.receivedAt.localeCompare(left.receivedAt))
      .slice(0, resultLimit);
    return {
      codeExpiresAt: result.codeExpiresAt,
      email: result.aliasEmail || result.primaryEmail || items[0]?.targetEmail || 'iCloud 邮箱',
      items: items.map((item) => ({
        id: item.id,
        body: item.bodyText || (item.extractedCode ? `验证码：${item.extractedCode}` : ''),
        extractedCode: item.extractedCode,
        from: item.fromName ? `${item.fromName} <${item.fromAddress}>` : item.fromAddress,
        savedAt: item.receivedAt,
        subject: item.subject,
        to: item.targetEmail,
        virtualEmailId: item.virtualEmailId
      })),
      maxVisibleMessages: targetType === 'VIRTUAL' ? V2_VENDURE_VIRTUAL_MAIL_LIMIT : null,
      provider: 'icloud' as const,
      queriedAt: new Date().toISOString(),
      remainingDays: result.remainingDays,
      targetType,
      totalEmails: targetType === 'VIRTUAL' ? items.length : result.totalEmails,
      virtualEmailsList: targetType === 'PRIMARY' ? result.virtualEmailsList : null
    };
  }

  private scopeVendureQueryItems(queryCode: string, result: V2VendureMailboxPublicQueryResult) {
    if (this.vendureTargetType(queryCode, result) !== 'VIRTUAL') return [...result.items];

    const aliasEmail = this.normalizeEmail(result.aliasEmail);
    if (!aliasEmail) return [];
    return result.items.filter((item) => this.normalizeEmail(item.targetEmail) === aliasEmail);
  }

  private vendureTargetType(queryCode: string, result: V2VendureMailboxPublicQueryResult) {
    if (/^BUY-/i.test(queryCode)) return 'VIRTUAL' as const;
    if (/^MSTR-/i.test(queryCode)) return 'PRIMARY' as const;
    return String(result.targetType ?? '').toUpperCase() === 'VIRTUAL'
      ? ('VIRTUAL' as const)
      : ('PRIMARY' as const);
  }

  private normalizeEmail(value: unknown) {
    return typeof value === 'string' ? value.trim().toLocaleLowerCase() : '';
  }

  private async resolveProviderInput(
    mailbox: { id: string; email: string; provider: 'gmail' | 'icloud' | 'microsoft' },
    providerCredential: string
  ) {
    if (mailbox.provider !== 'microsoft') {
      return {
        appPassword: providerCredential,
        email: mailbox.email,
        provider: mailbox.provider
      } as const;
    }
    const tokens = await this.microsoftOAuth.refreshAccessToken(providerCredential);
    if (tokens.refreshToken !== providerCredential) {
      const encrypted = this.encryption.encrypt(tokens.refreshToken);
      if (encrypted) await this.repository.updateProviderCredential(mailbox.id, encrypted);
    }
    return {
      accessToken: tokens.accessToken,
      email: mailbox.email,
      provider: mailbox.provider
    } as const;
  }

  private matchesQueryCode(storedHash: string, queryCode: string) {
    const candidate = this.encryption.hash(queryCode);
    if (!candidate || storedHash.length !== candidate.length) return false;
    return timingSafeEqual(Buffer.from(storedHash, 'utf8'), Buffer.from(candidate, 'utf8'));
  }

  private normalizeQueryCode(value: unknown) {
    if (typeof value !== 'string') throw new BadRequestException('请输入邮件查询码');
    const input = value.trim();
    if (!input) throw new BadRequestException('请输入邮件查询码');
    if (input.length > V2_MAIL_VIEWER_LIMITS.credential) {
      throw new BadRequestException('邮件查询码格式不正确');
    }

    const separatorIndex = input.indexOf(CREDENTIAL_SEPARATOR);
    const legacyEmail = separatorIndex > 0 ? input.slice(0, separatorIndex).trim() : '';
    const queryCode =
      legacyEmail && EMAIL_PATTERN.test(legacyEmail)
        ? input.slice(separatorIndex + CREDENTIAL_SEPARATOR.length).trim()
        : input;
    if (
      !queryCode ||
      queryCode.length > V2_MAIL_VIEWER_LIMITS.queryCode ||
      Array.from(queryCode).some((character) => character.charCodeAt(0) <= 32)
    ) {
      throw new BadRequestException('邮件查询码格式不正确');
    }
    return queryCode;
  }

  private normalizeLimit(value: unknown) {
    const limit = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(limit) || limit < 1 || limit > V2_MAIL_VIEWER_LIMITS.messages) {
      throw new BadRequestException(`返回封数必须为 1 至 ${V2_MAIL_VIEWER_LIMITS.messages} 的整数`);
    }
    return limit;
  }

  private normalizeIp(value: string | null | undefined) {
    const ip = value?.split(',')[0]?.trim();
    return ip ? (ip.startsWith('::ffff:') ? ip.slice('::ffff:'.length) : ip) : null;
  }
}

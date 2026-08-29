import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  ServiceUnavailableException
} from '@nestjs/common';
import { V2_MAIL_VIEWER_LIMITS, type V2MailViewerQueryResult } from '@apple-business/shared';
import { timingSafeEqual } from 'node:crypto';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import type { QueryIdBusinessV2MailViewerDto } from './dto/id-business-v2-mail-viewer.dto';
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
const CREDENTIAL_SEPARATOR = '----';
const RATE_WINDOW_MS = 5 * 60 * 1000;
const MAX_QUERY_CODE_ATTEMPTS = 15;
const MAX_IP_ATTEMPTS = 40;

@Injectable()
export class IdBusinessV2MailViewerService {
  constructor(
    private readonly repository: IdBusinessV2ManagedMailboxRepository,
    private readonly encryption: FieldEncryptionService,
    private readonly mailProvider: IdBusinessV2ImapMailProvider,
    private readonly microsoftOAuth: IdBusinessV2MicrosoftMailOAuthClient
  ) {}

  async query(
    dto: QueryIdBusinessV2MailViewerDto,
    requestIp?: string | null
  ): Promise<V2MailViewerQueryResult> {
    const queryCode = this.normalizeQueryCode(dto.queryCode ?? dto.credential);
    const limit = this.normalizeLimit(dto.limit);
    const queryCodeHash = this.encryption.hash(queryCode);
    const ipHash = this.encryption.hash(this.normalizeIp(requestIp));
    if (!queryCodeHash) throw new ServiceUnavailableException('查询校验服务不可用');

    const reservation = await this.repository.reserveQueryAttempt({
      queryCodeHash,
      ipHash,
      since: new Date(Date.now() - RATE_WINDOW_MS),
      maxQueryCodeAttempts: MAX_QUERY_CODE_ATTEMPTS,
      maxIpAttempts: MAX_IP_ATTEMPTS
    });
    if (!reservation.allowed) {
      throw new HttpException('查询过于频繁，请稍后重试', HttpStatus.TOO_MANY_REQUESTS);
    }

    const mailbox = await this.repository.findByQueryCodeHash(queryCodeHash);
    const valid =
      mailbox?.status === 'active' &&
      mailbox.queryCodeExpiresAt.getTime() > Date.now() &&
      this.matchesQueryCode(mailbox.queryCodeHash, queryCode);
    if (!valid) {
      if (mailbox) {
        await this.repository.updateQueryAttempt(reservation.attemptId, {
          mailboxId: mailbox.id,
          outcome: 'invalid'
        });
      }
      throw new BadRequestException('邮件查询码不正确');
    }

    const providerCredential = this.encryption.decrypt(mailbox.providerCredentialEncrypted);
    if (!providerCredential) {
      await this.repository.updateQueryAttempt(reservation.attemptId, {
        mailboxId: mailbox.id,
        outcome: 'provider_error'
      });
      throw new ServiceUnavailableException('邮箱授权数据不可用，请联系卖家');
    }

    try {
      const providerInput = await this.resolveProviderInput(mailbox, providerCredential);
      const items = await this.mailProvider.query(providerInput, limit);
      const queriedAt = new Date();
      await Promise.all([
        this.repository.updateQueryAttempt(reservation.attemptId, {
          mailboxId: mailbox.id,
          outcome: 'success'
        }),
        this.repository.updateQueryState(mailbox.id, {
          lastErrorCode: null,
          lastQueriedAt: queriedAt,
          lastVerifiedAt: queriedAt,
          status: 'active'
        })
      ]);
      return {
        email: mailbox.email,
        items,
        provider: mailbox.provider,
        queriedAt: queriedAt.toISOString()
      };
    } catch (error) {
      await this.repository.updateQueryAttempt(reservation.attemptId, {
        mailboxId: mailbox.id,
        outcome: 'provider_error'
      });
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

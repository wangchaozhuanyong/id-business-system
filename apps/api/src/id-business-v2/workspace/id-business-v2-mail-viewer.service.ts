import {
  BadRequestException,
  HttpException,
  HttpStatus,
  Injectable,
  Logger,
  ServiceUnavailableException
} from '@nestjs/common';
import {
  V2_MAIL_VIEWER_LIMITS,
  type V2MailProvider,
  type V2MailViewerQueryResult
} from '@apple-business/shared';
import { timingSafeEqual } from 'node:crypto';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import type { QueryIdBusinessV2MailViewerDto } from './dto/id-business-v2-mail-viewer.dto';
import { IdBusinessV2ManagedMailboxRepository } from './persistence/id-business-v2-managed-mailbox.repository';
import {
  IdBusinessV2ImapMailProvider,
  MailProviderAuthenticationError,
  MailProviderUnavailableError
} from './providers/id-business-v2-imap-mail.provider';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CREDENTIAL_SEPARATOR = '----';
const RATE_WINDOW_MS = 5 * 60 * 1000;
const MAX_EMAIL_ATTEMPTS = 15;
const MAX_IP_ATTEMPTS = 40;

@Injectable()
export class IdBusinessV2MailViewerService {
  private readonly logger = new Logger(IdBusinessV2MailViewerService.name);

  constructor(
    private readonly repository: IdBusinessV2ManagedMailboxRepository,
    private readonly encryption: FieldEncryptionService,
    private readonly mailProvider: IdBusinessV2ImapMailProvider
  ) {}

  async query(
    dto: QueryIdBusinessV2MailViewerDto,
    requestIp?: string | null,
    requestId = 'public-mailbox-query'
  ): Promise<V2MailViewerQueryResult> {
    const startedAt = Date.now();
    const { email, queryCode } = this.normalizeCredential(dto.credential);
    const limit = this.normalizeLimit(dto.limit);
    const emailHash = this.encryption.hash(email);
    const ipHash = this.encryption.hash(this.normalizeIp(requestIp));
    if (!emailHash) throw new ServiceUnavailableException('查询校验服务不可用');

    const reservation = await this.repository.reserveQueryAttempt({
      emailHash,
      ipHash,
      since: new Date(Date.now() - RATE_WINDOW_MS),
      maxEmailAttempts: MAX_EMAIL_ATTEMPTS,
      maxIpAttempts: MAX_IP_ATTEMPTS
    });
    if (!reservation.allowed) {
      this.logQueryEvent({ outcome: 'rate_limited', requestId, startedAt });
      throw new HttpException('查询过于频繁，请稍后重试', HttpStatus.TOO_MANY_REQUESTS);
    }

    const mailbox = await this.repository.findByEmail(email);
    const valid =
      mailbox?.status === 'active' && this.matchesQueryCode(mailbox.queryCodeHash, queryCode);
    if (!valid) {
      if (mailbox) {
        await this.repository.updateQueryAttempt(reservation.attemptId, {
          mailboxId: mailbox.id,
          outcome: 'invalid'
        });
      }
      this.logQueryEvent({ outcome: 'invalid', requestId, startedAt });
      throw new BadRequestException('邮箱或邮件查询码不正确');
    }

    const appPassword = this.encryption.decrypt(mailbox.providerCredentialEncrypted);
    if (!appPassword) {
      await this.repository.updateQueryAttempt(reservation.attemptId, {
        mailboxId: mailbox.id,
        outcome: 'provider_error'
      });
      this.logQueryEvent({
        errorCode: 'credential_unavailable',
        outcome: 'provider_error',
        provider: mailbox.provider,
        requestId,
        startedAt
      });
      throw new ServiceUnavailableException('邮箱授权数据不可用，请联系卖家');
    }

    try {
      const items = await this.mailProvider.query(
        { appPassword, email: mailbox.email, provider: mailbox.provider },
        limit
      );
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
      this.logQueryEvent({
        outcome: 'success',
        provider: mailbox.provider,
        requestId,
        startedAt
      });
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
      if (error instanceof MailProviderAuthenticationError) {
        await this.repository.updateQueryState(mailbox.id, {
          lastErrorCode: 'provider_auth_failed',
          status: 'auth_failed'
        });
        this.logQueryEvent({
          errorCode: 'provider_auth_failed',
          outcome: 'provider_error',
          provider: mailbox.provider,
          requestId,
          startedAt
        });
        throw new ServiceUnavailableException('邮箱授权已失效，请联系卖家更新');
      }
      if (error instanceof MailProviderUnavailableError && error.code === 'edge_runtime') {
        this.logQueryEvent({
          errorCode: 'edge_runtime',
          outcome: 'provider_error',
          provider: mailbox.provider,
          requestId,
          startedAt
        });
        throw new ServiceUnavailableException('邮件查询服务尚未配置，请联系卖家');
      }
      this.logQueryEvent({
        errorCode:
          error instanceof MailProviderUnavailableError
            ? error.code
            : 'unclassified_provider_error',
        outcome: 'provider_error',
        provider: mailbox.provider,
        requestId,
        startedAt
      });
      throw new ServiceUnavailableException('暂时无法连接邮箱服务，请稍后重试');
    }
  }

  private matchesQueryCode(storedHash: string, queryCode: string) {
    const candidate = this.encryption.hash(queryCode);
    if (!candidate || storedHash.length !== candidate.length) return false;
    return timingSafeEqual(Buffer.from(storedHash, 'utf8'), Buffer.from(candidate, 'utf8'));
  }

  private normalizeCredential(value: unknown) {
    if (typeof value !== 'string') throw new BadRequestException('请输入邮箱和邮件查询码');
    const credential = value.trim();
    if (!credential || credential.length > V2_MAIL_VIEWER_LIMITS.credential) {
      throw new BadRequestException('邮箱和邮件查询码格式不正确');
    }
    const separatorIndex = credential.indexOf(CREDENTIAL_SEPARATOR);
    if (separatorIndex < 1) {
      throw new BadRequestException('格式不正确，请输入 邮箱----邮件查询码');
    }
    const email = credential.slice(0, separatorIndex).trim().toLowerCase();
    const queryCode = credential.slice(separatorIndex + CREDENTIAL_SEPARATOR.length).trim();
    if (!email || email.length > V2_MAIL_VIEWER_LIMITS.email || !EMAIL_PATTERN.test(email)) {
      throw new BadRequestException('请输入有效的邮箱地址');
    }
    if (
      !queryCode ||
      queryCode.length > V2_MAIL_VIEWER_LIMITS.queryCode ||
      Array.from(queryCode).some((character) => character.charCodeAt(0) <= 32)
    ) {
      throw new BadRequestException('邮件查询码格式不正确');
    }
    return { email, queryCode };
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

  private logQueryEvent(input: {
    errorCode?: string;
    outcome: 'invalid' | 'provider_error' | 'rate_limited' | 'success';
    provider?: V2MailProvider;
    requestId: string;
    startedAt: number;
  }) {
    const event = JSON.stringify({
      durationMs: Math.max(0, Date.now() - input.startedAt),
      errorCode: input.errorCode,
      outcome: input.outcome,
      provider: input.provider,
      rateLimited: input.outcome === 'rate_limited',
      requestId: input.requestId,
      type: 'managed_mailbox_query'
    });
    if (input.outcome === 'success') {
      this.logger.log(event);
      return;
    }
    this.logger.warn(event);
  }
}

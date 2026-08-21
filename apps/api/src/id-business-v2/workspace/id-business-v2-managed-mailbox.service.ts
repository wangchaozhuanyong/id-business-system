import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException
} from '@nestjs/common';
import {
  V2_MAIL_PROVIDERS,
  V2_MAIL_VIEWER_LIMITS,
  V2_MANAGED_MAILBOX_STATUSES,
  type CreateV2ManagedMailboxResult,
  type V2MailProvider,
  type V2ManagedMailbox,
  type V2ManagedMailboxList,
  type V2ManagedMailboxListQuery,
  type V2ManagedMailboxStatus
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
  CreateIdBusinessV2ManagedMailboxDto,
  ListIdBusinessV2ManagedMailboxesDto,
  UpdateIdBusinessV2ManagedMailboxCredentialDto,
  UpdateIdBusinessV2ManagedMailboxStatusDto
} from './dto/id-business-v2-managed-mailbox.dto';
import { IdBusinessV2ManagedMailboxRepository } from './persistence/id-business-v2-managed-mailbox.repository';
import {
  IdBusinessV2ImapMailProvider,
  MailProviderAuthenticationError,
  MailProviderUnavailableError
} from './providers/id-business-v2-imap-mail.provider';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const QUERY_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
const QUERY_CODE_LENGTH = 20;

@Injectable()
export class IdBusinessV2ManagedMailboxService {
  constructor(
    private readonly repository: IdBusinessV2ManagedMailboxRepository,
    private readonly transactionManager: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService,
    private readonly encryption: FieldEncryptionService,
    private readonly mailProvider: IdBusinessV2ImapMailProvider
  ) {}

  async list(
    dto: ListIdBusinessV2ManagedMailboxesDto,
    operator?: AuthenticatedUser
  ): Promise<V2ManagedMailboxList> {
    this.requireAdmin(operator);
    const query = this.normalizeListQuery(dto);
    const where = {
      ...(query.provider ? { provider: query.provider } : {}),
      ...(query.status ? { status: query.status } : {}),
      ...(query.q
        ? {
            OR: [
              { email: { contains: query.q } },
              { label: { contains: query.q } }
            ]
          }
        : {})
    };
    const [rows, total] = await Promise.all([
      this.repository.list({
        where,
        skip: (query.page - 1) * query.pageSize,
        take: query.pageSize
      }),
      this.repository.count(where)
    ]);
    return { items: rows.map((row) => this.toResponse(row)), ...query, total };
  }

  async create(
    dto: CreateIdBusinessV2ManagedMailboxDto,
    operator?: AuthenticatedUser,
    requestId = 'managed-mailbox-create'
  ): Promise<CreateV2ManagedMailboxResult> {
    const userId = this.requireAdmin(operator);
    const input = this.normalizeCreate(dto);
    if (await this.repository.findByEmail(input.email)) {
      throw new ConflictException('该邮箱已经加入邮箱池');
    }
    await this.verifyProvider({
      email: input.email,
      provider: input.provider,
      appPassword: input.appPassword
    });

    const queryCode = this.generateQueryCode();
    const encrypted = this.encryption.encrypt(input.appPassword);
    const queryCodeHash = this.encryption.hash(queryCode);
    if (!encrypted || !queryCodeHash) throw new ServiceUnavailableException('敏感信息加密失败');

    const row = await this.transactionManager.execute(
      async (tx, context) => {
        if (await this.repository.findByEmail(input.email, tx)) {
          throw new ConflictException('该邮箱已经加入邮箱池');
        }
        const created = await this.repository.create(tx, {
          email: input.email,
          label: input.label,
          provider: input.provider,
          providerCredentialEncrypted: encrypted,
          queryCodeHash,
          queryCodeHint: queryCode.slice(-4),
          status: 'active',
          lastVerifiedAt: context.businessTime,
          createdByUserId: userId,
          updatedByUserId: userId
        });
        await this.audit.append(tx, {
          userId,
          module: 'id_business_v2',
          action: 'id_business_v2.managed_mailbox.create',
          objectType: 'id_business_v2_managed_mailbox',
          objectId: created.id,
          afterData: toV2JsonDocument(this.toAuditData(created)),
          remark: `已添加受管邮箱：${created.email}`
        });
        return created;
      },
      { requestId, operator, retryMode: 'none' }
    );

    return {
      mailbox: this.toResponse(row),
      buyerCredential: `${row.email}----${queryCode}`
    };
  }

  async updateStatus(
    mailboxIdInput: unknown,
    dto: UpdateIdBusinessV2ManagedMailboxStatusDto,
    operator?: AuthenticatedUser,
    requestId = 'managed-mailbox-status'
  ): Promise<V2ManagedMailbox> {
    const userId = this.requireAdmin(operator);
    const mailboxId = this.normalizeId(mailboxIdInput);
    const status = this.normalizeControllableStatus(dto.status);

    const row = await this.transactionManager.execute(
      async (tx) => {
        const before = await this.repository.findById(mailboxId, tx);
        if (!before) throw new NotFoundException('邮箱不存在');
        if (before.status === 'auth_failed' && status === 'active') {
          throw new ConflictException('请先更新应用专用密码并重新验证');
        }
        if (before.status === status) return before;
        const updated = await this.repository.updateStatus(tx, before.id, status, userId);
        await this.audit.append(tx, {
          userId,
          module: 'id_business_v2',
          action: 'id_business_v2.managed_mailbox.status_update',
          objectType: 'id_business_v2_managed_mailbox',
          objectId: updated.id,
          beforeData: toV2JsonDocument(this.toAuditData(before)),
          afterData: toV2JsonDocument(this.toAuditData(updated)),
          remark:
            status === 'active' ? `已启用邮箱：${updated.email}` : `已停用邮箱：${updated.email}`
        });
        return updated;
      },
      { requestId, operator, retryMode: 'none' }
    );
    return this.toResponse(row);
  }

  async updateCredential(
    mailboxIdInput: unknown,
    dto: UpdateIdBusinessV2ManagedMailboxCredentialDto,
    operator?: AuthenticatedUser,
    requestId = 'managed-mailbox-credential-update'
  ): Promise<V2ManagedMailbox> {
    const userId = this.requireAdmin(operator);
    const mailboxId = this.normalizeId(mailboxIdInput);
    const before = await this.repository.findById(mailboxId);
    if (!before) throw new NotFoundException('邮箱不存在');
    const appPassword = this.normalizeAppPassword(dto.appPassword);
    await this.verifyProvider({ email: before.email, provider: before.provider, appPassword });
    const encrypted = this.encryption.encrypt(appPassword);
    if (!encrypted) throw new ServiceUnavailableException('敏感信息加密失败');

    const row = await this.transactionManager.execute(
      async (tx, context) => {
        const current = await this.repository.findById(mailboxId, tx);
        if (!current) throw new NotFoundException('邮箱不存在');
        const updated = await this.repository.updateCredential(tx, current.id, {
          providerCredentialEncrypted: encrypted,
          updatedByUserId: userId,
          verifiedAt: context.businessTime
        });
        await this.audit.append(tx, {
          userId,
          module: 'id_business_v2',
          action: 'id_business_v2.managed_mailbox.credential_update',
          objectType: 'id_business_v2_managed_mailbox',
          objectId: updated.id,
          beforeData: toV2JsonDocument(this.toAuditData(current)),
          afterData: toV2JsonDocument({ ...this.toAuditData(updated), credentialUpdated: true }),
          remark: `已更新邮箱授权：${updated.email}`
        });
        return updated;
      },
      { requestId, operator, retryMode: 'none' }
    );
    return this.toResponse(row);
  }

  async rotateQueryCode(
    mailboxIdInput: unknown,
    operator?: AuthenticatedUser,
    requestId = 'managed-mailbox-query-code-rotate'
  ): Promise<CreateV2ManagedMailboxResult> {
    const userId = this.requireAdmin(operator);
    const mailboxId = this.normalizeId(mailboxIdInput);
    const queryCode = this.generateQueryCode();
    const queryCodeHash = this.encryption.hash(queryCode);
    if (!queryCodeHash) throw new ServiceUnavailableException('查询码生成失败');

    const row = await this.transactionManager.execute(
      async (tx) => {
        const before = await this.repository.findById(mailboxId, tx);
        if (!before) throw new NotFoundException('邮箱不存在');
        const updated = await this.repository.updateQueryCode(tx, before.id, {
          queryCodeHash,
          queryCodeHint: queryCode.slice(-4),
          updatedByUserId: userId
        });
        await this.audit.append(tx, {
          userId,
          module: 'id_business_v2',
          action: 'id_business_v2.managed_mailbox.query_code_rotate',
          objectType: 'id_business_v2_managed_mailbox',
          objectId: updated.id,
          beforeData: toV2JsonDocument(this.toAuditData(before)),
          afterData: toV2JsonDocument({ ...this.toAuditData(updated), queryCodeRotated: true }),
          remark: `已重置买家查询码：${updated.email}`
        });
        return updated;
      },
      { requestId, operator, retryMode: 'none' }
    );

    return { mailbox: this.toResponse(row), buyerCredential: `${row.email}----${queryCode}` };
  }

  private async verifyProvider(input: {
    appPassword: string;
    email: string;
    provider: V2MailProvider;
  }) {
    try {
      await this.mailProvider.verify(input);
    } catch (error) {
      if (error instanceof MailProviderAuthenticationError) {
        throw new BadRequestException('邮箱或应用专用密码不正确');
      }
      if (error instanceof MailProviderUnavailableError && error.code === 'edge_runtime') {
        throw new ServiceUnavailableException('当前后端不支持 IMAP，请使用 Node 邮件运行时');
      }
      throw new ServiceUnavailableException('暂时无法连接邮箱服务，请稍后重试');
    }
  }

  private normalizeCreate(dto: CreateIdBusinessV2ManagedMailboxDto) {
    const email = this.normalizeEmail(dto.email);
    const provider = this.normalizeProvider(dto.provider);
    if (provider === 'icloud' && !/@(icloud\.com|me\.com|mac\.com)$/i.test(email)) {
      throw new BadRequestException('iCloud 类型只支持 iCloud、me.com 或 mac.com 邮箱');
    }
    return {
      appPassword: this.normalizeAppPassword(dto.appPassword),
      email,
      label: this.normalizeLabel(dto.label),
      provider
    };
  }

  private normalizeListQuery(
    dto: ListIdBusinessV2ManagedMailboxesDto
  ): Required<Pick<V2ManagedMailboxListQuery, 'page' | 'pageSize'>> &
    Pick<V2ManagedMailboxListQuery, 'provider' | 'q' | 'status'> {
    const page = this.normalizePositiveInteger(dto.page, 1, 1, 100_000, '页码');
    const pageSize = this.normalizePositiveInteger(dto.pageSize, 20, 10, 100, '每页数量');
    const provider =
      dto.provider === undefined || dto.provider === ''
        ? undefined
        : this.normalizeProvider(dto.provider);
    const status =
      dto.status === undefined || dto.status === ''
        ? undefined
        : V2_MANAGED_MAILBOX_STATUSES.includes(dto.status as V2ManagedMailboxStatus)
          ? (dto.status as V2ManagedMailboxStatus)
          : (() => {
              throw new BadRequestException('邮箱状态无效');
            })();
    const q = typeof dto.q === 'string' ? dto.q.trim().slice(0, 100) : undefined;
    return { page, pageSize, provider, q: q || undefined, status };
  }

  private normalizePositiveInteger(
    value: unknown,
    fallback: number,
    minimum: number,
    maximum: number,
    label: string
  ) {
    if (value === undefined || value === '') return fallback;
    const parsed = Number(value);
    if (!Number.isInteger(parsed) || parsed < minimum || parsed > maximum) {
      throw new BadRequestException(`${label}无效`);
    }
    return parsed;
  }

  private normalizeEmail(value: unknown) {
    if (typeof value !== 'string') throw new BadRequestException('请输入邮箱');
    const email = value.trim().toLowerCase();
    if (!email || email.length > V2_MAIL_VIEWER_LIMITS.email || !EMAIL_PATTERN.test(email)) {
      throw new BadRequestException('请输入有效的邮箱地址');
    }
    return email;
  }

  private normalizeProvider(value: unknown): V2MailProvider {
    if (typeof value === 'string' && V2_MAIL_PROVIDERS.includes(value as V2MailProvider)) {
      return value as V2MailProvider;
    }
    throw new BadRequestException('请选择 Gmail 或 iCloud');
  }

  private normalizeAppPassword(value: unknown) {
    if (typeof value !== 'string') throw new BadRequestException('请输入应用专用密码');
    const appPassword = value.replace(/\s+/g, '').trim();
    if (!appPassword || appPassword.length > V2_MAIL_VIEWER_LIMITS.providerCredential) {
      throw new BadRequestException('应用专用密码格式不正确');
    }
    if (Array.from(appPassword).some((character) => character.charCodeAt(0) < 33)) {
      throw new BadRequestException('应用专用密码格式不正确');
    }
    return appPassword;
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

  private normalizeControllableStatus(
    value: unknown
  ): Extract<V2ManagedMailboxStatus, 'active' | 'disabled'> {
    if (value === 'active' || value === 'disabled') return value;
    throw new BadRequestException('邮箱状态无效');
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

  private toAuditData(row: { email: string; provider: string; status: string }) {
    return { email: row.email, provider: row.provider, status: row.status };
  }

  private toResponse(row: {
    id: string;
    email: string;
    label: string | null;
    provider: V2MailProvider;
    status: V2ManagedMailboxStatus;
    queryCodeHint: string;
    lastVerifiedAt: Date | null;
    lastQueriedAt: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }): V2ManagedMailbox {
    if (!V2_MANAGED_MAILBOX_STATUSES.includes(row.status)) {
      throw new ServiceUnavailableException('邮箱状态数据异常');
    }
    return {
      id: row.id,
      email: row.email,
      label: row.label,
      provider: row.provider,
      status: row.status,
      queryCodeHint: row.queryCodeHint,
      lastVerifiedAt: row.lastVerifiedAt?.toISOString() ?? null,
      lastQueriedAt: row.lastQueriedAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString()
    };
  }
}

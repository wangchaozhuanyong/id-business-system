import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import type {
  BatchCreateV2VendureMailboxAliasesInput,
  CreateV2VendureMailboxAliasInput,
  CreateV2VendureMailboxPrimaryInput,
  UpdateV2VendureMailboxAliasInput,
  UpdateV2VendureMailboxPrimaryInput
} from '@apple-business/shared';
import type { AuthenticatedUser } from '../../auth/auth.types';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  toV2JsonDocument
} from '../runtime/public-api';
import type {
  BatchCreateIdBusinessV2VendureMailboxAliasesDto,
  CreateIdBusinessV2VendureMailboxAliasDto,
  CreateIdBusinessV2VendureMailboxPrimaryDto,
  ListIdBusinessV2VendureMailboxDto,
  QueryIdBusinessV2VendureMailboxDto,
  ReassignIdBusinessV2VendureMailboxMailDto,
  UpdateIdBusinessV2VendureMailboxAliasDto,
  UpdateIdBusinessV2VendureMailboxPrimaryDto
} from './dto/id-business-v2-vendure-mailbox.dto';
import { IdBusinessV2VendureMailboxClient } from './providers/id-business-v2-vendure-mailbox.client';

const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const PRIMARY_STATUSES = new Set(['ACTIVE', 'DISABLED', 'AUTH_ERROR', 'SYNCING']);
const ALIAS_STATUSES = new Set(['ACTIVE', 'DISABLED']);

@Injectable()
export class IdBusinessV2VendureMailboxService {
  constructor(
    private readonly client: IdBusinessV2VendureMailboxClient,
    private readonly transactionManager: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService
  ) {}

  status(operator?: AuthenticatedUser) {
    this.requireAdmin(operator);
    return { configured: this.client.isConfigured() };
  }

  async listPrimary(dto: ListIdBusinessV2VendureMailboxDto, operator?: AuthenticatedUser) {
    this.requireAdmin(operator);
    const query = this.listQuery(dto);
    const items = (await this.client.primaryAccounts()).filter(
      (item) =>
        (!query.status || item.status === query.status) &&
        (!query.q || this.includes(item, query.q, ['email', 'note']))
    );
    return this.page(items, query.page, query.pageSize);
  }

  async listAliases(dto: ListIdBusinessV2VendureMailboxDto, operator?: AuthenticatedUser) {
    this.requireAdmin(operator);
    const query = this.listQuery(dto);
    const primaryAccountId = this.optionalId(dto.primaryAccountId);
    const items = (await this.client.virtualEmails(primaryAccountId)).filter(
      (item) =>
        (!query.status || item.status === query.status) &&
        (!query.q || this.includes(item, query.q, ['aliasEmail', 'primaryAccountEmail', 'note']))
    );
    return this.page(items, query.page, query.pageSize);
  }

  async listMails(dto: ListIdBusinessV2VendureMailboxDto, operator?: AuthenticatedUser) {
    this.requireAdmin(operator);
    const query = this.listQuery(dto);
    const items = (
      await this.client.receivedMails({
        primaryAccountId: this.optionalId(dto.primaryAccountId),
        virtualEmailId: this.optionalId(dto.virtualEmailId),
        unassignedOnly: this.boolean(dto.unassignedOnly),
        limit: 500
      })
    ).filter(
      (item) =>
        !query.q ||
        this.includes(item, query.q, ['fromAddress', 'fromName', 'subject', 'extractedCode'])
    );
    return this.page(items, query.page, query.pageSize);
  }

  async createPrimary(
    dto: CreateIdBusinessV2VendureMailboxPrimaryDto,
    operator?: AuthenticatedUser,
    requestId = 'vendure-mailbox-primary-create'
  ) {
    const userId = this.requireAdmin(operator);
    const input: CreateV2VendureMailboxPrimaryInput = {
      email: this.email(dto.email),
      appPassword: this.requiredString(dto.appPassword, '请填写 iCloud 专用密码', 256),
      ...this.primaryEditable(dto)
    };
    const result = await this.client.createPrimary(input);
    await this.record(
      userId,
      operator,
      requestId,
      'primary.create',
      'vendure_icloud_primary',
      result.id
    );
    return result;
  }

  async updatePrimary(
    idValue: unknown,
    dto: UpdateIdBusinessV2VendureMailboxPrimaryDto,
    operator?: AuthenticatedUser,
    requestId = 'vendure-mailbox-primary-update'
  ) {
    const userId = this.requireAdmin(operator);
    const id = this.id(idValue);
    const input: UpdateV2VendureMailboxPrimaryInput = {
      ...(dto.email === undefined ? {} : { email: this.email(dto.email) }),
      ...(dto.appPassword === undefined
        ? {}
        : { appPassword: this.requiredString(dto.appPassword, '专用密码不能为空', 256) }),
      ...this.primaryEditable(dto),
      ...(dto.status === undefined
        ? {}
        : {
            status: this.statusValue(
              dto.status,
              PRIMARY_STATUSES
            ) as UpdateV2VendureMailboxPrimaryInput['status']
          })
    };
    const result = await this.client.updatePrimary(id, input);
    await this.record(userId, operator, requestId, 'primary.update', 'vendure_icloud_primary', id);
    return result;
  }

  async deletePrimary(
    idValue: unknown,
    operator?: AuthenticatedUser,
    requestId = 'vendure-mailbox-primary-delete'
  ) {
    const userId = this.requireAdmin(operator);
    const id = this.id(idValue);
    const result = await this.client.deletePrimary(id);
    await this.record(userId, operator, requestId, 'primary.delete', 'vendure_icloud_primary', id);
    return { deleted: result };
  }

  async primaryAction(
    idValue: unknown,
    action: 'test' | 'sync' | 'reset-code',
    operator?: AuthenticatedUser,
    requestId = 'vendure-mailbox-primary-action'
  ) {
    const userId = this.requireAdmin(operator);
    const id = this.id(idValue);
    const result =
      action === 'test'
        ? await this.client.testConnection(id)
        : action === 'sync'
          ? await this.client.syncPrimary(id)
          : await this.client.resetPrimaryCode(id);
    await this.record(
      userId,
      operator,
      requestId,
      `primary.${action}`,
      'vendure_icloud_primary',
      id
    );
    return result;
  }

  async reconcile(
    idValue: unknown,
    dryRunValue: unknown,
    operator?: AuthenticatedUser,
    requestId = 'vendure-mailbox-reconcile'
  ) {
    const userId = this.requireAdmin(operator);
    const id = this.id(idValue);
    const dryRun = dryRunValue !== false;
    const result = await this.client.reconcileHistory(id, dryRun);
    await this.record(
      userId,
      operator,
      requestId,
      dryRun ? 'mail.reconcile.preview' : 'mail.reconcile.apply',
      'vendure_icloud_primary',
      id
    );
    return result;
  }

  async createAlias(
    dto: CreateIdBusinessV2VendureMailboxAliasDto,
    operator?: AuthenticatedUser,
    requestId = 'vendure-mailbox-alias-create'
  ) {
    const userId = this.requireAdmin(operator);
    const input: CreateV2VendureMailboxAliasInput = {
      primaryAccountId: this.id(dto.primaryAccountId),
      aliasEmail: this.email(dto.aliasEmail),
      ...this.aliasEditable(dto)
    };
    const result = await this.client.createAlias(input);
    await this.record(
      userId,
      operator,
      requestId,
      'alias.create',
      'vendure_icloud_alias',
      result.id
    );
    return result;
  }

  async batchCreateAliases(
    dto: BatchCreateIdBusinessV2VendureMailboxAliasesDto,
    operator?: AuthenticatedUser,
    requestId = 'vendure-mailbox-alias-batch-create'
  ) {
    const userId = this.requireAdmin(operator);
    const input: BatchCreateV2VendureMailboxAliasesInput = {
      primaryAccountId: this.id(dto.primaryAccountId),
      rawInput: this.requiredString(dto.rawInput, '请填写要导入的虚拟邮箱', 100_000),
      ...(dto.codeResetIntervalDays === undefined
        ? {}
        : { codeResetIntervalDays: this.days(dto.codeResetIntervalDays) })
    };
    const result = await this.client.batchCreateAliases(input);
    await this.record(
      userId,
      operator,
      requestId,
      'alias.batch-create',
      'vendure_icloud_primary',
      input.primaryAccountId
    );
    return result;
  }

  async updateAlias(
    idValue: unknown,
    dto: UpdateIdBusinessV2VendureMailboxAliasDto,
    operator?: AuthenticatedUser,
    requestId = 'vendure-mailbox-alias-update'
  ) {
    const userId = this.requireAdmin(operator);
    const id = this.id(idValue);
    const input: UpdateV2VendureMailboxAliasInput = {
      ...(dto.aliasEmail === undefined ? {} : { aliasEmail: this.email(dto.aliasEmail) }),
      ...this.aliasEditable(dto),
      ...(dto.status === undefined
        ? {}
        : {
            status: this.statusValue(
              dto.status,
              ALIAS_STATUSES
            ) as UpdateV2VendureMailboxAliasInput['status']
          })
    };
    const result = await this.client.updateAlias(id, input);
    await this.record(userId, operator, requestId, 'alias.update', 'vendure_icloud_alias', id);
    return result;
  }

  async aliasAction(
    idValue: unknown,
    action: 'reset-code' | 'delete',
    operator?: AuthenticatedUser,
    requestId = 'vendure-mailbox-alias-action'
  ) {
    const userId = this.requireAdmin(operator);
    const id = this.id(idValue);
    const result =
      action === 'delete'
        ? await this.client.deleteAlias(id)
        : await this.client.resetAliasCode(id);
    await this.record(userId, operator, requestId, `alias.${action}`, 'vendure_icloud_alias', id);
    return action === 'delete' ? { deleted: result } : result;
  }

  async reassignMail(
    idValue: unknown,
    dto: ReassignIdBusinessV2VendureMailboxMailDto,
    operator?: AuthenticatedUser,
    requestId = 'vendure-mailbox-mail-reassign'
  ) {
    const userId = this.requireAdmin(operator);
    const id = this.id(idValue);
    const result = await this.client.reassignMail(id, this.id(dto.virtualEmailId));
    await this.record(userId, operator, requestId, 'mail.reassign', 'vendure_icloud_mail', id);
    return result;
  }

  async deleteMail(
    idValue: unknown,
    operator?: AuthenticatedUser,
    requestId = 'vendure-mailbox-mail-delete'
  ) {
    const userId = this.requireAdmin(operator);
    const id = this.id(idValue);
    const result = await this.client.deleteMail(id);
    await this.record(userId, operator, requestId, 'mail.delete', 'vendure_icloud_mail', id);
    return { deleted: result };
  }

  publicQuery(dto: QueryIdBusinessV2VendureMailboxDto, clientIp?: string) {
    const queryCode = this.requiredString(dto.queryCode, '请填写邮箱查询码', 100);
    return this.client.publicQuery(queryCode, clientIp);
  }

  private primaryEditable(
    dto: CreateIdBusinessV2VendureMailboxPrimaryDto | UpdateIdBusinessV2VendureMailboxPrimaryDto
  ) {
    return {
      ...(dto.note === undefined ? {} : { note: this.optionalString(dto.note, 500) }),
      ...(dto.imapHost === undefined
        ? {}
        : { imapHost: this.requiredString(dto.imapHost, 'IMAP 地址不能为空', 255) }),
      ...(dto.imapPort === undefined
        ? {}
        : { imapPort: this.integer(dto.imapPort, 1, 65_535, 'IMAP 端口') }),
      ...(dto.codeResetIntervalDays === undefined
        ? {}
        : { codeResetIntervalDays: this.days(dto.codeResetIntervalDays) }),
      ...(dto.masterQueryCode === undefined
        ? {}
        : { masterQueryCode: this.requiredString(dto.masterQueryCode, '主查询码不能为空', 100) })
    };
  }

  private aliasEditable(
    dto: CreateIdBusinessV2VendureMailboxAliasDto | UpdateIdBusinessV2VendureMailboxAliasDto
  ) {
    return {
      ...(dto.note === undefined ? {} : { note: this.optionalString(dto.note, 500) }),
      ...(dto.buyerQueryCode === undefined
        ? {}
        : { buyerQueryCode: this.requiredString(dto.buyerQueryCode, '买家查询码不能为空', 100) }),
      ...(dto.codeResetIntervalDays === undefined
        ? {}
        : { codeResetIntervalDays: this.days(dto.codeResetIntervalDays) })
    };
  }

  private listQuery(dto: ListIdBusinessV2VendureMailboxDto) {
    return {
      page: this.integer(dto.page ?? 1, 1, 100_000, '页码'),
      pageSize: this.integer(dto.pageSize ?? 20, 1, 1000, '每页数量'),
      q: this.optionalString(dto.q, 120).toLocaleLowerCase(),
      status: this.optionalString(dto.status, 30)
    };
  }

  private page<T>(items: T[], page: number, pageSize: number) {
    const ordered = [...items].sort((left, right) =>
      this.updatedAt(right).localeCompare(this.updatedAt(left))
    );
    return {
      items: ordered.slice((page - 1) * pageSize, page * pageSize),
      total: ordered.length,
      page,
      pageSize
    };
  }

  private updatedAt(value: unknown) {
    const record = value as { updatedAt?: unknown; receivedAt?: unknown };
    return String(record.receivedAt ?? record.updatedAt ?? '');
  }

  private includes(value: unknown, query: string, keys: string[]) {
    const record = value as Record<string, unknown>;
    return keys.some((key) =>
      String(record[key] ?? '')
        .toLocaleLowerCase()
        .includes(query)
    );
  }

  private requireAdmin(operator?: AuthenticatedUser) {
    if (!operator?.id || !operator.roles.includes('admin'))
      throw new ForbiddenException('仅管理员可管理 Vendure 邮箱');
    return operator.id;
  }

  private id(value: unknown) {
    return this.requiredString(value, '记录编号无效', 80);
  }

  private optionalId(value: unknown) {
    const result = this.optionalString(value, 80);
    return result || undefined;
  }

  private email(value: unknown) {
    const email = this.requiredString(value, '请填写有效邮箱地址', 320).toLocaleLowerCase();
    if (!EMAIL_PATTERN.test(email)) throw new BadRequestException('请填写有效邮箱地址');
    return email;
  }

  private requiredString(value: unknown, message: string, maxLength: number) {
    if (typeof value !== 'string' || !value.trim() || value.trim().length > maxLength)
      throw new BadRequestException(message);
    return value.trim();
  }

  private optionalString(value: unknown, maxLength: number) {
    if (value === undefined || value === null) return '';
    if (typeof value !== 'string' || value.trim().length > maxLength)
      throw new BadRequestException('提交内容格式无效');
    return value.trim();
  }

  private integer(value: unknown, min: number, max: number, label: string) {
    const parsed = typeof value === 'number' ? value : Number(value);
    if (!Number.isInteger(parsed) || parsed < min || parsed > max)
      throw new BadRequestException(`${label}需要是 ${min} 至 ${max} 的整数`);
    return parsed;
  }

  private days(value: unknown) {
    return this.integer(value, 1, 3650, '查询码有效天数');
  }

  private statusValue(value: unknown, allowed: Set<string>) {
    if (typeof value !== 'string' || !allowed.has(value))
      throw new BadRequestException('邮箱状态无效');
    return value;
  }

  private boolean(value: unknown) {
    if (
      value === undefined ||
      value === null ||
      value === '' ||
      value === false ||
      value === 'false'
    )
      return undefined;
    if (value === true || value === 'true') return true;
    throw new BadRequestException('未分配筛选值无效');
  }

  private async record(
    userId: string,
    operator: AuthenticatedUser | undefined,
    requestId: string,
    action: string,
    objectType: string,
    objectId: string
  ) {
    await this.transactionManager.execute(
      async (tx) => {
        await this.audit.append(tx, {
          userId,
          module: 'id_business_v2',
          action: `id_business_v2.vendure_mailbox.${action}`,
          objectType,
          objectId,
          afterData: toV2JsonDocument({ remoteSystem: 'vendure', action }),
          remark: '已通过 ID 系统操作 Vendure 邮箱数据'
        });
      },
      { changedScopes: ['auto-recharge'], requestId, operator, retryMode: 'none' }
    );
  }
}

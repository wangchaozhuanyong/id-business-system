import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { V2RegistrationMailbox } from '@apple-business/shared';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { getPagination } from '../../common/pagination';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import { IdBusinessV2VendureMailboxService } from '../workspace/public-api';
import { RegistrationRepository } from './persistence/registration.repository';
import { record, text } from './registration-validation';

@Injectable()
export class RegistrationMailboxesService {
  constructor(
    private readonly repository: RegistrationRepository,
    private readonly mailboxes: IdBusinessV2VendureMailboxService,
    private readonly transactions: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService,
    private readonly encryption: FieldEncryptionService
  ) {}

  async list(
    query: { page?: string; pageSize?: string; keyword?: string },
    operator: AuthenticatedUser
  ) {
    const pagination = getPagination(query);
    const page = await this.mailboxes.listAliases(
      { page: pagination.page, pageSize: pagination.pageSize, q: query.keyword },
      operator
    );
    const hashes = page.items.map(
      (row) => this.encryption.hash(row.aliasEmail.trim().toLowerCase())!
    );
    const accounts = hashes.length ? await this.repository.accountsByEmailHashes(hashes) : [];
    const accountsByHash = new Map(accounts.map((account) => [account.emailHash, account]));
    const items: V2RegistrationMailbox[] = page.items.map((row, index) => {
      const account = accountsByHash.get(hashes[index]!);
      return {
        id: row.id,
        email: row.aliasEmail,
        primaryEmail: row.primaryAccountEmail,
        status: row.status,
        registered: account?.registered ?? false,
        accountId: account?.id ?? null,
        accountUpdatedAt: account?.updatedAt.toISOString() ?? null,
        note: row.note,
        updatedAt: row.updatedAt
      };
    });
    return { items, total: page.total, page: pagination.page, pageSize: pagination.pageSize };
  }

  async markRegistered(aliasId: string, value: unknown, operator: AuthenticatedUser) {
    const input = record(value);
    if (
      Object.keys(input).some(
        (key) => !['expectedUpdatedAt', 'registered', 'expectedAccountUpdatedAt'].includes(key)
      )
    )
      throw new BadRequestException('注册标记包含未知字段');
    const explicitStatus = Object.hasOwn(input, 'registered');
    if (explicitStatus && typeof input.registered !== 'boolean')
      throw new BadRequestException('注册状态必须为已注册或未注册');
    const registered = explicitStatus ? (input.registered as boolean) : true;
    let expectedAccountUpdatedAt: number | null = null;
    if (explicitStatus) {
      if (!Object.hasOwn(input, 'expectedAccountUpdatedAt'))
        throw new BadRequestException('缺少账号资料版本，请刷新后重新确认');
      if (input.expectedAccountUpdatedAt !== null) {
        expectedAccountUpdatedAt = Date.parse(
          text(input.expectedAccountUpdatedAt, '账号资料版本', 40)
        );
        if (!Number.isFinite(expectedAccountUpdatedAt))
          throw new BadRequestException('账号资料版本无效');
      }
    }
    const expectedUpdatedAt = Date.parse(text(input.expectedUpdatedAt, '邮箱资料版本', 40));
    if (!Number.isFinite(expectedUpdatedAt)) throw new BadRequestException('邮箱资料版本无效');
    const { email, updatedAt } = await this.mailboxes.aliasAddress(aliasId, operator);
    if (Date.parse(updatedAt) !== expectedUpdatedAt)
      throw new ConflictException('隐藏邮箱资料已变化，请刷新后重新确认');
    if (email.length > 250) throw new BadRequestException('邮箱地址过长，无法保存为 ChatGPT 账号');
    const emailHash = this.encryption.hash(email)!;
    const [local, domain] = email.split('@');
    return this.transactions.execute(
      async (tx) => {
        await this.repository.lock(tx);
        let account = await this.repository.account(tx, emailHash);
        const beforeRegistered = account?.registered ?? false;
        if (explicitStatus && (account?.updatedAt.getTime() ?? null) !== expectedAccountUpdatedAt)
          throw new ConflictException('账号资料已变化，请刷新后重新确认');
        if (!explicitStatus && account && !account.registered)
          throw new ConflictException('注册状态已修改，请刷新后使用新的标记操作');
        const created = !account && registered;
        if (beforeRegistered !== registered) {
          if (await this.repository.activeEmail(tx, emailHash))
            throw new ConflictException('该邮箱有注册任务正在执行，请先结束或取消任务再修改状态');
        }
        if (created) {
          account = await this.repository.createManualAccount(tx, {
            emailHash,
            emailEncrypted: this.encryption.encrypt(email)!,
            emailMasked: `${local.slice(0, 2)}***@${domain}`,
            createdByUserId: operator.id,
            updatedByUserId: operator.id
          });
        } else if (account && beforeRegistered !== registered) {
          account = await this.repository.setAccountRegistered(
            tx,
            account.id,
            account.updatedAt,
            registered,
            operator.id
          );
        }
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: `id_business_v2.auto_registration.${registered ? 'mark_registered' : 'mark_unregistered'}`,
          objectType: account ? 'chatgpt_account' : 'registration_mailbox',
          objectId: account?.id,
          beforeData: { registered: beforeRegistered },
          afterData: {
            emailMasked: account?.emailMasked ?? `${local.slice(0, 2)}***@${domain}`,
            registered,
            created
          },
          remark: registered
            ? '管理员确认已注册，创建或复用 ChatGPT 账号'
            : '管理员修正为未注册，保留已有账号资料'
        });
        return explicitStatus
          ? {
              accountId: account?.id ?? null,
              created,
              registered,
              accountUpdatedAt: account?.updatedAt.toISOString() ?? null
            }
          : { accountId: account!.id, created };
      },
      {
        changedScopes: ['auto-recharge'],
        operator,
        requestId: randomUUID(),
        retryMode: 'none',
        uniqueConflictMessage: '该邮箱账号已保存，请刷新后重试；不会创建重复账号'
      }
    );
  }
}

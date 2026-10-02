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
    const accountIds = new Map(accounts.map((account) => [account.emailHash, account.id]));
    const items: V2RegistrationMailbox[] = page.items.map((row, index) => {
      const accountId = accountIds.get(hashes[index]!) ?? null;
      return {
        id: row.id,
        email: row.aliasEmail,
        primaryEmail: row.primaryAccountEmail,
        status: row.status,
        registered: Boolean(accountId),
        accountId,
        note: row.note,
        updatedAt: row.updatedAt
      };
    });
    return { items, total: page.total, page: pagination.page, pageSize: pagination.pageSize };
  }

  async markRegistered(aliasId: string, value: unknown, operator: AuthenticatedUser) {
    const input = record(value);
    if (Object.keys(input).some((key) => key !== 'expectedUpdatedAt'))
      throw new BadRequestException('注册标记包含未知字段');
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
        const created = !account;
        if (!account) {
          if (await this.repository.activeEmail(tx, emailHash))
            throw new ConflictException('该邮箱有注册任务正在执行，请先结束或取消任务再标记');
          account = await this.repository.createManualAccount(tx, {
            emailHash,
            emailEncrypted: this.encryption.encrypt(email)!,
            emailMasked: `${local.slice(0, 2)}***@${domain}`,
            createdByUserId: operator.id,
            updatedByUserId: operator.id
          });
        }
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_registration.mark_registered',
          objectType: 'chatgpt_account',
          objectId: account.id,
          afterData: { emailMasked: account.emailMasked, created },
          remark: '管理员确认已注册，加入 ChatGPT 账号'
        });
        return { accountId: account.id, created };
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

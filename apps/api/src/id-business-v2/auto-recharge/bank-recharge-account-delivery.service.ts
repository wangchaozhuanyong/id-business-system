import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  toV2JsonDocument
} from '../runtime/public-api';
import { IdBusinessV2VendureMailboxService } from '../workspace/public-api';
import { BankRechargeAccountService } from './bank-recharge-account.service';
import { RechargeSettingsRepository } from './persistence/recharge-settings.repository';
import { bankRechargeObject } from './bank-recharge-validation';
import { accountCopySuffix } from './account-copy-settings';
import { storedBrowserOptions } from './recharge-browser-options';

@Injectable()
export class BankRechargeAccountDeliveryService {
  constructor(
    private readonly accounts: BankRechargeAccountService,
    private readonly mailboxes: IdBusinessV2VendureMailboxService,
    private readonly settings: RechargeSettingsRepository,
    private readonly encryption: FieldEncryptionService,
    private readonly transactions: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService
  ) {}

  private requireAdmin(operator: AuthenticatedUser) {
    if (!operator.id || !operator.roles.includes('admin'))
      throw new ForbiddenException('仅管理员可复制账号资料');
  }

  async copySettings(operator: AuthenticatedUser) {
    this.requireAdmin(operator);
    return { suffix: accountCopySuffix((await this.settings.find(operator.id))?.browserOptions) };
  }

  async updateCopySettings(value: unknown, operator: AuthenticatedUser) {
    this.requireAdmin(operator);
    const input = bankRechargeObject(value);
    if (
      Object.keys(input).some((key) => key !== 'suffix') ||
      typeof input.suffix !== 'string' ||
      input.suffix.length > 5000 ||
      [...input.suffix].some((character) => {
        const code = character.charCodeAt(0);
        return code === 127 || (code < 32 && ![9, 10, 13].includes(code));
      })
    )
      throw new BadRequestException('复制后缀格式无效，最多 5000 字');
    const suffix = input.suffix;
    await this.transactions.execute(
      async (tx) => {
        const before = await this.settings.findInTransaction(tx, operator.id);
        const options = {
          ...storedBrowserOptions(before?.browserOptions),
          ...(before?.browserOptions &&
          typeof before.browserOptions === 'object' &&
          !Array.isArray(before.browserOptions)
            ? before.browserOptions
            : {})
        };
        await this.settings.upsert(tx, operator.id, {
          browserOptions: toV2JsonDocument({ ...options, accountCopySuffix: suffix })
        });
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_recharge.account_copy.settings',
          objectType: 'recharge_browser_settings',
          objectId: operator.id,
          afterData: { suffixLength: suffix.length },
          remark: '设置账号资料复制后缀'
        });
      },
      { changedScopes: ['auto-recharge'], requestId: randomUUID(), operator, retryMode: 'none' }
    );
    return { suffix };
  }

  async copyAccount(id: string, operator: AuthenticatedUser) {
    this.requireAdmin(operator);
    const identity = await this.accounts.accountIdentity(id, operator);
    const alias = await this.mailboxes.accountBuyerCode(identity.email, operator);
    return this.transactions.execute(
      async (tx) => {
        const account = await this.accounts.requireActive(tx, id);
        if (this.encryption.decrypt(account.emailEncrypted) !== identity.email)
          throw new BadRequestException('账号邮箱已变更，请重新复制');
        const row = await this.settings.findInTransaction(tx, operator.id);
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_recharge.chatgpt_account.copy',
          objectType: 'chatgpt_account',
          objectId: id,
          afterData: {
            aliasId: alias.aliasId,
            hasPassword: Boolean(account.passwordEncrypted),
            hasTotp: Boolean(account.totpSecretEncrypted)
          },
          remark: '复制账号资料及买家查询码'
        });
        const suffix = accountCopySuffix(row?.browserOptions);
        return {
          text: `${identity.email}----${this.encryption.decrypt(account.passwordEncrypted) ?? ''}----${this.encryption.decrypt(account.totpSecretEncrypted) ?? ''}----${alias.buyerQueryCode}${suffix ? `\n${suffix}` : ''}`
        };
      },
      { changedScopes: ['audit-logs'], requestId: randomUUID(), operator, retryMode: 'none' }
    );
  }
}

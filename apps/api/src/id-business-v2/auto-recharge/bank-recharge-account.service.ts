import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { IdBusinessV2ChatgptAccount, IdBusinessV2RechargeJob } from '@prisma/client';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { BankRechargeRepository } from './persistence/bank-recharge.repository';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  type V2CommandTransaction
} from '../runtime/public-api';
import { generateIdBusinessV2TotpCode, parseIdBusinessV2TotpSecret } from '../workspace/public-api';
import {
  bankRechargeCurrency,
  bankRechargeEmail,
  bankRechargeId,
  bankRechargeMaskedEmail,
  bankRechargeObject,
  bankRechargePassword,
  bankRechargeText
} from './bank-recharge-validation';
import { supportedCurrencies, zeroDecimalCurrencies } from './recharge-local-validation';

@Injectable()
export class BankRechargeAccountService {
  constructor(
    private readonly repository: BankRechargeRepository,
    private readonly transactions: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService,
    private readonly encryption: FieldEncryptionService
  ) {}

  async listAccounts() {
    const items = await this.repository.listAccounts();
    return {
      items: items.map((item) => ({
        id: item.id,
        emailMasked: item.emailMasked,
        status: item.status,
        hasPassword: Boolean(item.passwordEncrypted),
        hasTotp: Boolean(item.totpSecretEncrypted),
        remark: item.remark,
        createdAt: item.createdAt,
        updatedAt: item.updatedAt
      }))
    };
  }

  async createAccount(value: unknown, operator: AuthenticatedUser) {
    const input = bankRechargeObject(value);
    const email = bankRechargeEmail(input.email);
    const password = bankRechargePassword(input.password);
    const totpInput = bankRechargeText(input.totpSecret, '2FA 密钥', 2048, false);
    let totp: ReturnType<typeof parseIdBusinessV2TotpSecret> | null = null;
    if (totpInput) {
      try {
        totp = parseIdBusinessV2TotpSecret(totpInput);
      } catch {
        throw new BadRequestException('2FA 密钥格式无效');
      }
    }
    const remark = bankRechargeText(input.remark, '备注', 500, false);
    return this.transactions.execute(
      async (tx) => {
        const item = await this.repository.createAccount(tx, {
          data: {
            emailEncrypted: this.encryption.encrypt(email)!,
            emailHash: this.encryption.hash(email)!,
            emailMasked: bankRechargeMaskedEmail(email),
            passwordEncrypted: this.encryption.encrypt(password),
            totpSecretEncrypted: this.encryption.encrypt(totp?.secret),
            totpAlgorithm: totp?.algorithm ?? 'sha1',
            totpDigits: totp?.digits ?? 6,
            totpPeriod: totp?.period ?? 30,
            remark: remark || null,
            createdByUserId: operator.id,
            updatedByUserId: operator.id
          }
        });
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_recharge.chatgpt_account.create',
          objectType: 'chatgpt_account',
          objectId: item.id,
          afterData: {
            emailMasked: item.emailMasked,
            hasPassword: Boolean(password),
            hasTotp: Boolean(totp)
          },
          remark: '新增 ChatGPT 充值账号'
        });
        return { id: item.id, emailMasked: item.emailMasked };
      },
      {
        changedScopes: ['auto-recharge'],
        requestId: randomUUID(),
        operator,
        retryMode: 'none',
        uniqueConflictMessage: '该 ChatGPT 邮箱已保存'
      }
    );
  }

  async updateAccount(id: string, value: unknown, operator: AuthenticatedUser) {
    bankRechargeId(id, '账号编号');
    const input = bankRechargeObject(value);
    if (!Object.keys(input).length) throw new BadRequestException('没有要修改的账号资料');
    if (
      Object.keys(input).some(
        (key) => !['email', 'password', 'totpSecret', 'status', 'remark'].includes(key)
      )
    ) {
      throw new BadRequestException('账号资料包含未知字段');
    }
    const email = input.email === undefined ? undefined : bankRechargeEmail(input.email);
    const password =
      input.password === undefined ? undefined : bankRechargePassword(input.password);
    const totpInput =
      input.totpSecret === undefined
        ? undefined
        : bankRechargeText(input.totpSecret, '2FA 密钥', 2048, false);
    let totp: ReturnType<typeof parseIdBusinessV2TotpSecret> | null = null;
    if (totpInput) {
      try {
        totp = parseIdBusinessV2TotpSecret(totpInput);
      } catch {
        throw new BadRequestException('2FA 密钥格式无效');
      }
    }
    if (input.status !== undefined && input.status !== 'active' && input.status !== 'disabled') {
      throw new BadRequestException('账号状态无效');
    }
    const remark =
      input.remark === undefined ? undefined : bankRechargeText(input.remark, '备注', 500, false);
    return this.transactions.execute(
      async (tx) => {
        const before = await this.repository.findAccount(tx, id);
        if (!before) throw new NotFoundException('ChatGPT 账号不存在');
        if (
          email &&
          email !== this.encryption.decrypt(before.emailEncrypted) &&
          before.officialAccountKey
        ) {
          throw new ConflictException('已核验的官网账号不能直接更换邮箱，请建立新账号');
        }
        const updated = await this.repository.updateAccount(tx, {
          where: { id },
          data: {
            ...(email
              ? {
                  emailEncrypted: this.encryption.encrypt(email)!,
                  emailHash: this.encryption.hash(email)!,
                  emailMasked: bankRechargeMaskedEmail(email)
                }
              : {}),
            ...(password !== undefined
              ? { passwordEncrypted: this.encryption.encrypt(password) }
              : {}),
            ...(totpInput !== undefined
              ? {
                  totpSecretEncrypted: this.encryption.encrypt(totp?.secret),
                  totpAlgorithm: totp?.algorithm ?? 'sha1',
                  totpDigits: totp?.digits ?? 6,
                  totpPeriod: totp?.period ?? 30
                }
              : {}),
            ...(input.status ? { status: input.status as 'active' | 'disabled' } : {}),
            ...(remark !== undefined ? { remark: remark || null } : {}),
            updatedByUserId: operator.id
          }
        });
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_recharge.chatgpt_account.update',
          objectType: 'chatgpt_account',
          objectId: id,
          beforeData: { emailMasked: before.emailMasked, status: before.status },
          afterData: {
            emailMasked: updated.emailMasked,
            status: updated.status,
            passwordChanged: password !== undefined,
            totpChanged: totpInput !== undefined
          },
          remark: '修改 ChatGPT 充值账号'
        });
        return { id: updated.id, emailMasked: updated.emailMasked, status: updated.status };
      },
      {
        changedScopes: ['auto-recharge'],
        requestId: randomUUID(),
        operator,
        retryMode: 'none',
        uniqueConflictMessage: '该 ChatGPT 邮箱已保存'
      }
    );
  }

  async requireActive(tx: V2CommandTransaction, id: string) {
    bankRechargeId(id, 'ChatGPT 账号');
    const account = await this.repository.findAccount(tx, id);
    if (!account || account.status !== 'active')
      throw new BadRequestException('ChatGPT 账号不存在或已停用');
    return account;
  }

  async launchCredential(id: string, operator: AuthenticatedUser) {
    bankRechargeId(id, 'ChatGPT 账号');
    return this.transactions.execute(
      async (tx) => {
        const account = await this.requireActive(tx, id);
        if (!account.passwordEncrypted) throw new ConflictException('该账号尚未保存登录密码');
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_recharge.chatgpt_account.use',
          objectType: 'chatgpt_account',
          objectId: id,
          afterData: { use: 'single_local_recharge' },
          remark: '将账号凭据交给本次本机充值任务'
        });
        return {
          email: this.encryption.decrypt(account.emailEncrypted)!,
          password: this.encryption.decrypt(account.passwordEncrypted)!
        };
      },
      { changedScopes: ['auto-recharge'], requestId: randomUUID(), operator, retryMode: 'none' }
    );
  }

  async accountIdentity(id: string, operator: AuthenticatedUser) {
    bankRechargeId(id, 'ChatGPT 账号');
    return this.transactions.execute(
      async (tx) => {
        const account = await this.requireActive(tx, id);
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_recharge.chatgpt_account.identity_read',
          objectType: 'chatgpt_account',
          objectId: id,
          afterData: { use: 'single_local_recharge' },
          remark: '读取本次充值所选账号邮箱'
        });
        return { id, email: this.encryption.decrypt(account.emailEncrypted)! };
      },
      { changedScopes: ['audit-logs'], requestId: randomUUID(), operator, retryMode: 'none' }
    );
  }

  savedLogin(account: IdBusinessV2ChatgptAccount) {
    if (!account.passwordEncrypted) throw new ConflictException('该账号尚未保存登录密码');
    return {
      email: this.encryption.decrypt(account.emailEncrypted)!,
      password: this.encryption.decrypt(account.passwordEncrypted)!
    };
  }

  async bindOfficialAccount(tx: V2CommandTransaction, id: string, accountKey: string) {
    const account = await this.requireActive(tx, id);
    if (account.officialAccountKey && account.officialAccountKey !== accountKey) {
      throw new ConflictException('官网账户与已保存的 ChatGPT 账号不一致');
    }
    if (!account.officialAccountKey) {
      await this.repository.updateAccount(tx, {
        where: { id },
        data: { officialAccountKey: accountKey }
      });
    }
  }

  async assertOfficialAccount(tx: V2CommandTransaction, id: string, accountKey: string) {
    const account = await this.requireActive(tx, id);
    if (account.officialAccountKey && account.officialAccountKey !== accountKey) {
      throw new ConflictException('官网账户与已保存的 ChatGPT 账号不一致');
    }
  }

  async ensureAccountForVerifiedPayment(tx: V2CommandTransaction, job: IdBusinessV2RechargeJob) {
    if (job.chatgptAccountId) return job.chatgptAccountId;
    if (!job.expectedEmailEncrypted || !job.accountKey) return null;
    const email = this.encryption.decrypt(job.expectedEmailEncrypted);
    if (!email) return null;
    const emailHash = this.encryption.hash(email)!;
    const [byEmail, byOfficial] = await Promise.all([
      this.repository.findAccountByEmailHash(tx, emailHash),
      this.repository.findAccountByOfficialKey(tx, job.accountKey)
    ]);
    if (byOfficial && byOfficial.id !== byEmail?.id) return null;
    if (byEmail) {
      if (
        byEmail.status !== 'active' ||
        (byEmail.officialAccountKey && byEmail.officialAccountKey !== job.accountKey)
      )
        return null;
      if (!byEmail.officialAccountKey) {
        await this.repository.updateAccount(tx, {
          where: { id: byEmail.id },
          data: { officialAccountKey: job.accountKey }
        });
      }
      return byEmail.id;
    }
    const account = await this.repository.createAccount(tx, {
      data: {
        emailEncrypted: this.encryption.encrypt(email)!,
        emailHash,
        emailMasked: bankRechargeMaskedEmail(email),
        officialAccountKey: job.accountKey,
        createdByUserId: job.ownerId,
        updatedByUserId: job.ownerId
      }
    });
    await this.audit.append(tx, {
      userId: job.ownerId,
      module: 'id_business_v2',
      action: 'id_business_v2.auto_recharge.chatgpt_account.create_from_payment',
      objectType: 'chatgpt_account',
      objectId: account.id,
      afterData: { emailMasked: account.emailMasked, verifiedRechargeJobId: job.id },
      remark: '官网付款成功后建立 ChatGPT 账号记录'
    });
    return account.id;
  }

  async totpCode(id: string, operator: AuthenticatedUser) {
    bankRechargeId(id, 'ChatGPT 账号');
    return this.transactions.execute(
      async (tx) => {
        const account = await this.requireActive(tx, id);
        if (!account.totpSecretEncrypted) throw new ConflictException('该账号未保存 2FA 密钥');
        const code = generateIdBusinessV2TotpCode({
          algorithm: account.totpAlgorithm,
          digits: account.totpDigits,
          period: account.totpPeriod,
          secret: this.encryption.decrypt(account.totpSecretEncrypted)!
        });
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.auto_recharge.chatgpt_account.totp_use',
          objectType: 'chatgpt_account',
          objectId: id,
          afterData: { expiresAt: code.expiresAt.toISOString() },
          remark: '为本次官网登录生成 2FA 验证码'
        });
        return code;
      },
      { changedScopes: ['auto-recharge'], requestId: randomUUID(), operator, retryMode: 'none' }
    );
  }

  async listCurrencies() {
    return {
      items: await this.repository.listCurrencies()
    };
  }

  async createCurrency(value: unknown, operator: AuthenticatedUser) {
    const input = bankRechargeObject(value);
    const code = bankRechargeCurrency(input.code);
    if (!supportedCurrencies.has(code)) {
      throw new BadRequestException('本机执行器尚不支持该币种');
    }
    const name = bankRechargeText(input.name, '币种名称', 80);
    const minorUnits = input.minorUnits;
    if (minorUnits !== 0 && minorUnits !== 2) {
      throw new BadRequestException('自动充值币种的小数位数当前支持 0 或 2');
    }
    if (minorUnits !== (zeroDecimalCurrencies.has(code) ? 0 : 2)) {
      throw new BadRequestException('币种小数位数与自动充值执行器不一致');
    }
    return this.transactions.execute(
      async (tx) => {
        const item = await this.repository.createCurrency(tx, {
          data: { code, name, minorUnits: Number(minorUnits), createdByUserId: operator.id }
        });
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.bank_recharge.currency.create',
          objectType: 'bank_recharge_currency',
          objectId: code,
          afterData: { code, name, minorUnits: item.minorUnits },
          remark: '新增银充币种'
        });
        return item;
      },
      {
        changedScopes: ['auto-recharge'],
        requestId: randomUUID(),
        operator,
        retryMode: 'none',
        uniqueConflictMessage: '该银充币种已存在'
      }
    );
  }

  async requireCurrency(tx: V2CommandTransaction, code: string) {
    const currency = await this.repository.findCurrency(tx, code);
    if (!currency || !currency.active) throw new BadRequestException('银充币种不存在或已停用');
    return currency;
  }

  async ensureVerifiedCurrency(tx: V2CommandTransaction, code: string, minorUnits: number) {
    const existing = await this.repository.findCurrency(tx, code);
    if (existing) {
      if (existing.minorUnits !== minorUnits) {
        throw new ConflictException('官网付款币种精度与银充币种设置不一致');
      }
      return existing;
    }
    if (![0, 2].includes(minorUnits)) throw new BadRequestException('官网付款币种精度无效');
    return this.repository.createCurrency(tx, {
      data: { code, name: code, minorUnits, active: true }
    });
  }

  async listCards() {
    return {
      items: await this.repository.listCards()
    };
  }

  async createCard(value: unknown, operator: AuthenticatedUser) {
    const input = bankRechargeObject(value);
    const label = bankRechargeText(input.label, '银行卡名称', 80);
    const last4 = bankRechargeText(input.last4, '银行卡尾号', 4);
    if (!/^\d{4}$/.test(last4)) throw new BadRequestException('只允许保存银行卡后四位');
    if (input.fundingType !== undefined && input.fundingType !== 'prepaid') {
      throw new BadRequestException('银充只支持预存资金银行卡');
    }
    const currencyCode = bankRechargeCurrency(input.currencyCode);
    return this.transactions.execute(
      async (tx) => {
        await this.requireCurrency(tx, currencyCode);
        const item = await this.repository.createCard(tx, {
          data: {
            label,
            last4,
            currencyCode,
            createdByUserId: operator.id
          }
        });
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: 'id_business_v2.bank_recharge.card.create',
          objectType: 'bank_recharge_card',
          objectId: item.id,
          afterData: { label, last4, currencyCode },
          remark: '新增银充银行卡标识'
        });
        return item;
      },
      { changedScopes: ['auto-recharge'], requestId: randomUUID(), operator, retryMode: 'none' }
    );
  }
}

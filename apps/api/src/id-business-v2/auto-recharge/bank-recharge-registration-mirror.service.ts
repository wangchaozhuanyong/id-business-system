import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable
} from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  type V2CommandTransaction
} from '../runtime/public-api';
import { BankRechargeRepository } from './persistence/bank-recharge.repository';
import {
  bankRechargeCountryCode,
  bankRechargeEmail,
  bankRechargeId,
  bankRechargeMaskedEmail,
  bankRechargePassword,
  bankRechargeText
} from './bank-recharge-validation';

export interface RegistrationMirrorInput {
  accountId: string;
  sourceTaskUuid: string;
  upstreamAccountId: string | number;
  email: string;
  password?: string;
  registrationCountryCode?: string | null;
  source: 'register' | 'login';
  /** 原任务、邮箱与本地账号标识的指纹，禁止包含凭据。 */
  fingerprint: string;
}

export interface RegistrationMirrorResult {
  accountId: string;
  replayed: boolean;
}

const mirrorAuditAction = 'id_business_v2.auto_registration.chatgpt_account.mirror';
const mirrorConflictMessage = '该邮箱或账号编号已有其他来源资料，请核对原账号；未覆盖任何资料';

/** 仅供服务端注册适配层使用；稳定账号编号必须先在原任务中加密登记。 */
@Injectable()
export class BankRechargeRegistrationMirrorService {
  constructor(
    private readonly repository: BankRechargeRepository,
    private readonly transactions: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService,
    private readonly encryption: FieldEncryptionService
  ) {}

  async registeredEmailHashes(emails: readonly string[], operator: AuthenticatedUser) {
    this.assertAdmin(operator);
    if (!Array.isArray(emails) || emails.length > 500)
      throw new BadRequestException('每次只能核对最多 500 个邮箱');
    const hashes = [
      ...new Set(emails.map((email) => this.encryption.hash(bankRechargeEmail(email))!))
    ];
    if (!hashes.length) return new Set<string>();
    const rows = await this.repository.accountEmailHashes(hashes);
    // 包含已软删除资料，删除不能证明邮箱没有注册过。
    return new Set(rows.map((row) => row.emailHash));
  }

  async mirrorRegistration(
    input: RegistrationMirrorInput,
    operator: AuthenticatedUser
  ): Promise<RegistrationMirrorResult> {
    this.assertAdmin(operator);
    if (!input || typeof input !== 'object' || Array.isArray(input))
      throw new BadRequestException('注册同步资料格式无效');
    const accountId = bankRechargeId(input.accountId, '账号编号').toLowerCase();
    const sourceTaskUuid = bankRechargeId(input.sourceTaskUuid, '注册任务编号').toLowerCase();
    const upstreamAccountId = bankRechargeText(
      typeof input.upstreamAccountId === 'number' && Number.isSafeInteger(input.upstreamAccountId)
        ? String(input.upstreamAccountId)
        : input.upstreamAccountId,
      '原账号编号',
      128
    );
    if (!/^[1-9]\d*$/.test(upstreamAccountId)) throw new BadRequestException('原账号编号格式无效');
    const fingerprint = bankRechargeText(input.fingerprint, '注册同步指纹', 64).toLowerCase();
    if (!/^[0-9a-f]{64}$/.test(fingerprint)) throw new BadRequestException('注册同步指纹格式无效');
    const email = bankRechargeEmail(input.email);
    const emailHash = this.encryption.hash(email)!;
    if (input.source !== 'register' && input.source !== 'login')
      throw new BadRequestException('注册账号来源无效');
    if (input.source === 'register' && input.password === undefined)
      throw new BadRequestException('新注册账号缺少已保存的登录密码');
    const password =
      input.password === undefined ? undefined : bankRechargePassword(input.password);
    const registrationCountryCode = bankRechargeCountryCode(input.registrationCountryCode);

    const replay = async (tx: V2CommandTransaction): Promise<RegistrationMirrorResult> => {
      const rows = await this.repository.registrationMirrorAccounts(tx, accountId, emailHash);
      const account = rows[0];
      if (
        rows.length !== 1 ||
        !account ||
        account.id !== accountId ||
        account.emailHash !== emailHash ||
        account.deletedAt
      )
        throw new ConflictException(mirrorConflictMessage);
      const receipts = await this.repository.registrationMirrorAudit(tx, {
        accountId,
        action: mirrorAuditAction
      });
      const proven = receipts.some(({ afterData }) => {
        if (!afterData || typeof afterData !== 'object' || Array.isArray(afterData)) return false;
        return (
          afterData.sourceTaskUuid === sourceTaskUuid &&
          afterData.upstreamAccountId === upstreamAccountId &&
          afterData.fingerprint === fingerprint &&
          afterData.source === input.source &&
          afterData.registrationCountryCode === registrationCountryCode &&
          afterData.emailHash === emailHash
        );
      });
      if (!proven) throw new ConflictException(mirrorConflictMessage);
      return { accountId, replayed: true };
    };

    return this.transactions.execute(
      async (tx) => {
        const existing = await this.repository.registrationMirrorAccounts(tx, accountId, emailHash);
        if (existing.length) return replay(tx);
        await this.repository.createAccount(tx, {
          data: {
            id: accountId,
            emailEncrypted: this.encryption.encrypt(email)!,
            emailHash,
            emailMasked: bankRechargeMaskedEmail(email),
            registered: true,
            registrationCountryCode,
            ...(password !== undefined
              ? { passwordEncrypted: this.encryption.encrypt(password) }
              : {}),
            createdByUserId: operator.id,
            updatedByUserId: operator.id
          }
        });
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: mirrorAuditAction,
          objectType: 'chatgpt_account',
          objectId: accountId,
          afterData: {
            sourceTaskUuid,
            upstreamAccountId,
            fingerprint,
            source: input.source,
            emailHash,
            emailMasked: bankRechargeMaskedEmail(email),
            registrationCountryCode,
            hasPassword: password !== undefined
          },
          remark: '保存自动注册账号及原任务来源'
        });
        return { accountId, replayed: false };
      },
      {
        changedScopes: ['auto-recharge'],
        requestId: sourceTaskUuid,
        operator,
        retryMode: 'stableIdempotency',
        idempotencyKey: accountId,
        replay,
        uniqueConflictMessage: mirrorConflictMessage
      }
    );
  }

  private assertAdmin(operator: AuthenticatedUser) {
    if (!operator?.id || !operator.roles?.includes('admin') || operator.mustResetPassword)
      throw new ForbiddenException('管理员授权已失效');
  }
}

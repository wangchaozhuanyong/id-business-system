import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable
} from '@nestjs/common';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { createHash } from 'node:crypto';
import { isIP } from 'node:net';
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
  schemaVersion?: 2;
  registrationIp?: string | null;
  registeredAt?: string | null;
  creationConfirmed?: boolean;
  provider?: string;
  identityStatus?: 'creation_confirmed' | 'verified';
}

export interface ManualRegisteredMirrorInput {
  email: string;
  aliasId: string;
  revision: number;
  registrationIp?: string | null;
}

export interface RegistrationMirrorResult {
  accountId: string;
  replayed: boolean;
}

const mirrorAuditAction = 'id_business_v2.auto_registration.chatgpt_account.mirror';
const manualMirrorAuditAction =
  'id_business_v2.auto_registration.chatgpt_account.manual_registered_mirror';
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
    if (input.schemaVersion !== undefined && input.schemaVersion !== 2)
      throw new BadRequestException('注册同步版本无效');
    const v2 = input.schemaVersion === 2;
    if (v2 && input.identityStatus !== 'creation_confirmed' && input.identityStatus !== 'verified')
      throw new BadRequestException('注册身份确认状态无效');
    if (
      !v2 &&
      (input.registrationIp || input.registeredAt || input.creationConfirmed !== undefined)
    )
      throw new BadRequestException('注册事实需要新版同步协议');
    if (v2 && (input.registrationIp || input.registeredAt) && input.creationConfirmed !== true)
      throw new BadRequestException('缺少官网创建确认，不能记录注册出口或时间');
    if (v2 && input.source === 'login' && input.creationConfirmed === true)
      throw new BadRequestException('已有账号登录不能作为首次注册依据');
    const registrationIp = this.registrationIp(input.registrationIp);
    const registeredAt = this.registrationTime(input.registeredAt);

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
      const sameSource = (afterData: unknown): afterData is Record<string, unknown> => {
        if (!afterData || typeof afterData !== 'object' || Array.isArray(afterData)) return false;
        return (
          'sourceTaskUuid' in afterData &&
          afterData.sourceTaskUuid === sourceTaskUuid &&
          'upstreamAccountId' in afterData &&
          afterData.upstreamAccountId === upstreamAccountId &&
          'source' in afterData &&
          afterData.source === input.source &&
          'emailHash' in afterData &&
          afterData.emailHash === emailHash
        );
      };
      const proven = receipts.some(
        ({ afterData }) =>
          sameSource(afterData) &&
          afterData.fingerprint === fingerprint &&
          afterData.registrationCountryCode === registrationCountryCode
      );
      // 同一创建检查点的新版补偿仅填空值，不覆盖人工后续修改。
      const canSupplement =
        v2 &&
        input.creationConfirmed === true &&
        receipts.some(
          ({ afterData }) =>
            sameSource(afterData) &&
            afterData.schemaVersion === 2 &&
            afterData.creationConfirmed === true
        );
      if (!proven && canSupplement) {
        const countryEdits =
          !account.registrationCountryCode && registrationCountryCode
            ? await this.repository.registrationCountryEdits(tx, accountId)
            : [];
        const countryManuallyCleared = countryEdits.some(
          ({ beforeData, afterData }) =>
            beforeData &&
            typeof beforeData === 'object' &&
            !Array.isArray(beforeData) &&
            afterData &&
            typeof afterData === 'object' &&
            !Array.isArray(afterData) &&
            typeof beforeData.registrationCountryCode === 'string' &&
            afterData.registrationCountryCode === null
        );
        const data = {
          ...(!account.passwordEncrypted && password
            ? { passwordEncrypted: this.encryption.encrypt(password) }
            : {}),
          ...(!account.registrationCountryCode && registrationCountryCode && !countryManuallyCleared
            ? { registrationCountryCode }
            : {}),
          ...(!account.registrationIpEncrypted && registrationIp
            ? { registrationIpEncrypted: this.encryption.encrypt(registrationIp) }
            : {}),
          ...(!account.registeredAt && registeredAt ? { registeredAt } : {})
        };
        if (Object.keys(data).length) {
          await this.repository.updateAccount(tx, {
            where: { id: accountId, updatedAt: account.updatedAt },
            data
          });
        }
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
            registrationCountryCode,
            schemaVersion: 2,
            creationConfirmed: true,
            identityStatus: input.identityStatus ?? null,
            supplementedFields: Object.keys(data),
            hasRegistrationIp: Boolean(registrationIp),
            registeredAt: registeredAt?.toISOString() ?? null
          },
          remark: '按原创建检查点补齐缺失注册资料'
        });
        return { accountId, replayed: false };
      }
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
            ...(v2
              ? { registrationIpEncrypted: this.encryption.encrypt(registrationIp), registeredAt }
              : {}),
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
            hasPassword: password !== undefined,
            ...(v2
              ? {
                  schemaVersion: 2,
                  creationConfirmed: input.creationConfirmed === true,
                  identityStatus: input.identityStatus ?? null,
                  provider: bankRechargeText(input.provider, '邮箱服务', 64, false),
                  hasRegistrationIp: Boolean(registrationIp),
                  registeredAt: registeredAt?.toISOString() ?? null
                }
              : {})
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

  async previewManualRegistered(input: ManualRegisteredMirrorInput, operator: AuthenticatedUser) {
    this.assertAdmin(operator);
    const values = this.manualInput(input);
    const rows = await this.repository.registrationMirrorPreview(
      values.accountId,
      values.emailHash
    );
    return this.manualPreview(rows, values);
  }

  async mirrorManualRegistered(
    input: ManualRegisteredMirrorInput,
    operator: AuthenticatedUser
  ): Promise<RegistrationMirrorResult> {
    this.assertAdmin(operator);
    const values = this.manualInput(input);
    const { accountId, email, emailHash, aliasId, revision, registrationIp } = values;
    const existing = async (tx: V2CommandTransaction) => {
      const result = this.manualPreview(
        await this.repository.registrationMirrorAccounts(tx, accountId, emailHash),
        values
      );
      if (result.status === 'exists') return { accountId: result.accountId!, replayed: true };
      throw new ConflictException(
        result.status === 'deleted' ? '该邮箱账号位于回收站，未自动恢复' : mirrorConflictMessage
      );
    };
    return this.transactions.execute(
      async (tx) => {
        const rows = await this.repository.registrationMirrorAccounts(tx, accountId, emailHash);
        if (rows.length) return existing(tx);
        await this.repository.createAccount(tx, {
          data: {
            id: accountId,
            emailEncrypted: this.encryption.encrypt(email)!,
            emailHash,
            emailMasked: bankRechargeMaskedEmail(email),
            registered: true,
            registrationCountryCode: null,
            registrationIpEncrypted: this.encryption.encrypt(registrationIp),
            registeredAt: null,
            createdByUserId: operator.id,
            updatedByUserId: operator.id
          }
        });
        await this.audit.append(tx, {
          userId: operator.id,
          module: 'id_business_v2',
          action: manualMirrorAuditAction,
          objectType: 'chatgpt_account',
          objectId: accountId,
          afterData: {
            aliasId,
            revision,
            emailHash,
            source: 'manual',
            hasRegistrationIp: Boolean(registrationIp)
          },
          remark: '人工确认已注册邮箱补建待补资料台账'
        });
        return { accountId, replayed: false };
      },
      {
        changedScopes: ['auto-recharge'],
        // 人工补建命令的稳定幂等编号；不冒充原注册任务。
        requestId: accountId,
        operator,
        retryMode: 'stableIdempotency',
        idempotencyKey: accountId,
        replay: existing,
        uniqueConflictMessage: mirrorConflictMessage
      }
    );
  }

  private manualPreview(
    rows: { id: string; emailHash: string; deletedAt: Date | null }[],
    values: { accountId: string; emailHash: string }
  ) {
    if (!rows.length) return { status: 'create' as const, accountId: values.accountId };
    if (rows.length !== 1 || rows[0]!.emailHash !== values.emailHash)
      return { status: 'conflict' as const };
    return {
      status: rows[0]!.deletedAt ? ('deleted' as const) : ('exists' as const),
      accountId: rows[0]!.id
    };
  }

  private manualInput(input: ManualRegisteredMirrorInput) {
    if (!input || typeof input !== 'object') throw new BadRequestException('人工补建资料无效');
    const email = bankRechargeEmail(input.email);
    const emailHash = this.encryption.hash(email)!;
    const aliasId = bankRechargeText(input.aliasId, '邮箱编号', 191);
    if (!Number.isSafeInteger(input.revision) || input.revision < 0)
      throw new BadRequestException('邮箱版本无效');
    const hex = createHash('sha256')
      .update(`manual-registered-account:v1:${emailHash}`)
      .digest('hex');
    const accountId = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-5${hex.slice(13, 16)}-a${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
    return {
      email,
      emailHash,
      aliasId,
      revision: input.revision,
      accountId,
      registrationIp: this.registrationIp(input.registrationIp)
    };
  }

  private registrationIp(value?: string | null) {
    if (value == null || value === '') return null;
    if (typeof value !== 'string' || !isIP(value) || value.length > 45)
      throw new BadRequestException('注册 IP 格式无效');
    return value;
  }

  private registrationTime(value?: string | null) {
    if (value == null || value === '') return null;
    if (
      typeof value !== 'string' ||
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,6})?(?:Z|[+-]\d{2}:\d{2})$/.test(value)
    )
      throw new BadRequestException('真实注册时间格式无效');
    const time = new Date(value);
    const [year, month, day, hours, minutes, seconds] = value
      .slice(0, 19)
      .split(/[-T:]/)
      .map(Number);
    if (
      month! < 1 ||
      month! > 12 ||
      day! < 1 ||
      day! > new Date(Date.UTC(year!, month!, 0)).getUTCDate() ||
      hours! > 23 ||
      minutes! > 59 ||
      seconds! > 59 ||
      !Number.isFinite(time.getTime()) ||
      time.getTime() <= 0 ||
      time.getTime() > Date.now() + 300_000
    )
      throw new BadRequestException('真实注册时间无效');
    return time;
  }

  private assertAdmin(operator: AuthenticatedUser) {
    if (!operator?.id || !operator.roles?.includes('admin') || operator.mustResetPassword)
      throw new ForbiddenException('管理员授权已失效');
  }
}

import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ServiceUnavailableException
} from '@nestjs/common';
import {
  V2_SAVED_TOTP_ACCOUNT_LIMITS,
  type V2SavedTotpAccount,
  type V2SavedTotpAccountList,
  type V2TotpAlgorithm
} from '@apple-business/shared';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import {
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  toV2JsonDocument
} from '../runtime/public-api';
import type {
  CreateIdBusinessV2TotpAccountDto,
  UpdateIdBusinessV2TotpAccountDto
} from './dto/id-business-v2-totp-account.dto';
import {
  generateIdBusinessV2TotpCode,
  parseIdBusinessV2TotpSecret,
  type IdBusinessV2TotpConfiguration
} from './id-business-v2-totp';
import { IdBusinessV2TotpAccountRepository } from './persistence/id-business-v2-totp-account.repository';

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

interface SavedTotpRow {
  id: string;
  userId: string;
  name: string;
  issuer: string | null;
  secretEncrypted: string;
  secretHash: string;
  algorithm: 'sha1' | 'sha256' | 'sha512';
  digits: number;
  period: number;
  createdAt: Date;
  updatedAt: Date;
}

@Injectable()
export class IdBusinessV2TotpAccountService {
  constructor(
    private readonly repository: IdBusinessV2TotpAccountRepository,
    private readonly transactionManager: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService,
    private readonly encryption: FieldEncryptionService
  ) {}

  async list(operator?: AuthenticatedUser): Promise<V2SavedTotpAccountList> {
    const userId = this.requireUserId(operator);
    const rows = await this.repository.listByUser(userId);
    const timestamp = Date.now();
    return { items: rows.map((row) => this.toResponse(row, timestamp)) };
  }

  async create(
    dto: CreateIdBusinessV2TotpAccountDto,
    operator?: AuthenticatedUser,
    requestId = 'workspace-totp-account-create'
  ): Promise<V2SavedTotpAccount> {
    const userId = this.requireUserId(operator);
    const name = this.normalizeName(dto.name);
    const configuration = this.normalizeSecret(dto.secret);
    const encrypted = this.encryption.encrypt(configuration.secret);
    const secretHash = this.hashConfiguration(configuration);
    if (!encrypted || !secretHash) throw new ServiceUnavailableException('2FA 密钥加密失败');

    const row = await this.transactionManager.execute(
      async (tx) => {
        if ((await this.repository.countByUser(userId, tx)) >= V2_SAVED_TOTP_ACCOUNT_LIMITS.count) {
          throw new BadRequestException(
            `每位用户最多保存 ${V2_SAVED_TOTP_ACCOUNT_LIMITS.count} 个 2FA 账号`
          );
        }
        if (await this.repository.findByUserAndName(userId, name, tx)) {
          throw new ConflictException('该账号名称已经存在');
        }
        if (await this.repository.findByUserAndSecretHash(userId, secretHash, tx)) {
          throw new ConflictException('该 2FA 密钥已经保存');
        }
        const created = await this.repository.create(tx, {
          userId,
          name,
          issuer: configuration.issuer,
          secretEncrypted: encrypted,
          secretHash,
          algorithm: configuration.algorithm,
          digits: configuration.digits,
          period: configuration.period
        });
        await this.audit.append(tx, {
          userId,
          module: 'id_business_v2',
          action: 'id_business_v2.workspace_totp_account.create',
          objectType: 'id_business_v2_totp_account',
          objectId: created.id,
          afterData: toV2JsonDocument(this.toAuditData(created)),
          remark: `已添加 2FA 账号：${created.name}`
        });
        return created;
      },
      { changedScopes: ['workspace'], requestId, operator, retryMode: 'none' }
    );

    return this.toResponse(row, Date.now());
  }

  async update(
    accountIdInput: unknown,
    dto: UpdateIdBusinessV2TotpAccountDto,
    operator?: AuthenticatedUser,
    requestId = 'workspace-totp-account-update'
  ): Promise<V2SavedTotpAccount> {
    const userId = this.requireUserId(operator);
    const accountId = this.normalizeId(accountIdInput);
    const name = this.normalizeName(dto.name);
    const configuration =
      dto.secret === undefined || dto.secret === null || dto.secret === ''
        ? null
        : this.normalizeSecret(dto.secret);
    const encrypted = configuration ? this.encryption.encrypt(configuration.secret) : null;
    const secretHash = configuration ? this.hashConfiguration(configuration) : null;
    if (configuration && (!encrypted || !secretHash)) {
      throw new ServiceUnavailableException('2FA 密钥加密失败');
    }

    const row = await this.transactionManager.execute(
      async (tx) => {
        const before = await this.repository.findByIdAndUser(accountId, userId, tx);
        if (!before) throw new NotFoundException('2FA 账号不存在');
        const duplicateName = await this.repository.findByUserAndName(userId, name, tx);
        if (duplicateName && duplicateName.id !== before.id) {
          throw new ConflictException('该账号名称已经存在');
        }
        if (secretHash) {
          const duplicateSecret = await this.repository.findByUserAndSecretHash(
            userId,
            secretHash,
            tx
          );
          if (duplicateSecret && duplicateSecret.id !== before.id) {
            throw new ConflictException('该 2FA 密钥已经保存');
          }
        }

        const updated = await this.repository.update(tx, before.id, {
          name,
          ...(configuration && encrypted && secretHash
            ? {
                issuer: configuration.issuer,
                secretEncrypted: encrypted,
                secretHash,
                algorithm: configuration.algorithm,
                digits: configuration.digits,
                period: configuration.period
              }
            : {})
        });
        await this.audit.append(tx, {
          userId,
          module: 'id_business_v2',
          action: 'id_business_v2.workspace_totp_account.update',
          objectType: 'id_business_v2_totp_account',
          objectId: updated.id,
          beforeData: toV2JsonDocument(this.toAuditData(before)),
          afterData: toV2JsonDocument({
            ...this.toAuditData(updated),
            secretUpdated: Boolean(configuration)
          }),
          remark: `已修改 2FA 账号：${updated.name}`
        });
        return updated;
      },
      { changedScopes: ['workspace'], requestId, operator, retryMode: 'none' }
    );

    return this.toResponse(row, Date.now());
  }

  async remove(
    accountIdInput: unknown,
    operator?: AuthenticatedUser,
    requestId = 'workspace-totp-account-delete'
  ) {
    const userId = this.requireUserId(operator);
    const accountId = this.normalizeId(accountIdInput);

    return this.transactionManager.execute(
      async (tx) => {
        const before = await this.repository.findByIdAndUser(accountId, userId, tx);
        if (!before) throw new NotFoundException('2FA 账号不存在');
        await this.repository.remove(tx, before.id);
        await this.audit.append(tx, {
          userId,
          module: 'id_business_v2',
          action: 'id_business_v2.workspace_totp_account.delete',
          objectType: 'id_business_v2_totp_account',
          objectId: before.id,
          beforeData: toV2JsonDocument(this.toAuditData(before)),
          afterData: toV2JsonDocument({ deleted: true }),
          remark: `已删除 2FA 账号：${before.name}`
        });
        return { id: before.id, deleted: true as const };
      },
      { changedScopes: ['workspace'], requestId, operator, retryMode: 'none' }
    );
  }

  private requireUserId(operator?: AuthenticatedUser) {
    if (!operator?.id) throw new BadRequestException('无法识别当前操作人');
    return operator.id;
  }

  private normalizeId(value: unknown) {
    if (typeof value !== 'string' || !UUID_PATTERN.test(value)) {
      throw new BadRequestException('2FA 账号标识无效');
    }
    return value;
  }

  private normalizeName(value: unknown) {
    if (typeof value !== 'string') throw new BadRequestException('请输入账号名称');
    const name = value.trim().replace(/\s+/g, ' ');
    if (!name || name.length > V2_SAVED_TOTP_ACCOUNT_LIMITS.name) {
      throw new BadRequestException(
        `账号名称长度必须为 1 至 ${V2_SAVED_TOTP_ACCOUNT_LIMITS.name} 个字符`
      );
    }
    return name;
  }

  private normalizeSecret(value: unknown) {
    if (typeof value !== 'string') throw new BadRequestException('请输入 2FA 密钥');
    try {
      return parseIdBusinessV2TotpSecret(value);
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : '2FA 密钥格式无效');
    }
  }

  private hashConfiguration(configuration: IdBusinessV2TotpConfiguration) {
    return this.encryption.hash(
      [
        configuration.algorithm,
        configuration.digits,
        configuration.period,
        configuration.secret
      ].join(':')
    );
  }

  private toAuditData(
    row: Pick<SavedTotpRow, 'algorithm' | 'digits' | 'issuer' | 'name' | 'period'>
  ) {
    return {
      name: row.name,
      issuer: row.issuer,
      algorithm: row.algorithm.toUpperCase(),
      digits: row.digits,
      period: row.period
    };
  }

  private toResponse(row: SavedTotpRow, timestamp: number): V2SavedTotpAccount {
    let secret: string | null;
    try {
      secret = this.encryption.decrypt(row.secretEncrypted);
    } catch {
      throw new ServiceUnavailableException('保存的 2FA 账号暂时无法解密');
    }
    if (!secret) throw new ServiceUnavailableException('保存的 2FA 账号缺少密钥');
    const generated = generateIdBusinessV2TotpCode(
      {
        algorithm: row.algorithm,
        digits: row.digits,
        period: row.period,
        secret
      },
      timestamp
    );
    return {
      id: row.id,
      name: row.name,
      issuer: row.issuer,
      algorithm: row.algorithm.toUpperCase() as V2TotpAlgorithm,
      digits: row.digits,
      period: row.period,
      token: generated.token,
      expiresAt: generated.expiresAt.toISOString(),
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString()
    };
  }
}

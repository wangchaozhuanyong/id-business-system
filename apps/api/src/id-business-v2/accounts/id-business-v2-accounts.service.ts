import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { IdBusinessV2BalanceCalculatorService } from '../balances/public-api';
import {
  IdBusinessV2FinanceFxService,
  IdBusinessV2FinancePostingService
} from '../finance/public-api';
import { IdBusinessV2OptionsService } from '../options/public-api';
import {
  Amount4,
  V2CommandTransactionManager,
  V2TransactionalAuditService,
  toV2JsonDocument,
  type V2CommandTransaction
} from '../runtime/public-api';
import { IdBusinessV2SensitiveAccessService } from '../sensitive-access/public-api';
import type { CreateIdBusinessV2AccountDto } from './dto/create-id-business-v2-account.dto';
import type { ImportIdBusinessV2AccountsDto } from './dto/import-id-business-v2-accounts.dto';
import type { RevealIdBusinessV2AccountSecretDto } from './dto/reveal-id-business-v2-account-secret.dto';
import type { UpdateIdBusinessV2AccountDto } from './dto/update-id-business-v2-account.dto';
import { assertAccountLossNotReported } from './id-business-v2-account-balance-guard';
import { IdBusinessV2AccountBalanceAdjustmentService } from './id-business-v2-account-balance-adjustment.service';
import { createIdBusinessV2Account } from './id-business-v2-account-create';
import { importAccountRows } from './id-business-v2-account-import';
import {
  SECRET_FIELDS,
  assertSecretPermission,
  getEncryptedSecretValue,
  maskAppleId,
  maskPhone,
  normalizeAppleId,
  normalizeMoney,
  normalizeNullableString,
  normalizePhone,
  normalizeRevealReason,
  parseRecordStatus,
  parseSaleState,
  parseSecretField,
  toAccountResponse,
  type AccountListQuery,
  type AccountUpdateData,
  type AccountWithRelations
} from './id-business-v2-account-support';
import { IdBusinessV2AccountsRepository } from './persistence/id-business-v2-accounts.repository';

export type ListIdBusinessV2AccountsQuery = AccountListQuery;
export interface AuditRequestMeta {
  requestId?: string;
  ip?: string | null;
  userAgent?: string | null;
}

export interface AccountCommandMeta {
  requestId?: string;
}

const MAX_ACCOUNT_EXPORT_ROWS = 10_000;

@Injectable()
export class IdBusinessV2AccountsService {
  constructor(
    private readonly repository: IdBusinessV2AccountsRepository,
    private readonly fieldEncryptionService: FieldEncryptionService,
    private readonly optionsService: IdBusinessV2OptionsService,
    private readonly balanceCalculator: IdBusinessV2BalanceCalculatorService,
    private readonly financeFxService: IdBusinessV2FinanceFxService,
    private readonly financePostingService: IdBusinessV2FinancePostingService,
    private readonly transactionManager: V2CommandTransactionManager,
    private readonly transactionalAudit: V2TransactionalAuditService,
    private readonly balanceAdjustmentService: IdBusinessV2AccountBalanceAdjustmentService,
    private readonly sensitiveAccessService: IdBusinessV2SensitiveAccessService
  ) {}

  async list(query: ListIdBusinessV2AccountsQuery) {
    const result = await this.repository.list(query, (value) =>
      this.fieldEncryptionService.hash(value)
    );
    return { ...result, items: result.items.map((account) => toAccountResponse(account)) };
  }

  listPurchaseSources() {
    return this.repository.listPurchaseSources();
  }

  exportRows(
    query: ListIdBusinessV2AccountsQuery,
    operator?: AuthenticatedUser,
    metadata: AccountCommandMeta = {}
  ) {
    return this.transactionManager.execute(
      async (tx, context) => {
        const result = await this.repository.listForExport(
          query,
          (value) => this.fieldEncryptionService.hash(value),
          tx
        );
        if (result.total > MAX_ACCOUNT_EXPORT_ROWS) {
          throw new BadRequestException(`单次最多导出 ${MAX_ACCOUNT_EXPORT_ROWS} 条 ID 资料`);
        }
        const items = result.items.map((account) => toAccountResponse(account));
        await this.transactionalAudit.append(tx, {
          userId: operator?.id,
          module: 'id_business_v2_accounts',
          action: 'id_business_v2.account.export',
          objectType: 'id_business_v2_account',
          afterData: toV2JsonDocument({
            count: items.length,
            containsSensitiveFields: false,
            filters: {
              hasKeyword: Boolean(normalizeNullableString(query.keyword)),
              countryOptionId: normalizeNullableString(query.countryOptionId),
              statusOptionId: normalizeNullableString(query.statusOptionId),
              supplierOptionId: normalizeNullableString(query.supplierOptionId),
              recordStatus: parseRecordStatus(query.recordStatus, false),
              saleState: parseSaleState(query.saleState)
            }
          }),
          remark: `导出 V2 ID 脱敏资料：${items.length} 条`
        });
        return {
          items,
          total: items.length,
          containsSensitiveFields: false as const,
          exportedAt: context.businessTime.toISOString()
        };
      },
      { requestId: metadata.requestId ?? randomUUID(), operator }
    );
  }

  async importRows(
    dto: ImportIdBusinessV2AccountsDto,
    operator?: AuthenticatedUser,
    metadata: AccountCommandMeta = {}
  ) {
    const requestId = metadata.requestId ?? randomUUID();
    let sequence = 0;
    const result = await importAccountRows(
      dto,
      (input, currentOperator) => {
        sequence += 1;
        return this.create(input, currentOperator, { requestId: `${requestId}:row:${sequence}` });
      },
      operator
    );
    await this.transactionManager.execute(
      async (tx) => {
        await this.transactionalAudit.append(tx, {
          userId: operator?.id,
          module: 'id_business_v2_accounts',
          action: 'id_business_v2.account.import',
          objectType: 'id_business_v2_account',
          afterData: toV2JsonDocument({
            totalCount: result.totalCount,
            successCount: result.successCount,
            failedCount: result.failedCount,
            failedRowNumbers: result.failures.map((item) => item.rowNumber)
          }),
          remark: `导入 V2 ID：成功 ${result.successCount} 条，失败 ${result.failedCount} 条`
        });
      },
      { requestId: `${requestId}:summary`, operator }
    );
    return result;
  }

  async get(id: string) {
    return toAccountResponse(await this.repository.findByIdOrThrow(id));
  }

  create(
    dto: CreateIdBusinessV2AccountDto,
    operator?: AuthenticatedUser,
    metadata: AccountCommandMeta = {}
  ) {
    return createIdBusinessV2Account(
      {
        repository: this.repository,
        fieldEncryptionService: this.fieldEncryptionService,
        optionsService: this.optionsService,
        balanceCalculator: this.balanceCalculator,
        financeFxService: this.financeFxService,
        financePostingService: this.financePostingService,
        transactionManager: this.transactionManager,
        transactionalAudit: this.transactionalAudit
      },
      dto,
      operator,
      metadata.requestId ?? randomUUID()
    );
  }

  async update(
    id: string,
    dto: UpdateIdBusinessV2AccountDto,
    operator?: AuthenticatedUser,
    metadata: AccountCommandMeta = {}
  ) {
    const requestId = metadata.requestId ?? randomUUID();
    const adjustsBalance = dto.currentBalance !== undefined || dto.balanceCostAmount !== undefined;
    const buildUpdateData = (tx: V2CommandTransaction, existing: AccountWithRelations) =>
      this.buildUpdateData(tx, existing, dto, operator);

    if (adjustsBalance) {
      const account = await this.balanceAdjustmentService.update(
        id,
        dto,
        buildUpdateData,
        operator,
        requestId
      );
      return toAccountResponse(account);
    }

    return this.transactionManager.execute(
      async (tx) => {
        const existing = await this.repository.lockAccount(tx, id);
        const updateData = await buildUpdateData(tx, existing);
        const account = await this.repository.updateActive(tx, id, updateData);
        const response = toAccountResponse(account);
        await this.transactionalAudit.append(tx, {
          userId: operator?.id,
          module: 'id_business_v2_accounts',
          action: 'id_business_v2.account.update',
          objectType: 'id_business_v2_account',
          objectId: account.id,
          beforeData: toV2JsonDocument(toAccountResponse(existing)),
          afterData: toV2JsonDocument(response),
          remark: `修改 V2 ID：${existing.appleIdMasked}`
        });
        return response;
      },
      { requestId, operator, uniqueConflictMessage: '该 Apple ID 已存在' }
    );
  }

  remove(id: string, operator?: AuthenticatedUser, metadata: AccountCommandMeta = {}) {
    return this.transactionManager.execute(
      async (tx) => {
        const existing = await this.repository.lockAccount(tx, id);
        assertAccountLossNotReported(
          existing.lossReportedAt,
          '已报损 ID 必须保留历史记录，不能删除'
        );
        if (existing.soldByOrderId) {
          throw new ConflictException('已卖出的 ID 不能删除，请先通过退款流程确认收回');
        }
        await this.repository.softDelete(tx, existing.id, operator?.id);
        await this.transactionalAudit.append(tx, {
          userId: operator?.id,
          module: 'id_business_v2_accounts',
          action: 'id_business_v2.account.delete',
          objectType: 'id_business_v2_account',
          objectId: existing.id,
          beforeData: toV2JsonDocument(toAccountResponse(existing)),
          remark: `删除 V2 ID：${existing.appleIdMasked}`
        });
        return { deleted: true };
      },
      { requestId: metadata.requestId ?? randomUUID(), operator }
    );
  }

  async revealSecret(
    id: string,
    dto: RevealIdBusinessV2AccountSecretDto,
    operator?: AuthenticatedUser,
    requestMeta: AuditRequestMeta = {}
  ) {
    const field = parseSecretField(dto.field);
    const config = SECRET_FIELDS[field];
    assertSecretPermission(config, operator);

    return this.transactionManager.execute(
      async (tx, context) => {
        const account = await this.repository.findByIdOrThrow(id, tx);
        const access = await this.sensitiveAccessService.authorize(tx, {
          approvalId: dto.approvalId,
          module: 'id_business_v2_account',
          fieldName: field,
          objectType: 'id_business_v2_account',
          objectId: account.id,
          operator,
          now: context.businessTime
        });
        const reason =
          access.mode === 'approval'
            ? access.reason
            : normalizeRevealReason(dto.reason, access.reason);
        const value = this.fieldEncryptionService.decrypt(getEncryptedSecretValue(account, field));
        if (!value) throw new NotFoundException(`${config.label}未填写`);
        await this.repository.appendSensitiveAccess(tx, {
          userId: operator?.id,
          fieldName: field,
          objectId: account.id,
          accessReason: reason,
          approved: true,
          ip: requestMeta.ip ?? undefined,
          userAgent: requestMeta.userAgent ?? undefined
        });
        await this.transactionalAudit.append(tx, {
          userId: operator?.id,
          module: 'id_business_v2_accounts',
          action: 'id_business_v2.account.secret.reveal',
          objectType: 'id_business_v2_account',
          objectId: account.id,
          afterData: toV2JsonDocument({
            field,
            reason,
            approved: true,
            accessMode: access.mode,
            approvalId: access.approvalId
          }),
          ip: requestMeta.ip ?? undefined,
          userAgent: requestMeta.userAgent ?? undefined,
          remark: `查看 V2 ID 敏感字段：${config.label} / ${account.appleIdMasked}`
        });
        return {
          accountId: account.id,
          field,
          value,
          revealedAt: context.businessTime.toISOString()
        };
      },
      { requestId: requestMeta.requestId ?? randomUUID(), operator }
    );
  }

  private async buildUpdateData(
    tx: V2CommandTransaction,
    existing: AccountWithRelations,
    dto: UpdateIdBusinessV2AccountDto,
    operator?: AuthenticatedUser
  ): Promise<AccountUpdateData> {
    assertAccountLossNotReported(existing.lossReportedAt, '已报损冻结 ID 不能再修改');
    if (
      dto.purchaseCost !== undefined &&
      !Amount4.from(normalizeMoney(dto.purchaseCost, 'ID 购买成本')).equals(existing.purchaseCost)
    ) {
      throw new BadRequestException('已入账的 ID 采购成本不能直接修改，请冲销原账务后重记');
    }
    const appleId = dto.appleId === undefined ? undefined : normalizeAppleId(dto.appleId, true)!;
    const appleIdHash =
      appleId === undefined ? undefined : this.fieldEncryptionService.hash(appleId)!;
    if (
      appleIdHash &&
      appleIdHash !== existing.appleIdHash &&
      (await this.repository.findByAppleIdHash(appleIdHash, tx, existing.id))
    ) {
      throw new ConflictException('该 Apple ID 已存在');
    }
    const country =
      dto.countryOptionId === undefined
        ? undefined
        : await this.optionsService.requireActiveOption(
            dto.countryOptionId,
            'country',
            '国家',
            false,
            tx
          );
    const status =
      dto.statusOptionId === undefined
        ? undefined
        : await this.optionsService.requireActiveOption(
            dto.statusOptionId,
            'id_status',
            'ID 状态',
            false,
            tx
          );
    const supplier =
      dto.supplierOptionId === undefined
        ? undefined
        : await this.optionsService.requireActiveOption(
            dto.supplierOptionId,
            'id_supplier',
            'ID 供应商',
            true,
            tx
          );
    const phone = dto.phone === undefined ? undefined : normalizePhone(dto.phone);
    return {
      appleIdEncrypted:
        appleId === undefined ? undefined : this.fieldEncryptionService.encrypt(appleId)!,
      appleIdHash,
      appleIdMasked: appleId === undefined ? undefined : maskAppleId(appleId),
      passwordEncrypted:
        dto.password === undefined
          ? undefined
          : this.fieldEncryptionService.encrypt(normalizeNullableString(dto.password)),
      phoneEncrypted: phone === undefined ? undefined : this.fieldEncryptionService.encrypt(phone),
      phoneHash: phone === undefined ? undefined : this.fieldEncryptionService.hash(phone),
      phoneMasked: phone === undefined ? undefined : maskPhone(phone),
      phoneTail: phone === undefined ? undefined : (phone?.slice(-8) ?? null),
      securityInfoEncrypted:
        dto.securityInfo === undefined
          ? undefined
          : this.fieldEncryptionService.encrypt(normalizeNullableString(dto.securityInfo)),
      countryOptionId: country?.id,
      statusOptionId: status?.id,
      supplierOptionId: supplier === undefined ? undefined : (supplier?.id ?? null),
      purchaseCost:
        dto.purchaseCost === undefined
          ? undefined
          : normalizeMoney(dto.purchaseCost, 'ID 购买成本'),
      recordStatus:
        dto.recordStatus === undefined
          ? undefined
          : (parseRecordStatus(dto.recordStatus, true) ?? undefined),
      remark: dto.remark === undefined ? undefined : normalizeNullableString(dto.remark),
      updatedByUserId: operator?.id
    };
  }
}

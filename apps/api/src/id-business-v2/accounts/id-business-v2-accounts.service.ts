import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { Prisma as PrismaNamespace } from '@prisma/client';
import { AuditLogsService } from '../../audit-logs/audit-logs.service';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { FieldEncryptionService } from '../../common/crypto/field-encryption.service';
import { getPagination } from '../../common/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import { verifySensitiveAccessApproval } from '../../common/sensitive-access-approval';
import { IdBusinessV2BalanceCalculatorService } from '../balances/public-api';
import { IdBusinessV2OptionsService } from '../options/public-api';
import type { CreateIdBusinessV2AccountDto } from './dto/create-id-business-v2-account.dto';
import type { ImportIdBusinessV2AccountsDto } from './dto/import-id-business-v2-accounts.dto';
import type { RevealIdBusinessV2AccountSecretDto } from './dto/reveal-id-business-v2-account-secret.dto';
import type { UpdateIdBusinessV2AccountDto } from './dto/update-id-business-v2-account.dto';
import {
  assertAccountLossNotReported,
  type LockedAccountBalanceRow
} from './id-business-v2-account-balance-guard';
import { importAccountRows } from './id-business-v2-account-import';
import {
  ACCOUNT_INCLUDE,
  SECRET_FIELDS,
  assertBalanceAdjustmentPermission,
  assertBalanceAdjustmentReplay,
  assertSecretPermission,
  buildAccountOrderBy,
  buildAccountWhere,
  getEncryptedSecretValue,
  maskAppleId,
  maskPhone,
  normalizeAppleId,
  normalizeBalanceAdjustmentIdempotencyKey,
  normalizeBalanceAdjustmentReason,
  normalizeMoney,
  normalizeNullableString,
  normalizePhone,
  normalizeRevealReason,
  parseRecordStatus,
  parseSaleState,
  parseSecretField,
  requireBalanceSnapshotValue,
  toAccountResponse,
  toAuditJson,
  type AccountListQuery,
  type AccountWithRelations
} from './id-business-v2-account-support';

export type ListIdBusinessV2AccountsQuery = AccountListQuery;
export interface AuditRequestMeta {
  ip?: string | null;
  userAgent?: string | null;
}

const MAX_ACCOUNT_EXPORT_ROWS = 10_000;

@Injectable()
export class IdBusinessV2AccountsService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly auditLogsService: AuditLogsService,
    private readonly fieldEncryptionService: FieldEncryptionService,
    private readonly optionsService: IdBusinessV2OptionsService,
    private readonly balanceCalculator: IdBusinessV2BalanceCalculatorService
  ) {}

  async list(query: ListIdBusinessV2AccountsQuery) {
    const result = await this.findList(query);
    return {
      ...result,
      items: result.items.map((account) => toAccountResponse(account))
    };
  }

  private async findList(query: ListIdBusinessV2AccountsQuery) {
    const pagination = getPagination(query);
    const where = buildAccountWhere(query, (value) => this.fieldEncryptionService.hash(value));

    const [items, total] = await this.prisma.$transaction([
      this.prisma.idBusinessV2Account.findMany({
        where,
        include: ACCOUNT_INCLUDE,
        skip: pagination.skip,
        take: pagination.take,
        orderBy: buildAccountOrderBy(query)
      }),
      this.prisma.idBusinessV2Account.count({ where })
    ]);

    return {
      items,
      total,
      page: pagination.page,
      pageSize: pagination.pageSize
    };
  }

  async exportRows(query: ListIdBusinessV2AccountsQuery, operator?: AuthenticatedUser) {
    const where = buildAccountWhere(query, (value) => this.fieldEncryptionService.hash(value));
    const total = await this.prisma.idBusinessV2Account.count({ where });
    if (total > MAX_ACCOUNT_EXPORT_ROWS) {
      throw new BadRequestException(`单次最多导出 ${MAX_ACCOUNT_EXPORT_ROWS} 条 ID 资料`);
    }

    const accounts = await this.prisma.idBusinessV2Account.findMany({
      where,
      include: ACCOUNT_INCLUDE,
      orderBy: buildAccountOrderBy(query)
    });
    const items = accounts.map((account) => toAccountResponse(account));

    await this.auditLogsService.create({
      userId: operator?.id,
      module: 'id_business_v2_accounts',
      action: 'id_business_v2.account.export',
      objectType: 'id_business_v2_account',
      afterData: toAuditJson({
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
      exportedAt: new Date().toISOString()
    };
  }

  async importRows(dto: ImportIdBusinessV2AccountsDto, operator?: AuthenticatedUser) {
    return importAccountRows(
      dto,
      (input, currentOperator) => this.create(input, currentOperator),
      this.auditLogsService,
      operator
    );
  }

  async get(id: string) {
    return toAccountResponse(await this.findAccountOrThrow(id));
  }

  async create(dto: CreateIdBusinessV2AccountDto, operator?: AuthenticatedUser) {
    const appleId = normalizeAppleId(dto.appleId, true)!;
    const appleIdHash = this.fieldEncryptionService.hash(appleId)!;
    await this.assertAppleIdAvailable(appleIdHash);

    const country = await this.optionsService.requireActiveOption(
      dto.countryOptionId,
      'country',
      '国家'
    );
    const status = await this.optionsService.requireActiveOption(
      dto.statusOptionId,
      'id_status',
      'ID 状态'
    );
    const supplier = await this.optionsService.requireActiveOption(
      dto.supplierOptionId,
      'id_supplier',
      'ID 供应商',
      true
    );
    const phone = normalizePhone(dto.phone);
    const openingBalance = this.balanceCalculator.normalizeSnapshot(
      dto.currentBalance ?? '0',
      dto.balanceCostAmount ?? '0'
    );
    if (!openingBalance.currentBalance.equals(0) || !openingBalance.balanceCostAmount.equals(0)) {
      assertBalanceAdjustmentPermission(operator);
    }

    const account = await this.prisma.$transaction(async (tx) => {
      const created = await tx.idBusinessV2Account.create({
        data: {
          appleIdEncrypted: this.fieldEncryptionService.encrypt(appleId)!,
          appleIdHash,
          appleIdMasked: maskAppleId(appleId),
          passwordEncrypted: this.fieldEncryptionService.encrypt(
            normalizeNullableString(dto.password)
          ),
          phoneEncrypted: this.fieldEncryptionService.encrypt(phone),
          phoneHash: this.fieldEncryptionService.hash(phone),
          phoneMasked: maskPhone(phone),
          phoneTail: phone ? phone.slice(-8) : null,
          securityInfoEncrypted: this.fieldEncryptionService.encrypt(
            normalizeNullableString(dto.securityInfo)
          ),
          countryOptionId: country!.id,
          statusOptionId: status!.id,
          supplierOptionId: supplier?.id ?? null,
          currentBalance: openingBalance.currentBalance,
          balanceCostAmount: openingBalance.balanceCostAmount,
          purchaseCost: normalizeMoney(dto.purchaseCost, 'ID 购买成本'),
          recordStatus: parseRecordStatus(dto.recordStatus, false) ?? 'active',
          remark: normalizeNullableString(dto.remark),
          createdByUserId: operator?.id,
          updatedByUserId: operator?.id
        },
        include: ACCOUNT_INCLUDE
      });

      if (!openingBalance.currentBalance.equals(0)) {
        await tx.idBusinessV2BalanceLedger.create({
          data: {
            accountId: created.id,
            giftCardId: null,
            orderId: null,
            entryType: 'opening_balance',
            direction: 'credit',
            balanceAmount: openingBalance.currentBalance,
            costAmount: openingBalance.balanceCostAmount,
            balanceBefore: '0',
            balanceAfter: openingBalance.currentBalance,
            costBefore: '0',
            costAfter: openingBalance.balanceCostAmount,
            averageCostBefore: '0',
            averageCostAfter: openingBalance.averageCost,
            reversalOfEntryId: null,
            idempotencyKey: `account-opening:${created.id}`,
            remark: 'ID 新增期初余额',
            createdByUserId: operator?.id
          }
        });
      }

      return created;
    });

    const response = toAccountResponse(account);
    await this.auditLogsService.create({
      userId: operator?.id,
      module: 'id_business_v2_accounts',
      action: 'id_business_v2.account.create',
      objectType: 'id_business_v2_account',
      objectId: account.id,
      afterData: toAuditJson(response),
      remark: `创建 V2 ID：${account.appleIdMasked}`
    });

    return response;
  }

  async update(id: string, dto: UpdateIdBusinessV2AccountDto, operator?: AuthenticatedUser) {
    const existing = await this.findAccountOrThrow(id);
    assertAccountLossNotReported(existing.lossReportedAt, '已报损 ID 永久冻结，不能再修改');
    const appleId = dto.appleId === undefined ? undefined : normalizeAppleId(dto.appleId, true)!;
    const appleIdHash =
      appleId === undefined ? undefined : this.fieldEncryptionService.hash(appleId)!;
    if (appleIdHash && appleIdHash !== existing.appleIdHash) {
      await this.assertAppleIdAvailable(appleIdHash, existing.id);
    }
    const country =
      dto.countryOptionId === undefined
        ? undefined
        : await this.optionsService.requireActiveOption(dto.countryOptionId, 'country', '国家');
    const status =
      dto.statusOptionId === undefined
        ? undefined
        : await this.optionsService.requireActiveOption(dto.statusOptionId, 'id_status', 'ID 状态');
    const supplier =
      dto.supplierOptionId === undefined
        ? undefined
        : await this.optionsService.requireActiveOption(
            dto.supplierOptionId,
            'id_supplier',
            'ID 供应商',
            true
          );
    const phone = dto.phone === undefined ? undefined : normalizePhone(dto.phone);

    const updateData: Prisma.IdBusinessV2AccountUncheckedUpdateInput = {
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
    const adjustsBalance = dto.currentBalance !== undefined || dto.balanceCostAmount !== undefined;
    const account = adjustsBalance
      ? await this.updateWithBalanceAdjustment(existing.id, dto, updateData, operator)
      : await this.updateActiveAccount(existing.id, updateData);

    const response = toAccountResponse(account);
    await this.auditLogsService.create({
      userId: operator?.id,
      module: 'id_business_v2_accounts',
      action: 'id_business_v2.account.update',
      objectType: 'id_business_v2_account',
      objectId: account.id,
      beforeData: toAuditJson(toAccountResponse(existing)),
      afterData: toAuditJson(response),
      remark: `修改 V2 ID：${existing.appleIdMasked}`
    });

    return response;
  }

  async remove(id: string, operator?: AuthenticatedUser) {
    const existing = await this.findAccountOrThrow(id);
    assertAccountLossNotReported(existing.lossReportedAt, '已报损 ID 必须保留历史记录，不能删除');
    if (existing.soldByOrderId) {
      throw new ConflictException('已卖出的 ID 不能删除，请先通过退款流程确认收回');
    }
    const result = await this.prisma.idBusinessV2Account.updateMany({
      where: { id: existing.id, lossReportedAt: null },
      data: {
        deletedAt: new Date(),
        recordStatus: 'disabled',
        updatedByUserId: operator?.id
      }
    });
    if (result.count !== 1) {
      throw new ConflictException('该 ID 已报损，不能删除');
    }

    await this.auditLogsService.create({
      userId: operator?.id,
      module: 'id_business_v2_accounts',
      action: 'id_business_v2.account.delete',
      objectType: 'id_business_v2_account',
      objectId: existing.id,
      beforeData: toAuditJson(toAccountResponse(existing)),
      remark: `删除 V2 ID：${existing.appleIdMasked}`
    });

    return { deleted: true };
  }

  async revealSecret(
    id: string,
    dto: RevealIdBusinessV2AccountSecretDto,
    operator?: AuthenticatedUser,
    requestMeta?: AuditRequestMeta
  ) {
    const field = parseSecretField(dto.field);
    const config = SECRET_FIELDS[field];
    assertSecretPermission(config, operator);
    const reason = normalizeRevealReason(dto.reason);
    const account = await this.findAccountOrThrow(id);
    const value = this.fieldEncryptionService.decrypt(getEncryptedSecretValue(account, field));
    if (!value) {
      throw new NotFoundException(`${config.label}未填写`);
    }

    const approved = await verifySensitiveAccessApproval(this.prisma, {
      approvalId: dto.approvalId,
      requesterId: operator?.id,
      module: 'id_business_v2_account',
      fieldName: field,
      objectType: 'id_business_v2_account',
      objectId: account.id
    });

    await this.prisma.sensitiveAccessLog.create({
      data: {
        userId: operator?.id,
        module: 'id_business_v2_account',
        fieldName: field,
        objectType: 'id_business_v2_account',
        objectId: account.id,
        accessReason: reason,
        approved,
        ip: requestMeta?.ip ?? undefined,
        userAgent: requestMeta?.userAgent ?? undefined
      }
    });

    await this.auditLogsService.create({
      userId: operator?.id,
      module: 'id_business_v2_accounts',
      action: 'id_business_v2.account.secret.reveal',
      objectType: 'id_business_v2_account',
      objectId: account.id,
      afterData: toAuditJson({
        field,
        reason,
        approved
      }),
      ip: requestMeta?.ip ?? undefined,
      userAgent: requestMeta?.userAgent ?? undefined,
      remark: `查看 V2 ID 敏感字段：${config.label} / ${account.appleIdMasked}`
    });

    return {
      accountId: account.id,
      field,
      value,
      revealedAt: new Date().toISOString()
    };
  }

  private async updateWithBalanceAdjustment(
    accountId: string,
    dto: UpdateIdBusinessV2AccountDto,
    updateData: Prisma.IdBusinessV2AccountUncheckedUpdateInput,
    operator?: AuthenticatedUser
  ) {
    assertBalanceAdjustmentPermission(operator);
    const expected = this.balanceCalculator.normalizeSnapshot(
      requireBalanceSnapshotValue(dto.expectedCurrentBalance, '修改前余额'),
      requireBalanceSnapshotValue(dto.expectedBalanceCostAmount, '修改前人民币成本')
    );
    const target = this.balanceCalculator.normalizeSnapshot(
      dto.currentBalance ?? expected.currentBalance,
      dto.balanceCostAmount ?? expected.balanceCostAmount
    );
    const reason = normalizeBalanceAdjustmentReason(dto.balanceAdjustmentReason);
    const idempotencyKey = normalizeBalanceAdjustmentIdempotencyKey(
      dto.balanceAdjustmentIdempotencyKey
    );

    return this.prisma.$transaction(async (tx) => {
      const existingEntry = await tx.idBusinessV2BalanceLedger.findUnique({
        where: { idempotencyKey }
      });
      if (existingEntry) {
        assertBalanceAdjustmentReplay(existingEntry, {
          accountId,
          expectedBalance: expected.currentBalance,
          expectedCost: expected.balanceCostAmount,
          targetBalance: target.currentBalance,
          targetCost: target.balanceCostAmount,
          reason
        });
        const replayedAccount = await tx.idBusinessV2Account.findFirst({
          where: { id: accountId, deletedAt: null },
          include: ACCOUNT_INCLUDE
        });
        if (!replayedAccount) throw new NotFoundException('ID 资料不存在');
        assertAccountLossNotReported(
          replayedAccount.lossReportedAt,
          '已报损 ID 永久冻结，不能调整余额'
        );
        return replayedAccount;
      }

      const locked = await this.lockAccountBalance(tx, accountId);
      assertAccountLossNotReported(locked.lossReportedAt, '已报损 ID 永久冻结，不能调整余额');
      if (locked.soldByOrderId) {
        throw new ConflictException('该 ID 已卖出，不能调整余额或人民币成本');
      }
      if (
        !locked.currentBalance.equals(expected.currentBalance) ||
        !locked.balanceCostAmount.equals(expected.balanceCostAmount)
      ) {
        throw new ConflictException('ID 余额或人民币成本已发生变化，请刷新后重新修改');
      }

      const balanceDelta = target.currentBalance.minus(locked.currentBalance);
      const costDelta = target.balanceCostAmount.minus(locked.balanceCostAmount);
      if (balanceDelta.equals(0) && costDelta.equals(0)) {
        return tx.idBusinessV2Account.update({
          where: { id: accountId },
          data: updateData,
          include: ACCOUNT_INCLUDE
        });
      }

      const before = this.balanceCalculator.normalizeSnapshot(
        locked.currentBalance,
        locked.balanceCostAmount
      );
      await tx.idBusinessV2BalanceLedger.create({
        data: {
          accountId,
          giftCardId: null,
          orderId: null,
          entryType: 'manual_adjustment',
          direction: 'adjustment',
          balanceAmount: balanceDelta.abs(),
          costAmount: costDelta.abs(),
          balanceBefore: before.currentBalance,
          balanceAfter: target.currentBalance,
          costBefore: before.balanceCostAmount,
          costAfter: target.balanceCostAmount,
          averageCostBefore: before.averageCost,
          averageCostAfter: target.averageCost,
          reversalOfEntryId: null,
          idempotencyKey,
          remark: reason,
          createdByUserId: operator?.id
        }
      });

      return tx.idBusinessV2Account.update({
        where: { id: accountId },
        data: {
          ...updateData,
          currentBalance: target.currentBalance,
          balanceCostAmount: target.balanceCostAmount
        },
        include: ACCOUNT_INCLUDE
      });
    });
  }

  private async lockAccountBalance(tx: Prisma.TransactionClient, accountId: string) {
    const rows = await tx.$queryRaw<LockedAccountBalanceRow[]>(PrismaNamespace.sql`
      SELECT
        "id",
        "current_balance" AS "currentBalance",
        "balance_cost_amount" AS "balanceCostAmount",
        "sold_by_order_id" AS "soldByOrderId",
        "loss_reported_at" AS "lossReportedAt"
      FROM "id_business_v2_accounts"
      WHERE
        "id" = CAST(${accountId} AS UUID)
        AND "deleted_at" IS NULL
      FOR UPDATE
    `);
    const account = rows[0];
    if (!account) throw new NotFoundException('ID 资料不存在');
    return account;
  }

  private async updateActiveAccount(
    accountId: string,
    updateData: Prisma.IdBusinessV2AccountUncheckedUpdateInput
  ) {
    const result = await this.prisma.idBusinessV2Account.updateMany({
      where: {
        id: accountId,
        deletedAt: null,
        lossReportedAt: null
      },
      data: updateData
    });
    if (result.count !== 1) {
      throw new ConflictException('该 ID 已报损，不能修改');
    }
    return this.findAccountOrThrow(accountId);
  }

  private async findAccountOrThrow(id: string): Promise<AccountWithRelations> {
    const account = await this.prisma.idBusinessV2Account.findFirst({
      where: {
        id,
        deletedAt: null
      },
      include: ACCOUNT_INCLUDE
    });
    if (!account) {
      throw new NotFoundException('ID 资料不存在');
    }
    return account;
  }

  private async assertAppleIdAvailable(hash: string, excludedId?: string) {
    const existing = await this.prisma.idBusinessV2Account.findFirst({
      where: {
        appleIdHash: hash,
        id: excludedId ? { not: excludedId } : undefined
      },
      select: { id: true }
    });
    if (existing) {
      throw new ConflictException('该 Apple ID 已存在');
    }
  }
}

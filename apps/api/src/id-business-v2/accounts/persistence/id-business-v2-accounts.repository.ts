import { ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import type { IdBusinessV2FinanceCurrency, Prisma } from '@prisma/client';
import { getPagination } from '../../../common/pagination';
import { PrismaService } from '../../../common/prisma/prisma.service';
import {
  verifySensitiveAccessApproval,
  type SensitiveAccessApprovalCheckInput
} from '../../../common/sensitive-access-approval';
import {
  Amount4,
  Rate8,
  mapAmount4,
  mapRate8,
  type V2CommandTransaction
} from '../../runtime/public-api';
import {
  normalizeAppleId,
  normalizeNullableString,
  normalizePhone,
  parseAccountLifecycle,
  parseRecordStatus,
  parseSaleState,
  type AccountListQuery,
  type AccountUpdateData,
  type AccountWithRelations
} from '../id-business-v2-account-support';

const ACCOUNT_INCLUDE = {
  countryOption: { select: { id: true, code: true, name: true } },
  statusOption: { select: { id: true, code: true, name: true, isSystem: true } },
  supplierOption: { select: { id: true, code: true, name: true } },
  soldByOrder: { select: { id: true, orderNo: true } },
  createdBy: { select: { id: true, username: true, displayName: true } }
} satisfies Prisma.IdBusinessV2AccountInclude;

type PersistedAccount = Prisma.IdBusinessV2AccountGetPayload<{ include: typeof ACCOUNT_INCLUDE }>;

const ACCOUNT_SORT_FIELDS: Record<
  string,
  keyof Prisma.IdBusinessV2AccountOrderByWithRelationInput
> = {
  appleId: 'appleIdMasked',
  currentBalance: 'currentBalance',
  balanceCostAmount: 'balanceCostAmount',
  purchaseCost: 'purchaseCost',
  recordStatus: 'recordStatus',
  createdAt: 'createdAt',
  updatedAt: 'updatedAt'
};

export interface AccountCreatePersistenceInput extends AccountUpdateData {
  appleIdEncrypted: string;
  appleIdHash: string;
  appleIdMasked: string;
  countryOptionId: string;
  statusOptionId: string;
  currentBalance: string;
  balanceCostAmount: string;
  purchaseCost: string;
  purchaseOriginalAmount: string;
  purchaseCurrency: IdBusinessV2FinanceCurrency;
  purchaseFxRateToCny: string;
  purchaseFxSnapshotId: string | null;
  purchaseFinanceAccountId: string | null;
  purchaseSupplierAccountId: string | null;
  purchasedAt: Date;
  createdByUserId?: string;
}

export interface LockedSupplierWallet {
  id: string;
  currency: IdBusinessV2FinanceCurrency;
  currentBalance: Amount4;
  currentBalanceCny: Amount4;
  supplierName: string;
}

@Injectable()
export class IdBusinessV2AccountsRepository {
  constructor(private readonly prisma: PrismaService) {}

  async list(query: AccountListQuery, hash: (value: string | null) => string | null) {
    const pagination = getPagination(query);
    const where = this.buildWhere(query, hash);
    const [items, total] = await this.prisma.$transaction([
      this.prisma.idBusinessV2Account.findMany({
        where,
        include: ACCOUNT_INCLUDE,
        skip: pagination.skip,
        take: pagination.take,
        orderBy: this.buildOrderBy(query)
      }),
      this.prisma.idBusinessV2Account.count({ where })
    ]);
    return {
      items: items.map((row) => this.mapAccount(row)),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize
    };
  }

  async listForExport(
    query: AccountListQuery,
    hash: (value: string | null) => string | null,
    tx?: V2CommandTransaction
  ) {
    const client = tx ?? this.prisma;
    const where = this.buildWhere(query, hash);
    const total = await client.idBusinessV2Account.count({ where });
    const items = await client.idBusinessV2Account.findMany({
      where,
      include: ACCOUNT_INCLUDE,
      orderBy: this.buildOrderBy(query)
    });
    return { total, items: items.map((row) => this.mapAccount(row)) };
  }

  async listPurchaseSources() {
    const financeAccounts = await this.prisma.idBusinessV2FinanceAccount.findMany({
      where: { status: 'active' },
      select: { id: true, name: true, currency: true, currentBalance: true },
      orderBy: [{ currency: 'asc' }, { name: 'asc' }]
    });
    return {
      financeAccounts: financeAccounts.map((row) => ({
        ...row,
        currentBalance: mapAmount4(
          row.currentBalance,
          'id_business_v2_finance_accounts.current_balance'
        ).toString()
      })),
      supplierWallets: []
    };
  }

  async findById(id: string, tx?: V2CommandTransaction) {
    const client = tx ?? this.prisma;
    const row = await client.idBusinessV2Account.findFirst({
      where: { id, deletedAt: null },
      include: ACCOUNT_INCLUDE
    });
    return row ? this.mapAccount(row) : null;
  }

  async findByIdOrThrow(id: string, tx?: V2CommandTransaction) {
    const account = await this.findById(id, tx);
    if (!account) throw new NotFoundException('ID 资料不存在');
    return account;
  }

  async lockAccount(tx: V2CommandTransaction, accountId: string) {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "id_business_v2_accounts"
      WHERE "id" = CAST(${accountId} AS UUID) AND "deleted_at" IS NULL
      FOR UPDATE
    `;
    if (!rows[0]) throw new NotFoundException('ID 资料不存在');
    return this.findByIdOrThrow(accountId, tx);
  }

  async findByAppleIdHash(hash: string, tx?: V2CommandTransaction, excludedId?: string) {
    const client = tx ?? this.prisma;
    return client.idBusinessV2Account.findFirst({
      where: { appleIdHash: hash, id: excludedId ? { not: excludedId } : undefined },
      select: { id: true }
    });
  }

  async create(tx: V2CommandTransaction, input: AccountCreatePersistenceInput) {
    const row = await tx.idBusinessV2Account.create({
      data: input as Prisma.IdBusinessV2AccountUncheckedCreateInput,
      include: ACCOUNT_INCLUDE
    });
    return this.mapAccount(row);
  }

  async updateActive(
    tx: V2CommandTransaction,
    accountId: string,
    data: AccountUpdateData & { currentBalance?: string; balanceCostAmount?: string }
  ) {
    const result = await tx.idBusinessV2Account.updateMany({
      where: { id: accountId, deletedAt: null, lossReportedAt: null },
      data
    });
    if (result.count !== 1) throw new ConflictException('该 ID 已报损，不能修改');
    return this.findByIdOrThrow(accountId, tx);
  }

  async updateRecordStatus(
    tx: V2CommandTransaction,
    accountId: string,
    input: {
      recordStatus: 'active' | 'disabled';
      disabledReason: string | null;
      disabledAt: Date | null;
      operatorId?: string;
    }
  ) {
    const result = await tx.idBusinessV2Account.updateMany({
      where: {
        id: accountId,
        deletedAt: null,
        lossReportedAt: null
      },
      data: {
        recordStatus: input.recordStatus,
        disabledReason: input.disabledReason,
        disabledAt: input.disabledAt,
        updatedByUserId: input.operatorId
      }
    });
    if (result.count !== 1) {
      throw new ConflictException('该 ID 状态已变化，请刷新后重试');
    }
    return this.findByIdOrThrow(accountId, tx);
  }

  verifySensitiveApproval(tx: V2CommandTransaction, input: SensitiveAccessApprovalCheckInput) {
    return verifySensitiveAccessApproval(tx, input);
  }

  async appendSensitiveAccess(
    tx: V2CommandTransaction,
    input: {
      userId?: string;
      fieldName: string;
      objectId: string;
      accessReason: string;
      approved: boolean;
      ip?: string;
      userAgent?: string;
    }
  ) {
    await tx.sensitiveAccessLog.create({
      data: {
        userId: input.userId,
        module: 'id_business_v2_account',
        fieldName: input.fieldName,
        objectType: 'id_business_v2_account',
        objectId: input.objectId,
        accessReason: input.accessReason,
        approved: input.approved,
        ip: input.ip,
        userAgent: input.userAgent
      }
    });
  }

  async lockAccountBalance(tx: V2CommandTransaction, accountId: string) {
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        currentBalance: unknown;
        balanceCostAmount: unknown;
        soldByOrderId: string | null;
        lossReportedAt: Date | null;
      }>
    >`
      SELECT
        "id",
        "current_balance" AS "currentBalance",
        "balance_cost_amount" AS "balanceCostAmount",
        "sold_by_order_id" AS "soldByOrderId",
        "loss_reported_at" AS "lossReportedAt"
      FROM "id_business_v2_accounts"
      WHERE "id" = CAST(${accountId} AS UUID) AND "deleted_at" IS NULL
      FOR UPDATE
    `;
    const row = rows[0];
    if (!row) throw new NotFoundException('ID 资料不存在');
    return {
      ...row,
      currentBalance: mapAmount4(row.currentBalance, 'id_business_v2_accounts.current_balance'),
      balanceCostAmount: mapAmount4(
        row.balanceCostAmount,
        'id_business_v2_accounts.balance_cost_amount'
      )
    };
  }

  async lockSupplierWallet(tx: V2CommandTransaction, walletId: string) {
    const rows = await tx.$queryRaw<
      Array<{
        id: string;
        currency: IdBusinessV2FinanceCurrency;
        currentBalance: unknown;
        currentBalanceCny: unknown;
        supplierName: string;
      }>
    >`
      SELECT
        wallet."id",
        wallet."currency",
        wallet."current_balance" AS "currentBalance",
        wallet."current_balance_cny" AS "currentBalanceCny",
        supplier."name" AS "supplierName"
      FROM "id_business_v2_topup_supplier_accounts" wallet
      INNER JOIN "id_business_v2_options" supplier
        ON supplier."id" = wallet."supplier_option_id"
      WHERE wallet."id" = CAST(${walletId} AS UUID)
      FOR UPDATE OF wallet
    `;
    const row = rows[0];
    return row
      ? {
          ...row,
          currentBalance: mapAmount4(
            row.currentBalance,
            'id_business_v2_topup_supplier_accounts.current_balance'
          ),
          currentBalanceCny: mapAmount4(
            row.currentBalanceCny,
            'id_business_v2_topup_supplier_accounts.current_balance_cny'
          )
        }
      : null;
  }

  async appendOpeningBalance(
    tx: V2CommandTransaction,
    input: {
      accountId: string;
      balance: Amount4;
      cost: Amount4;
      averageCost: Rate8;
      operatorId?: string;
    }
  ) {
    return tx.idBusinessV2BalanceLedger.create({
      data: {
        accountId: input.accountId,
        giftCardId: null,
        orderId: null,
        entryType: 'opening_balance',
        direction: 'credit',
        balanceAmount: input.balance.toString(),
        costAmount: input.cost.toString(),
        balanceBefore: '0',
        balanceAfter: input.balance.toString(),
        costBefore: '0',
        costAfter: input.cost.toString(),
        averageCostBefore: '0',
        averageCostAfter: input.averageCost.toString(),
        reversalOfEntryId: null,
        idempotencyKey: `account-opening:${input.accountId}`,
        remark: 'ID 新增期初余额',
        createdByUserId: input.operatorId
      }
    });
  }

  async debitSupplierWallet(
    tx: V2CommandTransaction,
    input: {
      wallet: LockedSupplierWallet;
      amount: Amount4;
      amountCny: Amount4;
      accountId: string;
      accountMasked: string;
      operatorId?: string;
    }
  ) {
    const balanceAfter = input.wallet.currentBalance.sub(input.amount);
    const balanceAfterCny = input.wallet.currentBalanceCny.sub(input.amountCny);
    await tx.idBusinessV2TopupSupplierLedger.create({
      data: {
        supplierAccountId: input.wallet.id,
        entryType: 'id_purchase_debit',
        direction: 'debit',
        currency: input.wallet.currency,
        amount: input.amount.toString(),
        balanceBefore: input.wallet.currentBalance.toString(),
        balanceAfter: balanceAfter.toString(),
        amountCny: input.amountCny.toString(),
        balanceBeforeCny: input.wallet.currentBalanceCny.toString(),
        balanceAfterCny: balanceAfterCny.toString(),
        supplierNameSnapshot: input.wallet.supplierName,
        idempotencyKey: `supplier_id_purchase:${input.accountId}`,
        reason: `采购 ID：${input.accountMasked}`,
        createdByUserId: input.operatorId
      }
    });
    await tx.idBusinessV2TopupSupplierAccount.update({
      where: { id: input.wallet.id },
      data: {
        currentBalance: balanceAfter.toString(),
        currentBalanceCny: balanceAfterCny.toString(),
        updatedByUserId: input.operatorId
      }
    });
  }

  async assertFxSnapshot(
    tx: V2CommandTransaction,
    input: {
      id: string | null;
      currency: IdBusinessV2FinanceCurrency;
      rate: Rate8;
      occurredAt: Date;
    }
  ) {
    if (input.currency === 'CNY') {
      if (input.id || !input.rate.equals(1)) throw new ConflictException('人民币汇率快照无效');
      return;
    }
    if (!input.id) throw new ConflictException('采购汇率快照缺失，请重新获取');
    const snapshot = await tx.idBusinessV2FinanceFxRateSnapshot.findUnique({
      where: { id: input.id }
    });
    if (
      !snapshot ||
      snapshot.currency !== input.currency ||
      !mapRate8(snapshot.rateToCny, 'id_business_v2_finance_fx_rate_snapshots.rate_to_cny').equals(
        input.rate
      ) ||
      (snapshot.expiresAt && snapshot.expiresAt.getTime() < input.occurredAt.getTime())
    ) {
      throw new ConflictException('采购汇率快照已失效，请重新获取');
    }
  }

  async assertFinanceAccountCurrency(
    tx: V2CommandTransaction,
    accountId: string,
    currency: IdBusinessV2FinanceCurrency
  ) {
    const account = await tx.idBusinessV2FinanceAccount.findUnique({
      where: { id: accountId },
      select: { status: true, currency: true }
    });
    if (!account || account.status !== 'active' || account.currency !== currency) {
      throw new ConflictException('采购付款账户不存在、已停用或币种不一致');
    }
  }

  async findBalanceLedgerByIdempotencyKey(tx: V2CommandTransaction, idempotencyKey: string) {
    const entry = await tx.idBusinessV2BalanceLedger.findUnique({ where: { idempotencyKey } });
    return entry
      ? {
          ...entry,
          balanceBefore: mapAmount4(
            entry.balanceBefore,
            'id_business_v2_balance_ledger.balance_before'
          ),
          balanceAfter: mapAmount4(
            entry.balanceAfter,
            'id_business_v2_balance_ledger.balance_after'
          ),
          costBefore: mapAmount4(entry.costBefore, 'id_business_v2_balance_ledger.cost_before'),
          costAfter: mapAmount4(entry.costAfter, 'id_business_v2_balance_ledger.cost_after')
        }
      : null;
  }

  async appendBalanceAdjustment(
    tx: V2CommandTransaction,
    input: {
      accountId: string;
      balanceDelta: Amount4;
      costDelta: Amount4;
      balanceBefore: Amount4;
      balanceAfter: Amount4;
      costBefore: Amount4;
      costAfter: Amount4;
      averageCostBefore: Rate8;
      averageCostAfter: Rate8;
      idempotencyKey: string;
      reason: string;
      operatorId?: string;
    }
  ) {
    return tx.idBusinessV2BalanceLedger.create({
      data: {
        accountId: input.accountId,
        giftCardId: null,
        orderId: null,
        entryType: 'manual_adjustment',
        direction: 'adjustment',
        balanceAmount: input.balanceDelta.abs().toString(),
        costAmount: input.costDelta.abs().toString(),
        balanceBefore: input.balanceBefore.toString(),
        balanceAfter: input.balanceAfter.toString(),
        costBefore: input.costBefore.toString(),
        costAfter: input.costAfter.toString(),
        averageCostBefore: input.averageCostBefore.toString(),
        averageCostAfter: input.averageCostAfter.toString(),
        reversalOfEntryId: null,
        idempotencyKey: input.idempotencyKey,
        remark: input.reason,
        createdByUserId: input.operatorId
      }
    });
  }

  private mapAccount(row: PersistedAccount): AccountWithRelations {
    return {
      ...row,
      currentBalance: mapAmount4(row.currentBalance, 'id_business_v2_accounts.current_balance'),
      balanceCostAmount: mapAmount4(
        row.balanceCostAmount,
        'id_business_v2_accounts.balance_cost_amount'
      ),
      purchaseCost: mapAmount4(row.purchaseCost, 'id_business_v2_accounts.purchase_cost'),
      purchaseOriginalAmount: mapAmount4(
        row.purchaseOriginalAmount ?? row.purchaseCost,
        'id_business_v2_accounts.purchase_original_amount'
      ),
      purchaseCurrency: row.purchaseCurrency ?? 'CNY',
      purchaseFxRateToCny: mapRate8(
        row.purchaseFxRateToCny ?? '1',
        'id_business_v2_accounts.purchase_fx_rate_to_cny'
      ),
      purchaseFxSnapshotId: row.purchaseFxSnapshotId ?? null,
      purchaseFinanceAccountId: row.purchaseFinanceAccountId ?? null,
      purchaseSupplierAccountId: row.purchaseSupplierAccountId ?? null,
      purchasedAt: row.purchasedAt ?? row.createdAt
    };
  }

  private buildWhere(
    query: AccountListQuery,
    hash: (value: string | null) => string | null
  ): Prisma.IdBusinessV2AccountWhereInput {
    const keyword = normalizeNullableString(query.keyword);
    const normalizedAppleId = keyword ? normalizeAppleId(keyword, false) : null;
    const normalizedPhone = keyword ? normalizePhone(keyword) : null;
    const saleState = parseSaleState(query.saleState);
    const lifecycle = parseAccountLifecycle(query.lifecycle);
    const lifecycleWhere: Prisma.IdBusinessV2AccountWhereInput =
      lifecycle === 'available'
        ? { soldByOrderId: null, lossReportedAt: null, recordStatus: 'active' }
        : lifecycle === 'disabled'
          ? { soldByOrderId: null, lossReportedAt: null, recordStatus: 'disabled' }
          : lifecycle === 'sold'
            ? { soldByOrderId: { not: null }, lossReportedAt: null }
            : lifecycle === 'reported'
              ? { lossReportedAt: { not: null } }
              : {};
    return {
      deletedAt: null,
      ...lifecycleWhere,
      countryOptionId: normalizeNullableString(query.countryOptionId) ?? undefined,
      statusOptionId: normalizeNullableString(query.statusOptionId) ?? undefined,
      supplierOptionId: normalizeNullableString(query.supplierOptionId) ?? undefined,
      recordStatus:
        lifecycle === null
          ? (parseRecordStatus(query.recordStatus, false) ?? undefined)
          : lifecycleWhere.recordStatus,
      soldByOrderId:
        lifecycle === null
          ? saleState === 'sold'
            ? { not: null }
            : saleState === 'available'
              ? null
              : undefined
          : lifecycleWhere.soldByOrderId,
      OR: keyword
        ? [
            { appleIdMasked: { contains: keyword, mode: 'insensitive' } },
            { appleIdHash: hash(normalizedAppleId) ?? undefined },
            {
              phoneTail: {
                contains: normalizedPhone?.slice(-8) ?? keyword,
                mode: 'insensitive'
              }
            },
            { phoneHash: hash(normalizedPhone) ?? undefined },
            { supplierOption: { name: { contains: keyword, mode: 'insensitive' } } }
          ]
        : undefined
    };
  }

  private buildOrderBy(query: AccountListQuery) {
    const field = query.sortBy ? ACCOUNT_SORT_FIELDS[query.sortBy] : undefined;
    if (!field) {
      return [
        { updatedAt: 'desc' },
        { id: 'desc' }
      ] satisfies Prisma.IdBusinessV2AccountOrderByWithRelationInput[];
    }
    const direction = query.sortOrder === 'desc' ? 'desc' : 'asc';
    return [
      { [field]: direction },
      { updatedAt: 'desc' },
      { id: 'desc' }
    ] as Prisma.IdBusinessV2AccountOrderByWithRelationInput[];
  }
}

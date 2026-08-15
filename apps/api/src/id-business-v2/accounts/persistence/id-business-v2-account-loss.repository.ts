import { Injectable, NotFoundException } from '@nestjs/common';
import type { IdBusinessV2RecordStatus, Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { Amount4, mapAmount4, type V2CommandTransaction } from '../../runtime/public-api';

const LOSS_USER_SELECT = {
  id: true,
  username: true,
  displayName: true
} satisfies Prisma.UserSelect;

const REPORTED_BY_INCLUDE = {
  account: {
    select: {
      appleIdEncrypted: true
    }
  },
  reportedBy: {
    select: LOSS_USER_SELECT
  },
  reversedBy: {
    select: LOSS_USER_SELECT
  }
} satisfies Prisma.IdBusinessV2AccountLossInclude;

interface LockedAccountPersistenceRow {
  id: string;
  appleIdMasked: string;
  statusOptionId: string;
  statusName: string;
  countryOptionId: string;
  countryName: string;
  currencyCode: string | null;
  supplierOptionId: string | null;
  supplierName: string | null;
  currentBalance: unknown;
  balanceCostAmount: unknown;
  purchaseCost: unknown;
  soldByOrderId: string | null;
  ownershipTransferredAt: Date | null;
  soldOrderNo: string | null;
  lossReportedAt: Date | null;
  activeLossRecordId: string | null;
  recordStatus: IdBusinessV2RecordStatus;
}

export interface LockedAccountLossRow extends Omit<
  LockedAccountPersistenceRow,
  'currentBalance' | 'balanceCostAmount' | 'purchaseCost'
> {
  currentBalance: Amount4;
  balanceCostAmount: Amount4;
  purchaseCost: Amount4;
}

type PersistedAccountLossRecord = Prisma.IdBusinessV2AccountLossGetPayload<{
  include: typeof REPORTED_BY_INCLUDE;
}>;
export type IdBusinessV2AccountLossRecord = Omit<
  PersistedAccountLossRecord,
  'lossBalance' | 'lossCostAmount' | 'idPurchaseCostLossAmount'
> & {
  lossBalance: Amount4;
  lossCostAmount: Amount4;
  idPurchaseCostLossAmount: Amount4;
};

export interface AccountLossListPersistenceInput {
  keyword: string | null;
  appleIdSearchTokens: string[];
  countryOptionId: string | null;
  saleState: 'available' | 'sold' | null;
  status: 'active' | 'reversed' | null;
  reportedFrom: Date | null;
  reportedToExclusive: Date | null;
  sortBy: 'reportedAt' | 'lossBalance' | 'lossCostAmount' | null;
  sortOrder: 'asc' | 'desc' | null;
  skip: number;
  take: number;
}

@Injectable()
export class IdBusinessV2AccountLossRepository {
  constructor(private readonly prisma: PrismaService) {}

  async list(input: AccountLossListPersistenceInput) {
    const where: Prisma.IdBusinessV2AccountLossWhereInput = {
      countryOptionId: input.countryOptionId ?? undefined,
      saleState: input.saleState ?? undefined,
      status: input.status ?? undefined,
      reportedAt:
        input.reportedFrom || input.reportedToExclusive
          ? {
              gte: input.reportedFrom ?? undefined,
              lt: input.reportedToExclusive ?? undefined
            }
          : undefined,
      OR: input.keyword
        ? [
            { appleIdMasked: { contains: input.keyword, mode: 'insensitive' } },
            {
              account: {
                is: {
                  appleIdSearchTokens: input.appleIdSearchTokens.length
                    ? { hasEvery: input.appleIdSearchTokens }
                    : undefined
                }
              }
            },
            { soldOrderNo: { contains: input.keyword, mode: 'insensitive' } },
            { reason: { contains: input.keyword, mode: 'insensitive' } },
            { reportedByName: { contains: input.keyword, mode: 'insensitive' } },
            {
              reportedBy: {
                is: { displayName: { contains: input.keyword, mode: 'insensitive' } }
              }
            },
            {
              reportedBy: {
                is: { username: { contains: input.keyword, mode: 'insensitive' } }
              }
            }
          ]
        : undefined
    };
    const orderBy: Prisma.IdBusinessV2AccountLossOrderByWithRelationInput[] =
      input.sortBy && input.sortOrder
        ? [{ [input.sortBy]: input.sortOrder }, { reportedAt: 'desc' }, { id: 'desc' }]
        : [{ reportedAt: 'desc' }, { id: 'desc' }];
    const [items, total] = await this.prisma.$transaction([
      this.prisma.idBusinessV2AccountLoss.findMany({
        where,
        include: REPORTED_BY_INCLUDE,
        skip: input.skip,
        take: input.take,
        orderBy
      }),
      this.prisma.idBusinessV2AccountLoss.count({ where })
    ]);
    return { items: items.map((item) => this.mapLossRecord(item)), total };
  }
  async findByIdempotencyKey(tx: V2CommandTransaction, idempotencyKey: string) {
    const record = await tx.idBusinessV2AccountLoss.findUnique({
      where: { idempotencyKey },
      include: REPORTED_BY_INCLUDE
    });
    return record ? this.mapLossRecord(record) : null;
  }

  async findByAccountId(tx: V2CommandTransaction, accountId: string) {
    const record = await tx.idBusinessV2AccountLoss.findFirst({
      where: { accountId, status: 'active' },
      include: REPORTED_BY_INCLUDE,
      orderBy: [{ reportedAt: 'desc' }, { id: 'desc' }]
    });
    return record ? this.mapLossRecord(record) : null;
  }

  async findById(tx: V2CommandTransaction, id: string) {
    const record = await tx.idBusinessV2AccountLoss.findUnique({
      where: { id },
      include: REPORTED_BY_INCLUDE
    });
    return record ? this.mapLossRecord(record) : null;
  }

  async findUnfreezeReplay(tx: V2CommandTransaction, idempotencyKey: string) {
    const journal = await tx.idBusinessV2FinanceJournal.findUnique({
      where: { idempotencyKey },
      select: {
        id: true,
        journalType: true,
        sourceType: true
      }
    });
    if (!journal || journal.journalType !== 'reversal' || journal.sourceType !== 'account_loss') {
      return null;
    }
    const record = await tx.idBusinessV2AccountLoss.findFirst({
      where: { reversalFinanceJournalId: journal.id },
      include: REPORTED_BY_INCLUDE
    });
    return record ? this.mapLossRecord(record) : null;
  }

  async lockAccount(tx: V2CommandTransaction, accountId: string): Promise<LockedAccountLossRow> {
    const rows = await tx.$queryRaw<LockedAccountPersistenceRow[]>`
      SELECT
        account."id",
        account."apple_id_masked" AS "appleIdMasked",
        account."status_option_id" AS "statusOptionId",
        status_option."name" AS "statusName",
        account."country_option_id" AS "countryOptionId",
        country."name" AS "countryName",
        country."currency_code" AS "currencyCode",
        account."supplier_option_id" AS "supplierOptionId",
        supplier."name" AS "supplierName",
        account."current_balance" AS "currentBalance",
        account."balance_cost_amount" AS "balanceCostAmount",
        account."purchase_cost" AS "purchaseCost",
        account."sold_by_order_id" AS "soldByOrderId",
        account."ownership_transferred_at" AS "ownershipTransferredAt",
        sold_order."order_no" AS "soldOrderNo",
        account."loss_reported_at" AS "lossReportedAt",
        account."active_loss_record_id" AS "activeLossRecordId",
        account."record_status" AS "recordStatus"
      FROM "id_business_v2_accounts" account
      INNER JOIN "id_business_v2_options" status_option
        ON status_option."id" = account."status_option_id"
      INNER JOIN "id_business_v2_options" country
        ON country."id" = account."country_option_id"
      LEFT JOIN "id_business_v2_options" supplier
        ON supplier."id" = account."supplier_option_id"
      LEFT JOIN "id_business_v2_orders" sold_order
        ON sold_order."id" = account."sold_by_order_id"
      WHERE
        account."id" = CAST(${accountId} AS UUID)
        AND account."deleted_at" IS NULL
      FOR UPDATE OF account
    `;
    const account = rows[0];
    if (!account) throw new NotFoundException('ID 不存在或已删除');

    return {
      ...account,
      currentBalance: mapAmount4(account.currentBalance, 'id_business_v2_accounts.current_balance'),
      balanceCostAmount: mapAmount4(
        account.balanceCostAmount,
        'id_business_v2_accounts.balance_cost_amount'
      ),
      purchaseCost: mapAmount4(account.purchaseCost, 'id_business_v2_accounts.purchase_cost')
    };
  }

  countActiveLocks(tx: V2CommandTransaction, accountId: string, now: Date) {
    return tx.idBusinessV2AccountLock.count({
      where: {
        accountId,
        status: 'active',
        expiresAt: { gt: now }
      }
    });
  }

  findFrozenStatus(tx: V2CommandTransaction) {
    return tx.idBusinessV2Option.findFirst({
      where: {
        type: 'id_status',
        code: 'frozen',
        status: 'active',
        isSystem: true,
        deletedAt: null
      },
      select: { id: true }
    });
  }

  findNormalStatus(tx: V2CommandTransaction) {
    return tx.idBusinessV2Option.findFirst({
      where: {
        type: 'id_status',
        code: 'normal',
        status: 'active',
        isSystem: true,
        deletedAt: null
      },
      select: { id: true }
    });
  }

  createBalanceLedger(
    tx: V2CommandTransaction,
    data: Prisma.IdBusinessV2BalanceLedgerUncheckedCreateInput
  ) {
    return tx.idBusinessV2BalanceLedger.create({ data, select: { id: true } });
  }

  async createLossRecord(
    tx: V2CommandTransaction,
    data: Prisma.IdBusinessV2AccountLossUncheckedCreateInput
  ) {
    const record = await tx.idBusinessV2AccountLoss.create({
      data,
      include: REPORTED_BY_INCLUDE
    });
    return this.mapLossRecord(record);
  }

  async attachFinanceJournalToLoss(
    tx: V2CommandTransaction,
    input: { lossRecordId: string; financeJournalId: string }
  ) {
    const record = await tx.idBusinessV2AccountLoss.update({
      where: { id: input.lossRecordId },
      data: { financeJournalId: input.financeJournalId },
      include: REPORTED_BY_INCLUDE
    });
    return this.mapLossRecord(record);
  }

  freezeAccount(
    tx: V2CommandTransaction,
    input: {
      accountId: string;
      frozenStatusId: string;
      lossRecordId: string;
      now: Date;
      operatorId?: string;
    }
  ) {
    return tx.idBusinessV2Account.update({
      where: { id: input.accountId },
      data: {
        statusOptionId: input.frozenStatusId,
        lossReportedAt: input.now,
        activeLossRecordId: input.lossRecordId,
        recordStatus: 'disabled',
        updatedByUserId: input.operatorId
      },
      select: { id: true }
    });
  }

  async markLossReversed(
    tx: V2CommandTransaction,
    input: {
      lossRecordId: string;
      reversalFinanceJournalId: string;
      reason: string;
      now: Date;
      operatorId?: string;
      operatorName?: string;
    }
  ) {
    const record = await tx.idBusinessV2AccountLoss.update({
      where: { id: input.lossRecordId },
      data: {
        status: 'reversed',
        reversalFinanceJournalId: input.reversalFinanceJournalId,
        reversalReason: input.reason,
        reversedAt: input.now,
        reversedByUserId: input.operatorId,
        reversedByName: input.operatorName
      },
      include: REPORTED_BY_INCLUDE
    });
    return this.mapLossRecord(record);
  }

  unfreezeAccount(
    tx: V2CommandTransaction,
    input: {
      accountId: string;
      statusOptionId: string;
      recordStatus: IdBusinessV2RecordStatus;
      operatorId?: string;
    }
  ) {
    return tx.idBusinessV2Account.update({
      where: { id: input.accountId },
      data: {
        statusOptionId: input.statusOptionId,
        lossReportedAt: null,
        activeLossRecordId: null,
        recordStatus: input.recordStatus,
        updatedByUserId: input.operatorId
      },
      select: { id: true }
    });
  }

  markActivationsAbnormal(
    tx: V2CommandTransaction,
    input: { accountId: string; now: Date; operatorId?: string }
  ) {
    return tx.idBusinessV2Activation.updateMany({
      where: {
        accountId: input.accountId,
        status: 'active'
      },
      data: {
        status: 'abnormal',
        statusChangedAt: input.now,
        updatedByUserId: input.operatorId
      }
    });
  }

  private mapLossRecord(record: PersistedAccountLossRecord): IdBusinessV2AccountLossRecord {
    return {
      ...record,
      lossBalance: mapAmount4(record.lossBalance, 'id_business_v2_account_losses.loss_balance'),
      lossCostAmount: mapAmount4(
        record.lossCostAmount,
        'id_business_v2_account_losses.loss_cost_amount'
      ),
      idPurchaseCostLossAmount: mapAmount4(
        record.idPurchaseCostLossAmount,
        'id_business_v2_account_losses.id_purchase_cost_loss_amount'
      )
    };
  }
}

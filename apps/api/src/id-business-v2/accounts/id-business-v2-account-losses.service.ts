import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException
} from '@nestjs/common';
import { Prisma as PrismaNamespace } from '@prisma/client';
import type { Prisma } from '@prisma/client';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { getPagination, type PaginationQuery } from '../../common/pagination';
import { PrismaService } from '../../common/prisma/prisma.service';
import { IdBusinessV2BalanceCalculatorService } from '../balances/public-api';
import { toV2DecimalString } from '../decimal-policy';
import type { ReportIdBusinessV2AccountLossDto } from './dto/report-id-business-v2-account-loss.dto';

interface ListIdBusinessV2AccountLossesQuery extends PaginationQuery {
  keyword?: string;
  countryOptionId?: string;
  saleState?: string;
  reportedFrom?: string;
  reportedTo?: string;
  sortBy?: string;
  sortOrder?: string;
}

interface LockedAccountRow {
  id: string;
  appleIdMasked: string;
  countryOptionId: string;
  countryName: string;
  currencyCode: string | null;
  supplierOptionId: string | null;
  supplierName: string | null;
  currentBalance: PrismaNamespace.Decimal;
  balanceCostAmount: PrismaNamespace.Decimal;
  soldByOrderId: string | null;
  soldOrderNo: string | null;
  lossReportedAt: Date | null;
}

export interface IdBusinessV2AccountLossAuditContext {
  source: 'gift_card_redeemed';
  giftCardId: string;
  giftCardMasked: string;
  reversalLedgerEntryId: string;
}

const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]{8,100}$/;
const SORT_FIELDS = {
  reportedAt: 'reportedAt',
  lossBalance: 'lossBalance',
  lossCostAmount: 'lossCostAmount'
} as const satisfies Record<string, keyof Prisma.IdBusinessV2AccountLossOrderByWithRelationInput>;

@Injectable()
export class IdBusinessV2AccountLossesService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly balanceCalculator: IdBusinessV2BalanceCalculatorService
  ) {}

  async reportLoss(
    accountIdValue: string,
    dto: ReportIdBusinessV2AccountLossDto,
    operator?: AuthenticatedUser
  ) {
    try {
      return await this.prisma.$transaction((tx) =>
        this.reportLossInTransaction(tx, accountIdValue, dto, operator)
      );
    } catch (error) {
      if (
        error instanceof PrismaNamespace.PrismaClientKnownRequestError &&
        error.code === 'P2002'
      ) {
        throw new ConflictException('该 ID 已报损或本次请求已处理');
      }
      throw error;
    }
  }

  async reportLossInTransaction(
    tx: Prisma.TransactionClient,
    accountIdValue: string,
    dto: ReportIdBusinessV2AccountLossDto,
    operator?: AuthenticatedUser,
    auditContext?: IdBusinessV2AccountLossAuditContext
  ) {
    const accountId = this.normalizeUuid(accountIdValue, 'ID');
    const reason = this.normalizeReason(dto.reason);
    const requestIdempotencyKey = this.normalizeIdempotencyKey(dto.idempotencyKey);
    const idempotencyKey = `account_loss:${accountId}:${requestIdempotencyKey}`;
    const expected = this.balanceCalculator.normalizeSnapshot(
      dto.expectedCurrentBalance,
      dto.expectedBalanceCostAmount
    );

    const replay = await tx.idBusinessV2AccountLoss.findUnique({
      where: { idempotencyKey },
      include: {
        reportedBy: {
          select: {
            id: true,
            username: true,
            displayName: true
          }
        }
      }
    });
    if (replay) {
      this.assertReplayMatches(replay, accountId, reason, expected);
      return this.toReportResult(replay, true);
    }

    const account = await this.lockAccount(tx, accountId);
    if (account.lossReportedAt) {
      const committedReplay = await tx.idBusinessV2AccountLoss.findUnique({
        where: { accountId },
        include: {
          reportedBy: {
            select: {
              id: true,
              username: true,
              displayName: true
            }
          }
        }
      });
      if (committedReplay?.idempotencyKey === idempotencyKey) {
        this.assertReplayMatches(committedReplay, accountId, reason, expected);
        return this.toReportResult(committedReplay, true);
      }
      throw new ConflictException('该 ID 已报损，不能重复操作');
    }
    if (
      !account.currentBalance.equals(expected.currentBalance) ||
      !account.balanceCostAmount.equals(expected.balanceCostAmount)
    ) {
      throw new ConflictException('ID 余额已发生变化，请刷新后重新确认报损');
    }

    const now = new Date();
    const activeLockCount = await tx.idBusinessV2AccountLock.count({
      where: {
        accountId,
        status: 'active',
        expiresAt: { gt: now }
      }
    });
    if (activeLockCount > 0) {
      throw new ConflictException('该 ID 有未释放的订单锁，请先处理关联订单再报损');
    }

    const frozenStatus = await tx.idBusinessV2Option.findFirst({
      where: {
        type: 'id_status',
        code: 'frozen',
        status: 'active',
        isSystem: true,
        deletedAt: null
      },
      select: { id: true }
    });
    if (!frozenStatus) {
      throw new ConflictException('系统缺少固定的冻结状态，请先完成数据库迁移');
    }

    const averageCostBefore = this.balanceCalculator.calculateAverageCost(
      account.currentBalance,
      account.balanceCostAmount
    );
    const ledgerEntry = await tx.idBusinessV2BalanceLedger.create({
      data: {
        accountId,
        giftCardId: null,
        orderId: null,
        entryType: 'account_loss',
        direction: 'debit',
        balanceAmount: account.currentBalance,
        costAmount: account.balanceCostAmount,
        balanceBefore: account.currentBalance,
        balanceAfter: '0',
        costBefore: account.balanceCostAmount,
        costAfter: '0',
        averageCostBefore,
        averageCostAfter: '0',
        reversalOfEntryId: null,
        idempotencyKey,
        remark: reason,
        createdByUserId: operator?.id,
        createdAt: now
      }
    });

    const lossRecord = await tx.idBusinessV2AccountLoss.create({
      data: {
        accountId,
        ledgerEntryId: ledgerEntry.id,
        appleIdMasked: account.appleIdMasked,
        countryOptionId: account.countryOptionId,
        countryName: account.countryName,
        currencyCode: account.currencyCode,
        supplierOptionId: account.supplierOptionId,
        supplierName: account.supplierName,
        saleState: account.soldByOrderId ? 'sold' : 'available',
        soldOrderId: account.soldByOrderId,
        soldOrderNo: account.soldOrderNo,
        lossBalance: account.currentBalance,
        lossCostAmount: account.balanceCostAmount,
        reason,
        idempotencyKey,
        reportedByUserId: operator?.id,
        reportedByName: operator?.displayName || operator?.username,
        reportedAt: now
      },
      include: {
        reportedBy: {
          select: {
            id: true,
            username: true,
            displayName: true
          }
        }
      }
    });

    await tx.idBusinessV2Account.update({
      where: { id: accountId },
      data: {
        statusOptionId: frozenStatus.id,
        currentBalance: '0',
        balanceCostAmount: '0',
        lossReportedAt: now,
        recordStatus: 'disabled',
        updatedByUserId: operator?.id
      }
    });
    await tx.idBusinessV2Activation.updateMany({
      where: {
        accountId,
        status: 'active'
      },
      data: {
        status: 'abnormal',
        statusChangedAt: now,
        updatedByUserId: operator?.id
      }
    });
    await tx.auditLog.create({
      data: {
        userId: operator?.id,
        module: 'id_business_v2_accounts',
        action: 'id_business_v2.account.report_loss',
        objectType: 'id_business_v2_account',
        objectId: accountId,
        beforeData: {
          currentBalance: toV2DecimalString(account.currentBalance),
          balanceCostAmount: toV2DecimalString(account.balanceCostAmount),
          lossReportedAt: null,
          saleState: account.soldByOrderId ? 'sold' : 'available'
        },
        afterData: {
          currentBalance: '0',
          balanceCostAmount: '0',
          lossReportedAt: now.toISOString(),
          lossRecordId: lossRecord.id,
          ledgerEntryId: ledgerEntry.id,
          reason,
          ...(auditContext
            ? {
                source: auditContext.source,
                sourceGiftCardId: auditContext.giftCardId,
                sourceGiftCardMasked: auditContext.giftCardMasked,
                sourceReversalLedgerEntryId: auditContext.reversalLedgerEntryId
              }
            : {})
        },
        remark: `V2 ID 永久报损：${account.appleIdMasked}`
      }
    });

    return this.toReportResult(lossRecord, false);
  }

  async list(query: ListIdBusinessV2AccountLossesQuery) {
    const pagination = getPagination(query);
    const keyword = this.normalizeKeyword(query.keyword);
    const countryOptionId = this.normalizeOptionalUuid(query.countryOptionId, '国家');
    const saleState = this.normalizeSaleState(query.saleState);
    const reportedAt = this.buildReportedAtFilter(query.reportedFrom, query.reportedTo);
    const where: Prisma.IdBusinessV2AccountLossWhereInput = {
      countryOptionId: countryOptionId ?? undefined,
      saleState: saleState ?? undefined,
      reportedAt,
      OR: keyword
        ? [
            { appleIdMasked: { contains: keyword, mode: 'insensitive' } },
            { soldOrderNo: { contains: keyword, mode: 'insensitive' } },
            { reason: { contains: keyword, mode: 'insensitive' } },
            { reportedByName: { contains: keyword, mode: 'insensitive' } },
            { reportedBy: { is: { displayName: { contains: keyword, mode: 'insensitive' } } } },
            { reportedBy: { is: { username: { contains: keyword, mode: 'insensitive' } } } }
          ]
        : undefined
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.idBusinessV2AccountLoss.findMany({
        where,
        include: {
          reportedBy: {
            select: {
              id: true,
              username: true,
              displayName: true
            }
          }
        },
        skip: pagination.skip,
        take: pagination.take,
        orderBy: this.buildOrderBy(query)
      }),
      this.prisma.idBusinessV2AccountLoss.count({ where })
    ]);

    return {
      items: items.map((item, index) => ({
        rowNumber: pagination.skip + index + 1,
        ...this.toLossRecordResponse(item)
      })),
      total,
      page: pagination.page,
      pageSize: pagination.pageSize
    };
  }

  private async lockAccount(tx: Prisma.TransactionClient, accountId: string) {
    const rows = await tx.$queryRaw<LockedAccountRow[]>(PrismaNamespace.sql`
      SELECT
        account."id",
        account."apple_id_masked" AS "appleIdMasked",
        account."country_option_id" AS "countryOptionId",
        country."name" AS "countryName",
        country."currency_code" AS "currencyCode",
        account."supplier_option_id" AS "supplierOptionId",
        supplier."name" AS "supplierName",
        account."current_balance" AS "currentBalance",
        account."balance_cost_amount" AS "balanceCostAmount",
        account."sold_by_order_id" AS "soldByOrderId",
        sold_order."order_no" AS "soldOrderNo",
        account."loss_reported_at" AS "lossReportedAt"
      FROM "id_business_v2_accounts" account
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
    `);
    const account = rows[0];
    if (!account) {
      throw new NotFoundException('ID 不存在或已删除');
    }
    return account;
  }

  private toReportResult(
    loss: {
      id: string;
      accountId: string;
      ledgerEntryId: string;
      appleIdMasked: string;
      countryOptionId: string;
      countryName: string;
      currencyCode: string | null;
      supplierOptionId: string | null;
      supplierName: string | null;
      saleState: 'available' | 'sold';
      soldOrderId: string | null;
      soldOrderNo: string | null;
      lossBalance: PrismaNamespace.Decimal;
      lossCostAmount: PrismaNamespace.Decimal;
      reason: string;
      reportedByName: string | null;
      reportedAt: Date;
      reportedBy: { id: string; username: string; displayName: string } | null;
    },
    idempotentReplay: boolean
  ) {
    return {
      lossRecord: this.toLossRecordResponse(loss),
      account: {
        id: loss.accountId,
        appleIdMasked: loss.appleIdMasked,
        lossStatus: 'reported' as const,
        lossReportedAt: loss.reportedAt.toISOString(),
        currentBalance: '0',
        balanceCostAmount: '0'
      },
      idempotentReplay
    };
  }

  private assertReplayMatches(
    replay: {
      accountId: string;
      reason: string;
      lossBalance: PrismaNamespace.Decimal;
      lossCostAmount: PrismaNamespace.Decimal;
    },
    accountId: string,
    reason: string,
    expected: {
      currentBalance: PrismaNamespace.Decimal;
      balanceCostAmount: PrismaNamespace.Decimal;
    }
  ) {
    if (
      replay.accountId !== accountId ||
      replay.reason !== reason ||
      !replay.lossBalance.equals(expected.currentBalance) ||
      !replay.lossCostAmount.equals(expected.balanceCostAmount)
    ) {
      throw new ConflictException('相同幂等键对应的报损内容不一致');
    }
  }

  private toLossRecordResponse(loss: {
    id: string;
    accountId: string;
    ledgerEntryId: string;
    appleIdMasked: string;
    countryOptionId: string;
    countryName: string;
    currencyCode: string | null;
    supplierOptionId: string | null;
    supplierName: string | null;
    saleState: 'available' | 'sold';
    soldOrderId: string | null;
    soldOrderNo: string | null;
    lossBalance: PrismaNamespace.Decimal;
    lossCostAmount: PrismaNamespace.Decimal;
    reason: string;
    reportedByName: string | null;
    reportedAt: Date;
    reportedBy: { id: string; username: string; displayName: string } | null;
  }) {
    return {
      id: loss.id,
      accountId: loss.accountId,
      ledgerEntryId: loss.ledgerEntryId,
      appleIdMasked: loss.appleIdMasked,
      countryOptionId: loss.countryOptionId,
      countryName: loss.countryName,
      currencyCode: loss.currencyCode,
      supplierOptionId: loss.supplierOptionId,
      supplierName: loss.supplierName,
      saleState: loss.saleState,
      soldOrderId: loss.soldOrderId,
      soldOrderNo: loss.soldOrderNo,
      lossBalance: toV2DecimalString(loss.lossBalance),
      lossCostAmount: toV2DecimalString(loss.lossCostAmount),
      reason: loss.reason,
      reportedByName: loss.reportedByName,
      reportedBy: loss.reportedBy,
      reportedAt: loss.reportedAt.toISOString()
    };
  }

  private buildOrderBy(
    query: ListIdBusinessV2AccountLossesQuery
  ): Prisma.IdBusinessV2AccountLossOrderByWithRelationInput[] {
    const sortField =
      query.sortBy && Object.prototype.hasOwnProperty.call(SORT_FIELDS, query.sortBy)
        ? SORT_FIELDS[query.sortBy as keyof typeof SORT_FIELDS]
        : undefined;
    const sortOrder =
      query.sortOrder === 'asc' || query.sortOrder === 'desc' ? query.sortOrder : null;
    if (!sortField || !sortOrder) {
      return [{ reportedAt: 'desc' }, { id: 'desc' }];
    }
    return [{ [sortField]: sortOrder }, { reportedAt: 'desc' }, { id: 'desc' }];
  }

  private buildReportedAtFilter(fromValue?: string, toValue?: string) {
    const from = this.normalizeDate(fromValue, '开始日期');
    const to = this.normalizeDate(toValue, '结束日期');
    if (from && to && from.getTime() > to.getTime()) {
      throw new BadRequestException('开始日期不能晚于结束日期');
    }
    if (!from && !to) return undefined;
    const exclusiveTo = to ? new Date(to.getTime() + 24 * 60 * 60 * 1000) : undefined;
    return {
      gte: from,
      lt: exclusiveTo
    };
  }

  private normalizeDate(value: unknown, label: string) {
    if (value === undefined || value === null || value === '') return undefined;
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!/^\d{4}-\d{2}-\d{2}$/.test(normalized)) {
      throw new BadRequestException(`${label}格式无效`);
    }
    const date = new Date(`${normalized}T00:00:00.000Z`);
    if (Number.isNaN(date.getTime()) || date.toISOString().slice(0, 10) !== normalized) {
      throw new BadRequestException(`${label}格式无效`);
    }
    return date;
  }

  private normalizeKeyword(value: unknown) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (normalized.length > 160) {
      throw new BadRequestException('搜索内容不能超过 160 个字符');
    }
    return normalized || null;
  }

  private normalizeSaleState(value: unknown): 'available' | 'sold' | null {
    if (value === undefined || value === null || value === '') return null;
    if (value === 'available' || value === 'sold') return value;
    throw new BadRequestException('销售状态无效');
  }

  private normalizeReason(value: unknown) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (normalized.length < 2 || normalized.length > 500) {
      throw new BadRequestException('报损原因必须为 2 至 500 个字符');
    }
    return normalized;
  }

  private normalizeIdempotencyKey(value: unknown) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!IDEMPOTENCY_KEY_PATTERN.test(normalized)) {
      throw new BadRequestException('幂等键必须是 8 至 100 位字母、数字或 ._:-');
    }
    return normalized;
  }

  private normalizeUuid(value: unknown, label: string) {
    const normalized = typeof value === 'string' ? value.trim() : '';
    if (!UUID_PATTERN.test(normalized)) {
      throw new BadRequestException(`${label}格式无效`);
    }
    return normalized;
  }

  private normalizeOptionalUuid(value: unknown, label: string) {
    if (value === undefined || value === null || value === '') return null;
    return this.normalizeUuid(value, label);
  }
}

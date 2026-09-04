import { Injectable } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import type { V2CommandTransaction } from '../../runtime/public-api';

const REPORT_ROW_LIMIT = 10_000;

type GoogleSheetsSyncPersistenceClient = Pick<V2CommandTransaction, 'idBusinessV2GoogleSheetsSync'>;

const ORDER_REPORT_SELECT = {
  id: true,
  orderNo: true,
  customer: { select: { name: true } },
  serviceOption: { select: { name: true, parent: { select: { name: true } } } },
  settlementPlatform: { select: { name: true } },
  receivedAmount: true,
  receivedOriginalAmount: true,
  receivedCurrency: true,
  platformFeeAmount: true,
  appliedAccountCostAmount: true,
  appliedBalanceCostAmount: true,
  refundCostAmount: true,
  profitAmount: true,
  status: true,
  accountSource: true,
  accountDisposition: true,
  openedAt: true,
  dueAt: true,
  createdAt: true,
  updatedAt: true
} satisfies Prisma.IdBusinessV2OrderSelect;

const GIFT_CARD_REPORT_SELECT = {
  id: true,
  cardNameSnapshot: true,
  countryNameSnapshot: true,
  currencyCodeSnapshot: true,
  supplierNameSnapshot: true,
  faceValue: true,
  exchangeRate: true,
  costAmount: true,
  purchaseOriginalAmount: true,
  purchaseCurrency: true,
  purchaseFxRateToCny: true,
  supplierRefundStatus: true,
  supplierRefundAmountCny: true,
  status: true,
  creditedAt: true,
  updatedAt: true
} satisfies Prisma.IdBusinessV2GiftCardSelect;

const RENEWAL_REPORT_SELECT = {
  id: true,
  order: { select: { orderNo: true } },
  customer: { select: { name: true } },
  serviceOption: { select: { name: true, parent: { select: { name: true } } } },
  openedAt: true,
  dueAt: true,
  status: true,
  autoRenewalStatus: true,
  renewedFromActivationId: true,
  updatedAt: true
} satisfies Prisma.IdBusinessV2ActivationSelect;

const FINANCE_REPORT_SELECT = {
  businessDate: true,
  lines: {
    select: {
      accountCode: true,
      amountCny: true,
      direction: true
    }
  }
} satisfies Prisma.IdBusinessV2FinanceJournalSelect;

export type IdBusinessV2GoogleSheetsOrderRow = Prisma.IdBusinessV2OrderGetPayload<{
  select: typeof ORDER_REPORT_SELECT;
}>;
export type IdBusinessV2GoogleSheetsGiftCardRow = Prisma.IdBusinessV2GiftCardGetPayload<{
  select: typeof GIFT_CARD_REPORT_SELECT;
}>;
export type IdBusinessV2GoogleSheetsRenewalRow = Prisma.IdBusinessV2ActivationGetPayload<{
  select: typeof RENEWAL_REPORT_SELECT;
}>;
export type IdBusinessV2GoogleSheetsFinanceRow = Prisma.IdBusinessV2FinanceJournalGetPayload<{
  select: typeof FINANCE_REPORT_SELECT;
}>;

@Injectable()
export class IdBusinessV2GoogleSheetsSyncRepository {
  constructor(private readonly prisma: PrismaService) {}

  getConfiguration(client: GoogleSheetsSyncPersistenceClient = this.prisma) {
    return client.idBusinessV2GoogleSheetsSync.findUnique({ where: { id: 1 } });
  }

  findConfigurationByStateHash(stateHash: string) {
    return this.prisma.idBusinessV2GoogleSheetsSync.findUnique({
      where: { oauthStateHash: stateHash }
    });
  }

  saveConfiguration(
    input: Prisma.IdBusinessV2GoogleSheetsSyncUncheckedCreateInput,
    client: GoogleSheetsSyncPersistenceClient = this.prisma
  ) {
    const data: Prisma.IdBusinessV2GoogleSheetsSyncUncheckedCreateInput = {
      ...input,
      id: undefined
    };
    return client.idBusinessV2GoogleSheetsSync.upsert({
      where: { id: 1 },
      create: { ...data, id: 1 },
      update: data
    });
  }

  updateConfiguration(
    input: Prisma.IdBusinessV2GoogleSheetsSyncUncheckedUpdateInput,
    client: GoogleSheetsSyncPersistenceClient = this.prisma
  ) {
    return client.idBusinessV2GoogleSheetsSync.update({ where: { id: 1 }, data: input });
  }

  async acquireLease(leaseId: string, now: Date, expiresAt: Date) {
    const result = await this.prisma.idBusinessV2GoogleSheetsSync.updateMany({
      where: {
        id: 1,
        enabled: true,
        refreshTokenEncrypted: { not: null },
        OR: [{ runLeaseId: null }, { runLeaseExpiresAt: { lt: now } }]
      },
      data: { lastAttemptAt: now, runLeaseExpiresAt: expiresAt, runLeaseId: leaseId }
    });
    return result.count === 1;
  }

  releaseLease(leaseId: string) {
    return this.prisma.idBusinessV2GoogleSheetsSync.updateMany({
      where: { id: 1, runLeaseId: leaseId },
      data: { runLeaseExpiresAt: null, runLeaseId: null }
    });
  }

  async listSourceVersions() {
    const rows = await this.prisma.idBusinessV2ScopeVersion.findMany({
      orderBy: { scope: 'asc' },
      select: { scope: true, version: true }
    });
    return Object.fromEntries(rows.map((row) => [row.scope, row.version.toString()]));
  }

  async loadReportSource() {
    const [orders, giftCards, renewals, financeJournals] = await Promise.all([
      this.prisma.idBusinessV2Order.findMany({
        where: { deletedAt: null },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: REPORT_ROW_LIMIT,
        select: ORDER_REPORT_SELECT
      }),
      this.prisma.idBusinessV2GiftCard.findMany({
        orderBy: [{ creditedAt: 'desc' }, { id: 'desc' }],
        take: REPORT_ROW_LIMIT,
        select: GIFT_CARD_REPORT_SELECT
      }),
      this.prisma.idBusinessV2Activation.findMany({
        orderBy: [{ openedAt: 'desc' }, { id: 'desc' }],
        take: REPORT_ROW_LIMIT,
        select: RENEWAL_REPORT_SELECT
      }),
      this.prisma.idBusinessV2FinanceJournal.findMany({
        orderBy: [{ businessDate: 'desc' }, { id: 'desc' }],
        take: REPORT_ROW_LIMIT,
        select: FINANCE_REPORT_SELECT
      })
    ]);
    return { financeJournals, giftCards, orders, renewals };
  }
}

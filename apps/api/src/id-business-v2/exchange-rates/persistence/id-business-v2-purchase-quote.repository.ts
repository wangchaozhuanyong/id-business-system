import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../../../common/prisma/prisma.service';
import { mapRate8, type V2CommandTransaction } from '../../runtime/public-api';

const PURCHASE_CURRENCY_INCLUDE = {
  updatedBy: { select: { id: true, username: true, displayName: true } },
  snapshots: {
    take: 1,
    orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    include: {
      createdBy: { select: { id: true, username: true, displayName: true } }
    }
  }
} satisfies Prisma.IdBusinessV2PurchaseCurrencyInclude;

const PURCHASE_SNAPSHOT_INCLUDE = {
  createdBy: { select: { id: true, username: true, displayName: true } }
} satisfies Prisma.IdBusinessV2PurchaseRateSnapshotInclude;

type PurchaseCurrencyRow = Prisma.IdBusinessV2PurchaseCurrencyGetPayload<{
  include: typeof PURCHASE_CURRENCY_INCLUDE;
}>;

type PurchaseSnapshotRow = Prisma.IdBusinessV2PurchaseRateSnapshotGetPayload<{
  include: typeof PURCHASE_SNAPSHOT_INCLUDE;
}>;

@Injectable()
export class IdBusinessV2PurchaseQuoteRepository {
  constructor(private readonly prisma: PrismaService) {}

  async listCurrencies() {
    const rows = await this.prisma.idBusinessV2PurchaseCurrency.findMany({
      include: PURCHASE_CURRENCY_INCLUDE,
      orderBy: [{ sortOrder: 'asc' }, { code: 'asc' }]
    });
    return rows.map(mapPurchaseCurrency);
  }

  async findCurrency(code: string) {
    const row = await this.prisma.idBusinessV2PurchaseCurrency.findUnique({
      where: { code },
      include: PURCHASE_CURRENCY_INCLUDE
    });
    return row ? mapPurchaseCurrency(row) : null;
  }

  async findCurrencyInTransaction(tx: V2CommandTransaction, code: string) {
    const row = await tx.idBusinessV2PurchaseCurrency.findUnique({
      where: { code },
      include: PURCHASE_CURRENCY_INCLUDE
    });
    return row ? mapPurchaseCurrency(row) : null;
  }

  async updateCurrency(
    tx: V2CommandTransaction,
    code: string,
    data: Prisma.IdBusinessV2PurchaseCurrencyUpdateInput
  ) {
    const row = await tx.idBusinessV2PurchaseCurrency.update({
      where: { code },
      data,
      include: PURCHASE_CURRENCY_INCLUDE
    });
    return mapPurchaseCurrency(row);
  }

  async createSnapshot(
    tx: V2CommandTransaction,
    data: Prisma.IdBusinessV2PurchaseRateSnapshotUncheckedCreateInput
  ) {
    const row = await tx.idBusinessV2PurchaseRateSnapshot.create({
      data,
      include: PURCHASE_SNAPSHOT_INCLUDE
    });
    return mapPurchaseSnapshot(row);
  }
}

function mapPurchaseCurrency(row: PurchaseCurrencyRow) {
  return {
    code: row.code,
    nameCn: row.nameCn,
    displayName: row.displayName,
    purchaseRatio: mapRate8(row.purchaseRatio, 'purchase currency purchaseRatio'),
    quoteUnit: mapRate8(row.quoteUnit, 'purchase currency quoteUnit'),
    decimalPlaces: row.decimalPlaces,
    roundingMode: row.roundingMode,
    enabled: row.enabled,
    sortOrder: row.sortOrder,
    updatedBy: row.updatedBy,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    latestSnapshot: row.snapshots[0] ? mapPurchaseSnapshot(row.snapshots[0]) : null
  };
}

function mapPurchaseSnapshot(row: PurchaseSnapshotRow) {
  return {
    id: row.id,
    currencyCode: row.currencyCode,
    marketRateCnyPerUnit: mapRate8(
      row.marketRateCnyPerUnit,
      'purchase snapshot marketRateCnyPerUnit'
    ),
    purchaseRatio: mapRate8(row.purchaseRatio, 'purchase snapshot purchaseRatio'),
    quoteUnit: mapRate8(row.quoteUnit, 'purchase snapshot quoteUnit'),
    purchaseRateRaw: mapRate8(row.purchaseRateRaw, 'purchase snapshot purchaseRateRaw'),
    purchaseRateDisplay: mapRate8(row.purchaseRateDisplay, 'purchase snapshot purchaseRateDisplay'),
    decimalPlaces: row.decimalPlaces,
    roundingMode: row.roundingMode,
    marketRateSource: row.marketRateSource,
    marketRateSourceReference: row.marketRateSourceReference,
    marketRateCapturedAt: row.marketRateCapturedAt,
    fetchRunId: row.fetchRunId,
    changeRate: row.changeRate ? mapRate8(row.changeRate, 'purchase snapshot changeRate') : null,
    validationStatus: row.validationStatus,
    createdBy: row.createdBy,
    createdAt: row.createdAt
  };
}

export type IdBusinessV2PurchaseCurrencyRecord = ReturnType<typeof mapPurchaseCurrency>;
export type IdBusinessV2PurchaseRateSnapshotRecord = ReturnType<typeof mapPurchaseSnapshot>;

import { Prisma } from '@prisma/client';

export type IdBusinessV2OtcProviderName = 'Binance' | 'OKX';
export type IdBusinessV2OtcSide = 'merchant_buy' | 'merchant_sell';

export interface IdBusinessV2OtcQuote {
  sourceAdId: string;
  side: IdBusinessV2OtcSide;
  priceToRmb: Prisma.Decimal;
  minAmountRmb: Prisma.Decimal;
  maxAmountRmb: Prisma.Decimal;
  tradableAmountUsdt: Prisma.Decimal | null;
  paymentMethods: string[];
  merchantType: string;
  completedOrderCount: number | null;
  completionRate: Prisma.Decimal | null;
  positiveReviewRate: Prisma.Decimal | null;
}

export interface IdBusinessV2OtcSideCollection {
  side: IdBusinessV2OtcSide;
  sourceUrl: string;
  receivedAdCount: number;
  acceptedAdCount: number;
  rejectedAdCount: number;
  quotes: IdBusinessV2OtcQuote[];
}

export interface IdBusinessV2OtcCollection {
  provider: IdBusinessV2OtcProviderName;
  sourceContract: 'binance-p2p-friendly-adv-search-v2' | 'okx-public-trading-orders-books-v3';
  asset: 'USDT';
  fiat: 'CNY';
  targetAmountRmb: Prisma.Decimal;
  collectedAt: Date;
  merchantBuy: IdBusinessV2OtcSideCollection;
  merchantSell: IdBusinessV2OtcSideCollection;
}

export interface IdBusinessV2OtcProviderFailure {
  provider: IdBusinessV2OtcProviderName;
  causeCode: string;
  side: IdBusinessV2OtcSide | null;
  retryable: boolean;
}

export interface IdBusinessV2OtcCollector {
  collect(targetAmountRmb: Prisma.Decimal): Promise<IdBusinessV2OtcCollection>;
}

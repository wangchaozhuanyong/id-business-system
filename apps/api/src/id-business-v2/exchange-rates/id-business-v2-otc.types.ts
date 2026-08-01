import { Amount4, Rate8 } from '../runtime/public-api';

export type IdBusinessV2OtcProviderName = 'Binance' | 'OKX';
export type IdBusinessV2OtcSide = 'merchant_buy' | 'merchant_sell';

export interface IdBusinessV2OtcQuote {
  sourceAdId: string;
  side: IdBusinessV2OtcSide;
  priceToRmb: Rate8;
  minAmountRmb: Amount4;
  maxAmountRmb: Amount4;
  tradableAmountUsdt: Amount4 | null;
  paymentMethods: string[];
  merchantType: string;
  completedOrderCount: number | null;
  completionRate: Rate8 | null;
  positiveReviewRate: Rate8 | null;
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
  targetAmountRmb: Amount4;
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
  collect(targetAmountRmb: Amount4): Promise<IdBusinessV2OtcCollection>;
}

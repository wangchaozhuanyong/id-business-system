import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import type {
  IdBusinessV2OtcCollection,
  IdBusinessV2OtcCollector,
  IdBusinessV2OtcQuote,
  IdBusinessV2OtcSide,
  IdBusinessV2OtcSideCollection
} from './id-business-v2-otc.types';

type BinanceTradeType = 'BUY' | 'SELL';

interface BinanceResponse {
  code?: unknown;
  message?: unknown;
  messageDetail?: unknown;
  data?: unknown;
}

const SOURCE_URL = 'https://p2p.binance.com/bapi/c2c/v2/friendly/c2c/adv/search';
const SOURCE_CONTRACT = 'binance-p2p-friendly-adv-search-v2';
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_DECIMAL = new Prisma.Decimal('999999999999999999');

export class IdBusinessV2BinanceOtcError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly side: IdBusinessV2OtcSide | null,
    readonly retryable: boolean,
    readonly httpStatus: number | null = null
  ) {
    super(message);
    this.name = 'IdBusinessV2BinanceOtcError';
  }
}

@Injectable()
export class IdBusinessV2BinanceOtcCollector implements IdBusinessV2OtcCollector {
  private fetcher: typeof fetch = fetch;
  private requestTimeoutMs = REQUEST_TIMEOUT_MS;

  setFetchImplementationForTest(fetcher: typeof fetch) {
    this.fetcher = fetcher;
  }

  setRequestTimeoutForTest(timeoutMs: number) {
    this.requestTimeoutMs = Math.max(1, Math.trunc(timeoutMs));
  }

  async collect(targetAmountRmb: Prisma.Decimal): Promise<IdBusinessV2OtcCollection> {
    const target = this.normalizeTarget(targetAmountRmb);
    const [merchantBuy, merchantSell] = await Promise.all([
      this.collectSide('merchant_buy', target),
      this.collectSide('merchant_sell', target)
    ]);

    return {
      provider: 'Binance',
      sourceContract: SOURCE_CONTRACT,
      asset: 'USDT',
      fiat: 'CNY',
      targetAmountRmb: target,
      collectedAt: new Date(),
      merchantBuy,
      merchantSell
    };
  }

  private async collectSide(
    side: IdBusinessV2OtcSide,
    targetAmountRmb: Prisma.Decimal
  ): Promise<IdBusinessV2OtcSideCollection> {
    // Binance tradeType is the taker's action, so SELL means the merchant buys USDT.
    const tradeType: BinanceTradeType = side === 'merchant_buy' ? 'SELL' : 'BUY';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await this.fetcher(SOURCE_URL, {
        method: 'POST',
        headers: {
          accept: 'application/json',
          'content-type': 'application/json',
          'user-agent': 'Mozilla/5.0 Apple-ID-Business-V2-Exchange-Collector/1.0'
        },
        body: JSON.stringify({
          page: 1,
          rows: 20,
          payTypes: [],
          asset: 'USDT',
          fiat: 'CNY',
          tradeType,
          publisherType: 'merchant',
          transAmount: targetAmountRmb.toFixed(2)
        }),
        signal: controller.signal
      });
      if (!response.ok) {
        throw new IdBusinessV2BinanceOtcError(
          'binance_otc_http_error',
          `Binance P2P 请求返回 HTTP ${response.status}`,
          side,
          response.status === 408 || response.status === 429 || response.status >= 500,
          response.status
        );
      }

      const payload = await this.readPayload(response, side);
      return this.parseSide(payload, side, tradeType, targetAmountRmb);
    } catch (error) {
      if (error instanceof IdBusinessV2BinanceOtcError) throw error;
      if (controller.signal.aborted) {
        throw new IdBusinessV2BinanceOtcError(
          'binance_otc_timeout',
          `Binance P2P ${this.sideLabel(side)}请求超时`,
          side,
          true
        );
      }
      throw new IdBusinessV2BinanceOtcError(
        'binance_otc_network_error',
        `Binance P2P ${this.sideLabel(side)}网络请求失败`,
        side,
        true
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readPayload(response: Response, side: IdBusinessV2OtcSide) {
    try {
      return JSON.parse(await response.text()) as BinanceResponse;
    } catch {
      throw new IdBusinessV2BinanceOtcError(
        'binance_otc_invalid_response',
        `Binance P2P ${this.sideLabel(side)}返回的不是有效 JSON`,
        side,
        true
      );
    }
  }

  private parseSide(
    payload: BinanceResponse,
    side: IdBusinessV2OtcSide,
    tradeType: BinanceTradeType,
    targetAmountRmb: Prisma.Decimal
  ): IdBusinessV2OtcSideCollection {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw this.invalidResponse(side, '响应根节点格式无效');
    }
    if (this.readString(payload.code) !== '000000') {
      throw new IdBusinessV2BinanceOtcError(
        'binance_otc_provider_error',
        `Binance P2P ${this.sideLabel(side)}返回业务错误`,
        side,
        true
      );
    }
    if (!Array.isArray(payload.data)) {
      throw this.invalidResponse(side, 'data 不是数组');
    }

    const unique = new Map<string, IdBusinessV2OtcQuote>();
    for (const item of payload.data) {
      const quote = this.parseQuote(item, side, tradeType, targetAmountRmb);
      if (quote && !unique.has(quote.sourceAdId)) unique.set(quote.sourceAdId, quote);
    }
    const quotes = [...unique.values()];
    if (!quotes.length) {
      throw new IdBusinessV2BinanceOtcError(
        'binance_otc_empty_side',
        `Binance P2P ${this.sideLabel(side)}没有覆盖 ¥${targetAmountRmb.toFixed(2)} 的商家广告`,
        side,
        true
      );
    }

    return {
      side,
      sourceUrl: SOURCE_URL,
      receivedAdCount: payload.data.length,
      acceptedAdCount: quotes.length,
      rejectedAdCount: payload.data.length - quotes.length,
      quotes
    };
  }

  private parseQuote(
    value: unknown,
    side: IdBusinessV2OtcSide,
    requestTradeType: BinanceTradeType,
    targetAmountRmb: Prisma.Decimal
  ): IdBusinessV2OtcQuote | null {
    const item = this.toObject(value);
    const adv = this.toObject(item?.adv);
    const advertiser = this.toObject(item?.advertiser);
    const sourceAdId = this.readString(adv?.advNo);
    const responseTradeType = this.readString(adv?.tradeType)?.toUpperCase();
    const expectedResponseTradeType = requestTradeType === 'SELL' ? 'BUY' : 'SELL';
    const priceToRmb = this.positiveDecimal(adv?.price);
    const minAmountRmb = this.positiveDecimal(adv?.minSingleTransAmount);
    const maxAmountRmb =
      this.positiveDecimal(adv?.dynamicMaxSingleTransAmount) ??
      this.positiveDecimal(adv?.maxSingleTransAmount);
    const merchantType = this.readString(advertiser?.userType)?.toLowerCase();

    if (
      !sourceAdId ||
      responseTradeType !== expectedResponseTradeType ||
      this.readString(adv?.asset)?.toUpperCase() !== 'USDT' ||
      this.readString(adv?.fiatUnit)?.toUpperCase() !== 'CNY' ||
      merchantType !== 'merchant' ||
      !priceToRmb ||
      !minAmountRmb ||
      !maxAmountRmb ||
      maxAmountRmb.lt(minAmountRmb) ||
      targetAmountRmb.lt(minAmountRmb) ||
      targetAmountRmb.gt(maxAmountRmb)
    ) {
      return null;
    }

    return {
      sourceAdId,
      side,
      priceToRmb,
      minAmountRmb,
      maxAmountRmb,
      tradableAmountUsdt:
        this.nonNegativeDecimal(adv?.tradableQuantity) ??
        this.nonNegativeDecimal(adv?.surplusAmount),
      paymentMethods: this.paymentMethods(adv?.tradeMethods),
      merchantType,
      completedOrderCount: this.nonNegativeInteger(advertiser?.monthOrderCount),
      completionRate: this.ratioDecimal(advertiser?.monthFinishRate),
      positiveReviewRate: this.ratioDecimal(advertiser?.positiveRate)
    };
  }

  private normalizeTarget(value: Prisma.Decimal) {
    const target = new Prisma.Decimal(value).toDecimalPlaces(2, Prisma.Decimal.ROUND_HALF_UP);
    if (!target.isFinite() || target.lte(0)) {
      throw new IdBusinessV2BinanceOtcError(
        'binance_otc_invalid_target',
        'Binance P2P 目标成交额无效',
        null,
        false
      );
    }
    return target;
  }

  private positiveDecimal(value: unknown) {
    const decimal = this.decimal(value);
    return decimal?.gt(0) ? decimal : null;
  }

  private nonNegativeDecimal(value: unknown) {
    const decimal = this.decimal(value);
    return decimal?.gte(0) ? decimal : null;
  }

  private ratioDecimal(value: unknown) {
    const decimal = this.nonNegativeDecimal(value);
    return decimal?.lte(1) ? decimal : null;
  }

  private decimal(value: unknown) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    try {
      const decimal = new Prisma.Decimal(String(value));
      return decimal.isFinite() && decimal.abs().lte(MAX_DECIMAL) ? decimal : null;
    } catch {
      return null;
    }
  }

  private nonNegativeInteger(value: unknown) {
    const parsed =
      typeof value === 'number'
        ? value
        : typeof value === 'string' && /^\d+$/.test(value.trim())
          ? Number(value)
          : Number.NaN;
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
  }

  private paymentMethods(value: unknown) {
    if (!Array.isArray(value)) return [];
    return [
      ...new Set(
        value
          .map((item) => {
            const method = this.toObject(item);
            return (
              this.readString(method?.payType) ??
              this.readString(method?.identifier) ??
              this.readString(method?.tradeMethodName)
            );
          })
          .filter((item): item is string => Boolean(item))
          .map((item) => item.slice(0, 80))
      )
    ].slice(0, 20);
  }

  private invalidResponse(side: IdBusinessV2OtcSide, detail: string) {
    return new IdBusinessV2BinanceOtcError(
      'binance_otc_invalid_response',
      `Binance P2P ${this.sideLabel(side)}响应结构无效：${detail}`,
      side,
      true
    );
  }

  private readString(value: unknown) {
    return typeof value === 'string' && value.trim() ? value.trim() : null;
  }

  private toObject(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null;
  }

  private sideLabel(side: IdBusinessV2OtcSide) {
    return side === 'merchant_buy' ? '商家买入' : '商家卖出';
  }
}

import { Injectable } from '@nestjs/common';
import { Amount4, Rate8 } from '../runtime/public-api';
import type {
  IdBusinessV2OtcCollection,
  IdBusinessV2OtcCollector,
  IdBusinessV2OtcQuote,
  IdBusinessV2OtcSide,
  IdBusinessV2OtcSideCollection
} from './id-business-v2-otc.types';

type OkxSide = 'buy' | 'sell';

interface OkxResponse {
  code?: unknown;
  message?: unknown;
  msg?: unknown;
  detailMsg?: unknown;
  data?: unknown;
}

const SOURCE_URL = 'https://www.okx.com/v3/c2c/tradingOrders/books';
const SOURCE_CONTRACT = 'okx-public-trading-orders-books-v3';
const REQUEST_TIMEOUT_MS = 12_000;
const MAX_DECIMAL = Amount4.from('999999999999999999');
const NON_MERCHANT_TYPES = new Set(['common', 'ordinary', 'personal', 'user']);

export class IdBusinessV2OkxOtcError extends Error {
  constructor(
    readonly code: string,
    message: string,
    readonly side: IdBusinessV2OtcSide | null,
    readonly retryable: boolean,
    readonly httpStatus: number | null = null
  ) {
    super(message);
    this.name = 'IdBusinessV2OkxOtcError';
  }
}

@Injectable()
export class IdBusinessV2OkxOtcCollector implements IdBusinessV2OtcCollector {
  private fetcher: typeof fetch = fetch;
  private requestTimeoutMs = REQUEST_TIMEOUT_MS;

  setFetchImplementationForTest(fetcher: typeof fetch) {
    this.fetcher = fetcher;
  }

  setRequestTimeoutForTest(timeoutMs: number) {
    this.requestTimeoutMs = Math.max(1, Math.trunc(timeoutMs));
  }

  async collect(targetAmountRmb: Amount4): Promise<IdBusinessV2OtcCollection> {
    const target = this.normalizeTarget(targetAmountRmb);
    const [merchantBuy, merchantSell] = await Promise.all([
      this.collectSide('merchant_buy', target),
      this.collectSide('merchant_sell', target)
    ]);

    return {
      provider: 'OKX',
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
    targetAmountRmb: Amount4
  ): Promise<IdBusinessV2OtcSideCollection> {
    const sideParam: OkxSide = side === 'merchant_buy' ? 'buy' : 'sell';
    const sourceUrl = this.buildSourceUrl(sideParam);
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.requestTimeoutMs);

    try {
      const response = await this.fetcher(sourceUrl, {
        method: 'GET',
        headers: {
          accept: 'application/json',
          'user-agent': 'Mozilla/5.0 Apple-ID-Business-V2-Exchange-Collector/1.0'
        },
        signal: controller.signal
      });
      if (!response.ok) {
        throw new IdBusinessV2OkxOtcError(
          'okx_otc_http_error',
          `OKX P2P 请求返回 HTTP ${response.status}`,
          side,
          response.status === 408 || response.status === 429 || response.status >= 500,
          response.status
        );
      }
      const payload = await this.readPayload(response, side);
      return this.parseSide(payload, side, sideParam, sourceUrl, targetAmountRmb);
    } catch (error) {
      if (error instanceof IdBusinessV2OkxOtcError) throw error;
      if (controller.signal.aborted) {
        throw new IdBusinessV2OkxOtcError(
          'okx_otc_timeout',
          `OKX P2P ${this.sideLabel(side)}请求超时`,
          side,
          true
        );
      }
      throw new IdBusinessV2OkxOtcError(
        'okx_otc_network_error',
        `OKX P2P ${this.sideLabel(side)}网络请求失败`,
        side,
        true
      );
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readPayload(response: Response, side: IdBusinessV2OtcSide) {
    try {
      return JSON.parse(await response.text()) as OkxResponse;
    } catch {
      throw new IdBusinessV2OkxOtcError(
        'okx_otc_invalid_response',
        `OKX P2P ${this.sideLabel(side)}返回的不是有效 JSON`,
        side,
        true
      );
    }
  }

  private parseSide(
    payload: OkxResponse,
    side: IdBusinessV2OtcSide,
    sideParam: OkxSide,
    sourceUrl: string,
    targetAmountRmb: Amount4
  ): IdBusinessV2OtcSideCollection {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw this.invalidResponse(side, '响应根节点格式无效');
    }
    if (this.providerCode(payload.code) !== '0') {
      throw new IdBusinessV2OkxOtcError(
        'okx_otc_provider_error',
        `OKX P2P ${this.sideLabel(side)}返回业务错误`,
        side,
        true
      );
    }
    const data = this.toObject(payload.data);
    const items = data?.[sideParam];
    if (!Array.isArray(items)) {
      throw this.invalidResponse(side, `data.${sideParam} 不是数组`);
    }

    const unique = new Map<string, IdBusinessV2OtcQuote>();
    for (const item of items) {
      const quote = this.parseQuote(item, side, sideParam, targetAmountRmb);
      if (quote && !unique.has(quote.sourceAdId)) unique.set(quote.sourceAdId, quote);
    }
    const quotes = [...unique.values()];
    if (!quotes.length) {
      throw new IdBusinessV2OkxOtcError(
        'okx_otc_empty_side',
        `OKX P2P ${this.sideLabel(side)}没有覆盖 ¥${targetAmountRmb.toFixed(2)} 的商家广告`,
        side,
        true
      );
    }

    return {
      side,
      sourceUrl,
      receivedAdCount: items.length,
      acceptedAdCount: quotes.length,
      rejectedAdCount: items.length - quotes.length,
      quotes
    };
  }

  private parseQuote(
    value: unknown,
    side: IdBusinessV2OtcSide,
    sideParam: OkxSide,
    targetAmountRmb: Amount4
  ): IdBusinessV2OtcQuote | null {
    const row = this.toObject(value);
    const sourceAdId = this.readString(row?.id);
    const merchantType = this.readString(row?.creatorType)?.toLowerCase();
    const priceToRmb = this.positiveRate(row?.price);
    const minAmountRmb = this.positiveAmount(row?.quoteMinAmountPerOrder);
    const maxAmountRmb = this.positiveAmount(row?.quoteMaxAmountPerOrder);

    if (
      !sourceAdId ||
      this.readString(row?.side)?.toLowerCase() !== sideParam ||
      this.readString(row?.baseCurrency)?.toUpperCase() !== 'USDT' ||
      this.readString(row?.quoteCurrency)?.toUpperCase() !== 'CNY' ||
      !this.readString(row?.merchantId) ||
      !merchantType ||
      NON_MERCHANT_TYPES.has(merchantType) ||
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
      tradableAmountUsdt: this.nonNegativeDecimal(row?.availableAmount),
      paymentMethods: this.paymentMethods(row?.paymentMethods),
      merchantType,
      completedOrderCount: this.nonNegativeInteger(row?.completedOrderQuantity),
      completionRate: this.ratioDecimal(row?.completedRate),
      positiveReviewRate: this.ratioDecimal(row?.posReviewPercentage)
    };
  }

  private buildSourceUrl(side: OkxSide) {
    const url = new URL(SOURCE_URL);
    url.searchParams.set('baseCurrency', 'usdt');
    url.searchParams.set('quoteCurrency', 'cny');
    url.searchParams.set('side', side);
    url.searchParams.set('paymentMethod', 'all');
    url.searchParams.set('userType', 'all');
    url.searchParams.set('page', '1');
    url.searchParams.set('limit', '100');
    return url.toString();
  }

  private normalizeTarget(value: Amount4) {
    const target = Amount4.from(value);
    if (target.lte(0)) {
      throw new IdBusinessV2OkxOtcError(
        'okx_otc_invalid_target',
        'OKX P2P 目标成交额无效',
        null,
        false
      );
    }
    return target;
  }

  private positiveAmount(value: unknown) {
    const decimal = this.amount(value);
    return decimal?.gt(0) ? decimal : null;
  }

  private nonNegativeDecimal(value: unknown) {
    const decimal = this.amount(value);
    return decimal?.gte(0) ? decimal : null;
  }

  private ratioDecimal(value: unknown) {
    const decimal = this.rate(value);
    if (!decimal) return null;
    const normalized = decimal.gt(1) && decimal.lte(100) ? decimal.div(100) : decimal;
    return normalized.lte(1) ? normalized : null;
  }

  private positiveRate(value: unknown) {
    const decimal = this.rate(value);
    return decimal?.gt(0) ? decimal : null;
  }

  private amount(value: unknown) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    try {
      const decimal = Amount4.from(String(value));
      return decimal.abs().lte(MAX_DECIMAL) ? decimal : null;
    } catch {
      return null;
    }
  }

  private rate(value: unknown) {
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    try {
      const decimal = Rate8.from(String(value));
      return decimal.abs().lte(MAX_DECIMAL) ? decimal : null;
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
            if (typeof item === 'string') return this.readString(item);
            const method = this.toObject(item);
            return this.readString(method?.paymentMethod) ?? this.readString(method?.name);
          })
          .filter((item): item is string => Boolean(item))
          .map((item) => item.slice(0, 80))
      )
    ].slice(0, 20);
  }

  private providerCode(value: unknown) {
    if (typeof value === 'number' && Number.isSafeInteger(value)) return String(value);
    return this.readString(value);
  }

  private invalidResponse(side: IdBusinessV2OtcSide, detail: string) {
    return new IdBusinessV2OkxOtcError(
      'okx_otc_invalid_response',
      `OKX P2P ${this.sideLabel(side)}响应结构无效：${detail}`,
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

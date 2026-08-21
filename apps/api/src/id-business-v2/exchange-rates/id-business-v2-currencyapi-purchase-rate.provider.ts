import { Injectable } from '@nestjs/common';
import {
  ID_BUSINESS_V2_PURCHASE_RATE_PROVIDER,
  IdBusinessV2PurchaseRateProviderError,
  type IdBusinessV2PurchaseRateProvider,
  type IdBusinessV2PurchaseRateProviderResult
} from './id-business-v2-purchase-rate-provider.types';

const ENDPOINT = 'https://api.currencyapi.com/v3/latest';
const SOURCE_CONTRACT = 'currencyapi-v3-latest-cny-base';
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;
const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/;
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30_000;

interface CurrencyApiPayload {
  meta?: { last_updated_at?: unknown };
  data?: Record<string, { code?: unknown; value?: unknown }>;
}

@Injectable()
export class IdBusinessV2CurrencyApiPurchaseRateProvider implements IdBusinessV2PurchaseRateProvider {
  async fetchLatest(currencyCodes: string[]): Promise<IdBusinessV2PurchaseRateProviderResult> {
    const apiKey = process.env.CURRENCY_API_KEY?.trim();
    if (!apiKey) {
      throw new IdBusinessV2PurchaseRateProviderError(
        'purchase_rate_provider_not_configured',
        '收购汇率供应商密钥未配置',
        false
      );
    }

    const normalizedCodes = [...new Set(currencyCodes.map((code) => code.trim().toUpperCase()))];
    if (
      normalizedCodes.length === 0 ||
      normalizedCodes.some((code) => !CURRENCY_CODE_PATTERN.test(code) || code === 'CNY')
    ) {
      throw new IdBusinessV2PurchaseRateProviderError(
        'purchase_rate_currency_request_invalid',
        '自动汇率请求的币种列表无效',
        false
      );
    }

    const url = new URL(ENDPOINT);
    url.searchParams.set('base_currency', 'CNY');
    url.searchParams.set('currencies', normalizedCodes.join(','));
    const timeoutMs = this.requestTimeoutMs();
    let response: Response;
    try {
      response = await fetch(url, {
        headers: { accept: 'application/json', apikey: apiKey },
        signal: AbortSignal.timeout(timeoutMs)
      });
    } catch (error) {
      throw new IdBusinessV2PurchaseRateProviderError(
        error instanceof Error && error.name === 'TimeoutError'
          ? 'purchase_rate_provider_timeout'
          : 'purchase_rate_provider_network_error',
        error instanceof Error && error.name === 'TimeoutError'
          ? '自动汇率供应商请求超时'
          : '自动汇率供应商网络请求失败',
        true
      );
    }

    if (!response.ok) {
      const retryable = response.status === 429 || response.status >= 500;
      throw new IdBusinessV2PurchaseRateProviderError(
        `purchase_rate_provider_http_${response.status}`,
        `自动汇率供应商返回 HTTP ${response.status}`,
        retryable
      );
    }

    let payload: CurrencyApiPayload;
    try {
      payload = (await response.json()) as CurrencyApiPayload;
    } catch {
      throw new IdBusinessV2PurchaseRateProviderError(
        'purchase_rate_provider_invalid_json',
        '自动汇率供应商响应不是有效 JSON',
        true
      );
    }

    const providerUpdatedAt = this.parseProviderTimestamp(payload.meta?.last_updated_at);
    const quotePerCny: Record<string, string> = {};
    for (const code of normalizedCodes) {
      const entry = payload.data?.[code];
      const value = this.parsePositiveDecimal(entry?.value);
      if (!entry || entry.code !== code || !value) {
        throw new IdBusinessV2PurchaseRateProviderError(
          'purchase_rate_provider_incomplete_response',
          `自动汇率供应商缺少有效的 ${code} 汇率`,
          true
        );
      }
      quotePerCny[code] = value;
    }

    return {
      provider: ID_BUSINESS_V2_PURCHASE_RATE_PROVIDER,
      baseCurrency: 'CNY',
      providerUpdatedAt,
      quotePerCny,
      sourceContract: SOURCE_CONTRACT,
      sourceReference: url.toString()
    };
  }

  private parseProviderTimestamp(value: unknown) {
    if (typeof value !== 'string' || !value.trim()) {
      throw new IdBusinessV2PurchaseRateProviderError(
        'purchase_rate_provider_timestamp_missing',
        '自动汇率供应商未返回数据时间',
        true
      );
    }
    const timestamp = new Date(value);
    if (Number.isNaN(timestamp.getTime()) || timestamp.getTime() > Date.now() + 5 * 60_000) {
      throw new IdBusinessV2PurchaseRateProviderError(
        'purchase_rate_provider_timestamp_invalid',
        '自动汇率供应商返回的数据时间无效',
        true
      );
    }
    return timestamp;
  }

  private parsePositiveDecimal(value: unknown) {
    if (typeof value !== 'number' && typeof value !== 'string') return null;
    const normalized = String(value).trim();
    if (!DECIMAL_PATTERN.test(normalized)) return null;
    try {
      return BigInt(normalized.replace('.', '')) > 0n ? normalized : null;
    } catch {
      return null;
    }
  }

  private requestTimeoutMs() {
    const value = Number(process.env.CURRENCY_RATE_REQUEST_TIMEOUT_MS);
    return Number.isInteger(value) && value >= MIN_TIMEOUT_MS && value <= MAX_TIMEOUT_MS
      ? value
      : DEFAULT_TIMEOUT_MS;
  }
}

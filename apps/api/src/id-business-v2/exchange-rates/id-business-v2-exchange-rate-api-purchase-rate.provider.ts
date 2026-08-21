import { Injectable } from '@nestjs/common';
import {
  ID_BUSINESS_V2_PURCHASE_RATE_PROVIDER,
  IdBusinessV2PurchaseRateProviderError,
  type IdBusinessV2PurchaseRateProvider,
  type IdBusinessV2PurchaseRateProviderResult
} from './id-business-v2-purchase-rate-provider.types';

const ENDPOINT = 'https://open.er-api.com/v6/latest/CNY';
const PROVIDER_URL = 'https://www.exchangerate-api.com';
const DOCUMENTATION_URL = 'https://www.exchangerate-api.com/docs/free';
const TERMS_URL = 'https://www.exchangerate-api.com/terms';
const SOURCE_CONTRACT = 'exchange-rate-api-open-v6-daily-cny-base';
const CURRENCY_CODE_PATTERN = /^[A-Z]{3}$/;
const DECIMAL_PATTERN = /^\d+(?:\.\d+)?$/;
const DEFAULT_TIMEOUT_MS = 10_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 30_000;

interface ExchangeRateApiPayload {
  result?: unknown;
  provider?: unknown;
  documentation?: unknown;
  terms_of_use?: unknown;
  time_last_update_unix?: unknown;
  base_code?: unknown;
  rates?: Record<string, unknown>;
}

@Injectable()
export class IdBusinessV2ExchangeRateApiPurchaseRateProvider implements IdBusinessV2PurchaseRateProvider {
  async fetchLatest(currencyCodes: string[]): Promise<IdBusinessV2PurchaseRateProviderResult> {
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

    let response: Response;
    try {
      response = await fetch(ENDPOINT, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(this.requestTimeoutMs())
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

    let responseBody: string;
    let payload: ExchangeRateApiPayload;
    try {
      responseBody = await response.text();
      payload = JSON.parse(responseBody) as ExchangeRateApiPayload;
    } catch {
      throw new IdBusinessV2PurchaseRateProviderError(
        'purchase_rate_provider_invalid_json',
        '自动汇率供应商响应不是有效 JSON',
        true
      );
    }

    this.assertContract(payload);
    const providerUpdatedAt = this.parseProviderTimestamp(payload.time_last_update_unix);
    const rawRates = this.extractRatesObject(responseBody);
    const quotePerCny: Record<string, string> = {};
    for (const code of normalizedCodes) {
      const value = this.extractPositiveRate(rawRates, code);
      if (!value) {
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
      sourceReference: ENDPOINT
    };
  }

  private assertContract(payload: ExchangeRateApiPayload) {
    if (
      payload.result !== 'success' ||
      payload.base_code !== 'CNY' ||
      payload.provider !== PROVIDER_URL ||
      payload.documentation !== DOCUMENTATION_URL ||
      payload.terms_of_use !== TERMS_URL ||
      !payload.rates ||
      typeof payload.rates !== 'object'
    ) {
      throw new IdBusinessV2PurchaseRateProviderError(
        'purchase_rate_provider_contract_invalid',
        '自动汇率供应商响应契约无效',
        true
      );
    }
  }

  private parseProviderTimestamp(value: unknown) {
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      throw new IdBusinessV2PurchaseRateProviderError(
        'purchase_rate_provider_timestamp_missing',
        '自动汇率供应商未返回数据时间',
        true
      );
    }
    const timestamp = new Date(value * 1000);
    if (Number.isNaN(timestamp.getTime()) || timestamp.getTime() > Date.now() + 5 * 60_000) {
      throw new IdBusinessV2PurchaseRateProviderError(
        'purchase_rate_provider_timestamp_invalid',
        '自动汇率供应商返回的数据时间无效',
        true
      );
    }
    return timestamp;
  }

  private extractRatesObject(rawJson: string) {
    const ratesProperty = /"rates"\s*:/.exec(rawJson);
    if (!ratesProperty) return null;
    let start = ratesProperty.index + ratesProperty[0].length;
    while (/\s/.test(rawJson[start] ?? '')) start += 1;
    if (rawJson[start] !== '{') return null;

    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let index = start; index < rawJson.length; index += 1) {
      const character = rawJson[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === '\\') escaped = true;
        else if (character === '"') inString = false;
        continue;
      }
      if (character === '"') {
        inString = true;
        continue;
      }
      if (character === '{') depth += 1;
      if (character === '}' && --depth === 0) return rawJson.slice(start, index + 1);
    }
    return null;
  }

  private extractPositiveRate(rawRates: string | null, code: string) {
    if (!rawRates) return null;
    const match = new RegExp(`"${code}"\\s*:\\s*(\\d+(?:\\.\\d+)?)(?=\\s*[,}])`).exec(rawRates);
    if (!match) return null;
    const normalized = match[1];
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

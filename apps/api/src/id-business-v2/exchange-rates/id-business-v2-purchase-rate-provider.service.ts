import { Injectable } from '@nestjs/common';
import { IdBusinessV2CurrencyApiPurchaseRateProvider } from './id-business-v2-currencyapi-purchase-rate.provider';
import {
  ID_BUSINESS_V2_PURCHASE_RATE_PROVIDER,
  IdBusinessV2PurchaseRateProviderError,
  type IdBusinessV2PurchaseRateProvider,
  type IdBusinessV2PurchaseRateProviderResult
} from './id-business-v2-purchase-rate-provider.types';

@Injectable()
export class IdBusinessV2PurchaseRateProviderService implements IdBusinessV2PurchaseRateProvider {
  constructor(private readonly currencyApi: IdBusinessV2CurrencyApiPurchaseRateProvider) {}

  fetchLatest(currencyCodes: string[]): Promise<IdBusinessV2PurchaseRateProviderResult> {
    const configured = (process.env.CURRENCY_RATE_PROVIDER || ID_BUSINESS_V2_PURCHASE_RATE_PROVIDER)
      .trim()
      .toLowerCase();
    if (configured !== ID_BUSINESS_V2_PURCHASE_RATE_PROVIDER) {
      throw new IdBusinessV2PurchaseRateProviderError(
        'purchase_rate_provider_unsupported',
        '收购汇率供应商配置不受支持',
        false
      );
    }
    return this.currencyApi.fetchLatest(currencyCodes);
  }

  getRuntime() {
    return {
      code: ID_BUSINESS_V2_PURCHASE_RATE_PROVIDER,
      configured:
        Boolean(process.env.CURRENCY_API_KEY?.trim()) &&
        (!process.env.CURRENCY_RATE_PROVIDER ||
          process.env.CURRENCY_RATE_PROVIDER.trim().toLowerCase() ===
            ID_BUSINESS_V2_PURCHASE_RATE_PROVIDER),
      source: 'https://api.currencyapi.com/',
      contract: 'currencyapi-v3-latest-cny-base'
    };
  }
}

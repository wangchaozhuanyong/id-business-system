import { Module } from '@nestjs/common';
import { IdBusinessV2RuntimeModule } from '../runtime/public-api';
import { IdBusinessV2BinanceOtcCollector } from './id-business-v2-binance-otc.collector';
import { IdBusinessV2ExchangeRateCronService } from './id-business-v2-exchange-rate-cron.service';
import { IdBusinessV2ExchangeRateOrderQuoteService } from './id-business-v2-exchange-rate-order-quote.service';
import { IdBusinessV2ExchangeRatePersistenceService } from './id-business-v2-exchange-rate-persistence.service';
import { IdBusinessV2ExchangeRateQueryService } from './id-business-v2-exchange-rate-query.service';
import { IdBusinessV2ExchangeRateSettingsService } from './id-business-v2-exchange-rate-settings.service';
import { IdBusinessV2ExchangeRateWorker } from './id-business-v2-exchange-rate.worker';
import { IdBusinessV2ExchangeRatesController } from './id-business-v2-exchange-rates.controller';
import { IdBusinessV2ExchangeRatesService } from './id-business-v2-exchange-rates.service';
import { IdBusinessV2OkxOtcCollector } from './id-business-v2-okx-otc.collector';
import { IdBusinessV2OtcAverageService } from './id-business-v2-otc-average.service';
import { IdBusinessV2OtcMidRateService } from './id-business-v2-otc-mid-rate.service';
import { IdBusinessV2PurchaseQuoteService } from './id-business-v2-purchase-quote.service';
import { IdBusinessV2CurrencyApiPurchaseRateProvider } from './id-business-v2-currencyapi-purchase-rate.provider';
import { IdBusinessV2PurchaseRateProviderService } from './id-business-v2-purchase-rate-provider.service';
import { IdBusinessV2PurchaseRateQueryService } from './id-business-v2-purchase-rate-query.service';
import { IdBusinessV2PurchaseRateSettingsService } from './id-business-v2-purchase-rate-settings.service';
import { IdBusinessV2PurchaseRateWorker } from './id-business-v2-purchase-rate.worker';
import { IdBusinessV2ExchangeRateRepository } from './persistence/id-business-v2-exchange-rate.repository';
import { IdBusinessV2PurchaseQuoteRepository } from './persistence/id-business-v2-purchase-quote.repository';
import { IdBusinessV2PurchaseRateAutomationRepository } from './persistence/id-business-v2-purchase-rate-automation.repository';

@Module({
  imports: [IdBusinessV2RuntimeModule],
  controllers: [IdBusinessV2ExchangeRatesController],
  providers: [
    IdBusinessV2ExchangeRatesService,
    IdBusinessV2BinanceOtcCollector,
    IdBusinessV2OkxOtcCollector,
    IdBusinessV2OtcAverageService,
    IdBusinessV2OtcMidRateService,
    IdBusinessV2ExchangeRateRepository,
    IdBusinessV2PurchaseQuoteRepository,
    IdBusinessV2PurchaseQuoteService,
    IdBusinessV2PurchaseRateAutomationRepository,
    IdBusinessV2CurrencyApiPurchaseRateProvider,
    IdBusinessV2PurchaseRateProviderService,
    IdBusinessV2PurchaseRateQueryService,
    IdBusinessV2PurchaseRateSettingsService,
    IdBusinessV2PurchaseRateWorker,
    IdBusinessV2ExchangeRateSettingsService,
    IdBusinessV2ExchangeRatePersistenceService,
    IdBusinessV2ExchangeRateQueryService,
    IdBusinessV2ExchangeRateOrderQuoteService,
    IdBusinessV2ExchangeRateWorker,
    IdBusinessV2ExchangeRateCronService
  ],
  exports: [
    IdBusinessV2ExchangeRatesService,
    IdBusinessV2ExchangeRateQueryService,
    IdBusinessV2ExchangeRateSettingsService,
    IdBusinessV2ExchangeRateOrderQuoteService,
    IdBusinessV2PurchaseQuoteService,
    IdBusinessV2PurchaseRateSettingsService
  ]
})
export class IdBusinessV2ExchangeRatesModule {}

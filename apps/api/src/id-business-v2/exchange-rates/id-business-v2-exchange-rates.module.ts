import { Module } from '@nestjs/common';
import { IdBusinessV2RuntimeModule } from '../runtime/public-api';
import { IdBusinessV2BinanceOtcCollector } from './id-business-v2-binance-otc.collector';
import { IdBusinessV2ExchangeRateCronService } from './id-business-v2-exchange-rate-cron.service';
import { IdBusinessV2ExchangeRateOrderQuoteService } from './id-business-v2-exchange-rate-order-quote.service';
import { IdBusinessV2ExchangeRatePersistenceService } from './id-business-v2-exchange-rate-persistence.service';
import { IdBusinessV2ExchangeRateQueryService } from './id-business-v2-exchange-rate-query.service';
import { IdBusinessV2ExchangeRateRetentionService } from './id-business-v2-exchange-rate-retention.service';
import { IdBusinessV2ExchangeRateSettingsService } from './id-business-v2-exchange-rate-settings.service';
import { IdBusinessV2ExchangeRateWorker } from './id-business-v2-exchange-rate.worker';
import { IdBusinessV2ExchangeRatesController } from './id-business-v2-exchange-rates.controller';
import { IdBusinessV2ExchangeRatesService } from './id-business-v2-exchange-rates.service';
import { IdBusinessV2OkxOtcCollector } from './id-business-v2-okx-otc.collector';
import { IdBusinessV2OtcAverageService } from './id-business-v2-otc-average.service';
import { IdBusinessV2OtcMidRateService } from './id-business-v2-otc-mid-rate.service';
import { IdBusinessV2ExchangeRateRepository } from './persistence/id-business-v2-exchange-rate.repository';

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
    IdBusinessV2ExchangeRateSettingsService,
    IdBusinessV2ExchangeRatePersistenceService,
    IdBusinessV2ExchangeRateQueryService,
    IdBusinessV2ExchangeRateOrderQuoteService,
    IdBusinessV2ExchangeRateWorker,
    IdBusinessV2ExchangeRateRetentionService,
    IdBusinessV2ExchangeRateCronService
  ],
  exports: [
    IdBusinessV2ExchangeRatesService,
    IdBusinessV2ExchangeRateQueryService,
    IdBusinessV2ExchangeRateSettingsService,
    IdBusinessV2ExchangeRateOrderQuoteService
  ]
})
export class IdBusinessV2ExchangeRatesModule {}

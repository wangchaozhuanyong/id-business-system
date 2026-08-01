import { Injectable } from '@nestjs/common';
import { V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES } from '@apple-business/shared';
import { Amount4, Rate8 } from '../runtime/public-api';
import {
  IdBusinessV2OtcAverageService,
  type IdBusinessV2OtcAverageResult
} from './id-business-v2-otc-average.service';

export interface IdBusinessV2OtcMidRateResult extends IdBusinessV2OtcAverageResult {
  midRateToRmb: Rate8;
}

@Injectable()
export class IdBusinessV2OtcMidRateService {
  constructor(private readonly averageService: IdBusinessV2OtcAverageService) {}

  async collectAndCalculate(targetAmountRmb: Amount4) {
    return this.calculate(await this.averageService.collectAndAverage(targetAmountRmb));
  }

  calculate(result: IdBusinessV2OtcAverageResult): IdBusinessV2OtcMidRateResult {
    if (
      result.asset !== 'USDT' ||
      result.fiat !== 'CNY' ||
      result.policy.decimalPlaces !== V2_RAW_EXCHANGE_RATE_DECIMAL_PLACES ||
      result.combinedMerchantBuyAverageRateToRmb.lte(0) ||
      result.combinedMerchantSellAverageRateToRmb.lte(0)
    ) {
      throw new Error('otc_mid_rate_invalid_average_result');
    }
    return {
      ...result,
      midRateToRmb: result.combinedMerchantBuyAverageRateToRmb
        .add(result.combinedMerchantSellAverageRateToRmb)
        .div(2)
    };
  }
}

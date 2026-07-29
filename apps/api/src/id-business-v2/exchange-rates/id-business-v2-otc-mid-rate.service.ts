import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import {
  IdBusinessV2OtcAverageService,
  type IdBusinessV2OtcAverageResult
} from './id-business-v2-otc-average.service';

export interface IdBusinessV2OtcMidRateResult extends IdBusinessV2OtcAverageResult {
  midRateToRmb: Prisma.Decimal;
}

@Injectable()
export class IdBusinessV2OtcMidRateService {
  constructor(private readonly averageService: IdBusinessV2OtcAverageService) {}

  async collectAndCalculate(targetAmountRmb: Prisma.Decimal) {
    return this.calculate(await this.averageService.collectAndAverage(targetAmountRmb));
  }

  calculate(result: IdBusinessV2OtcAverageResult): IdBusinessV2OtcMidRateResult {
    if (
      result.asset !== 'USDT' ||
      result.fiat !== 'CNY' ||
      result.policy.decimalPlaces !== 8 ||
      result.combinedMerchantBuyAverageRateToRmb.lte(0) ||
      result.combinedMerchantSellAverageRateToRmb.lte(0)
    ) {
      throw new Error('otc_mid_rate_invalid_average_result');
    }
    return {
      ...result,
      midRateToRmb: result.combinedMerchantBuyAverageRateToRmb
        .plus(result.combinedMerchantSellAverageRateToRmb)
        .div(2)
        .toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP)
    };
  }
}

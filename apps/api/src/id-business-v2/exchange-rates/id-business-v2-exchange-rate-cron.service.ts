import { createHash, timingSafeEqual } from 'node:crypto';
import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { IdBusinessV2ExchangeRateWorker } from './id-business-v2-exchange-rate.worker';

@Injectable()
export class IdBusinessV2ExchangeRateCronService {
  constructor(private readonly worker: IdBusinessV2ExchangeRateWorker) {}

  async run(authorization?: string) {
    this.assertAuthorized(authorization);
    const collection = await this.worker.runScheduled();

    return {
      collection,
      retention: {
        cleanupMode: 'governance_approval_required' as const,
        automaticCleanupExecuted: false
      },
      executedAt: new Date().toISOString()
    };
  }

  private assertAuthorized(authorization?: string) {
    const expected = process.env.ID_BUSINESS_V2_EXCHANGE_RATE_CRON_SECRET?.trim();
    if (!expected || expected.length < 32) {
      throw new ServiceUnavailableException('汇率定时采集密钥未配置');
    }

    const provided =
      authorization?.startsWith('Bearer ') === true ? authorization.slice(7).trim() : '';
    const expectedDigest = createHash('sha256').update(expected).digest();
    const providedDigest = createHash('sha256').update(provided).digest();
    if (!provided || !timingSafeEqual(expectedDigest, providedDigest)) {
      throw new UnauthorizedException('汇率定时采集请求未授权');
    }
  }
}

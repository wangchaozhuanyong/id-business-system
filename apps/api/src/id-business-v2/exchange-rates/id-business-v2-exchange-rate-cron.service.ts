import { createHash, timingSafeEqual } from 'node:crypto';
import { Injectable, ServiceUnavailableException, UnauthorizedException } from '@nestjs/common';
import { IdBusinessV2ExchangeRateRetentionService } from './id-business-v2-exchange-rate-retention.service';
import { IdBusinessV2ExchangeRateWorker } from './id-business-v2-exchange-rate.worker';

@Injectable()
export class IdBusinessV2ExchangeRateCronService {
  constructor(
    private readonly worker: IdBusinessV2ExchangeRateWorker,
    private readonly retentionService: IdBusinessV2ExchangeRateRetentionService
  ) {}

  async run(authorization?: string) {
    this.assertAuthorized(authorization);

    let collection: Awaited<ReturnType<IdBusinessV2ExchangeRateWorker['runScheduled']>> | undefined;
    let collectionError: unknown;
    try {
      collection = await this.worker.runScheduled();
    } catch (error) {
      collectionError = error;
    }

    const retention = await this.retentionService.cleanup();
    if (collectionError) {
      throw collectionError;
    }

    return {
      collection,
      retention,
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

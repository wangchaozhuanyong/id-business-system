import { ConflictException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { IdBusinessV2ExchangeRateQueryService } from './id-business-v2-exchange-rate-query.service';
import { IdBusinessV2ExchangeRateWorker } from './id-business-v2-exchange-rate.worker';

type EffectiveRate = Awaited<ReturnType<IdBusinessV2ExchangeRateQueryService['getEffective']>> & {
  available: true;
  snapshotId: string;
  midRateToRmb: string;
  averagedAt: Date;
  expiresAt: Date;
};

@Injectable()
export class IdBusinessV2ExchangeRateOrderQuoteService {
  private inFlight: Promise<EffectiveRate> | null = null;

  constructor(
    private readonly queryService: IdBusinessV2ExchangeRateQueryService,
    private readonly worker: IdBusinessV2ExchangeRateWorker
  ) {}

  async ensureEffective(): Promise<EffectiveRate> {
    const current = await this.queryService.getEffective();
    if (current.available) {
      return current as EffectiveRate;
    }
    if (this.inFlight) {
      return this.inFlight;
    }
    if (current.reason === 'collection_in_progress') {
      throw new ConflictException('USDT/CNY 汇率正在采集，请稍后重试');
    }

    this.inFlight = this.collectAndRead();
    try {
      return await this.inFlight;
    } finally {
      this.inFlight = null;
    }
  }

  private async collectAndRead(): Promise<EffectiveRate> {
    await this.worker.collectSystem();
    const collected = await this.queryService.getEffective();
    if (!collected.available) {
      throw new ServiceUnavailableException('USDT/CNY 汇率采集完成但未生成有效报价');
    }
    return collected as EffectiveRate;
  }
}

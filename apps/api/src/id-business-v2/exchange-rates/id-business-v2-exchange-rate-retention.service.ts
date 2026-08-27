import { Injectable } from '@nestjs/common';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import { IdBusinessV2ExchangeRateRepository } from './persistence/id-business-v2-exchange-rate.repository';

export interface IdBusinessV2ExchangeRateRetentionResult {
  cutoff: string;
  retentionDays: number;
  deletedRuns: number;
  deletedSnapshots: number;
  deletedProviderSnapshots: number;
  deletedQuoteSamples: number;
  deletedFxRateSnapshots: number;
  preservedReferencedRuns: number;
  preservedReferencedFxRateSnapshots: number;
}

@Injectable()
export class IdBusinessV2ExchangeRateRetentionService {
  constructor(
    private readonly repository: IdBusinessV2ExchangeRateRepository,
    private readonly transactionManager: V2CommandTransactionManager,
    private readonly audit: V2TransactionalAuditService
  ) {}

  async cleanup(): Promise<IdBusinessV2ExchangeRateRetentionResult> {
    return this.transactionManager.execute(
      async (tx) => {
        const result = this.parseResult(await this.repository.cleanupHistory(tx));

        const deletedCount =
          result.deletedRuns +
          result.deletedSnapshots +
          result.deletedProviderSnapshots +
          result.deletedQuoteSamples +
          result.deletedFxRateSnapshots;

        if (deletedCount > 0) {
          await this.audit.append(tx, {
            module: 'id_business_v2',
            action: 'id_business_v2.exchange_rate.retention_cleanup',
            objectType: 'id_business_v2_exchange_rate_run',
            afterData: {
              cutoff: result.cutoff,
              retentionDays: result.retentionDays,
              deletedRuns: result.deletedRuns,
              deletedSnapshots: result.deletedSnapshots,
              deletedProviderSnapshots: result.deletedProviderSnapshots,
              deletedQuoteSamples: result.deletedQuoteSamples,
              deletedFxRateSnapshots: result.deletedFxRateSnapshots,
              preservedReferencedRuns: result.preservedReferencedRuns,
              preservedReferencedFxRateSnapshots: result.preservedReferencedFxRateSnapshots
            },
            remark: `V2 联网汇率历史保留最近 ${result.retentionDays} 天；账务引用证据除外`
          });
        }

        return result;
      },
      { changedScopes: ['exchange-rates'], requestId: 'exchange-rate-retention', retryMode: 'none' }
    );
  }

  private parseResult(value: unknown): IdBusinessV2ExchangeRateRetentionResult {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('汇率保留清理返回格式无效');
    }

    const result = value as Record<string, unknown>;
    const cutoff = typeof result.cutoff === 'string' ? result.cutoff : '';
    const retentionDays = this.parseCount(result.retentionDays);
    const deletedRuns = this.parseCount(result.deletedRuns);
    const deletedSnapshots = this.parseCount(result.deletedSnapshots);
    const deletedProviderSnapshots = this.parseCount(result.deletedProviderSnapshots);
    const deletedQuoteSamples = this.parseCount(result.deletedQuoteSamples);
    const deletedFxRateSnapshots = this.parseCount(result.deletedFxRateSnapshots);
    const preservedReferencedRuns = this.parseCount(result.preservedReferencedRuns);
    const preservedReferencedFxRateSnapshots = this.parseCount(
      result.preservedReferencedFxRateSnapshots
    );
    if (!cutoff) {
      throw new Error('汇率保留清理缺少截止时间');
    }

    return {
      cutoff,
      retentionDays,
      deletedRuns,
      deletedSnapshots,
      deletedProviderSnapshots,
      deletedQuoteSamples,
      deletedFxRateSnapshots,
      preservedReferencedRuns,
      preservedReferencedFxRateSnapshots
    };
  }

  private parseCount(value: unknown) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new Error('汇率保留清理数量格式无效');
    }
    return value;
  }
}

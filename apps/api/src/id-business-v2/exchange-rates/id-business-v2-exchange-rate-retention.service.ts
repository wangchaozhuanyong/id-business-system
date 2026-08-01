import { Injectable } from '@nestjs/common';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import { IdBusinessV2ExchangeRateRepository } from './persistence/id-business-v2-exchange-rate.repository';

export interface IdBusinessV2ExchangeRateRetentionResult {
  cutoff: string;
  deletedRuns: number;
  deletedSnapshots: number;
  deletedProviderSnapshots: number;
  deletedQuoteSamples: number;
  preservedReferencedRuns: number;
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

        if (result.deletedRuns > 0) {
          await this.audit.append(tx, {
            module: 'id_business_v2',
            action: 'id_business_v2.exchange_rate.retention_cleanup',
            objectType: 'id_business_v2_exchange_rate_run',
            afterData: {
              cutoff: result.cutoff,
              deletedRuns: result.deletedRuns,
              deletedSnapshots: result.deletedSnapshots,
              deletedProviderSnapshots: result.deletedProviderSnapshots,
              deletedQuoteSamples: result.deletedQuoteSamples,
              preservedReferencedRuns: result.preservedReferencedRuns
            },
            remark: 'V2 联网汇率历史保留最近一个月；账务引用证据除外'
          });
        }

        return result;
      },
      { requestId: 'exchange-rate-retention', retryMode: 'none' }
    );
  }

  private parseResult(value: unknown): IdBusinessV2ExchangeRateRetentionResult {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('汇率保留清理返回格式无效');
    }

    const result = value as Record<string, unknown>;
    const cutoff = typeof result.cutoff === 'string' ? result.cutoff : '';
    const deletedRuns = this.parseCount(result.deletedRuns);
    const deletedSnapshots = this.parseCount(result.deletedSnapshots);
    const deletedProviderSnapshots = this.parseCount(result.deletedProviderSnapshots);
    const deletedQuoteSamples = this.parseCount(result.deletedQuoteSamples);
    const preservedReferencedRuns = this.parseCount(result.preservedReferencedRuns);
    if (!cutoff) {
      throw new Error('汇率保留清理缺少截止时间');
    }

    return {
      cutoff,
      deletedRuns,
      deletedSnapshots,
      deletedProviderSnapshots,
      deletedQuoteSamples,
      preservedReferencedRuns
    };
  }

  private parseCount(value: unknown) {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new Error('汇率保留清理数量格式无效');
    }
    return value;
  }
}

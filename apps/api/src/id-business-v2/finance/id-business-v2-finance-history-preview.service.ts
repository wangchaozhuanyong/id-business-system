import { Injectable } from '@nestjs/common';
import type { V2CommandTransaction } from '../runtime/public-api';
import { IdBusinessV2FinanceHistoryPreviewRepository } from './persistence/id-business-v2-finance-history-preview.repository';

export type { HistoryPreviewCategory } from './persistence/id-business-v2-finance-history-preview.repository';

@Injectable()
export class IdBusinessV2FinanceHistoryPreviewService {
  constructor(private readonly repository: IdBusinessV2FinanceHistoryPreviewRepository) {}

  preview(requestedAsOf?: Date) {
    return this.repository.preview(requestedAsOf);
  }

  previewInTransaction(tx: V2CommandTransaction, requestedAsOf?: Date) {
    return this.repository.previewInTransaction(tx, requestedAsOf);
  }
}

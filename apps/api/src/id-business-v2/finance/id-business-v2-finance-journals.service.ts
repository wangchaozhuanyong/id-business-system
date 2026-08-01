import { Injectable } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { AuthenticatedUser } from '../../auth/auth.types';
import { getPagination, type PaginationQuery } from '../../common/pagination';
import { V2CommandTransactionManager, V2TransactionalAuditService } from '../runtime/public-api';
import {
  normalizeFinanceCurrency,
  normalizeFinanceDate,
  normalizeFinanceIdempotencyKey,
  normalizeFinanceText,
  normalizeFinanceUuid
} from './id-business-v2-finance-input';
import { IdBusinessV2FinancePostingService } from './id-business-v2-finance-posting.service';
import { IdBusinessV2FinanceQueryRepository } from './persistence/id-business-v2-finance-query.repository';

interface ListJournalsQuery extends PaginationQuery {
  journalType?: string;
  sourceType?: string;
  sourceId?: string;
  periodMonth?: string;
  dateFrom?: string;
  dateTo?: string;
  currency?: string;
  supplierOptionId?: string;
  financeAccountId?: string;
}

@Injectable()
export class IdBusinessV2FinanceJournalsService {
  constructor(
    private readonly commandTransactions: V2CommandTransactionManager,
    private readonly queryRepository: IdBusinessV2FinanceQueryRepository,
    private readonly audit: V2TransactionalAuditService,
    private readonly postingService: IdBusinessV2FinancePostingService
  ) {}

  async list(query: ListJournalsQuery) {
    const pagination = getPagination(query);
    const filter = {
      journalType: query.journalType,
      sourceType: query.sourceType,
      sourceId: query.sourceId || undefined,
      periodMonth: query.periodMonth || undefined,
      businessDate:
        query.dateFrom || query.dateTo
          ? {
              gte: query.dateFrom
                ? normalizeFinanceDate(`${query.dateFrom}T00:00:00.000Z`, '开始日期')
                : undefined,
              lte: query.dateTo
                ? normalizeFinanceDate(`${query.dateTo}T00:00:00.000Z`, '结束日期')
                : undefined
            }
          : undefined,
      currency: query.currency ? normalizeFinanceCurrency(query.currency) : undefined,
      financeAccountId: query.financeAccountId
        ? normalizeFinanceUuid(query.financeAccountId, '资金账户')
        : undefined,
      supplierOptionId: query.supplierOptionId
        ? normalizeFinanceUuid(query.supplierOptionId, '供应商')
        : undefined
    };
    const { items, total } = await this.queryRepository.listJournals(
      filter,
      pagination.skip,
      pagination.take
    );
    return {
      items,
      total,
      page: pagination.page,
      pageSize: pagination.pageSize
    };
  }

  reverse(
    journalId: string,
    reasonValue: string,
    idempotencyKeyValue: string,
    operator?: AuthenticatedUser
  ) {
    const reason = normalizeFinanceText(reasonValue, '冲销原因', 500, true)!;
    const idempotencyKey = normalizeFinanceIdempotencyKey(idempotencyKeyValue, 'finance_reversal');
    return this.commandTransactions.execute(
      async (tx) => {
        const reversal = await this.postingService.reverse(
          tx,
          journalId,
          reason,
          idempotencyKey,
          operator
        );
        await this.audit.append(tx, {
          userId: operator?.id,
          module: 'id_business_v2_finance',
          action: 'id_business_v2.finance_journal.reverse',
          objectType: 'id_business_v2_finance_journal',
          objectId: journalId,
          afterData: { reversalJournalId: reversal.id, reason },
          remark: `冲销财务日记：${reversal.sourceReference ?? journalId}`
        });
        return reversal;
      },
      { requestId: randomUUID(), operator }
    );
  }
}
